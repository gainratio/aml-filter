import { describe, expect, it } from "vitest";
import { liveSmokeBrowsers } from "../../tests/e2e-live/browsers";

// The Dagger post-deploy smoke runs `playwright test -c playwright.live.config.ts`
// with no browser selection and installs only Chromium. The default must stay
// Chromium-only or every production deploy would try to launch a browser the
// container does not have. Firefox and WebKit are opt-in for local rehearsal.

describe("live smoke browser selection", () => {
	it.each([undefined, ""])("defaults to Chromium only (%s)", (raw) => {
		expect(liveSmokeBrowsers(raw)).toEqual(["chromium"]);
	});

	it("selects all three engines in the order given", () => {
		expect(liveSmokeBrowsers("webkit,chromium,firefox")).toEqual([
			"webkit",
			"chromium",
			"firefox",
		]);
	});

	it("trims spaces and drops duplicates", () => {
		expect(liveSmokeBrowsers(" firefox , firefox,webkit ")).toEqual([
			"firefox",
			"webkit",
		]);
	});

	it.each(["chrome", "safari", "firefox,edge", ","])(
		"refuses %s instead of silently running fewer browsers",
		(raw) => {
			expect(() => liveSmokeBrowsers(raw)).toThrow(/LIVE_SMOKE_BROWSERS/);
		},
	);
});
