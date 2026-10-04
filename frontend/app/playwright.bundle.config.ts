import { defineConfig, devices } from "@playwright/test";

/**
 * bundle e2e: the SIGNED, content-addressed BUNDLE delta-sync boot path, proven
 * END-TO-END in a real headless Chromium over the MINIFIED production build.
 *
 * Unlike the C1/KYC lanes (which take the same-origin `watchlist/` JSON path
 * with NO VITE_BUNDLE_BASE_URL), this lane sets VITE_BUNDLE_BASE_URL to the
 * committed bundle origin served same-origin at `/bundle/origin` (the
 * `app/public/bundle/origin/{latest,manifest,chunk}` CAS tree bundled into
 * dist/). The engine therefore delta-syncs + verifies the signed `/latest`
 * pointer (cache:no-store), content-verifies the manifest + every chunk + every
 * reassembled file against the pinned same-origin `public.key`, atomically
 * promotes into OPFS, and screens from the materialized lists.
 *
 * `http://localhost` is a secure context — REQUIRED for OPFS (the bundle's
 * durable CacheStore) and WebCrypto Ed25519 verification. A LAN IP or
 * host.docker.internal is NOT a secure context and does not count as validation
 * (CLAUDE.md browser-validation mandate); host Playwright on localhost is the
 * runner, NOT the Docker browser-MCP.
 */
const SPA_PORT = Number(process.env.E2E_BUNDLE_SPA_PORT ?? 4176);

export default defineConfig({
	testDir: "tests/e2e-bundle",
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	// The ~23 MB MiniLM compile in-tab is a one-time cold cost that varies on
	// shared CI runners; retry to absorb that variance. 0 retries locally to
	// surface real flakes.
	retries: process.env.CI ? 2 : 0,
	workers: 1,
	reporter: [["list"]],
	timeout: 240_000,
	expect: { timeout: 30_000 },
	use: {
		baseURL: `http://localhost:${SPA_PORT}`,
		headless: true,
		actionTimeout: 30_000,
		navigationTimeout: 30_000,
		trace: "retain-on-failure",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: [
		{
			// Build the minified SPA with the bundle path ENABLED (the committed
			// signed bundle origin is bundled into dist/ as static public/ assets and
			// served same-origin at /bundle/origin), then preview it.
			// serve-preview holds the port through the build (see the script header).
			command: `node scripts/serve-preview.mjs --port ${SPA_PORT}`,
			url: `http://localhost:${SPA_PORT}/screen`,
			reuseExistingServer: false,
			timeout: 240_000,
			env: {
				// THE switch: take the signed-bundle delta-sync path, not JSON.
				VITE_BUNDLE_BASE_URL: "/bundle/origin",
				// The model-load SILENCE window for this lane. Production is 90s; this
				// is lower so `boot-ceiling.spec.ts` can put the boot ceiling below it
				// (a backstop that fires before a tighter bound is not a backstop).
				// Still ~100x the 359-419 ms compile gap measured on this lane, where
				// the model is served same-origin out of dist/ over localhost.
				VITE_MODEL_LOAD_IDLE_TIMEOUT_MS: "45000",
				// The overall boot ceiling, lowered from its 900s production value so
				// `boot-ceiling.spec.ts` can actually WATCH it fire. That spec holds a
				// sync in the slow-but-moving state — one `sync-progress` tick every
				// fake-25s, which keeps re-arming the 30s no-progress watchdog — until
				// the ceiling expires. EVERY TICK COSTS A CHUNK, and that is what sets
				// this number: /screen's cold boot is scoped to OFAC SDN, so it fetches
				// 4 chunks (catalog + three ofac files), not the fixture's full 13. The
				// ceiling therefore has to be reachable in 3 ticks with one chunk still
				// held back, so the sync can never actually finish and let the boot
				// proceed. 3 x 25s = 75s. The PRODUCTION value is pinned by unit tests
				// instead (runtime.test.ts, "cannot fire before a healthy slow-link
				// cold download has finished").
				VITE_BOOT_TIMEOUT_MS: "75000",
				// No pubkey env here on purpose: the local preview server pairs the
				// committed demo bundle with the demo verify key by default
				// (vite.config localDemoPubkeyPin), the way a cold clone does.
			},
		},
	],
});
