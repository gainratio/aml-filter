import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, type Route, test } from "@playwright/test";

/**
 * delta-sync — the headline EDGE-PROC VALUE PROOF, end-to-end in a REAL headless
 * Chromium over the MINIFIED production build (VITE_BUNDLE_BASE_URL=/bundle/origin,
 * set by playwright.bundle.config.ts).
 *
 * It proves that publishing a NEW bundle version fetches ONLY the changed chunks
 * and reuses the rest from OPFS:
 *   1. Cold-boot the app on /screen against the committed v1 bundle
 *      (app/public/bundle/origin, version "demo-1") → reach ready, OPFS warmed
 *      with every v1 chunk. Confirm the NEW v2 OFAC entity is NOT yet matchable.
 *   2. Flip every `/bundle/origin/**` request to serve the committed v2 fixture
 *      (app/tests/e2e-bundle/fixtures/bundle-v2/origin, version "demo-2") from
 *      disk. Record every `/chunk/<hash>` URL actually FETCHED after the flip.
 *   3. Reload → the engine re-syncs, verifies the new signed /latest fail-closed,
 *      diffs the v2 manifest against OPFS, and fetches only the missing chunks.
 *   4. ASSERT the delta precisely (from the two committed manifests on disk):
 *      the chunks fetched on the v2 sync are EXACTLY the v1→v2 new-chunk set
 *      (OFAC entities/vectors/meta + the top-level catalog), and the 9 EU/UN/UK
 *      chunks — shared with v1, already in OPFS — were NOT re-fetched.
 *   5. ASSERT correctness: the NEW OFAC entity "Testor Newlysanctioned" (added at
 *      demo-2) is now a scored, explainable match, and the console stays clean.
 *
 * localhost is a secure context, so OPFS + WebCrypto Ed25519 verification work
 * with no COOP/COEP. The two manifests are read directly off disk so the chunk
 * sets are derived, never hard-coded (a fixture regen can't silently rot this).
 */

const MODEL_LOAD_TIMEOUT_MS = 160_000;
const RESULT_TIMEOUT_MS = 30_000;

const HERE = dirname(fileURLToPath(import.meta.url));
// The committed v1 boot bundle the SPA serves at /bundle/origin (bundled into dist/).
const V1_ORIGIN = join(HERE, "../../public/bundle/origin");
// The committed v2 fixture this spec routes in (NOT statically served — flipped
// in via page.route only AFTER OPFS is warm, exactly as a real new publish lands).
const V2_ORIGIN = join(HERE, "fixtures/bundle-v2/origin");

/** The NEW sanctioned entity added only at demo-2 (must be unmatchable at v1). */
const NEW_V2_NAME = "Testor Newlysanctioned";

interface ManifestRefs {
	readonly version: string;
	readonly manifestHash: string;
	/** Distinct chunk hashes referenced by the manifest. */
	readonly chunks: ReadonlySet<string>;
}

/** Read an origin's signed pointer + the manifest it names → its distinct chunks. */
function readManifestRefs(originDir: string): ManifestRefs {
	const pointer = JSON.parse(
		readFileSync(join(originDir, "latest"), "utf8"),
	) as {
		manifest_hash: string;
		version: string;
	};
	const manifest = JSON.parse(
		readFileSync(join(originDir, "manifest", pointer.manifest_hash), "utf8"),
	) as { files: ReadonlyArray<{ chunks: ReadonlyArray<{ hash: string }> }> };
	const chunks = new Set<string>();
	for (const file of manifest.files) {
		for (const ref of file.chunks) {
			chunks.add(ref.hash);
		}
	}
	return {
		version: pointer.version,
		manifestHash: pointer.manifest_hash,
		chunks,
	};
}

const V1 = readManifestRefs(V1_ORIGIN);
const V2 = readManifestRefs(V2_ORIGIN);
/** Chunks present in v2 but NOT v1 — the ONLY chunks a delta sync may fetch. */
const V2_ONLY = new Set([...V2.chunks].filter((h) => !V1.chunks.has(h)));
/** Chunks shared with v1 (already in OPFS) — must NOT be re-fetched. */
const SHARED = new Set([...V2.chunks].filter((h) => V1.chunks.has(h)));

/** Path tail after `/bundle/origin/` for a routed request, or null if not ours. */
function bundleTail(url: string): string | null {
	const marker = "/bundle/origin/";
	const at = url.indexOf(marker);
	if (at < 0) {
		return null;
	}
	// Strip any query string; the CAS layout has no query params.
	return url.slice(at + marker.length).split("?")[0] ?? null;
}

/** Serve a `/bundle/origin/**` request from the committed v2 fixture on disk. */
async function serveFromV2(route: Route): Promise<void> {
	const tail = bundleTail(route.request().url());
	if (tail === null) {
		await route.continue();
		return;
	}
	const body = readFileSync(join(V2_ORIGIN, tail));
	const contentType =
		tail === "latest" ? "application/json" : "application/octet-stream";
	await route.fulfill({
		status: 200,
		contentType,
		// no-store so the mutable /latest pointer is never served stale from the
		// browser HTTP cache (mirrors the engine's own cache:"no-store" intent).
		headers: { "cache-control": "no-store" },
		body,
	});
}

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

