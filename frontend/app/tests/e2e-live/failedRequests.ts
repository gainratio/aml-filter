/**
 * Which `requestfailed` reports the live smoke may ignore. Kept free of
 * Playwright so a Vitest contract can pin it
 * (src/__tests__/liveSmokeRequestFailures.contract.test.ts).
 *
 * A failed live smoke rolls production back, so it must fail on ANY broken
 * asset. There is exactly one known false alarm: Chromium reports
 * `net::ERR_ABORTED` for the signed `/bundle/origin/latest` pointer AFTER the
 * whole 200 response arrived (the consumer closes a finished stream before the
 * network service records completion). That rolled production back on
 * 2026-10-04.
 *
 * The excuse covers that one request and needs proof the body arrived whole:
 * Playwright fired `requestfinished` for it, or the received body is exactly as
 * long as its Content-Length. `timing().responseEnd` is NOT that proof, and no
 * other URL (manifest, chunk, script, model) is ever excused.
 *
 * The same pointer request is also excused when the smoke itself abandoned it:
 * a main-frame navigation began after the request did (e.g. /screen -> /settings
 * mid-boot), so Chromium cancelled the departing document's fetch with
 * `net::ERR_ABORTED` before any body arrived. That rolled production back on
 * 2026-10-15; it is reproduced by navigating the instant the pointer is
 * requested. Still only the pointer, and still only `net::ERR_ABORTED`.
 *
 * Production serves the pointer content-encoded (brotli) with no Content-Length,
 * and Playwright then reports a body size of 0 and cannot return the body, so
 * neither proof above can ever hold there, while Chromium keeps reporting the
 * worker's fully read pointer as `net::ERR_ABORTED` (3 of 3 @fresh runs,
 * 2026-10-15). An in-worker probe on the app's own stream reader showed every
 * such abort land in the same millisecond the app read the whole signed pointer
 * to end-of-stream: Chromium's reporting, not a cancel by the app (its only
 * abort is a 30 s stall watchdog). So a 2xx pointer with an allowlisted
 * Content-Encoding is excused only when the app requested the manifest for
 * that very fetch (see RequestLedger). The app requests `/manifest/<hash>` only after the pointer parsed
 * and its Ed25519 signature verified; a pointer it did not accept (stalled,
 * truncated, tampered) is never followed by one.
 */

/** What Playwright knows about a failed request, reduced to plain values. */
export interface FailedRequestFacts {
	readonly url: string;
	readonly errorText: string;
	/** HTTP status of the response, or `null` when none arrived. */
	readonly status: number | null;
	/** True when Playwright fired `requestfinished` for this request. */
	readonly finished: boolean;
	/** `request.sizes().responseBodySize` (encoded bytes), or `null` if unknown. */
	readonly receivedBodyBytes: number | null;
	/** The response's Content-Length (see parseContentLength), or `null`. */
	readonly contentLength: number | null;
	/** The response's Content-Encoding header, or `null` when absent. */
	readonly contentEncoding: string | null;
	/** True when a main-frame navigation started after this request did. */
	readonly abandonedByNavigation: boolean;
	/** True when the app requested the manifest for this very pointer fetch. */
	readonly manifestFollowed: boolean;
}

/** Encodings Chromium decodes and then cannot size for Playwright. */
const DECODED_ENCODINGS: ReadonlySet<string> = new Set([
	"br",
	"gzip",
	"zstd",
	"deflate",
]);

const POINTER_PATH = "/bundle/origin/latest";
const MANIFEST_PREFIX = "/bundle/origin/manifest/";
const ERR_ABORTED = "net::ERR_ABORTED";

/** A Content-Length header as a byte count; anything but plain digits is `null`. */
export function parseContentLength(header: string | undefined): number | null {
	return header !== undefined && /^\d+$/.test(header) ? Number(header) : null;
}

function isPointer(url: string): boolean {
	return new URL(url).pathname === POINTER_PATH;
}

