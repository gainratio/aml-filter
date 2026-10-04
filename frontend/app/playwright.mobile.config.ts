import { defineConfig, devices } from "@playwright/test";

/**
 * Mobile browser smoke gate over the minified production build. WebKit
 * approximates iPhone Safari's browser surface; Chromium uses the Pixel 5
 * Android profile plus a desktop control.
 */
// A default no sibling lane uses: kyc's default was this lane's 4178, so a kyc
// and a mobile run side by side fought over one port (scripts/serve-preview.test.ts).
const SPA_PORT = Number(process.env.E2E_MOBILE_SPA_PORT ?? 4177);

export default defineConfig({
	testDir: "./tests",
	testMatch: "**/mobile-workstation.spec.ts",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: "line",
	use: {
		baseURL: `http://localhost:${SPA_PORT}`,
		trace: "on-first-retry",
	},
	projects: [
		{
			name: "ios-webkit",
			use: { ...devices["iPhone 13"], browserName: "webkit" },
		},
		{
			name: "android-chromium",
			use: { ...devices["Pixel 5"], browserName: "chromium" },
		},
		{
			name: "desktop-control",
			use: { ...devices["Desktop Chrome"], browserName: "chromium" },
		},
	],
	webServer: {
		// serve-preview holds the port through the ~1 min build. The old
		// `pnpm build && vite preview --strictPort` was checked by Playwright before
		// the build but bound only after it, so a sibling lane taking the port in
		// between killed the preview ("webServer was not able to start").
		command: `node scripts/serve-preview.mjs --port ${SPA_PORT}`,
		url: `http://localhost:${SPA_PORT}/screen`,
		// Never reuse: this lane always builds its own tree, so a server already on
		// the port is another worktree's build, and testing it would be a lie.
		reuseExistingServer: false,
		timeout: 240_000,
		// No lane-only env: local preview pairs the committed demo bundle with its
		// demo verify key. The browser still exercises minified production assets.
	},
});
