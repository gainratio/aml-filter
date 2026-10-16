import { describe, expect, it } from "vitest";
import {
	excuseEvidence,
	type FailedRequestFacts,
	isExcusedFailedRequest,
	parseContentLength,
	RequestLedger,
} from "../../tests/e2e-live/failedRequests";

// The post-deploy live smoke fails on any failed same-origin request, and a
// failed smoke rolls production back. On 2026-10-04 both the Deploy and the
// Publish run failed it with `requestfailed: /bundle/origin/latest
// (net::ERR_ABORTED)`: the browser had already received the whole 200 pointer
// and then cancelled the finished stream.
//
// The first excuse for that (any URL, `responseEnd > 0`) was too wide:
// `responseEnd` is set when the response STARTS ending, which does not prove
// the body arrived, and it applied to every asset. A truncated chunk or script
// could slip through and a broken deploy would stay live.
//
// Contract now: the ONLY excusable failure is the signed pointer request, and
// only with proof the body arrived whole: Playwright saw `requestfinished`, or
// the received body is exactly as long as Content-Length says.
//
// The one other case (2026-10-15): the smoke itself navigates away from /screen
// (to /settings) while the boot is still fetching the pointer, and Chromium
// cancels the departing document's request with net::ERR_ABORTED before any
// body arrives. That aborted Publish runs on 10-12, 10-13, 10-14 (twice) and
// 10-15 and rolled production back. Reproduced by navigating the instant the
// pointer is requested. A pointer request a later main-frame navigation
// abandoned is not a broken asset; every other URL still fails.
//
// And the 2026-10-04 case never stopped: Chromium still reports the WORKER's
// fully read pointer as net::ERR_ABORTED on most page loads (no navigation, no
// worker termination; 3 of 3 @fresh runs against production). An in-worker probe
// on the app's own reader showed every such abort land in the same millisecond
// the app read the whole 257-byte signed pointer to end-of-stream. The proofs
// above cannot see it: production serves the pointer brotli-compressed with no
// Content-Length, and Playwright reports body size 0 and "No data found". So a
// content-encoded 2xx pointer is excused only when the app requested the
// manifest for THAT fetch (it was the only pointer waiting when the manifest
// was requested): the app fetches `/manifest/<hash>` only after the pointer
// parsed and its Ed25519 signature verified.

const POINTER = "http://127.0.0.1:5273/bundle/origin/latest";

const finishedPointer: FailedRequestFacts = {
	url: POINTER,
	errorText: "net::ERR_ABORTED",
	status: 200,
	finished: true,
	receivedBodyBytes: null,
	contentLength: null,
	contentEncoding: null,
	abandonedByNavigation: false,
	manifestFollowed: false,
};

const wholeBodyPointer: FailedRequestFacts = {
	...finishedPointer,
	finished: false,
	receivedBodyBytes: 412,
	contentLength: 412,
};

describe("the pointer request, cancelled after a provably complete body", () => {
	it("is excused when requestfinished fired", () => {
		expect(isExcusedFailedRequest(finishedPointer)).toBe(true);
	});

	it("is excused when the body length matches Content-Length", () => {
		expect(isExcusedFailedRequest(wholeBodyPointer)).toBe(true);
	});

	it("is excused with a query string on the pointer URL", () => {
		expect(
			isExcusedFailedRequest({ ...finishedPointer, url: `${POINTER}?t=1` }),
		).toBe(true);
	});
});

describe("the pointer request a later page navigation abandoned", () => {
	const abandonedPointer: FailedRequestFacts = {
		url: POINTER,
		errorText: "net::ERR_ABORTED",
		status: null,
		finished: false,
		receivedBodyBytes: null,
		contentLength: null,
		contentEncoding: null,
		abandonedByNavigation: true,
		manifestFollowed: false,
	};

	it("is excused with no response at all", () => {
		expect(isExcusedFailedRequest(abandonedPointer)).toBe(true);
	});

	it.each([
		"net::ERR_CONNECTION_RESET",
		"net::ERR_FAILED",
		"net::ERR_INTERNET_DISCONNECTED",
	])("is NOT excused when it failed with %s", (errorText) => {
		expect(isExcusedFailedRequest({ ...abandonedPointer, errorText })).toBe(
			false,
		);
	});

	it.each([
		"http://127.0.0.1:5273/bundle/origin/manifest/abc.json",
		"http://127.0.0.1:5273/bundle/origin/chunk/def.bin",
		"http://127.0.0.1:5273/assets/index-123.js",
	])("does not excuse %s, abandoned or not", (url) => {
		expect(isExcusedFailedRequest({ ...abandonedPointer, url })).toBe(false);
	});
});

