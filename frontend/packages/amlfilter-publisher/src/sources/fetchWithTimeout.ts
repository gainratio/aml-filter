// The single seam every sanctions-feed request goes through (OFAC, UN, EU, UK).
//
// It does three things a bare `fetch(url)` does not:
//   1. IDENTIFIES US. A bare fetch sends no User-Agent, which public feeds
//      increasingly treat as scraper traffic. On 2026-07-30 Treasury put the
//      OFAC sanctions-list service behind an AWS WAF and every UA-less request
//      started returning 403 — which killed every deploy. Announcing who we are
//      with a contactable URL is the baseline these publishers expect.
//   2. RETRIES TRANSIENTLY. A single 429/503/connection-reset from an upstream
//      must not be a one-shot kill for a release, so those get a small number of
//      attempts with growing backoff (5s, 10s, 20s: a three-second window lost
//      EU to one connect-timeout burst on 2026-09-25). A permanent answer (404,
//      400) is NOT retried — burning the budget on it only delays the real error.
//      401 IS retried: no feed takes credentials, and the EU webgate answered
//      its static public token with a one-off 401 on 2026-10-02.
//   3. NAMES A WAF BLOCK FOR WHAT IT IS. AWS WAF's `challenge` action answers
//      HTTP **202 with an empty body** — `response.ok` is TRUE. Passed through,
//      that hands zero bytes to a CSV parser and surfaces thousands of lines
//      later as "entity count 0 is outside plausible range". Detecting
//      `x-amzn-waf-action` here turns a baffling downstream failure into the
//      actual sentence: an edge WAF stopped us.
//
//   4. RESOLVES FEED HOSTS OVER IPv4 ONLY. On a GitHub runner, Dagger's
//      in-engine resolver never answers the AAAA query for
//      sanctionslist.fcdo.gov.uk (its Route 53 zone returns an out-of-zone SOA,
//      which Azure DNS SERVFAILs). getaddrinfo waits for both legs, undici
//      counts that wait inside its 10s connect budget, and the UK list failed
//      with `UND_ERR_CONNECT_TIMEOUT` for 24 days (2026-08-31 .. 09-24). No
//      feed needs IPv6, so no AAAA query is sent at all.
//
// Deliberately NOT retried: our own deadline. `SOURCE_FETCH_TIMEOUT_MS` is
// already a generous per-request bound, and re-arming it would triple the worst
// case this function exists to cap. Connection-level errors still retry.

import { lookup as dnsLookup } from "node:dns";
import type { LookupFunction } from "node:net";
import { Agent } from "undici";

/** An undici dispatcher whose connections resolve hosts over IPv4 only. */
export function createFeedDispatcher(
	lookup: LookupFunction = dnsLookup as LookupFunction,
): Agent {
	return new Agent({
		connect: {
			lookup: (hostname, options, callback) =>
				lookup(hostname, { ...options, family: 4 }, callback),
		},
	});
}

/** Node's fetch accepts an undici `dispatcher`; the DOM RequestInit type
 * does not declare it. */
type FeedRequestInit = RequestInit & { readonly dispatcher: Agent };

/** The dispatcher every feed request uses (see note 4 above). */
export const FEED_DISPATCHER = createFeedDispatcher();

/** Default upper bound for an external sanctions-feed request. */
export const SOURCE_FETCH_TIMEOUT_MS = 45_000;

/** Total attempts (1 initial + retries) for a transiently-failing feed. */
export const FEED_FETCH_ATTEMPTS = 4;

/** First backoff pause; each further retry doubles it. */
const BACKOFF_BASE_MS = 5_000;

/** How this publisher identifies itself to every upstream sanctions feed.
 * Overridable via SOURCE_USER_AGENT so an operator can adjust it without a code
 * change if an upstream's bot policy shifts again. */
export const FEED_USER_AGENT =
	process.env.SOURCE_USER_AGENT ??
	`aml-filter/${process.env.npm_package_version ?? "4"} (+https://aml-filter.com)`;

/** A feed request that could not be completed, and whether retrying may help. */
export class FeedFetchError extends Error {
	public readonly retryable: boolean;

	public constructor(
		message: string,
		retryable: boolean,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "FeedFetchError";
		this.retryable = retryable;
	}
}

/** One link of a cause chain: `[CODE] message`, with an AggregateError's
 * members inlined (undici's happy-eyeballs connect throws one per address). */
function describeLink(error: unknown): string {
	if (!(error instanceof Error)) {
		return String(error);
	}
	const code = (error as { code?: unknown }).code;
	const prefix = typeof code === "string" ? `[${code}] ` : "";
	const text = error.message === "" ? error.name : error.message;
	if (error instanceof AggregateError && error.errors.length > 0) {
		return `${prefix}${text} {${error.errors.map(describeLink).join("; ")}}`;
	}
	return `${prefix}${text}`;
}

