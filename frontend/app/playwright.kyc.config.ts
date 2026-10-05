import { defineConfig, devices } from "@playwright/test";

/**
 * e2e-kyc — the LOCAL-FIRST KYC workstation journey, proven END-TO-END in a
 * real headless Chromium against the MINIFIED production build with ZERO
 * application backend: the watchlists are the committed signed BUNDLE
 * (app/public/bundle/origin: signed `latest` → content-hashed `manifest` →
 * `chunk/` CAS) verified against the pinned key, and KYC records live in
 * SQLite-WASM persisted to OPFS via the DB Worker.
 *
 * ONE Playwright-managed webServer: `vite preview` over a freshly built dist/.
 * The signed bundle + pinned pubkey are static public/ assets served same-origin.
 * The build sets no VITE_BUNDLE_BASE_URL, so the runtime defaults to /bundle/origin.
 *
 * `http://localhost` is a secure context — REQUIRED for OPFS (the sahpool
 * database) and WebCrypto verification. A LAN IP or host.docker.internal is NOT
 * a secure context and does not count as validation (CLAUDE.md
 * browser-validation mandate).
 */
const SPA_PORT = Number(process.env.E2E_KYC_SPA_PORT ?? 4178);

export default defineConfig({
	testDir: "tests/e2e-kyc",
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	// One-time ~23 MB MiniLM compile in-tab varies on shared CI runners; retry to
	// absorb that variance. 0 retries locally to surface real flakes.
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
			// Minified SPA (bundling the committed signed catalog + per-list dirs +
			// pinned pubkey as static public/ assets). The model-load ceiling is bounded so a
			// blocked weights path fails loudly in seconds (same as the C1 config).
			// serve-preview holds the port through the build (see the script header).
			command: `node scripts/serve-preview.mjs --port ${SPA_PORT}`,
			url: `http://localhost:${SPA_PORT}/`,
			reuseExistingServer: false,
			timeout: 240_000,
			// 120s production ceiling — full headroom for a cold in-tab model compile
			// on a slow CI runner (45s was marginal and flaked).
			env: {
				VITE_MODEL_LOAD_IDLE_TIMEOUT_MS: "120000",
				// Rotation: verify the committed demo bundle against the throwaway demo
				// key, not the prod pin. See vite.config demoPubkeyOverrideForE2E.
				AMLFILTER_E2E_DEMO_PUBKEY: "1",
			},
		},
	],
});