describe("a compressed 2xx pointer response Chromium cannot measure", () => {
	const brotliPointer: FailedRequestFacts = {
		...finishedPointer,
		finished: false,
		receivedBodyBytes: 0,
		contentLength: null,
		contentEncoding: "br",
		manifestFollowed: true,
	};

	it("is excused when the app went on to fetch the manifest", () => {
		expect(isExcusedFailedRequest(brotliPointer)).toBe(true);
	});

	it("is NOT excused when no manifest request followed (app never accepted it)", () => {
		expect(
			isExcusedFailedRequest({ ...brotliPointer, manifestFollowed: false }),
		).toBe(false);
	});

	it.each(["gzip", "zstd", "deflate", "BR", " br "])(
		"is excused for %s too",
		(encoding) => {
			expect(
				isExcusedFailedRequest({ ...brotliPointer, contentEncoding: encoding }),
			).toBe(true);
		},
	);

	it.each(["identity", "Identity", "", "compress", "br, gzip"])(
		"is NOT excused for encoding %j (not on the allowlist)",
		(encoding) => {
			expect(
				isExcusedFailedRequest({ ...brotliPointer, contentEncoding: encoding }),
			).toBe(false);
		},
	);

	it.each([
		["no response", null],
		["a 404", 404],
		["a 500", 500],
	])("is NOT excused with %s", (_label, status) => {
		expect(isExcusedFailedRequest({ ...brotliPointer, status })).toBe(false);
	});

	it("is NOT excused for another error than net::ERR_ABORTED", () => {
		expect(
			isExcusedFailedRequest({
				...brotliPointer,
				errorText: "net::ERR_CONNECTION_RESET",
			}),
		).toBe(false);
	});

	it.each([
		"http://127.0.0.1:5273/bundle/origin/manifest/abc.json",
		"http://127.0.0.1:5273/bundle/origin/chunk/def.bin",
		"http://127.0.0.1:5273/assets/index-123.js",
	])("does not excuse a compressed %s", (url) => {
		expect(isExcusedFailedRequest({ ...brotliPointer, url })).toBe(false);
	});
});

describe("the pointer request without proof of a whole body fails", () => {
	it("no requestfinished and no body sizes", () => {
		expect(
			isExcusedFailedRequest({ ...finishedPointer, finished: false }),
		).toBe(false);
	});

	it("a body shorter than Content-Length", () => {
		expect(
			isExcusedFailedRequest({ ...wholeBodyPointer, receivedBodyBytes: 411 }),
		).toBe(false);
	});

	it("a body size but no Content-Length header", () => {
		expect(
			isExcusedFailedRequest({ ...wholeBodyPointer, contentLength: null }),
		).toBe(false);
	});

	it("no response at all", () => {
		expect(isExcusedFailedRequest({ ...finishedPointer, status: null })).toBe(
			false,
		);
	});

	it.each([
		["a 404", 404],
		["a 500", 500],
		["a 199", 199],
		["a 300", 300],
	])("%s is never excused", (_label, status) => {
		expect(isExcusedFailedRequest({ ...finishedPointer, status })).toBe(false);
	});

	it.each([
		"net::ERR_CONNECTION_RESET",
		"net::ERR_FAILED",
		"net::ERR_INTERNET_DISCONNECTED",
		"net::ERR_BLOCKED_BY_CLIENT",
	])("%s is never excused, even after a whole 200", (errorText) => {
		expect(isExcusedFailedRequest({ ...finishedPointer, errorText })).toBe(
			false,
		);
	});
});

describe("every other request fails the smoke, however complete it looks", () => {
	it.each([
		"http://127.0.0.1:5273/bundle/origin/manifest/abc.json",
		"http://127.0.0.1:5273/bundle/origin/chunk/def.bin",
		"http://127.0.0.1:5273/assets/index-123.js",
		"http://127.0.0.1:5273/bundle/origin/latest.json",
		"http://127.0.0.1:5273/bundle/origin/latest/",
		"http://127.0.0.1:5273/other/bundle/origin/latest",
	])("%s", (url) => {
		expect(isExcusedFailedRequest({ ...finishedPointer, url })).toBe(false);
		expect(isExcusedFailedRequest({ ...wholeBodyPointer, url })).toBe(false);
	});
});

