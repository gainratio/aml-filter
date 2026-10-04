/**
 * Which `requestfailed` reports the live smoke may ignore. Kept free of
 * Playwright so a Vitest contract can pin it
 * (src/__tests__/liveSmokeRequestFailures.contract.test.ts).
 *
 * Chromium reports `net::ERR_ABORTED` for a request the page cancelled AFTER the
 * whole response had arrived (the consumer closes a finished stream before the
 * network service records completion). The app did not abort anything, and the
 * smoke's own journey shows it: the sync that issued `/bundle/origin/latest`
 * carried on to fetch the manifest that pointer names. Failing a deploy on that
 * report rolled production back on 2026-10-04.
 *
 * The excuse is narrow on purpose. It needs ALL of: the abort error, a 2xx status,
 * and a recorded end of the response body. A request with no response, an
 * unfinished body, a non-2xx status, or any other error text still fails the smoke.
 */

/** What Playwright knows about a failed request, reduced to plain values. */
export interface FailedRequestFacts {
	readonly errorText: string;
	/** HTTP status of the response, or `null` when none arrived. */
	readonly status: number | null;
	/** Playwright's `timing().responseEnd`: -1 (or 0) until the body finished. */
	readonly responseEnd: number;
}

const ABORT_AFTER_COMPLETE = "net::ERR_ABORTED";

/** True when the browser cancelled a request whose response had already completed. */
export function isCompletedThenCancelled(facts: FailedRequestFacts): boolean {
	return (
		facts.errorText === ABORT_AFTER_COMPLETE &&
		facts.status !== null &&
		facts.status >= 200 &&
		facts.status < 300 &&
		facts.responseEnd > 0
	);
}
