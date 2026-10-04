import { createPrivateKey, createPublicKey } from "node:crypto";
import { expect, type Page, type Request } from "@playwright/test";

/**
 * The post-deploy LIVE smoke — what a real visitor's browser sees on the
 * deployed site, not what the build or the unit tests believe.
 *
 * WHY. On 2026-09-24 aml-filter.com served a weeks-stale UK list while every
 * publish was green, and a sister repo shipped an app that broke for returning
 * visitors because nothing opened the live site in a browser after a deploy.
 * Every check here is one a human would do by hand:
 *   - /screen (the public route, OFAC by design): wait for the signed bundle to
 *     verify in-tab (boot is fail-closed, so a usable search box IS the
 *     verification verdict) and screen a known OFAC name — the match's signed
 *     receipt must say OFAC_SDN and verify.
 *   - the workstation: enable EVERY list in /settings (Apply re-verifies each
 *     one fail-closed), onboard one known designated person per list, and read
 *     the source-list badge off each Review Board row.
 * The console must stay clean the whole way.
 */

import {
	type FailedRequestFacts,
	isExcusedFailedRequest,
	parseContentLength,
} from "./failedRequests";
import { LIST_PROBES, type ListProbe, reviewBadgePattern } from "./probes";

export { type ListProbe, SCREEN_PROBE } from "./probes";

async function fillProbeIdentifiers(
	page: Page,
	probe: ListProbe,
): Promise<void> {
	if (probe.country !== undefined) {
		await page.locator("#customer-country").fill(probe.country);
	}
	if (probe.dob !== undefined) {
		await page.locator("#customer-dob").fill(probe.dob);
	}
}

/** Boot = signed pointer + manifest + every chunk verified + ~23 MB model. */
export const BOOT_TIMEOUT_MS = 180_000;
const RESULT_TIMEOUT_MS = 45_000;
const SEARCH_PLACEHOLDER = "Search a name, e.g. Ivan Fakovich";

/** Everything the console said that a clean run must not contain. */
export interface ConsoleWatch {
	readonly problems: string[];
	/** Resolves once every failed request seen so far has been classified. */
	settled(): Promise<void>;
}

/** The encoded body size Playwright received, or `null` when it cannot say. */
async function receivedBodyBytes(request: Request): Promise<number | null> {
	const sizes = await request.sizes().catch(() => null);
	return sizes?.responseBodySize ?? null;
}

/** Read what Playwright knows about a failed request. */
async function failedRequestFacts(
	request: Request,
	finished: ReadonlySet<Request>,
): Promise<FailedRequestFacts> {
	const response = await request.response().catch(() => null);
	return {
		url: request.url(),
		errorText: request.failure()?.errorText ?? "unknown",
		status: response?.status() ?? null,
		finished: finished.has(request),
		receivedBodyBytes:
			response === null ? null : await receivedBodyBytes(request),
		contentLength: parseContentLength(response?.headers()["content-length"]),
	};
}

/** Add a failed request to `problems` unless it is the pointer request the
 * browser cancelled after its whole body arrived (see failedRequests.ts). */
async function recordFailedRequest(
	request: Request,
	finished: ReadonlySet<Request>,
	problems: string[],
): Promise<void> {
	const facts = await failedRequestFacts(request, finished);
	if (!isExcusedFailedRequest(facts)) {
		problems.push(`requestfailed: ${request.url()} (${facts.errorText})`);
	}
}

/** Record every console error, uncaught exception, and failed same-origin
 * request for the lifetime of the page. */
export function watchConsole(page: Page): ConsoleWatch {
	const problems: string[] = [];
	page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
	page.on("console", (message) => {
		if (message.type() === "error") {
			problems.push(`console.error: ${message.text()}`);
		}
	});
	const pending: Promise<void>[] = [];
	const finished = new Set<Request>();
	page.on("requestfinished", (request) => finished.add(request));
	page.on("requestfailed", (request) => {
		const origin = new URL(page.url() || request.url()).origin;
		if (request.url().startsWith(origin)) {
			pending.push(recordFailedRequest(request, finished, problems));
		}
	});
	return { problems, settled: async () => void (await Promise.all(pending)) };
}

/** A first visit to the workstation asks for an analyst name (stored only in
 * this browser). Answer it like a user; a returning profile skips straight on.
 *
 * The gate is recognised by its "Start reviewing" button, NOT by an "Analyst
 * name" textbox: /settings on an already-onboarded profile has its own "Analyst
 * name" field (to rename yourself), and keying on that sent an onboarded,
 * unprimed returning profile hunting for a gate button that is not there (the
 * 2026-09-28 deploy's @returning failure). */
