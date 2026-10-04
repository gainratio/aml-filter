/**
 * Which browser engines the live smoke runs in. Kept free of Playwright so a
 * Vitest contract can pin it (src/__tests__/liveSmokeBrowsers.contract.test.ts).
 *
 * The default is Chromium only: the Dagger post-deploy smoke installs only
 * Chromium and passes no selection. Firefox and WebKit are opt-in via
 * LIVE_SMOKE_BROWSERS=chromium,firefox,webkit (scripts/smoke-local.sh sets it).
 */

export type LiveSmokeBrowser = "chromium" | "firefox" | "webkit";

const KNOWN: readonly LiveSmokeBrowser[] = ["chromium", "firefox", "webkit"];

function isKnown(name: string): name is LiveSmokeBrowser {
	return (KNOWN as readonly string[]).includes(name);
}

/** Parse LIVE_SMOKE_BROWSERS; unset/empty means Chromium, an unknown name throws. */
export function liveSmokeBrowsers(
	raw: string | undefined,
): readonly LiveSmokeBrowser[] {
	if (raw === undefined || raw === "") {
		return ["chromium"];
	}
	const names = [...new Set(raw.split(",").map((name) => name.trim()))];
	const unknown = names.filter((name) => !isKnown(name));
	if (unknown.length > 0) {
		throw new Error(
			`LIVE_SMOKE_BROWSERS: unknown browser(s) ${JSON.stringify(unknown)}; use chromium, firefox, webkit`,
		);
	}
	return names.filter(isKnown);
}