test("a new bundle version fetches ONLY the changed chunks, reusing the rest from OPFS", async ({
	page,
}) => {
	test.setTimeout(300_000);

	// Sanity-check the fixtures wire up the delta we are about to prove. If a
	// future fixture regen makes v2 == v1 (no change) this guards against a
	// vacuously-green test.
	expect(V1.version, "v1 boot bundle must be demo-1").toBe("demo-1");
	expect(V2.version, "v2 fixture must be demo-2").toBe("demo-2");
	expect(V2.manifestHash, "v2 manifest must differ from v1").not.toBe(
		V1.manifestHash,
	);
	expect(
		V2_ONLY.size,
		"v2 must introduce a strict, non-empty subset of new chunks",
	).toBeGreaterThan(0);
	expect(V2_ONLY.size).toBeLessThan(V2.chunks.size);
	expect(
		SHARED.size,
		"v2 must reuse some v1 chunks (the unchanged lists)",
	).toBeGreaterThan(0);

	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
	page.on("console", (msg) => {
		if (msg.type() === "error") {
			errors.push(`console.error: ${msg.text()}`);
		}
	});

	// --- 1. cold boot on the committed v1 bundle: warm OPFS with the v1 chunks ---
	await page.goto("/screen", { waitUntil: "domcontentloaded" });
	await bootToReady(page);
	await expect(page.getByTestId("screen-sync-status")).toContainText(
		/Signed watchlist synced/i,
	);

	const search = page.getByPlaceholder("Search a name, e.g. Ivan Fakovich");

	// The committed v1 demo entity is matchable...
	await search.fill("Ivan Fakovich");
	await expect(scoredCard(page)).toBeVisible({ timeout: RESULT_TIMEOUT_MS });

	// ...but the NEW v2-only entity is NOT yet present (it ships in demo-2 only).
	await search.fill("");
	await search.fill(NEW_V2_NAME);
	const preClear = page.locator(".screen-results--clear");
	await expect(preClear).toBeVisible({ timeout: RESULT_TIMEOUT_MS });
	await expect(preClear).toContainText(/no sanctions match/i);
	expect(
		await page.locator(".match-card").count(),
		`"${NEW_V2_NAME}" must NOT match before the v2 publish`,
	).toBe(0);

	// --- 2. publish v2: every /bundle/origin/** request now serves the v2 fixture.
	// Record which CHUNK hashes are actually fetched after the flip. ---
	const fetchedChunks: string[] = [];
	page.on("request", (req) => {
		const tail = bundleTail(req.url());
		if (tail?.startsWith("chunk/")) {
			fetchedChunks.push(tail.slice("chunk/".length));
		}
	});
	await page.route("**/bundle/origin/**", serveFromV2);

	// --- 3. reload → the engine re-syncs against the new signed /latest (demo-2) ---
	await page.reload({ waitUntil: "domcontentloaded" });
	await bootToReady(page);
	await expect(page.getByTestId("screen-sync-status")).toContainText(
		/Watchlist patch applied/i,
	);

	// --- 4. ASSERT the delta precisely ---
	const fetchedSet = new Set(fetchedChunks);
	// Every fetched chunk is a genuinely-new v2 chunk — nothing shared was pulled.
	expect(
		[...fetchedSet].every((h) => V2_ONLY.has(h)),
		`delta must fetch ONLY v2-new chunks.\n  fetched: ${[...fetchedSet].join("\n           ")}\n  v2-only: ${[...V2_ONLY].join("\n           ")}`,
	).toBe(true);
	// None of the shared EU/UN/UK chunks were re-fetched (they live in OPFS).
	for (const shared of SHARED) {
		expect(
			fetchedSet.has(shared),
			`shared chunk ${shared} must be reused from OPFS, not re-fetched`,
		).toBe(false);
	}
	// And the delta actually moved bytes: the new chunks WERE fetched (not a no-op),
	// and strictly fewer than the whole v2 chunk set.
	expect(fetchedSet.size, "the v2-new chunks must have been fetched").toBe(
		V2_ONLY.size,
	);
	expect(fetchedSet.size).toBeLessThan(V2.chunks.size);

	// --- 5. ASSERT correctness after the update ---
	// The version advanced: the v1 demo entity still matches (carried across)...
	await search.fill("Ivan Fakovich");
	await expect(scoredCard(page)).toBeVisible({ timeout: RESULT_TIMEOUT_MS });

	// ...and the NEW demo-2 entity is now a scored, explainable match.
	await search.fill("");
	await search.fill(NEW_V2_NAME);
	const card = scoredCard(page);
	await expect(card).toBeVisible({ timeout: RESULT_TIMEOUT_MS });
	await expect(card.locator(".match-card__name")).toHaveText(NEW_V2_NAME);
	const scoreText =
		(await card.locator(".match-card__score").textContent()) ?? "";
	expect(Number.parseFloat(scoreText)).toBeGreaterThan(0);
	await expect(card.locator(".match-card__why")).not.toBeEmpty();

	expect(errors, `in-browser errors:\n${errors.join("\n")}`).toEqual([]);
});