async function passOnboarding(page: Page): Promise<void> {
	const start = page.getByRole("button", { name: "Start reviewing" });
	const lists = page.locator(
		`#watchlist-${LIST_PROBES[0]?.list ?? "OFAC_SDN"}`,
	);
	await expect(
		start.or(lists).or(page.locator('[role="alert"]')).first(),
	).toBeVisible({
		timeout: BOOT_TIMEOUT_MS,
	});
	await failOnAlert(page, "/settings");
	if (await start.isVisible()) {
		await page
			.getByRole("textbox", { name: "Analyst name" })
			.fill("Live smoke");
		await start.click();
	}
}

/**
 * Turn on every list the way a user does — /settings, tick each list, Apply.
 * A browser the app classes as memory-constrained ("streaming") screens only
 * OFAC until the user opts in, so without this a smoke would prove one list.
 */
export async function enableEveryList(page: Page): Promise<void> {
	await page.goto("/settings", { waitUntil: "domcontentloaded" });
	await passOnboarding(page);
	for (const probe of LIST_PROBES) {
		const box = page.locator(`#watchlist-${probe.list}`);
		await expect(box.or(page.locator('[role="alert"]')).first()).toBeVisible({
			timeout: BOOT_TIMEOUT_MS,
		});
		await failOnAlert(page, "/settings");
		await box.check();
	}
	await page.getByRole("button", { name: "Apply", exact: true }).click();
	const outcome = page.locator('.alert-success[role="status"], [role="alert"]');
	await expect(outcome.first()).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
	await failOnAlert(page, "/settings apply");
}

/** Where releases before the SQLite install key kept the signing seed. */
const LEGACY_SEED_KEY = "amlfilter.install_signing_seed.v1";
/** PKCS#8 DER prefix for a raw 32-byte Ed25519 seed (RFC 8410). */
const ED25519_PKCS8_PREFIX = "302e020100300506032b657004220420";

/** Ed25519 public key (hex) for a seed, derived in Node, never printed. */
function publicKeyOfSeed(seedHex: string): string {
	const privateKey = createPrivateKey({
		key: Buffer.from(ED25519_PKCS8_PREFIX + seedHex, "hex"),
		format: "der",
		type: "pkcs8",
	});
	const spki = createPublicKey(privateKey).export({
		format: "der",
		type: "spki",
	});
	return spki.subarray(-32).toString("hex");
}

/** The public key of an OLD release's localStorage seed, or null if none. */
export async function legacySeedPublicKey(page: Page): Promise<string | null> {
	const seed = await page.evaluate(
		(key) => localStorage.getItem(key),
		LEGACY_SEED_KEY,
	);
	return seed === null ? null : publicKeyOfSeed(seed);
}

/** The public key /settings shows, or null on a release without the card. */
export async function settingsPublicKey(page: Page): Promise<string | null> {
	await page.goto("/settings", { waitUntil: "domcontentloaded" });
	await passOnboarding(page);
	await expect(page.locator("#watchlist-OFAC_SDN")).toBeVisible({
		timeout: BOOT_TIMEOUT_MS,
	});
	const shown = page.getByTestId("signing-public-key");
	if ((await shown.count()) === 0) {
		return null;
	}
	await expect(shown).toHaveText(/^[0-9a-f]{64}$/, { timeout: 30_000 });
	return shown.textContent();
}

/** A visible error banner is the app refusing (e.g. a bundle that failed
 * verification) — report its words immediately instead of timing out. */
async function failOnAlert(page: Page, where: string): Promise<void> {
	const alert = page.locator('[role="alert"]');
	if ((await alert.count()) > 0 && (await alert.first().isVisible())) {
		throw new Error(
			`${where} refused: ${(await alert.first().textContent()) ?? ""}`,
		);
	}
}

/** Wait for the fail-closed boot: either the search box enables (every byte
 * verified) or the error banner appears, which is reported verbatim. */
export async function bootScreen(page: Page): Promise<void> {
	const search = page.getByPlaceholder(SEARCH_PLACEHOLDER);
	await expect(search).toBeVisible({ timeout: 60_000 });
	const alert = page.locator('[role="alert"]');
	const outcome = await Promise.race([
		expect(search)
			.toBeEnabled({ timeout: BOOT_TIMEOUT_MS })
			.then(() => null),
		alert
			.first()
			.waitFor({ state: "visible", timeout: BOOT_TIMEOUT_MS })
			.then(async () => (await alert.first().textContent()) ?? "(empty)"),
	]);
	if (outcome !== null) {
		throw new Error(`live /screen boot failed closed: ${outcome}`);
	}
}

