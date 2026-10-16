import { EventEmitter } from "node:events";
import type { Request } from "@playwright/test";
import { describe, expect, it } from "vitest";
import {
	type RequestOutcomes,
	type WatchedPage,
	watchFailedRequests,
} from "../../tests/e2e-live/requestWatch";

// Guard for the live smoke's failed-request watch (tests/e2e-live/requestWatch.ts,
// which watchConsole in liveSmoke.ts delegates to), driven with
// the exact event order of a hole northstar found in #214: two pointer fetches
// overlap, the app's (P0) completes and the app requests P0's manifest (M0),
// while the other (Pa) stalls after its 200 `br` headers and is later aborted.
// M0 must not vouch for Pa, so the smoke must report Pa.
//
// Playwright routing cannot produce this on a real page: `route.fulfill` always
// sends the whole body with a matching Content-Length, and a URL override makes
// Playwright fetch the whole body itself. So the real watch is fed the events a
// browser would emit, through a minimal Page/Request double.

const ORIGIN = "https://aml-filter.com";
const POINTER = `${ORIGIN}/bundle/origin/latest`;
const MANIFEST = `${ORIGIN}/bundle/origin/manifest/0ccec754`;
const MAIN_FRAME = {};

interface FakeResponse {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
}

function fakeRequest(
	url: string,
	failure?: { readonly errorText: string; readonly response: FakeResponse },
): Request {
	const response = failure?.response;
	const double = {
		url: () => url,
		isNavigationRequest: () => false,
		frame: () => MAIN_FRAME,
		failure: () => (failure ? { errorText: failure.errorText } : null),
		response: async () =>
			response
				? { status: () => response.status, headers: () => response.headers }
				: null,
		sizes: async () => ({ responseBodySize: 0 }),
	};
	return double as unknown as Request;
}

function fakePage(): {
	page: WatchedPage;
	emit: (event: string, arg: unknown) => void;
} {
	const events = new EventEmitter();
	const double = {
		on: (event: string, listener: (arg: unknown) => void) =>
			events.on(event, listener),
		url: () => `${ORIGIN}/screen`,
		mainFrame: () => MAIN_FRAME,
	};
	return {
		page: double as unknown as WatchedPage,
		emit: (event, arg) => events.emit(event, arg),
	};
}

const STALLED_BR: FakeResponse = {
	status: 200,
	headers: { "content-encoding": "br", "content-type": "application/json" },
};

describe("live smoke watch: overlapping pointer fetches", () => {
	it("reports a stalled pointer that overlapped another fetch, even though a manifest followed", async () => {
		const { page, emit } = fakePage();
		const watch: RequestOutcomes = { problems: [], excused: [] };
		const settled = watchFailedRequests(page, watch);
		const p0 = fakeRequest(POINTER);
		const pa = fakeRequest(POINTER, {
			errorText: "net::ERR_ABORTED",
			response: STALLED_BR,
		});
		emit("request", p0);
		emit("request", pa);
		emit("request", fakeRequest(MANIFEST));
		emit("requestfinished", p0);
		emit("requestfailed", pa);
		await settled();
		expect(watch.problems).toEqual([
			`requestfailed: ${POINTER} (net::ERR_ABORTED)`,
		]);
		expect(watch.excused).toEqual([]);
	});

	it("still excuses a lone pointer whose manifest followed (the production artifact)", async () => {
		const { page, emit } = fakePage();
		const watch: RequestOutcomes = { problems: [], excused: [] };
		const settled = watchFailedRequests(page, watch);
		const p0 = fakeRequest(POINTER, {
			errorText: "net::ERR_ABORTED",
			response: STALLED_BR,
		});
		emit("request", p0);
		emit("requestfailed", p0);
		emit("request", fakeRequest(MANIFEST));
		await settled();
		expect(watch.problems).toEqual([]);
		expect(watch.excused).toEqual([
			`${POINTER} (net::ERR_ABORTED): 200 br, manifest requested next`,
		]);
	});
});
