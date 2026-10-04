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
}

const POINTER_PATH = "/bundle/origin/latest";
const ABORT_AFTER_COMPLETE = "net::ERR_ABORTED";

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

/** True only for the pointer request cancelled after a provably whole 2xx body. */
export function isExcusedFailedRequest(facts: FailedRequestFacts): boolean {
	return (
		isPointer(facts.url) &&
		facts.errorText === ABORT_AFTER_COMPLETE &&
		isSuccess(facts.status) &&
		bodyArrivedWhole(facts)
	);
}
