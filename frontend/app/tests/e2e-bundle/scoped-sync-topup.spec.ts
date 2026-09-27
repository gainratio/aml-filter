import { expect, type Page, test } from "@playwright/test";

/**
 * scoped-sync-topup — the end-to-end guard for scoped list syncing.
 *
 * On a phone /screen starts on OFAC SDN alone (a desktop searches every list,
 * see src/pages/screenScope.ts, so this spec runs as a phone). `syncIndex` used to walk every file in
 * the manifest, so a cold boot downloaded the EU, UK and UN directories too and
 * then never read them. Against the live 2026-08-01 bundle that was 527 of 1,296
 * chunks and 18.4 MB of 46.7 MB — roughly 40% of the first-use cost, spent on
 * data the page does not touch.
 *
 * Narrowing a fetch is only safe if enabling a list LATER still works, and works
 * incrementally. This spec asserts both halves against a real browser, a real
 * dedicated Worker, and real OPFS:
 *
 *   1. the cold boot requests OFAC's chunks and NOT the other lists';
 *   2. enabling EU in Settings fetches EU's chunks and re-fetches NOTHING that
 *      is already local.
 *
 * (2) is the load-bearing one. A scoped sync that "worked" by silently
 * re-downloading everything on every selection change would pass a naive
 * screenshot test and be worse than the bug it replaced.
 *
 * The fixture bundle is 13 chunks — one per file, four lists — so per-list
 * request counts are exact and readable rather than statistical.
 *
 * PROVEN ABLE TO FAIL: with `wantedPaths` dropped from `syncIndex`, step (1)
 * sees eu/uk/un chunk requests on the cold boot and fails.
 */

const READY_TIMEOUT_MS = 160_000;

// A phone user agent: the /screen scope that syncs ONE list. The property under
// test is the scoped sync + top-up, not which device picks the scope.
test.use({
	userAgent:
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1",
});

/** Chunk hash -> which manifest file owns it, read from the served bundle. */
async function chunkOwners(page: Page): Promise<ReadonlyMap<string, string>> {
	const owners = await page.evaluate(async () => {
		const pointer = await (await fetch("/bundle/origin/latest")).json();
		const manifest = await (
			await fetch(`/bundle/origin/manifest/${pointer.manifest_hash}`)
		).json();
		const pairs: Array<[string, string]> = [];
		for (const file of manifest.files) {
			for (const chunk of file.chunks) {
				pairs.push([chunk.hash, file.path]);
			}
		}
		return pairs;
	});
	return new Map(owners);
}

/** The list directory each requested chunk belonged to. */
function listsFetched(
	owners: ReadonlyMap<string, string>,
	requestedChunkUrls: ReadonlyArray<string>,
): ReadonlySet<string> {
	const lists = new Set<string>();
	for (const url of requestedChunkUrls) {
		const hash = url.split("/").at(-1) ?? "";
		const path = owners.get(hash);
		if (path !== undefined) {
			lists.add(path.includes("/") ? path.split("/")[0] : "(root)");
		}
	}
	return lists;
}

async function waitForReady(page: Page): Promise<void> {
	const search = page.getByPlaceholder("Search a name, e.g. Ivan Fakovich");
	await expect(search).toBeVisible();
	await expect(search).toBeEnabled({ timeout: READY_TIMEOUT_MS });
	const alert = page.locator('[role="alert"]');
	if (await alert.count()) {
		throw new Error(`bootstrap errored: ${await alert.first().textContent()}`);
	}
}

test("the cold boot fetches only the selected list, and enabling another tops up", async ({
	page,
	context,
}) => {
	const chunkUrls: string[] = [];
	await context.route("**/bundle/origin/chunk/**", async (route) => {
		chunkUrls.push(route.request().url());
		await route.continue();
	});

	await page.goto("/screen");
	await waitForReady(page);

	const owners = await chunkOwners(page);
	// The interception has to have seen the Worker's own chunk requests, or every
	// assertion below is vacuous.
	expect(chunkUrls.length).toBeGreaterThan(0);

	const coldLists = listsFetched(owners, chunkUrls);
	expect([...coldLists].sort()).toEqual(["(root)", "ofac"]);

	// --- enable EU in Settings ---
	const coldChunks = new Set(
		chunkUrls.map((url) => url.split("/").at(-1) ?? ""),
	);
	chunkUrls.length = 0;

	// /settings sits behind the workstation gate: name yourself once, then the
	// local workspace opens. Same one-time step a real first-time analyst takes.
	await page.goto("/settings");
	await expect(
		page.getByRole("heading", { name: /welcome to the workstation/i }),
	).toBeVisible({ timeout: 60_000 });
	await page.locator("#analyst-name").fill("Scoped Sync Tester");
	await page.getByRole("button", { name: /start reviewing/i }).click();

	const euToggle = page.locator("#watchlist-EU_CONSOLIDATED");
	await expect(euToggle).toBeVisible({ timeout: 30_000 });
	await euToggle.check();
	// Applying is what re-bootstraps the engine with the wider selection.
	await page.getByRole("button", { name: "Apply" }).click();
	await expect(page.locator('[role="status"], [role="alert"]')).toBeVisible({
		timeout: READY_TIMEOUT_MS,
	});

	await page.goto("/screen");
	await waitForReady(page);

	const topUpChunks = new Set(
		chunkUrls.map((url) => url.split("/").at(-1) ?? ""),
	);
	const topUpLists = listsFetched(owners, chunkUrls);
	// EU arrives.
	expect(topUpLists.has("eu")).toBe(true);
	// And OFAC — everything already local — is NOT pulled again. This is the
	// incremental claim, and it is the one that matters: a scoped sync that
	// "worked" by re-downloading the world on every selection change would be
	// worse than the bug it replaced.
	expect(topUpLists.has("ofac")).toBe(false);

	// Stated as a set property so it cannot pass by coincidence: not one chunk
	// fetched during the cold boot is fetched a second time.
	const refetched = [...topUpChunks].filter((hash) => coldChunks.has(hash));
	expect(refetched).toEqual([]);

	// NOTE: the workstation (which /settings sits behind) defaults to screening
	// EVERY catalog list when no selection is stored, so this step also pulls UK
	// and UN. That is deliberate and is NOT relaxed here — narrowing what a KYC
	// workspace screens against would silently drop matches, which is a
	// correctness regression, not an optimisation. The /screen cold path
	// asserted above is the one this change is about.
});