describe("RequestLedger: which documents and bundle requests came first", () => {
	const ORIGIN = "http://127.0.0.1:5273";
	const at = (path: string) => ({ url: `${ORIGIN}${path}` });

	it("a request started before a later navigation was abandoned", () => {
		const ledger = new RequestLedger<object>();
		const pointer = {};
		ledger.note(pointer, at("/bundle/origin/latest").url, false);
		ledger.note({}, `${ORIGIN}/settings`, true);
		expect(ledger.abandoned(pointer)).toBe(true);
	});

	it("a request started after the latest navigation was not", () => {
		const ledger = new RequestLedger<object>();
		ledger.note({}, `${ORIGIN}/screen`, true);
		const pointer = {};
		ledger.note(pointer, at("/bundle/origin/latest").url, false);
		expect(ledger.abandoned(pointer)).toBe(false);
	});

	it("an unknown request is never abandoned", () => {
		const ledger = new RequestLedger<object>();
		ledger.note({}, `${ORIGIN}/screen`, true);
		expect(ledger.abandoned({})).toBe(false);
	});

	it("a lone pointer followed by a manifest was accepted", () => {
		const ledger = new RequestLedger<object>();
		const pointer = {};
		ledger.note(pointer, at("/bundle/origin/latest").url, false);
		ledger.note({}, `${ORIGIN}/assets/index-1.js`, false);
		ledger.note({}, at("/bundle/origin/manifest/ab12").url, false);
		expect(ledger.manifestFollowed(pointer)).toBe(true);
	});

	// REVERSED 2026-10-15 (was: the second pointer counts as accepted). With two
	// pointers in flight, the manifest may be the FIRST one's, so it vouches for
	// neither: otherwise a stalled overlapping fetch is excused by another fetch's
	// manifest (src/__tests__/liveSmokeOverlap.guard.test.ts).
	it("overlapping pointers: one manifest vouches for neither", () => {
		const ledger = new RequestLedger<object>();
		const first = {};
		const second = {};
		ledger.note(first, at("/bundle/origin/latest").url, false);
		ledger.note(second, at("/bundle/origin/latest").url, false);
		ledger.note({}, at("/bundle/origin/manifest/ab12").url, false);
		expect(ledger.manifestFollowed(first)).toBe(false);
		expect(ledger.manifestFollowed(second)).toBe(false);
	});

	it("sequential pointers each get their own manifest", () => {
		const ledger = new RequestLedger<object>();
		const first = {};
		const second = {};
		ledger.note(first, at("/bundle/origin/latest").url, false);
		ledger.note({}, at("/bundle/origin/manifest/ab12").url, false);
		ledger.note(second, at("/bundle/origin/latest").url, false);
		ledger.note({}, at("/bundle/origin/manifest/ab12").url, false);
		expect(ledger.manifestFollowed(first)).toBe(true);
		expect(ledger.manifestFollowed(second)).toBe(true);
	});

	it("a pointer still waiting after an ambiguous manifest blocks the next one", () => {
		const ledger = new RequestLedger<object>();
		ledger.note({}, at("/bundle/origin/latest").url, false);
		ledger.note({}, at("/bundle/origin/latest").url, false);
		ledger.note({}, at("/bundle/origin/manifest/ab12").url, false);
		const third = {};
		ledger.note(third, at("/bundle/origin/latest").url, false);
		ledger.note({}, at("/bundle/origin/manifest/ab12").url, false);
		expect(ledger.manifestFollowed(third)).toBe(false);
	});

	it("a navigation forgets the previous document's waiting pointers", () => {
		const ledger = new RequestLedger<object>();
		ledger.note({}, at("/bundle/origin/latest").url, false);
		ledger.note({}, `${ORIGIN}/settings`, true);
		const pointer = {};
		ledger.note(pointer, at("/bundle/origin/latest").url, false);
		ledger.note({}, at("/bundle/origin/manifest/ab12").url, false);
		expect(ledger.manifestFollowed(pointer)).toBe(true);
	});

	it("a pointer with no later manifest, or only an earlier one, was not", () => {
		const ledger = new RequestLedger<object>();
		ledger.note({}, at("/bundle/origin/manifest/ab12").url, false);
		const pointer = {};
		ledger.note(pointer, at("/bundle/origin/latest").url, false);
		ledger.note({}, at("/bundle/origin/chunk/cd34").url, false);
		expect(ledger.manifestFollowed(pointer)).toBe(false);
		expect(ledger.manifestFollowed({})).toBe(false);
	});

	it("only the exact manifest path counts", () => {
		const ledger = new RequestLedger<object>();
		const pointer = {};
		ledger.note(pointer, at("/bundle/origin/latest").url, false);
		ledger.note({}, at("/other/bundle/origin/manifest/ab12").url, false);
		ledger.note({}, at("/bundle/origin/manifest/").url, false);
		expect(ledger.manifestFollowed(pointer)).toBe(false);
	});
});

describe("the run log names the proof each excuse relied on", () => {
	it.each<[string, Partial<FailedRequestFacts>, string]>([
		[
			"navigation",
			{ abandonedByNavigation: true },
			"abandoned by a later navigation",
		],
		["requestfinished", {}, "requestfinished fired"],
		[
			"accepted compressed body",
			{ finished: false, contentEncoding: "br", manifestFollowed: true },
			"200 br, sole pointer awaiting its manifest",
		],
		[
			"Content-Length",
			{ finished: false, receivedBodyBytes: 412, contentLength: 412 },
			"body 412 B == Content-Length",
		],
	])("%s", (_label, overrides, evidence) => {
		expect(excuseEvidence({ ...finishedPointer, ...overrides })).toBe(evidence);
	});
});

describe("Content-Length parsing", () => {
	it.each([
		["412", 412],
		["0", 0],
	])("%s is %d bytes", (header, bytes) => {
		expect(parseContentLength(header)).toBe(bytes);
	});

	it.each([undefined, "", "-1", "12abc", "1.5", " 12"])(
		"%s is no usable length",
		(header) => {
			expect(parseContentLength(header)).toBeNull();
		},
	);
});
