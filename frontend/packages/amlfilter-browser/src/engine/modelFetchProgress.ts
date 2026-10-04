// Model-download progress metered at the TRANSPORT, not at the library.
//
// WHY not transformers.js's own `progress_callback`: in 4.2.0 passing it makes
// `pipeline()` run a metadata pass over every expected file first
// (pipelines.js: `if (progress_callback) await Promise.all(expected_files.map(
// get_file_metadata))`). With this app's self-hosting config
// (`allowLocalModels = true`, `localModelPath = "/models/"`) that metadata probe
// is NOT a cheap Range request — `_get_file_metadata` sees a root-relative path,
// takes the local-file branch, and issues a FULL same-origin GET whose body it
// never cancels. The ~23 MB ONNX would be pulled twice on every cold boot.
//
// So progress is read off the bytes instead: for the duration of the model load
// the transformers.js `env.fetch` knob is wrapped, and any response for a
// self-hosted model asset has its body teed through a counting stream. The tee
// re-enqueues the SAME chunks, so the consumer receives byte-for-byte what the
// server sent; nothing is buffered twice and no request is repeated.

import type { EmbedProgress, OnEmbedProgress } from "./embedder";

/** What `fetch` may be called with — the three forms transformers.js uses. */
type FetchInput = string | URL | Request;

/** The shape of a `fetch` implementation, narrowed to what is wrapped here. */
type FetchLike = (input: FetchInput, init?: RequestInit) => Promise<Response>;

/** Anything carrying a swappable `fetch` — in production the transformers.js
 * `env`, in tests a plain object. Structural so no global is monkey-patched. */
export interface FetchScope {
	fetch: FetchLike;
}

/**
 * The same-origin path the self-hosted model files live under. It mirrors
 * `env.localModelPath` in embedder.ts: transformers.js resolves each weight as
 * `/models/<modelId>/<file>`, so this prefix is exactly the set of requests the
 * ~23 MB boot download is made of — and nothing else (the ORT wasm loader under
 * `/ort/`, the signed bundle under `/bundle/origin/`, the pinned public key).
 */
export const MODEL_ASSET_PREFIX = "/models/";

/** The URL a fetch call targets, for each of the three input forms. Duck-typed
 * rather than `instanceof`, so a cross-realm URL/Request still resolves. */
function requestUrl(input: FetchInput): string {
	if (typeof input === "string") {
		return input;
	}
	return "url" in input ? input.url : input.href;
}

/** The path component of a request URL, or undefined if it is unparseable. */
function pathnameOf(url: string): string | undefined {
	if (url.startsWith("/")) {
		return url.split(/[?#]/, 1)[0];
	}
	try {
		return new URL(url).pathname;
	} catch {
		return undefined;
	}
}

/**
 * Whether a request targets a self-hosted model asset. Matched on the PATH, not
 * as a substring of the whole URL, so neither a query string nor a foreign host
 * that merely mentions the prefix can drag an unrelated request into metering.
 */
export function isModelAssetUrl(
	url: string,
	prefix: string = MODEL_ASSET_PREFIX,
): boolean {
	return pathnameOf(url)?.startsWith(prefix) === true;
}

/** `content-length` as a byte count, or undefined when absent/unparseable. */
function declaredLength(response: Response): number | undefined {
	const raw = response.headers.get("content-length");
	if (raw === null) {
		return undefined;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Whether `content-length` describes the bytes the stream will deliver. For a
 * compressed response it does NOT — the header counts wire bytes while fetch
 * hands back decoded ones — so such a response is left out of the accounting
 * entirely rather than reported as an impossible >100%.
 */
function isIdentityEncoded(response: Response): boolean {
	const encoding = response.headers.get("content-encoding");
	return encoding === null || encoding.trim().toLowerCase() === "identity";
}

/** The body whose bytes can be honestly counted, or null when this response is
 * not one the meter should touch (an error, a redirect, a compressed transfer,
 * or a bodyless reply). Returning the stream rather than a boolean keeps the
 * null check in ONE place instead of leaving a second, unreachable one below. */
function countableBody(response: Response): ReadableStream<Uint8Array> | null {
	if (response.status !== 200 || !isIdentityEncoded(response)) {
		return null;
	}
	return response.body;
}

/**
 * Re-wrap a response so every chunk is counted on its way to the consumer. The
 * chunks are enqueued unchanged and in order, so the delivered body is
 * byte-for-byte the original; a corrupted ONNX graph is the one failure mode
 * this whole feature must not introduce.
 */
function countingBody(
	response: Response,
	source: ReadableStream<Uint8Array>,
	count: (bytes: number) => void,
): Response {
	const reader = source.getReader();
	const teed = new ReadableStream<Uint8Array>({
		async pull(controller) {
			const { done, value } = await reader.read();
			if (done) {
				controller.close();
				return;
			}
			count(value.byteLength);
			controller.enqueue(value);
		},
		cancel: (reason) => reader.cancel(reason),
	});
	return new Response(teed, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

/**
 * Running byte totals for ONE model load. Aggregated across files rather than
 * reported per file: transformers.js downloads the tokenizer and the model
 * CONCURRENTLY (pipelines.js `Promise.all`), so per-file percentages would make
 * the banner jump backwards the moment the small file finished. `loaded` only
 * grows; `total` is the sum of the `content-length`s seen so far.
 */
class ByteMeter {
	readonly #emit: OnEmbedProgress;
	#loaded = 0;
	#total = 0;
	#totalKnown = true;

	public constructor(emit: OnEmbedProgress) {
		this.#emit = emit;
	}

	/** Meter `response` if it can be counted; otherwise hand it back untouched. */
	public track(response: Response): Response {
		const body = countableBody(response);
		if (body === null) {
			return response;
		}
		const declared = declaredLength(response);
		if (declared === undefined) {
			this.#totalKnown = false;
		} else {
			this.#total += declared;
		}
		return countingBody(response, body, (bytes) => this.#add(bytes));
	}

	#add(bytes: number): void {
		this.#loaded += bytes;
		this.#emit(this.#progress());
	}

	/** NEVER invent a denominator: with no honest total the sink gets bytes only
	 * — `total`/`pct` are OMITTED, not zeroed — and the banner shows megabytes
	 * instead of a fabricated percent. */
	#progress(): EmbedProgress {
		if (!this.#totalKnown || this.#total === 0) {
			return { loaded: this.#loaded };
		}
		const pct = Math.min(100, (this.#loaded / this.#total) * 100);
		return { loaded: this.#loaded, total: this.#total, pct };
	}
}

/**
 * Run `run()` with `scope.fetch` metering model-asset downloads into
 * `onProgress`, then ALWAYS put the original back — on success and on failure
 * alike. A load that rejects (blocked CDN, timeout) must not strand a wrapped
 * fetch that would keep metering every later request.
 */
export async function withModelFetchProgress<T>(
	scope: FetchScope,
	onProgress: OnEmbedProgress,
	run: () => Promise<T>,
	prefix: string = MODEL_ASSET_PREFIX,
): Promise<T> {
	const original = scope.fetch;
	// Bound to the scope: an unbound `fetch` extracted from a global throws
	// "Illegal invocation" in the browser.
	const call = original.bind(scope);
	const meter = new ByteMeter(onProgress);
	scope.fetch = async (input, init) => {
		const response = await call(input, init);
		return isModelAssetUrl(requestUrl(input), prefix)
			? meter.track(response)
			: response;
	};
	try {
		return await run();
	} finally {
		scope.fetch = original;
	}
}
