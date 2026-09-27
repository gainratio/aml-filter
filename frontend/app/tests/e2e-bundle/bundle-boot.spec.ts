import { expect, type Page, test } from "@playwright/test";

/**
 * bundle-boot — the headline SIGNED-BUNDLE delta-sync flow, proven END-TO-END in
 * a REAL headless Chromium over the MINIFIED production build with
 * VITE_BUNDLE_BASE_URL=/bundle/origin (set by playwright.bundle.config.ts).
 *
 * It is the permanent regression guard that the recovered edge-proc sync tier is
 * actually wired into EngineRuntime.bootstrap(): the engine must
 *   fetch + verify the signed /latest pointer (cache:no-store) →
 *   content-verify the manifest + every chunk + every reassembled file against
 *   the pinned SAME-ORIGIN public.key (fail-closed) → atomically promote into
 *   OPFS → materialize catalog.json + per-list {entities.jsonl,vectors.f32,
 *   meta.json} → download + compile the ~23 MB MiniLM model → screen in-tab.
 *
 * Asserts: cold boot reaches a screenable state having taken the BUNDLE path
 * (a /bundle/origin/latest + /manifest + /chunk fetch fired, NOT the JSON
 * watchlist/catalog.json); the committed sanctioned name "Ivan Fakovich"
 * surfaces as a scored, explainable match with the published DOB + a dob_match
 * signal; nonsense returns a clean no-match; the console stays clean; a RELOAD
 * re-fetches ZERO chunks (delta reuse from OPFS); and an OFFLINE reload (every
 * /bundle request aborted) still screens from OPFS. localhost is a secure
 * context, so OPFS + WebCrypto work with no COOP/COEP.
 */

const MODEL_LOAD_TIMEOUT_MS = 160_000;
const RESULT_TIMEOUT_MS = 30_000;

/** Wait for the engine to reach "ready": the search box enables only then. */
async function bootToReady(page: Page): Promise<void> {
	const search = page.getByPlaceholder("Search a name, e.g. Ivan Fakovich");
	await expect(search).toBeVisible();
	await expect(search).toBeEnabled({ timeout: MODEL_LOAD_TIMEOUT_MS });
	const alert = page.locator('[role="alert"]');
	if (await alert.count()) {
		throw new Error(`bootstrap errored: ${await alert.first().textContent()}`);
	}
}

/** A scored search card (browse cards carry no score; search cards do). */
function scoredCard(page: Page) {
	return page.locator(".match-card:has(.match-card__score)").first();
}

