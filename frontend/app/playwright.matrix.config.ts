import { defineConfig, devices } from "@playwright/test";

/**
 * Browser matrix: the /screen journey in every engine we support, over the
 * minified production build and the COMMITTED signed demo bundle + pinned key
 * (same server as C1). Part of `pnpm gate`. Run it alone with
 * `pnpm test:e2e:matrix`.
 *
 *   firefox         boot + one screening, plus boot with persist() forced to
 *                   never settle (Firefox's permission prompt hung boot forever)
 *   chromium        the same two specs, so a persist regression is caught in
 *                   the engine CI runs fastest
 *   webkit          boot + one screening, plus the index storage mode the app
 *                   reports (persistent OPFS, not the memory fallback)
 *   msedge          smoke; skipped with a reason when Edge is not installed
 *   chromium-lowend 4x CDP CPU throttle + a 360x640 viewport, boot + one
 *                   screening inside a budget that scales with worker count
 *
 * Port is env-overridable (E2E_MATRIX_SPA_PORT) so parallel worktrees do not
 * reuse each other's preview server.
 */
const SPA_PORT = Number(process.env.E2E_MATRIX_SPA_PORT ?? 4184);
const WORKERS = Number(process.env.E2E_MATRIX_WORKERS ?? 1);

export default defineConfig({
	testDir: "tests/e2e-matrix",
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	// Same rationale as C1: the cold model compile varies on shared runners.
	retries: process.env.CI ? 2 : 0,
	workers: WORKERS,
	reporter: [["list"]],
	timeout: 300_000,
	expect: { timeout: 30_000 },
	use: {
		baseURL: `http://localhost:${SPA_PORT}`,
		headless: true,
		actionTimeout: 30_000,
		navigationTimeout: 30_000,
		trace: "retain-on-failure",
	},
	projects: [
		{
			name: "firefox",
			use: { ...devices["Desktop Firefox"] },
			testMatch: ["journey.spec.ts", "persist-hang.spec.ts"],
		},
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
			testMatch: ["journey.spec.ts", "persist-hang.spec.ts"],
		},
		{
			name: "webkit",
			use: { ...devices["Desktop Safari"] },
			testMatch: ["journey.spec.ts", "webkit-storage.spec.ts"],
		},
		{
			name: "msedge",
			use: { ...devices["Desktop Edge"], channel: "msedge" },
			testMatch: ["edge-smoke.spec.ts"],
		},
		{
			name: "chromium-lowend",
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 360, height: 640 },
			},
			testMatch: ["low-end.spec.ts"],
		},
	],
	webServer: [
		{
			command: `pnpm build && pnpm exec vite preview --port ${SPA_PORT} --strictPort`,
			url: `http://localhost:${SPA_PORT}/screen`,
			reuseExistingServer: !process.env.CI,
			timeout: 240_000,
			// Same silence bound as C1 so the throttled lane is not cut off by the
			// model-load idle timer.
			env: { VITE_MODEL_LOAD_IDLE_TIMEOUT_MS: "120000" },
		},
	],
});