function bodyArrivedWhole(facts: FailedRequestFacts): boolean {
	return (
		facts.finished ||
		(facts.contentLength !== null &&
			facts.receivedBodyBytes === facts.contentLength)
	);
}

function isSuccess(status: number | null): boolean {
	return status !== null && status >= 200 && status < 300;
}

function isDecodedEncoding(encoding: string | null): boolean {
	return (
		encoding !== null && DECODED_ENCODINGS.has(encoding.trim().toLowerCase())
	);
}

/** A compressed pointer Chromium cannot size, which the app then accepted. */
function acceptedEncodedBody(facts: FailedRequestFacts): boolean {
	return isDecodedEncoding(facts.contentEncoding) && facts.manifestFollowed;
}

function completedBeforeAbort(facts: FailedRequestFacts): boolean {
	return (
		isSuccess(facts.status) &&
		(bodyArrivedWhole(facts) || acceptedEncodedBody(facts))
	);
}

/** True only for the pointer request aborted after a whole (or, compressed,
 * app-accepted) 2xx body, or abandoned by a later page navigation. */
export function isExcusedFailedRequest(facts: FailedRequestFacts): boolean {
	return (
		isPointer(facts.url) &&
		facts.errorText === ERR_ABORTED &&
		(facts.abandonedByNavigation || completedBeforeAbort(facts))
	);
}

/** For the run log: which proof an excused request relied on. */
export function excuseEvidence(facts: FailedRequestFacts): string {
	if (facts.abandonedByNavigation) return "abandoned by a later navigation";
	if (facts.finished) return "requestfinished fired";
	if (acceptedEncodedBody(facts)) {
		return `${facts.status} ${facts.contentEncoding}, manifest requested next`;
	}
	return `body ${facts.receivedBodyBytes} B == Content-Length`;
}

type BundleKind = "pointer" | "manifest";

function bundleKind(url: string): BundleKind | null {
	const path = new URL(url).pathname;
	if (path === POINTER_PATH) return "pointer";
	return path.startsWith(MANIFEST_PREFIX) &&
		path.length > MANIFEST_PREFIX.length
		? "manifest"
		: null;
}

/**
 * The order the page issued requests in, kept free of Playwright (keys are the
 * caller's request objects). It answers two questions about a failed request:
 * did a later main-frame navigation abandon it, and did the app go on to request
 * the manifest for THAT pointer fetch (the app accepted it).
 *
 * A manifest vouches for a pointer only when that pointer is the one fetch
 * still waiting for its manifest. With two pointer fetches in flight the
 * manifest may be either one's, so it vouches for neither (and both keep
 * waiting): a stalled overlapping fetch can never borrow another's manifest.
 */
export class RequestLedger<K extends object> {
	#navigations = 0;
	readonly #startedAt = new WeakMap<K, number>();
	readonly #waiting = new Set<K>();
	readonly #accepted = new WeakSet<K>();

	/** Record a request as it starts. */
	public note(key: K, url: string, isMainFrameNavigation: boolean): void {
		if (isMainFrameNavigation) {
			this.#navigations += 1;
			this.#waiting.clear();
		}
		this.#startedAt.set(key, this.#navigations);
		const kind = bundleKind(url);
		if (kind === "pointer") this.#waiting.add(key);
		if (kind === "manifest") this.#creditSoleWaitingPointer();
	}

	#creditSoleWaitingPointer(): void {
		if (this.#waiting.size !== 1) return;
		for (const pointer of this.#waiting) this.#accepted.add(pointer);
		this.#waiting.clear();
	}

	/** True when a main-frame navigation began after this request started. */
	public abandoned(key: K): boolean {
		const started = this.#startedAt.get(key);
		return started !== undefined && started < this.#navigations;
	}

	/** True when the app requested the manifest for this pointer fetch. */
	public manifestFollowed(key: K): boolean {
		return this.#accepted.has(key);
	}
}