/** `String(error)` plus every `cause` beneath it. undici reports every network
 * failure as the bare `TypeError: fetch failed` and puts the real reason
 * (EAI_AGAIN, ECONNRESET, UND_ERR_SOCKET, a cert error…) on `cause`; dropping
 * it cost 24 days of a stale UK list (2026-09). Cycle-safe. */
export function describeErrorChain(error: unknown): string {
	const parts = [String(error)];
	const seen = new Set<unknown>([error]);
	let cause = error instanceof Error ? error.cause : undefined;
	while (cause !== undefined && !seen.has(cause)) {
		seen.add(cause);
		parts.push(describeLink(cause));
		cause = cause instanceof Error ? cause.cause : undefined;
	}
	return parts.join(" <- ");
}

/** Injection points so retry behaviour is testable without real waiting. */
export interface FeedFetchOptions {
	readonly attempts?: number;
	readonly sleep?: (ms: number) => Promise<void>;
	/** Extra request headers (e.g. an upstream's API key). Never logged. */
	readonly headers?: Readonly<Record<string, string>>;
}

/** Bounds applied while consuming a response body, after headers arrive. */
export interface ResponseBodyLimits {
	readonly maxBytes: number;
	readonly elapsedMs: number;
	readonly idleMs: number;
	readonly sizeError?: (maxBytes: number) => Error;
}

const responseControllers = new WeakMap<Response, AbortController>();

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** Statuses worth another attempt: rate limits, edge blocks, server faults. */
function isRetryableStatus(status: number): boolean {
	return (
		status === 401 ||
		status === 403 ||
		status === 408 ||
		status === 425 ||
		status === 429 ||
		status >= 500
	);
}

/** Why this response is unusable, or null when it is a genuine payload. */
function rejectionReason(response: Response, label: string): string | null {
	const waf = response.headers.get("x-amzn-waf-action");
	if (waf !== null) {
		return `${label} request was stopped by an edge WAF (x-amzn-waf-action: ${waf}, HTTP ${response.status}) — this challenge cannot be solved by a plain HTTP client`;
	}
	if (!response.ok) {
		return `${label} request failed: ${response.status} ${response.statusText}`;
	}
	return null;
}

/** One bounded attempt. Throws FeedFetchError; never returns a bad response. */
async function attemptOnce(
	url: string,
	label: string,
	timeoutMs: number,
	extraHeaders: Readonly<Record<string, string>> = {},
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const init: FeedRequestInit = {
			dispatcher: FEED_DISPATCHER,
			signal: controller.signal,
			headers: {
				"user-agent": FEED_USER_AGENT,
				accept: "*/*",
				...extraHeaders,
			},
		};
		const response = await fetch(url, init);
		responseControllers.set(response, controller);
		return response;
	} catch (error) {
		if (controller.signal.aborted) {
			// Our own deadline — see the header note on why this is terminal.
			throw new FeedFetchError(
				`${label} request timed out after ${timeoutMs}ms`,
				false,
				{ cause: error },
			);
		}
		throw new FeedFetchError(
			`${label} request failed: ${describeErrorChain(error)}`,
			true,
			{ cause: error },
		);
	} finally {
		clearTimeout(timer);
	}
}

export async function cancelResponse(
	response: Response,
	reason: unknown,
): Promise<void> {
	responseControllers.get(response)?.abort(reason);
	try {
		await response.body?.cancel(reason);
	} catch {
		// The transport may already have closed the stream. The original error wins.
	}
}

/** Run one attempt and classify the outcome. */
async function classifyAttempt(
	url: string,
	label: string,
	timeoutMs: number,
	extraHeaders: Readonly<Record<string, string>>,
): Promise<Response | FeedFetchError> {
	try {
		const response = await attemptOnce(url, label, timeoutMs, extraHeaders);
		const reason = rejectionReason(response, label);
		if (reason === null) {
			return response;
		}
		const failure = new FeedFetchError(
			reason,
			isRetryableStatus(response.status),
		);
		await cancelResponse(response, failure);
		return failure;
	} catch (error) {
		return error instanceof FeedFetchError
			? error
			: new FeedFetchError(
					`${label} request failed: ${describeErrorChain(error)}`,
					true,
					{
						cause: error,
					},
				);
	}
}

function bodyTimeoutError(
	label: string,
	kind: "elapsed" | "idle",
	ms: number,
): FeedFetchError {
	return new FeedFetchError(
		`${label} response body exceeded its ${kind} timeout of ${ms}ms`,
		false,
	);
}

