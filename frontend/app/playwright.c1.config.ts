import { defineConfig, devices } from "@playwright/test";

/**
 * C1 e2e: the headline in-browser screening flow, proven against the REAL
 * MINIFIED production build — the lane the default `playwright.config.ts` never
 * exercises (it runs `vite dev`, which is unminified and so hid the production
 * `Ke(...).call is not a function` model-load crash).
 *
 * ONE webServer: `vite preview` over a freshly built dist/. The signed BUNDLE
 * (app/public/bundle/origin: `latest` + `manifest/<hash>` + `chunk/<hash>`) is a
 * set of plain static assets served same-origin by `vite preview`. The build sets
 * no VITE_BUNDLE_BASE_URL, so the runtime defaults to /bundle/origin (the same
 * path the e2e-bundle lane sets explicitly). The pinned ed25519 verify key is read
 * same-origin from /public.key — which on a local server is the demo key that pairs
 * with the committed demo bundle (vite.config localDemoPubkeyPin), the same key a
 * cold clone gets. Production serves the prod pin against a prod-signed bundle.
 *
 * The spec drives a real headless Chromium: it waits for the full
 * bundle sync → ed25519-verify → ~23 MB model download → screen pipeline, then
 * asserts a real explainable match for the committed sanctioned name and an
 * empty result for a nonsense name. `http://localhost` is a secure context, so
 * OPFS + WebCrypto work with no COOP/COEP.
 */
// Env-overridable like the kyc (E2E_KYC_SPA_PORT) and bundle (E2E_BUNDLE_SPA_PORT)
// lanes, so parallel checkouts/worktrees can run this gate without port clashes.
const SPA_PORT = Number(process.env.E2E_C1_SPA_PORT ?? 4175);

export default defineConfig({
	testDir: "tests/e2e-c1",
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	// The ~23 MB MiniLM compile in-tab is a one-time cold cost that varies widely
	// on shared CI runners; retry to absorb that variance (the logic is proven —
	// it passes locally + on warm runners). 0 retries locally to surface real flakes.
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
			// Build the minified SPA (which bundles the committed signed catalog
			// + per-list dirs + pinned pubkey as static public/ assets), then preview it.
			// serve-preview holds the port through the build (see the script header).
			command: `node scripts/serve-preview.mjs --port ${SPA_PORT}`,
			url: `http://localhost:${SPA_PORT}/screen`,
			reuseExistingServer: false,
			timeout: 240_000,
			// VITE_MODEL_LOAD_IDLE_TIMEOUT_MS bounds the in-tab model warmup by SILENCE
			// (no progress tick), not by elapsed time. Set to the
			// 120s production ceiling so the WARM specs get full headroom for a cold
			// ~23 MB compile on a slow/loaded CI runner (45s was marginal and flaked).
			// The "everything blocked" negative spec still rejects at this ceiling —
			// its coupled MODEL_LOAD_IDLE_TIMEOUT_MS in screen-cold-blocked.spec.ts is kept
			// in sync — so it stays loud, just bounded by 120s instead of 45s.
			// No pubkey env here on purpose: the local preview server pairs the committed
			// demo bundle with the demo verify key by default (vite.config
			// localDemoPubkeyPin), so this lane boots the way a cold clone does.
			env: {
				VITE_MODEL_LOAD_IDLE_TIMEOUT_MS: "120000",
			},
		},
	],
});
