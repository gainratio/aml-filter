import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type BrowserContext,
	chromium,
	expect,
	type Page,
	test,
} from "@playwright/test";
import {
	BOOT_TIMEOUT_MS,
	bootScreen,
	type ConsoleWatch,
	enableEveryList,
	expectListMatch,
	expectReviewRowsPerList,
	legacySeedPublicKey,
	liveBuildSha,
	onboardEveryProbe,
	opfsEntryCount,
	SCREEN_PROBE,
	settingsPublicKey,
	watchConsole,
} from "./liveSmoke";

/**
 * Three passes, selected with --grep (see playwright.live.config.ts):
 *
 *   @fresh      a brand-new profile — the first-time visitor. The scheduled
 *               probe runs only this.
 *   @prime      run BEFORE a deploy against what is live now (the previous
 *               good release): leaves a profile whose OPFS holds that bundle.
 *   @returning  run AFTER the deploy with the primed profile: open, RELOAD,
 *               and screen — the returning visitor whose cache predates the
 *               deploy. This is the path that broke silently next door.
 */

const PROFILE = process.env.LIVE_SMOKE_PROFILE ?? "";
const EXPECT_SHA = process.env.LIVE_SMOKE_EXPECT_SHA ?? "";
const PRIME_MARKER = ".live-smoke-prime.json";
/** Set when the previous release's warm index is known stale (a marker-scheme
 * change or a different signed list): the first load must REBUILD it. */
const EXPECT_INDEX_REBUILD =
	process.env.LIVE_SMOKE_EXPECT_INDEX_REBUILD === "1";

interface IndexOpens {
	readonly rebuilt: number;
	readonly reused: number;
}

/** How many watchlist indexes this page rebuilt vs reused (see vectorIndex.ts). */
async function indexOpens(page: Page): Promise<IndexOpens> {
	return page.evaluate(() => {
		const { amlIndexRebuilt, amlIndexReused } =
			document.documentElement.dataset;
		return {
			rebuilt: Number(amlIndexRebuilt ?? 0),
			reused: Number(amlIndexReused ?? 0),
		};
	});
}

/** Wait for the first index open, then require it to be a rebuild when one is expected. */
async function expectIndexOpens(page: Page): Promise<IndexOpens> {
	await expect
		.poll(
			async () => {
				const opens = await indexOpens(page);
				return opens.rebuilt + opens.reused;
			},
			{ timeout: 120_000 },
		)
		.toBeGreaterThan(0);
	const opens = await indexOpens(page);
	if (EXPECT_INDEX_REBUILD) {
		expect(opens.reused, "a stale warm index must never be reused").toBe(0);
		expect(opens.rebuilt).toBeGreaterThan(0);
	}
	return opens;
}

function requireProfile(): string {
	if (PROFILE === "") {
		throw new Error(
			"LIVE_SMOKE_PROFILE must name the returning-visitor profile",
		);
	}
	mkdirSync(PROFILE, { recursive: true });
	return PROFILE;
}

async function persistentPage(
	baseURL: string,
): Promise<{ context: BrowserContext; page: Page }> {
	const context = await chromium.launchPersistentContext(requireProfile(), {
		baseURL,
		headless: true,
	});
	return { context, page: context.pages()[0] ?? (await context.newPage()) };
}

async function expectCleanConsole(watch: ConsoleWatch): Promise<void> {
	await watch.settled();
	expect(watch.problems, "the console must stay clean").toEqual([]);
}

async function expectDeployedSha(page: Page): Promise<void> {
	if (EXPECT_SHA !== "") {
		expect(await liveBuildSha(page), "live build identity").toBe(EXPECT_SHA);
	}
}

/** /screen (public, OFAC) then the four-list workstation journey. */
async function screenAndWorkstation(page: Page, pass: string): Promise<string> {
	await page.goto("/screen", { waitUntil: "domcontentloaded" });
	await bootScreen(page);
	const screened = await expectListMatch(page, SCREEN_PROBE);
	const refs = await onboardEveryProbe(page, pass);
	const rows = await expectReviewRowsPerList(page, refs);
	return [`/screen ${screened}`, ...rows].join(" | ");
}

/**
 * A returning visitor keeps their receipt signing key: the old localStorage
 * seed is gone (moved into SQLite), and /settings shows the SAME public key
 * that signed the previous release's receipts — so those receipts still verify.
 */
