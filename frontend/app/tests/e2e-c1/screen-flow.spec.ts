import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { localhostPreviewCsp } from "../../src/dev/previewHeaders";

/**
 * C1 — the headline in-browser SEARCH flow, proven END-TO-END in a REAL
 * headless Chromium over the MINIFIED production build.
 *
 * This is the regression guard for the production-only model-load crash
 * (`Ke(...).call is not a function`, from class private fields downleveled at an
 * es2020 build target). The Node embedder path and the default `screen.spec.ts`
 * both run unminified and so never caught it. This spec exercises the exact path
 * a real visitor hits — now the SIGNED-BUNDLE boot (no JSON catalog; the c1 build
 * sets no VITE_BUNDLE_BASE_URL, so the runtime defaults to /bundle/origin):
 *
 *   fetch + verify the signed /bundle/origin/latest pointer (cache:no-store) →
 *   content-verify the manifest + every chunk against the pinned same-origin
 *   public.key (fail-closed) → materialize catalog.json + per-list
 *   {entities.jsonl,vectors.f32,meta.json} into OPFS → download + compile
 *   the ~23 MB MiniLM model in the Worker → search the lists in-tab as you type.
 *
 * It is also the embedding-parity end-to-end proof + the real-artifact guard:
 * it drives the COMMITTED signed bundle (app/public/bundle/origin) against the
 * COMMITTED pinned key and asserts the known demo entity "Ivan Fakovich"
 * (OFAC_SDN:0001) surfaces as a strong, explainable hit. It asserts: the empty
 * box browses the whole list (now the union of all bundle lists); an exact name
 * and a TYPO both surface a real, explainable, scored hit with the watchlist's
 * DOB; a kept-but-weak candidate renders under the collapsed Balanced
 * low-confidence disclosure (never as a primary card) while a confident hit
 * still leads primary; nonsense returns no match — all with NO in-page errors.
 */

const MODEL_LOAD_TIMEOUT_MS = 160_000;
const RESULT_TIMEOUT_MS = 30_000;
const SEARCH_SLA_MS = 10_000;
const MAX_RENDERED_DOM_NODES = 2_000;
// Keep a generous browser-heap ceiling while catching accidental eager-list
// residency. Native WASM/RSS still needs a physical-device gate; Chromium's
// JS heap metric is not a complete process-memory measurement.
const MAX_JS_HEAP_BYTES = 384 * 1024 * 1024;

function productionCsp(): string {
	const headers = readFileSync(
		new URL("../../public/_headers", import.meta.url),
		"utf8",
	);
	const csp = headers.match(/^\s*Content-Security-Policy:\s*(.+)$/m)?.[1];
	if (csp === undefined) {
		throw new Error("public/_headers has no Content-Security-Policy");
	}
	return csp;
}

