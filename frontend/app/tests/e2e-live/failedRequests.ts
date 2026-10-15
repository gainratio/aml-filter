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
 * neither proof above can ever hold there — while Chromium keeps reporting the
 * worker's fully read pointer as `net::ERR_ABORTED` (3 of 3 @fresh runs,
 * 2026-10-15). For a content-encoded 2xx pointer the app is the proof: it
 * verifies the signed pointer fail-closed (a truncated body is an
 * IntegrityError, never served from cache), and the smoke separately requires
 * the whole journey to succeed.
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
}

const POINTER_PATH = "/bundle/origin/latest";
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

/** A compressed body Chromium cannot measure: no length to compare against. */
function unmeasurableEncodedBody(facts: FailedRequestFacts): boolean {
	return facts.contentEncoding !== null && facts.contentEncoding !== "identity";
}

function completedBeforeAbort(facts: FailedRequestFacts): boolean {
	return (
		isSuccess(facts.status) &&
		(bodyArrivedWhole(facts) || unmeasurableEncodedBody(facts))
	);
}

/** True only for the pointer request aborted after a whole (or, compressed,
 * app-verified) 2xx body, or abandoned by a later page navigation. */
export function isExcusedFailedRequest(facts: FailedRequestFacts): boolean {
	return (
		isPointer(facts.url) &&
		facts.errorText === ERR_ABORTED &&
		(facts.abandonedByNavigation || completedBeforeAbort(facts))
	);
}