/** Read one chunk; a transport failure mid-body is named with its causes. */
async function readTransport(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	label: string,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	try {
		return await reader.read();
	} catch (error: unknown) {
		throw new FeedFetchError(
			`${label} response body read failed: ${describeErrorChain(error)}`,
			true,
			{ cause: error },
		);
	}
}

async function readWithDeadline(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	label: string,
	remainingMs: number,
	idleMs: number,
	elapsedMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	const timeoutMs = Math.min(remainingMs, idleMs);
	const kind = remainingMs <= idleMs ? "elapsed" : "idle";
	const reportedMs = kind === "elapsed" ? elapsedMs : idleMs;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(bodyTimeoutError(label, kind, reportedMs)),
			timeoutMs,
		);
	});
	try {
		return await Promise.race([readTransport(reader, label), timeout]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

interface BodyReadState {
	bytes: number;
	readonly startedAt: number;
}

function sizeError(label: string, limits: ResponseBodyLimits): Error {
	return (
		limits.sizeError?.(limits.maxBytes) ??
		new FeedFetchError(
			`${label} response body exceeded ${limits.maxBytes} bytes`,
			false,
		)
	);
}

async function nextBodyChunk(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	label: string,
	limits: ResponseBodyLimits,
	state: BodyReadState,
): Promise<Uint8Array | null> {
	const remainingMs = limits.elapsedMs - (Date.now() - state.startedAt);
	if (remainingMs <= 0) {
		throw bodyTimeoutError(label, "elapsed", limits.elapsedMs);
	}
	const result = await readWithDeadline(
		reader,
		label,
		remainingMs,
		limits.idleMs,
		limits.elapsedMs,
	);
	if (result.done) {
		return null;
	}
	state.bytes += result.value.byteLength;
	if (state.bytes > limits.maxBytes) {
		throw sizeError(label, limits);
	}
	return result.value;
}

async function cancelReader(
	response: Response,
	reader: ReadableStreamDefaultReader<Uint8Array>,
	reason: unknown,
): Promise<void> {
	responseControllers.get(response)?.abort(reason);
	try {
		await reader.cancel(reason);
	} catch {
		// Preserve the consumption error even if cancellation also fails.
	}
}

/** Stream a response under byte, total-elapsed, and between-chunk deadlines. */
export async function* streamResponseBody(
	response: Response,
	label: string,
	limits: ResponseBodyLimits,
): AsyncGenerator<Uint8Array> {
	if (response.body === null) {
		const failure = new FeedFetchError(
			`${label} response body is missing`,
			false,
		);
		responseControllers.get(response)?.abort(failure);
		throw failure;
	}
	const reader = response.body.getReader();
	const state: BodyReadState = { bytes: 0, startedAt: Date.now() };
	let complete = false;
	let cancelled = false;
	try {
		for (;;) {
			const chunk = await nextBodyChunk(reader, label, limits, state);
			if (chunk === null) {
				complete = true;
				return;
			}
			yield chunk;
		}
	} catch (error: unknown) {
		cancelled = true;
		await cancelReader(response, reader, error);
		throw error;
	} finally {
		if (!complete && !cancelled) {
			await cancelReader(
				response,
				reader,
				new Error(`${label} body abandoned`),
			);
		}
		reader.releaseLock();
	}
}

/** Decode a bounded response body without using the unbounded Response.text(). */
export async function readResponseText(
	response: Response,
	label: string,
	limits: ResponseBodyLimits,
): Promise<string> {
	const decoder = new TextDecoder();
	const text: string[] = [];
	for await (const chunk of streamResponseBody(response, label, limits)) {
		text.push(decoder.decode(chunk, { stream: true }));
	}
	text.push(decoder.decode());
	return text.join("");
}

/** Fetch one external feed: identified, bounded, and retried when it can help. */
export async function fetchWithTimeout(
	url: string,
	label: string,
	timeoutMs: number = SOURCE_FETCH_TIMEOUT_MS,
	options: FeedFetchOptions = {},
): Promise<Response> {
	const attempts = options.attempts ?? FEED_FETCH_ATTEMPTS;
	const sleep = options.sleep ?? defaultSleep;
	let failure = new FeedFetchError(
		`${label} request was never attempted`,
		false,
	);
	for (let attempt = 1; attempt <= attempts; attempt++) {
		if (attempt > 1) {
			await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 2));
		}
		const outcome = await classifyAttempt(
			url,
			label,
			timeoutMs,
			options.headers ?? {},
		);
		if (outcome instanceof FeedFetchError) {
			failure = outcome;
			if (!outcome.retryable) {
				break;
			}
		} else {
			return outcome;
		}
	}
	throw failure;
}
