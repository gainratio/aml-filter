import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, type Route, test } from "@playwright/test";

/**
 * rollback-recovery — a returning visitor stuck behind the anti-rollback floor
 * gets out IN-APP, with a warning and a confirm, never automatically.
 *
 * Since edgeproc-browser #13 the durable active pointer stays the rollback floor
 * even across a key change. A browser that once accepted a HIGHER sequence than
 * the origin now serves refuses every sync with a `RollbackError`, and the only
 * way out is clearing the cached lists — which must therefore be reachable from
 * the boot-failure card, must not need a successful sync first (the old clear
 * path synced before clearing, so it could never clear this state), and must
 * never fire on its own (an attacker who can serve an old signed pointer would
 * love an app that wipes the floor for them).
 *
 * The floor is seeded through the REAL sync path, not by poking storage: the first
 * visit is served the committed, genuinely signed demo-2 fixture (sequence 2),
 * which the Worker verifies and promotes. The second visit gets the committed
 * demo-1 origin (sequence 1) — a real rollback, refused by the real Worker.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const V1_LATEST = JSON.parse(
	readFileSync(join(HERE, "../../public/bundle/origin/latest"), "utf8"),
) as { sequence: number };
const V2_ORIGIN = join(HERE, "fixtures/bundle-v2/origin");
const V2_LATEST = JSON.parse(
	readFileSync(join(V2_ORIGIN, "latest"), "utf8"),
) as {
	sequence: number;
};

const SYNC_TIMEOUT_MS = 60_000;
const MODEL_LOAD_TIMEOUT_MS = 160_000;
const MODEL_CONFIG = "/models/Xenova/all-MiniLM-L6-v2/config.json";

async function serveFromV2(route: Route): Promise<void> {
	const url = route.request().url();
	const marker = "/bundle/origin/";
	const tail = url.slice(url.indexOf(marker) + marker.length).split("?")[0];
	await route.fulfill({
		status: 200,
		contentType:
			tail === "latest" ? "application/json" : "application/octet-stream",
		headers: { "cache-control": "no-store" },
		body: readFileSync(join(V2_ORIGIN, tail ?? "")),
	});
}

/** Count the sync Worker's chunk downloads (Worker traffic is visible to the page). */
function chunkRequests(page: Page): () => number {
	let count = 0;
	page.on("request", (req) => {
		if (req.url().includes("/bundle/origin/chunk/")) count += 1;
	});
	return () => count;
}

/**
 * Wait until the boot is PAST the signed sync: ready, or a failure card meaning the
 * boot stopped somewhere. (The model stage no longer marks the end of the sync: the
 * model is built BEFORE the lists, to keep its WebAssembly allocation off the
 * list-heavy heap that ran iPhone Safari out of memory.) Returns the failure
 * card's text, or "" when none.
 */
async function settlePastSync(page: Page): Promise<string> {
	const card = page.locator(".screen-banner--error");
	const search = page.getByPlaceholder("Search a name, e.g. Ivan Fakovich");
	await expect
		.poll(async () => (await card.count()) > 0 || (await search.isEnabled()), {
			timeout: SYNC_TIMEOUT_MS,
		})
		.toBe(true);
	return (await card.count()) > 0 ? ((await card.textContent()) ?? "") : "";
}

test("a refused rollback offers a warned, confirmed clear that restores the lists", async ({
	page,
}) => {
	test.setTimeout(300_000);
	expect(
		V2_LATEST.sequence,
		"the seeded floor must sit ABOVE the served origin",
	).toBeGreaterThan(V1_LATEST.sequence);

	// --- 1. seed a higher-sequence floor through the real sync path ---
	await page.route("**/bundle/origin/**", serveFromV2);
	const seeded = chunkRequests(page);
	await page.goto("/screen", { waitUntil: "domcontentloaded" });
	const seedOutcome = await settlePastSync(page);
	expect(seedOutcome, "the demo-2 seed must verify").not.toContain(
		"verification failed",
	);
	expect(seeded()).toBeGreaterThan(0);
	await page.unroute("**/bundle/origin/**");

	// --- 2. the origin now serves demo-1 (sequence 1): a real rollback ---
	await page.reload({ waitUntil: "domcontentloaded" });
	const recovery = page.getByTestId("cache-recovery");
	await expect(recovery).toBeVisible({ timeout: SYNC_TIMEOUT_MS });
	const card = page.locator(".screen-banner--error");
	await expect(card).toContainText("verification failed");
	await expect(card).toContainText("refusing rollback");
	// The plain-language warning is on screen BEFORE anything can be cleared.
	await expect(recovery).toContainText(
		"The server offered an older version of the screening lists than the one you already have.",
	);
	await expect(recovery).toContainText("Only clear if you trust this.");
	await expect(
		recovery.getByRole("link", { name: "Open Settings" }),
	).toHaveAttribute("href", "/settings");

	// Never automatic: sitting on the card does not clear, and a reload still refuses.
	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("cache-recovery")).toBeVisible({
		timeout: SYNC_TIMEOUT_MS,
	});

	// --- 3. two-step confirm, then clear ---
	await page.getByRole("button", { name: "Clear cached lists" }).click();
	const confirm = page.getByRole("button", { name: "Yes, clear cached lists" });
	await expect(confirm).toBeVisible();
	const recovered = chunkRequests(page);
	await confirm.click();

	// --- 4. the floor is gone: the demo-1 sync now verifies and promotes ---
	await expect(page.getByTestId("cache-recovery")).toHaveCount(0, {
		timeout: SYNC_TIMEOUT_MS,
	});
	const outcome = await settlePastSync(page);
	expect(outcome).not.toContain("verification failed");
	expect(outcome).not.toContain("refusing rollback");
	// The clear really emptied the store: the demo-1 chunks were downloaded again.
	expect(recovered()).toBeGreaterThan(0);

	// And it stays gone across a reload (the floor was really cleared, not skipped).
	await page.reload({ waitUntil: "domcontentloaded" });
	const reloaded = await settlePastSync(page);
	expect(reloaded).not.toContain("verification failed");
	await expect(page.getByTestId("cache-recovery")).toHaveCount(0);

	// --- 5. the lists load again (needs the self-hosted model: always in CI) ---
	const model = await page.request.get(MODEL_CONFIG);
	const modelServed =
		model.ok() &&
		(model.headers()["content-type"] ?? "").includes("application/json");
	if (!modelServed && !process.env.CI) {
		test.info().annotations.push({
			type: "skipped-step",
			description:
				"model weights not staged locally; the ready + search half runs in CI",
		});
		return;
	}
	const search = page.getByPlaceholder("Search a name, e.g. Ivan Fakovich");
	await expect(search).toBeEnabled({ timeout: MODEL_LOAD_TIMEOUT_MS });
	await search.fill("Ivan Fakovich");
	await expect(
		page.locator(".match-card:has(.match-card__score)").first(),
	).toBeVisible({ timeout: 30_000 });
});
