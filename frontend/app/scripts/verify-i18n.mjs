#!/usr/bin/env node
/**
 * i18n live-drive — REAL browser (headless Chromium via Playwright) against the
 * production build. Proves the offline bundled catalogs and the mounted
 * <I18nextProvider> actually render translated screens — not just that the unit
 * parity/component specs pass. It drives the pre-boot Landing (`/`), which
 * renders every visitor's first paint with NO engine, NO watchlist bundle, and
 * NO OPFS — so it is a fast, self-contained gate.
 *
 * Self-contained: this script spawns `vite preview` against the already-built
 * `dist/` (the gate's `build` step runs first), polls it, drives it, and tears it
 * down. It is wired into the canonical `gate` (frontend/package.json) so it runs
 * both locally and in CI from the exact same command — no gate/CI drift.
 *
 * Ported from AlmaMesh + edge-reco's scripts/verify-i18n.mjs, adapted to
 * AML-Filter's single (English) baseline, its namespaces, and the Landing +
 * shared chrome (nav / footer) that render before any engine boots.
 *
 * The deeper per-page proof (the /screen screening UI and the KYC workstation
 * pages, both behind engine boot / OPFS) is already guarded by the C1 + KYC
 * Playwright lanes, which assert the real English copy and so fail loudly on a
 * raw-key leak. This drive covers the Landing + shared chrome those lanes skip.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "@playwright/test";

async function freePort() {
	if (process.env.VERIFY_I18N_PORT) {
		return Number(process.env.VERIFY_I18N_PORT);
	}
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	await new Promise((resolve) => server.close(resolve));
	if (!port) throw new Error("could not reserve a preview port");
	return port;
}

// Known translated copy that MUST render on the Landing — the shared nav + footer
// chrome (common namespace) plus headline Landing copy (landing namespace). Each
// is the exact en catalog VALUE, so seeing it on screen proves t() resolved the
// key rather than leaking it.
const CASES = [
	{
		lang: "en",
		strings: [
			// common namespace — the public footer.
			"AML-Filter searches public sanctions data entirely in this browser tab",
			// landing namespace — headline marketing copy (exact en/landing.json
			// values: hero.title via <Trans> + hero.ctaPrimary).
			"Sanctions screening that runs",
			"entirely in your browser",
			"Screen a name now",
		],
	},
];

// If any of these dotted key fragments reach the screen, i18n silently failed and
// leaked a raw key instead of copy. Covers the namespaces that render on `/`.
const RAW_KEY_FRAGMENTS = [
	"nav.brand",
	"nav.screen",
	"layoutFooter",
	"demoFooter.",
	"hero.title",
	"hero.eyebrow",
	"hero.ctaprimary",
	"metrics.title",
	"whys.",
	"howitworks.",
	"workstation.cta",
	"common:",
	"landing:",
];

let failed = false;
function fail(message) {
	failed = true;
	console.error(`❌ ${message}`);
}

/** Start `vite preview` on the built dist and resolve once it accepts requests. */
async function startPreview() {
	const port = await freePort();
	const baseUrl = `http://localhost:${port}`;
	const child = spawn(
		"pnpm",
		["exec", "vite", "preview", "--port", String(port), "--strictPort"],
		{ stdio: ["ignore", "ignore", "inherit"] },
	);
	for (let i = 0; i < 60; i++) {
		if (child.exitCode !== null) {
			throw new Error("vite preview exited before it was ready");
		}
		try {
			const res = await fetch(baseUrl);
			if (res.ok) return { child, baseUrl };
		} catch {
			// not up yet
		}
		await sleep(1000);
	}
	child.kill("SIGTERM");
	throw new Error("vite preview did not become ready");
}

const { child: preview, baseUrl } = await startPreview();
const browser = await chromium.launch();
try {
	for (const { lang, strings } of CASES) {
		const context = await browser.newContext();
		const page = await context.newPage();
		const consoleErrors = [];
		page.on("console", (message) => {
			if (message.type() === "error") consoleErrors.push(message.text());
		});
		page.on("pageerror", (error) => consoleErrors.push(String(error)));

		await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
		await page
			.waitForSelector(
				"text=AML-Filter searches public sanctions data entirely in this browser tab",
				{
					timeout: 15000,
				},
			)
			.catch(() => {});

		const bodyText = await page.evaluate(() => document.body.innerText);
		const htmlLang = await page.evaluate(() => document.documentElement.lang);
		// innerText reflects CSS text-transform, so match case-insensitively — we
		// assert the copy is on screen, not its casing.
		const haystack = bodyText.toLowerCase();

		for (const string of strings) {
			if (!haystack.includes(string.toLowerCase())) {
				fail(`[${lang}] expected translated copy "${string}" — not on screen`);
			}
		}
		for (const fragment of RAW_KEY_FRAGMENTS) {
			if (haystack.includes(fragment.toLowerCase())) {
				fail(`[${lang}] raw i18n key fragment "${fragment}" is visible`);
			}
		}
		if (htmlLang !== lang) {
			fail(`[${lang}] expected <html lang>="${lang}" but got "${htmlLang}"`);
		}
		if (consoleErrors.length) {
			// Ignore benign preview noise unrelated to i18n: service-worker /
			// manifest / favicon / external-asset loads. A real i18n failure surfaces
			// as a missing-key warning or a render throw, not one of these.
			const real = consoleErrors.filter(
				(error) =>
					!/service worker|workbox|manifest|favicon|failed to load resource/i.test(
						error,
					),
			);
			if (real.length) {
				fail(`[${lang}] console errors: ${real.join(" | ")}`);
			}
		}

		if (!failed) {
			console.log(
				`✅ [${lang}] Landing renders translated copy  <html lang>=${htmlLang}  clean console`,
			);
		}
		await context.close();
	}
} finally {
	await browser.close();
	preview.kill("SIGTERM");
}

if (failed) {
	console.error("\ni18n live-drive FAILED");
	process.exit(1);
}
console.log(
	"\n✅ i18n live-drive PASSED — offline bundled catalogs render translated screens (en)",
);