test("searches the sanctions list in-browser over the minified build, with full dossiers", async ({
	page,
}) => {
	test.setTimeout(240_000);
	const csp = localhostPreviewCsp(productionCsp());
	await page.addInitScript(() => {
		const violations: string[] = [];
		Object.defineProperty(window, "__cspViolations", { value: violations });
		document.addEventListener("securitypolicyviolation", (event) => {
			violations.push(`${event.violatedDirective}: ${event.blockedURI}`);
		});
	});

	const errors: string[] = [];
	const consoleMessages: string[] = [];
	const requests: Array<{ readonly url: string; readonly body: string }> = [];
	page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
	page.on("console", (msg) => {
		consoleMessages.push(msg.text());
		if (msg.type() === "error") {
			errors.push(`console.error: ${msg.text()}`);
		}
	});
	let modelRequests = 0;
	page.on("request", (request) => {
		requests.push({ url: request.url(), body: request.postData() ?? "" });
		if (request.url().endsWith("/onnx/model_quantized.onnx")) {
			modelRequests += 1;
		}
	});

	const bootStartedAt = Date.now();
	const response = await page.goto("/screen", {
		waitUntil: "domcontentloaded",
	});
	// This must come from `vite preview` itself. Do not inject the header in the
	// test: that would let a CSP-less preview pass and hide production drift.
	expect(response?.headers()["content-security-policy"]).toBe(csp);

	const search = page.getByPlaceholder("Search a name, e.g. Ivan Fakovich");
	await expect(search).toBeVisible();

	const alert = page.locator('[role="alert"]');
	// Bootstrap = sync + verify the signed bundle + ~23 MB model download +
	// compile. Race readiness against the error banner so a real boot failure is
	// reported immediately instead of looking like a 160-second disabled-input hang.
	const outcome = await Promise.race([
		expect(search)
			.toBeEnabled({ timeout: MODEL_LOAD_TIMEOUT_MS })
			.then(() => ({ kind: "ready" as const })),
		alert
			.waitFor({ state: "visible", timeout: MODEL_LOAD_TIMEOUT_MS })
			.then(async () => ({
				kind: "error" as const,
				message: await alert.first().textContent(),
			})),
	]);
	if (outcome.kind === "error") {
		throw new Error(`bootstrap errored: ${outcome.message}`);
	}
	const bootDurationMs = Date.now() - bootStartedAt;
	expect(bootDurationMs, "cold boot SLA").toBeLessThanOrEqual(
		MODEL_LOAD_TIMEOUT_MS,
	);
	expect(modelRequests, "the model must be fetched exactly once").toBe(1);

	// --- browse: the empty box lists the whole demo list (discoverability) ---
	await expect(
		page.locator(".match-card__name", { hasText: "Ivan Fakovich" }),
	).toBeVisible({ timeout: RESULT_TIMEOUT_MS });
	const directory = page.getByRole("navigation", {
		name: "Watchlist directory pages",
	});
	await expect(directory).toBeVisible();
	expect(
		await page.locator(".screen-results__list > .match-card").count(),
	).toBeLessThanOrEqual(24);
	expect(
		await page.locator("*").count(),
		"rendered DOM node budget",
	).toBeLessThan(MAX_RENDERED_DOM_NODES);
	await expect(
		directory.getByRole("button", { name: "Previous page" }),
	).toBeDisabled();
	const usedJsHeapBytes = await page.evaluate(() => {
		const memory = (
			performance as Performance & {
				readonly memory?: { readonly usedJSHeapSize: number };
			}
		).memory;
		return memory?.usedJSHeapSize ?? null;
	});
	if (usedJsHeapBytes !== null) {
		expect(usedJsHeapBytes, "post-boot JavaScript heap budget").toBeLessThan(
			MAX_JS_HEAP_BYTES,
		);
	}

	// A scored search card (browse cards carry no score; search cards do).
	const scoredCard = page
		.locator(".match-card:has(.match-card__score)")
		.first();

	// --- positive: exact sanctioned name → scored, explainable, full dossier ---
	const queryNetworkStart = requests.length;
	const searchStartedAt = Date.now();
	await search.fill("Ivan Fakovich");
	await expect(scoredCard).toBeVisible({ timeout: RESULT_TIMEOUT_MS });
	const searchDurationMs = Date.now() - searchStartedAt;
	expect(searchDurationMs, "warm in-tab search SLA").toBeLessThanOrEqual(
		SEARCH_SLA_MS,
	);
	await expect(scoredCard.locator(".match-card__name")).toHaveText(
		"Ivan Fakovich",
	);
	const scoreText =
		(await scoredCard.locator(".match-card__score").textContent()) ?? "";
	expect(Number.parseFloat(scoreText)).toBeGreaterThan(0);
	await expect(scoredCard.locator(".match-card__why")).not.toBeEmpty();
	expect(
		await scoredCard.locator(".match-card__signal dt").count(),
	).toBeGreaterThan(0);
	// the dossier carries the DOB the v3 watchlist publishes for this entity.
	await expect(scoredCard).toContainText("1971-03-14");
	// A confident hit (0.75, above Balanced's 0.40 display line) leads as a
	// PRIMARY card; nothing here is low-confidence, so no disclosure renders.
	await expect(page.locator("details.screen-results__low")).toHaveCount(0);

	// --- fuzzy: a TYPO still finds the target (vector + trigram) ---
	await search.fill("");
	await search.fill("fakovic");
	await expect(
		page.locator(".match-card:has(.match-card__score) .match-card__name", {
			hasText: "Ivan Fakovich",
		}),
	).toBeVisible({ timeout: RESULT_TIMEOUT_MS });

	// --- low-confidence: a kept-but-weak candidate must not lead ---
	// "Invented" is KEPT by the token-containment escape hatch (it is a token of
	// the UN list's "Invented Charity Foundation") but its combined score (~0.36)
	// sits below Balanced's 0.40 display line. Honest render: NO primary card, an
	// explicit nothing-above-the-line headline (which is NOT the green clear), and
	// ONE collapsed disclosure the analyst can expand — recall preserved, fuzz
	// de-emphasized. This is the calibrated fix for the live "Zzyzx Nobody" /
	// "John Smith" junk-card reports against the full SDN.
	// (This probe was "Imaginary" while /screen searched OFAC alone. With every
	// list searched, the UK list's "Imaginary Logistics Ltd" now clears the line
	// for it at 0.403 — a correct hit — so the probe moved to a token that is
	// still weak across all four lists.)
	await search.fill("Invented");
	const disclosure = page.locator("details.screen-results__low");
	await expect(disclosure).toBeVisible({ timeout: RESULT_TIMEOUT_MS });
	await expect(
		disclosure.locator("summary.screen-results__low-summary"),
	).toHaveText("1 low-confidence candidate (below Balanced threshold)");
	// Collapsed by default: the grouped card is in the DOM but not visible,
	// and there is no primary count line — only the honest headline.
	await expect(disclosure).toHaveJSProperty("open", false);
	expect(await page.locator(".match-card:visible").count()).toBe(0);
	await expect(page.locator(".screen-results__count")).toHaveCount(0);
	await expect(page.locator(".screen-results__none")).toHaveText(
		/No match above the Balanced threshold/,
	);
	await expect(page.locator(".screen-results--clear")).toHaveCount(0);
	// Expanding reveals the full scored, explainable dossier (recall intact).
	await disclosure.locator("summary.screen-results__low-summary").click();
	await expect(disclosure).toHaveJSProperty("open", true);
	const groupedCard = disclosure.locator(".match-card");
	await expect(groupedCard).toHaveCount(1);
	await expect(groupedCard.locator(".match-card__name")).toHaveText(
		"Invented Charity Foundation",
	);
	const groupedScore = Number.parseFloat(
		(await groupedCard.locator(".match-card__score").textContent()) ?? "",
	);
	expect(
		groupedScore,
		"grouped candidate scores below the 0.40 line",
	).toBeLessThan(0.4);
	expect(groupedScore, "a real score, never fabricated").toBeGreaterThan(0);

	// --- mixed: a confident hit leads primary while sub-line fuzz stays grouped ---
	await search.fill("");
	await search.fill("Olga Notrealova bank");
	const primaryList = page.locator(
		"section.screen-results > ul.screen-results__list",
	);
	await expect(
		primaryList.locator(".match-card__name", { hasText: "Olga Notrealova" }),
	).toBeVisible({ timeout: RESULT_TIMEOUT_MS });
	await expect(page.locator(".screen-results__count")).toHaveText(
		/1 potential match/,
	);
	await expect(
		disclosure.locator("summary.screen-results__low-summary"),
	).toHaveText("1 low-confidence candidate (below Balanced threshold)");

	// --- junk: "Zzyzx Nobody" against this 3-entity demo list yields nothing at
	// all → the clean clear (against the full SDN its sub-line fuzz would render
	// grouped under the disclosure above, never as primary cards) ---
	await search.fill("");
	await search.fill("Zzyzx Nobody");
	const junkClear = page.locator(".screen-results--clear");
	await expect(junkClear).toBeVisible({ timeout: RESULT_TIMEOUT_MS });
	expect(await page.locator(".match-card:visible").count()).toBe(0);

	// --- negative: nonsense yields a clean no-match ---
	await search.fill("");
	await search.fill("zxqwqx vbnmlk");
	const clear = page.locator(".screen-results--clear");
	await expect(clear).toBeVisible({ timeout: RESULT_TIMEOUT_MS });
	await expect(clear).toContainText(/no sanctions match/i);
	expect(await page.locator(".match-card").count()).toBe(0);
	expect(
		requests.slice(queryNetworkStart),
		"typing and scoring must make zero network requests",
	).toEqual([]);
	const pageOrigin = new URL(page.url()).origin;
	const externalRequests = requests.filter(({ url }) => {
		const parsed = new URL(url);
		return (
			["http:", "https:"].includes(parsed.protocol) &&
			parsed.origin !== pageOrigin
		);
	});
	expect(
		externalRequests,
		"runtime must make zero third-party requests",
	).toEqual([]);
	const observableOutput = [
		...requests.flatMap(({ url, body }) => [url, body]),
		...consoleMessages,
	]
		.join("\n")
		.toLowerCase();
	for (const pii of [
		"ivan fakovich",
		"fakovic",
		"zxqwqx vbnmlk",
		"imaginary",
		"olga notrealova bank",
		"zzyzx nobody",
	]) {
		expect(
			observableOutput,
			`PII/query leaked to network or console: ${pii}`,
		).not.toContain(pii);
	}
	const cspViolations = await page.evaluate(
		() =>
			(
				window as unknown as {
					readonly __cspViolations: readonly string[];
				}
			).__cspViolations,
	);

	expect(cspViolations, "production CSP violations").toEqual([]);
	expect(errors, `in-browser errors:\n${errors.join("\n")}`).toEqual([]);
	test.info().annotations.push({
		type: "performance-budget",
		description: `cold boot ${bootDurationMs}ms; warm search ${searchDurationMs}ms; ${String(await page.locator("*").count())} DOM nodes; JS heap ${String(usedJsHeapBytes)} bytes; ${String(requests.length)} boot requests; 0 query requests`,
	});
});
