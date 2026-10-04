import { defineConfig, devices } from "@playwright/test";

/**
 * The default `vite dev` lane. Most specs here are exploratory and NOT gated.
 *
 * ONE spec in this lane IS gate-enforced: `tests/score-receipt-browser.spec.ts`,
 * run by `pnpm test:e2e:receipt` (app) which the canonical gate
 * (frontend/package.json) invokes by path. It is the cross-browser proof that
 * backs the `@vitest-environment node` switch in
 * packages/amlfilter-browser/src/engine/scoreReceipt.test.ts — leaving jsdom is
 * only defensible while a real browser proves the same path, so that proof has
 * to execute on every gate run, not merely exist.
 *
 * WHY IT RUNS HERE INSTEAD OF IN A FIFTH LANE OR AN EXISTING ONE:
 *   • It cannot fold into the c1 / kyc / bundle lanes. Those serve a built
 *     `dist/` through `vite preview`, and the spec reaches the unbundled
 *     workspace module over `/@fs/<abs path>` — a DEV-SERVER-only route that
 *     does not exist under preview.
 *   • The mobile lane is the only other `pnpm dev` lane, but its contract is
 *     device-profile smoke across three device profiles; an Ed25519 crypto proof
 *     hosted there would mislead every future reader and misattribute failures.
 *   • This config already owns the spec (testDir `./tests`, and testIgnore
 *     excludes only e2e-c1/e2e-kyc), with the webServer and CI settings it
 *     needs. So the gate adds an invocation, not a fifth config — and its cost
 *     is one `vite dev` boot, with no `pnpm build`, making it the cheapest
 *     browser lane in the gate.
 */
export default defineConfig({
	testDir: "./tests",
	// The C1 suite (tests/e2e-c1) and the DB-backed KYC suite (tests/e2e-kyc) each
	// have their own config + production webServers; they must not run here against
	// the unminified `vite dev` server (the KYC suite also needs a live backend).
	testIgnore: [
		"**/e2e-c1/**",
		"**/e2e-kyc/**",
		"**/e2e-matrix/**",
		"**/e2e-memory/**",
	],
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: "html",
	use: {
		baseURL: "http://localhost:5173",
		trace: "on-first-retry",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
		{
			name: "firefox",
			use: { ...devices["Desktop Firefox"] },
		},
		{
			name: "webkit",
			use: { ...devices["Desktop Safari"] },
		},
	],
	webServer: {
		command: "pnpm dev",
		url: "http://localhost:5173",
		reuseExistingServer: !process.env.CI,
		// No lane-only env on purpose: the local server pairs the committed demo bundle
		// with the demo verify key by default (vite.config localDemoPubkeyPin), so this
		// lane boots exactly the way a `pnpm dev` cold clone does.
	},
});