async function expectSigningKeyCarriedOver(
	page: Page,
	markerPath: string,
): Promise<string> {
	expect(
		await legacySeedPublicKey(page),
		"the old localStorage seed must be retired after the SQLite migration",
	).toBeNull();
	const current = await settingsPublicKey(page);
	expect(current, "/settings shows the signing key").toMatch(/^[0-9a-f]{64}$/);
	const primed: { installKey?: string | null } = existsSync(markerPath)
		? JSON.parse(readFileSync(markerPath, "utf8"))
		: {};
	if (typeof primed.installKey === "string") {
		expect(current, "signing key carried over from the previous release").toBe(
			primed.installKey,
		);
		return `signing key carried over (${current?.slice(0, 12)}…)`;
	}
	return "signing key present (previous release recorded none)";
}

test.describe.configure({ timeout: BOOT_TIMEOUT_MS * 2 + 120_000 });

test("@fresh a first-time visitor screens every list on the live site", async ({
	page,
}, testInfo) => {
	const watch = watchConsole(page);
	const response = await page.goto("/screen", {
		waitUntil: "domcontentloaded",
	});
	expect(response?.status(), "GET /screen").toBe(200);
	await enableEveryList(page);
	const evidence = await screenAndWorkstation(page, "fresh");
	await expectDeployedSha(page);
	await expectCleanConsole(watch);
	testInfo.annotations.push({ type: "matches", description: evidence });
	console.log(`[live-smoke fresh] ${evidence}`);
});

test("@prime cache the currently-live release into the returning profile", async ({
	baseURL,
}) => {
	const { context, page } = await persistentPage(baseURL ?? "");
	try {
		await enableEveryList(page);
		await screenAndWorkstation(page, "prime");
		// The key that signed this release's receipts: an old release keeps its
		// seed in localStorage, a newer one shows it in /settings.
		const installKey =
			(await legacySeedPublicKey(page)) ?? (await settingsPublicKey(page));
		const marker = {
			sha: await liveBuildSha(page),
			opfs: await opfsEntryCount(page),
			installKey,
		};
		writeFileSync(join(PROFILE, PRIME_MARKER), JSON.stringify(marker));
		console.log(
			`[live-smoke prime] primed against ${marker.sha} (opfs entries ${marker.opfs})`,
		);
	} finally {
		await context.close();
	}
});

test("@returning a visitor cached on the previous release reloads and screens", async ({
	baseURL,
}, testInfo) => {
	const markerPath = join(requireProfile(), PRIME_MARKER);
	const primed = existsSync(markerPath);
	const { context, page } = await persistentPage(baseURL ?? "");
	try {
		const watch = watchConsole(page);
		await page.goto("/robots.txt");
		const cached = await opfsEntryCount(page);
		if (primed) {
			const marker = readFileSync(markerPath, "utf8");
			expect(
				cached,
				`primed profile must hold a cached bundle (${marker})`,
			).toBeGreaterThan(0);
		} else {
			// Priming ran against whatever was live BEFORE this deploy; if that was
			// already broken, a returning pass on an unprimed profile is the best
			// available — say so loudly rather than fail a deploy that may be the fix.
			testInfo.annotations.push({
				type: "warning",
				description: "profile NOT primed",
			});
			console.log(
				"[live-smoke returning] WARNING: profile was not primed by the previous release",
			);
		}
		if (!primed) {
			await enableEveryList(page);
		}
		await page.goto("/screen", { waitUntil: "domcontentloaded" });
		await bootScreen(page);
		const firstLoad = await expectIndexOpens(page);
		await page.reload({ waitUntil: "domcontentloaded" });
		const evidence = await screenAndWorkstation(page, "returning");
		const reload = await indexOpens(page);
		const signing = await expectSigningKeyCarriedOver(page, markerPath);
		await expectDeployedSha(page);
		await expectCleanConsole(watch);
		console.log(
			`[live-smoke returning] cached opfs entries=${cached}; index first load rebuilt=${firstLoad.rebuilt} reused=${firstLoad.reused}; after reload rebuilt=${reload.rebuilt} reused=${reload.reused}; ${signing}; ${evidence}`,
		);
	} finally {
		await context.close();
	}
});
