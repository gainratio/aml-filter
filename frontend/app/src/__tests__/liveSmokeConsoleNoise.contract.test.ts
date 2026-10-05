import { describe, expect, it } from "vitest";
import {
	type ConsoleErrorFacts,
	isExcusedConsoleError,
} from "../../tests/e2e-live/consoleNoise";

// The live smoke fails on any console error, and a failed smoke rolls
// production back. On 2026-10-04 the local WebKit @returning pass failed with
// 7-19x `Cannot load blob:http://127.0.0.1:<port>/<uuid> due to access control
// checks.`, all inside ONE `page.goto("/customers")`, before the new document's
// DOMContentLoaded.
//
// Root cause (reproduced in a 20-line WebKit page): the edgeproc Worker reads
// cached chunks with OPFS `getFile().arrayBuffer()` (@gainratio/browser
// OpfsCacheStore). In WebKit an OPFS File is blob-backed; when a hard
// navigation tears the document down mid-read, WebKit cancels the read and
// logs that line. The app creates no blob: URL and the CSP is not involved.
// Chromium and Firefox stay silent.
//
// Contract: the excuse covers exactly that WebKit line, for a same-origin
// blob UUID, and ONLY while a main-frame navigation is in flight. The same
// line on a settled page, a cross-origin blob, any CSP refusal, or any other
// blob wording still fails the smoke.

const ORIGIN = "http://127.0.0.1:5773";
const TEARDOWN_TEXT = `Cannot load blob:${ORIGIN}/6f41cd9f-4d12-4698-bbcc-abdff40e96fb due to access control checks.`;

const teardownRead: ConsoleErrorFacts = {
	text: TEARDOWN_TEXT,
	pageOrigin: ORIGIN,
	duringNavigation: true,
};

describe("WebKit's cancelled OPFS read during a navigation", () => {
	it("is excused while the main frame is navigating", () => {
		expect(isExcusedConsoleError(teardownRead)).toBe(true);
	});

	it("is excused on the production origin too", () => {
		const origin = "https://aml-filter.com";
		expect(
			isExcusedConsoleError({
				text: `Cannot load blob:${origin}/15d04310-bfe7-4b5e-a8bd-7d9400547309 due to access control checks.`,
				pageOrigin: origin,
				duringNavigation: true,
			}),
		).toBe(true);
	});
});

describe("everything else still fails the smoke", () => {
	it("the same line on a settled page (no navigation in flight)", () => {
		expect(
			isExcusedConsoleError({ ...teardownRead, duringNavigation: false }),
		).toBe(false);
	});

	it("a blob from another origin", () => {
		expect(
			isExcusedConsoleError({
				...teardownRead,
				pageOrigin: "http://127.0.0.1:5774",
			}),
		).toBe(false);
	});

	it("an opaque page origin", () => {
		expect(isExcusedConsoleError({ ...teardownRead, pageOrigin: "null" })).toBe(
			false,
		);
	});

	it.each([
		// the CSP refusal of the transformers.js blob: loader import
		`Refused to load blob:${ORIGIN}/6f41cd9f-4d12-4698-bbcc-abdff40e96fb because it does not appear in the script-src directive of the Content Security Policy.`,
		"Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.",
		`Cannot load blob:${ORIGIN}/not-a-uuid due to access control checks.`,
		`Cannot load blob:${ORIGIN}/6f41cd9f-4d12-4698-bbcc-abdff40e96fb/x due to access control checks.`,
		`Cannot load ${ORIGIN}/assets/main.js due to access control checks.`,
		`prefix Cannot load blob:${ORIGIN}/6f41cd9f-4d12-4698-bbcc-abdff40e96fb due to access control checks.`,
		`Cannot load blob:${ORIGIN}/6f41cd9f-4d12-4698-bbcc-abdff40e96fb due to access control checks. and more`,
		"Unhandled Promise Rejection: NotReadableError: The I/O read operation failed.",
	])("%s", (text) => {
		expect(isExcusedConsoleError({ ...teardownRead, text })).toBe(false);
	});
});