test("boots over the signed bundle and screens the committed demo entity", async ({
	page,
}) => {
	test.setTimeout(240_000);

	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
	page.on("console", (msg) => {
		if (msg.type() === "error") {
			errors.push(`console.error: ${msg.text()}`);
		}
	});

	// Record every request so we can prove the BUNDLE path (not JSON) was taken.
	const bundleReqs: string[] = [];
	const jsonReqs: string[] = [];
	page.on("request", (req) => {
		const url = req.url();
		if (url.includes("/bundle/origin/")) {
			bundleReqs.push(url);
		}
		if (url.includes("/watchlist/catalog.json")) {
			jsonReqs.push(url);
		}
	});

	// --- cold boot: the banner walks downloading → verified → loading-model ---
	await page.goto("/screen", { waitUntil: "domcontentloaded" });
	// The first banner is the "downloading" stage.
	await expect(page.locator(".screen-banner")).toContainText(
		/Downloading the signed sanctions list/i,
		{ timeout: RESULT_TIMEOUT_MS },
	);
	await bootToReady(page);

	// The bundle delta-sync fired (signed /latest + manifest + chunk fetches), and
	// the JSON catalog path was NOT taken — proving bootstrap took the bundle path.
	expect(
		bundleReqs.some((u) => u.endsWith("/bundle/origin/latest")),
		`expected a /bundle/origin/latest fetch; saw:\n${bundleReqs.join("\n")}`,
	).toBe(true);
	expect(bundleReqs.some((u) => u.includes("/bundle/origin/manifest/"))).toBe(
		true,
	);
	expect(bundleReqs.some((u) => u.includes("/bundle/origin/chunk/"))).toBe(
		true,
	);
	expect(
		jsonReqs,
		`bundle path must NOT fetch the JSON catalog; saw:\n${jsonReqs.join("\n")}`,
	).toEqual([]);

	// --- browse: the empty box lists the committed demo entity (discoverability) ---
	await expect(
		page.locator(".match-card__name", { hasText: "Ivan Fakovich" }),
	).toBeVisible({ timeout: RESULT_TIMEOUT_MS });

	// --- positive: exact sanctioned name → scored, explainable, full dossier ---
	const search = page.getByPlaceholder("Search a name, e.g. Ivan Fakovich");
	await search.fill("Ivan Fakovich");
	const card = scoredCard(page);
	await expect(card).toBeVisible({ timeout: RESULT_TIMEOUT_MS });
	await expect(card.locator(".match-card__name")).toHaveText("Ivan Fakovich");
	const scoreText =
		(await card.locator(".match-card__score").textContent()) ?? "";
	expect(Number.parseFloat(scoreText)).toBeGreaterThan(0);
	await expect(card.locator(".match-card__why")).not.toBeEmpty();
	expect(await card.locator(".match-card__signal dt").count()).toBeGreaterThan(
		0,
	);

	// --- DOB query yields a date-of-birth signal (the published DOB for this entity) ---
	await page.locator("#screen-dob-input").fill("1971-03-14");
	const dobCard = scoredCard(page);
	await expect(dobCard).toBeVisible({ timeout: RESULT_TIMEOUT_MS });
	await expect(dobCard).toContainText("1971-03-14");
	await expect(
		// The signal is labelled in plain words; the code stays `dob_match`.
		dobCard.locator(".match-card__signal dt", { hasText: /date of birth/i }),
	).toHaveCount(1, { timeout: RESULT_TIMEOUT_MS });

	// --- negative: nonsense yields a clean no-match ---
	await page.locator("#screen-dob-input").fill("");
	await search.fill("");
	await search.fill("zxqwqx vbnmlk");
	const clear = page.locator(".screen-results--clear");
	await expect(clear).toBeVisible({ timeout: RESULT_TIMEOUT_MS });
	await expect(clear).toContainText(/no sanctions match/i);
	expect(await page.locator(".match-card").count()).toBe(0);

	expect(errors, `in-browser errors:\n${errors.join("\n")}`).toEqual([]);
});

test("reload re-fetches ZERO chunks (delta reuse from OPFS)", async ({
	page,
}) => {
	test.setTimeout(240_000);

	// First boot populates the OPFS chunk store.
	await page.goto("/screen", { waitUntil: "domcontentloaded" });
	await bootToReady(page);

	// Reload: count the /chunk fetches on the SECOND boot. Every chunk is already
	// in OPFS, so the delta sync fetches none. (The signed /latest is still
	// re-fetched no-store — that is the version poll, not a chunk.)
	const chunkReqs: string[] = [];
	page.on("request", (req) => {
		if (req.url().includes("/bundle/origin/chunk/")) {
			chunkReqs.push(req.url());
		}
	});
	await page.reload({ waitUntil: "domcontentloaded" });
	await bootToReady(page);

	expect(
		chunkReqs,
		`expected 0 chunk re-fetches after OPFS warm-up; saw:\n${chunkReqs.join("\n")}`,
	).toEqual([]);
	// Still screenable from the cached, re-verified bundle.
	await expect(
		page.locator(".match-card__name", { hasText: "Ivan Fakovich" }),
	).toBeVisible({ timeout: RESULT_TIMEOUT_MS });
});

test("offline reload still screens from OPFS (fail-closed cache)", async ({
	page,
}) => {
	test.setTimeout(240_000);

	// Warm OPFS online.
	await page.goto("/screen", { waitUntil: "domcontentloaded" });
	await bootToReady(page);

	// Now abort EVERY bundle-origin request: the sync tier must fall back to the
	// cached active version (NetworkError on /latest → readActive) and re-verify
	// the cached bytes fail-closed, then screen entirely from OPFS.
	await page.route("**/bundle/origin/**", (route) => route.abort());
	await page.reload({ waitUntil: "domcontentloaded" });
	await bootToReady(page);

	const search = page.getByPlaceholder("Search a name, e.g. Ivan Fakovich");
	await search.fill("Ivan Fakovich");
	const card = scoredCard(page);
	await expect(card).toBeVisible({ timeout: RESULT_TIMEOUT_MS });
	await expect(card.locator(".match-card__name")).toHaveText("Ivan Fakovich");
});
