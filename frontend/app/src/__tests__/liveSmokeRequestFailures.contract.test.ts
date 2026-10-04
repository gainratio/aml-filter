import { describe, expect, it } from "vitest";
import {
	type FailedRequestFacts,
	isCompletedThenCancelled,
} from "../../tests/e2e-live/failedRequests";

// The post-deploy live smoke fails on any failed same-origin request. On
// 2026-10-04 both the Deploy and the Publish run failed it with
// `requestfailed: /bundle/origin/latest (net::ERR_ABORTED)` and rolled production
// back. The app aborted nothing: the browser had already received the whole
// 200 response (responseEnd set, the sync went on to fetch the manifest it names)
// and then cancelled the finished stream. The same report shows up on the
// previous release, 3 runs in 16 on a loaded machine against 8 in 16 on the new one.
//
// The smoke must keep failing on a request that did NOT complete. This pins both
// sides: the finished-then-cancelled report is ignored; every real failure is not.

const completed: FailedRequestFacts = {
	errorText: "net::ERR_ABORTED",
	status: 200,
	responseEnd: 29.7,
};

describe("a request the browser cancelled after a complete response", () => {
	it("is not a failed request", () => {
		expect(isCompletedThenCancelled(completed)).toBe(true);
	});

	it.each([
		["a 204", 204],
		["a 299", 299],
	])("%s counts as complete", (_label, status) => {
		expect(isCompletedThenCancelled({ ...completed, status })).toBe(true);
	});
});

describe("a request that did not complete is still a failure", () => {
	it("aborted before any response arrived", () => {
		expect(isCompletedThenCancelled({ ...completed, status: null })).toBe(
			false,
		);
	});

	it("aborted with headers but before the body finished", () => {
		expect(isCompletedThenCancelled({ ...completed, responseEnd: -1 })).toBe(
			false,
		);
		expect(isCompletedThenCancelled({ ...completed, responseEnd: 0 })).toBe(
			false,
		);
	});

	it.each([
		["a 404", 404],
		["a 500", 500],
		["a 199", 199],
		["a 300", 300],
	])("%s is never excused", (_label, status) => {
		expect(isCompletedThenCancelled({ ...completed, status })).toBe(false);
	});

	it.each([
		"net::ERR_CONNECTION_RESET",
		"net::ERR_FAILED",
		"net::ERR_INTERNET_DISCONNECTED",
		"net::ERR_BLOCKED_BY_CLIENT",
	])("%s is never excused, even after a 200", (errorText) => {
		expect(isCompletedThenCancelled({ ...completed, errorText })).toBe(false);
	});
});
