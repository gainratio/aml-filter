import { defineConfig, devices } from "@playwright/test";

/**
 * Phone-class memory guard over the production build with the REAL signed
 * bundle mirrored from aml-filter.com (`build:live`). The demo bundle is 64 KB, so
 * every other lane boots with almost nothing resident and cannot see an iPhone
 * out-of-memory. This lane needs the network once, to mirror the bundle, so it is
 * NOT part of `pnpm gate`; run it with `pnpm test:e2e:memory`.
 *
 * Chromium with an iPhone user agent selects the phone scope (OFAC SDN only),
 * the same list set a real iPhone boots. It asserts a deterministic boot ORDER
 * and a WebAssembly-memory ceiling; it does NOT claim to measure Safari.
 */
const PORT = Number(process.env.E2E_MEMORY_PORT ?? 4179);
const CDP_PORT = Number(process.env.E2E_MEMORY_CDP_PORT ?? 9341);
const iphone = { ...devices["iPhone 13"], defaultBrowserType: undefined };

export default defineConfig({
	testDir: "./tests/e2e-memory",
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: 0,
	reporter: "line",
	use: {
		baseURL: `http://localhost:${PORT}`,
		...iphone,
		browserName: "chromium",
		launchOptions: { args: [`--remote-debugging-port=${CDP_PORT}`] },
	},
	webServer: {
		command: `pnpm build:live && pnpm exec vite preview --mode live --port ${PORT} --strictPort`,
		url: `http://localhost:${PORT}/screen`,
		reuseExistingServer: !process.env.CI,
		timeout: 600_000,
	},
});