/** Screen one probe and require a match from THAT list with a verified receipt. */
export async function expectListMatch(
	page: Page,
	probe: ListProbe,
): Promise<string> {
	await page.getByPlaceholder(SEARCH_PLACEHOLDER).fill(probe.query);
	const card = page
		.locator(".match-card")
		.filter({ has: page.locator(".match-card__name", { hasText: probe.name }) })
		.filter({
			has: page.locator(".match-card__signal", {
				hasText: `${probe.list}@`,
			}),
		})
		.first();
	await expect(
		card,
		`${probe.list}: "${probe.query}" must match an entity tagged ${probe.list}`,
	).toBeAttached({ timeout: RESULT_TIMEOUT_MS });
	await expect(card.locator(".receipt-status").first()).toHaveAttribute(
		"data-status",
		"verified",
	);
	const watchlist = card.locator(".match-card__signal", {
		hasText: `${probe.list}@`,
	});
	return `${probe.list}: ${await card.locator(".match-card__name").textContent()} (${await watchlist.first().locator("dd").textContent()})`;
}

/** Onboard one customer per list probe; each must raise a potential match. */
export async function onboardEveryProbe(
	page: Page,
	pass: string,
): Promise<ReadonlyMap<string, ListProbe>> {
	const refs = new Map<string, ListProbe>();
	const stamp = Date.now().toString(36);
	for (const probe of LIST_PROBES) {
		const ref = `smoke-${pass}-${probe.list}-${stamp}`;
		await page.goto("/customers", { waitUntil: "domcontentloaded" });
		await expect(
			page.getByRole("heading", { name: "KYC Customer Onboarding" }),
		).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
		await page.locator("#customer-reference").fill(ref);
		await page.locator("#customer-name").fill(probe.query);
		await fillProbeIdentifiers(page, probe);
		await page.getByRole("button", { name: "Onboard" }).click();
		// Wait for EITHER outcome, then require the match: a "no sanctions
		// matches" result fails in seconds with its own words, not a timeout.
		const outcome = page
			.locator(".alert-warning, .alert-success", { hasText: ref })
			.first();
		await expect(outcome).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
		await expect(
			outcome,
			`${probe.list}: onboarding "${probe.query}" must raise a potential match, got: ${await outcome.textContent()}`,
		).toHaveClass(/alert-warning/, { timeout: 1_000 });
		refs.set(ref, probe);
	}
	return refs;
}

/** Every onboarded probe has a Review Board row tagged with ITS list. */
export async function expectReviewRowsPerList(
	page: Page,
	refs: ReadonlyMap<string, ListProbe>,
): Promise<readonly string[]> {
	await page.goto("/review", { waitUntil: "domcontentloaded" });
	await expect(page.getByRole("heading", { name: "Review Board" })).toBeVisible(
		{
			timeout: BOOT_TIMEOUT_MS,
		},
	);
	const evidence: string[] = [];
	for (const [ref, probe] of refs) {
		const row = page
			.locator("tbody tr", { hasText: ref })
			.filter({ hasText: probe.name })
			.filter({
				has: page.locator(".badge-muted", {
					hasText: reviewBadgePattern(probe.list),
				}),
			})
			.first();
		await expect(
			row,
			`${probe.list}: "${probe.query}" must match an entity from ${probe.list}`,
		).toBeVisible({ timeout: RESULT_TIMEOUT_MS });
		evidence.push(
			`${probe.list}: ${(await row.locator("td").nth(2).textContent()) ?? ""}`,
		);
	}
	return evidence;
}

/** The deployed build identity, fetched past every cache. */
export async function liveBuildSha(page: Page): Promise<string> {
	return page.evaluate(async () => {
		const response = await fetch("/build.json", { cache: "no-store" });
		const body = (await response.json()) as { readonly git_sha?: unknown };
		return typeof body.git_sha === "string" ? body.git_sha : "(none)";
	});
}

/** How many top-level entries this origin's OPFS holds — nonzero proves a
 * profile really is a RETURNING visitor with a cached bundle. */
export async function opfsEntryCount(page: Page): Promise<number> {
	return page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		let count = 0;
		for await (const _ of (
			root as unknown as { keys(): AsyncIterable<string> }
		).keys()) {
			count += 1;
		}
		return count;
	});
}
