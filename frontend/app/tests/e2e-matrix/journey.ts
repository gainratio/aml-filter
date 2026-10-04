import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { expect, type Page } from "@playwright/test";

/**
 * Shared steps for the browser-matrix lane: open /screen over the production
 * build, wait for boot (signed-bundle verify + model + index), run ONE screening
 * of the committed demo sanctioned name, and read the rendered result.
 */

/** Cold boot on a desktop runner: the ~23 MB model compile dominates. */
export const BOOT_TIMEOUT_MS = 180_000;
export const RESULT_TIMEOUT_MS = 30_000;
/** The committed demo bundle's sanctioned entity (OFAC_SDN:0001), as C1 uses. */
export const SANCTIONED_NAME = "Ivan Fakovich";

/** Console errors and page errors seen during the journey. */
export function collectErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
	});
	return errors;
}

/** Open /screen and wait until the search box is enabled. Throws on a boot error banner. */
export async function bootScreen(page: Page): Promise<void> {
	await page.goto("/screen", { waitUntil: "domcontentloaded" });
	const search = page.getByPlaceholder("Search a name, e.g. Ivan Fakovich");
	await expect(search).toBeVisible();
	const alert = page.locator('[role="alert"]');
	// Race readiness against the error banner so a real boot failure is reported
	// immediately, not as a three-minute disabled-input hang.
	const outcome = await Promise.race([
		expect(search)
			.toBeEnabled({ timeout: BOOT_TIMEOUT_MS })
			.then(() => ({ kind: "ready" as const, message: "" })),
		alert
			.waitFor({ state: "visible", timeout: BOOT_TIMEOUT_MS })
			.then(async () => ({
				kind: "error" as const,
				message: (await alert.first().textContent()) ?? "",
			})),
	]);
	if (outcome.kind === "error") {
		throw new Error(`bootstrap errored: ${outcome.message}`);
	}
}

/** Screen the demo sanctioned name and assert a scored, explained hit renders. */
export async function screenSanctionedName(page: Page): Promise<void> {
	const search = page.getByPlaceholder("Search a name, e.g. Ivan Fakovich");
	await search.fill(SANCTIONED_NAME);
	const scoredCard = page
		.locator(".match-card:has(.match-card__score)")
		.first();
	await expect(scoredCard).toBeVisible({ timeout: RESULT_TIMEOUT_MS });
	await expect(scoredCard.locator(".match-card__name")).toHaveText(
		SANCTIONED_NAME,
	);
	const score = Number.parseFloat(
		(await scoredCard.locator(".match-card__score").textContent()) ?? "",
	);
	expect(score, "rendered match score").toBeGreaterThan(0);
	await expect(scoredCard.locator(".match-card__why")).not.toBeEmpty();
}

/**
 * Make `navigator.storage.persist()` never settle, the way Firefox behaves while
 * its permission prompt is open. Counts calls on `window.__amlPersistCalls` so
 * the test can prove the app really asked (the hang was in effect).
 */
export async function forcePersistHang(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const calls = { count: 0 };
		Object.defineProperty(window, "__amlPersistCalls", {
			get: () => calls.count,
		});
		Object.defineProperty(StorageManager.prototype, "persist", {
			configurable: true,
			value: () => {
				calls.count += 1;
				return new Promise<boolean>(() => undefined);
			},
		});
	});
}

/** How many times the page called the forced-hang persist(). */
export function persistCalls(page: Page): Promise<number> {
	return page.evaluate(
		() =>
			(window as unknown as { __amlPersistCalls: number }).__amlPersistCalls,
	);
}

/** Where Playwright's `msedge` channel looks for an installed Edge, per OS. */
const EDGE_PATHS: Readonly<Record<string, readonly string[]>> = {
	darwin: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
	linux: ["/opt/microsoft/msedge/msedge"],
	win32: [
		"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
		"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
	],
};

/** True when a stable Microsoft Edge is installed where the msedge channel expects it. */
export function edgeInstalled(): boolean {
	return (EDGE_PATHS[process.platform] ?? []).some((path) => existsSync(path));
}

/** CPU slowdown the low-end lane applies through CDP. */
export const LOW_END_CPU_THROTTLE = 4;
/** Unthrottled cold boot + one screening on one idle runner. Measured
 * 2026-10-04 on an M-series Mac: Chromium 2.5 s unthrottled, 5.5 s at 4x.
 * 30 s leaves an order of magnitude for a slow shared CI runner. */
export const LOW_END_BASE_BUDGET_MS = 30_000;

/**
 * Time budget for boot + one screening under CPU throttling.
 *
 *   budget = BASE × THROTTLE × contention
 *   contention = max(1, workers / max(1, floor(cores / 2)))
 *
 * BASE is the unthrottled cold boot on one idle runner. THROTTLE multiplies all
 * main-thread work. Each Playwright worker runs its own browser, which itself
 * needs about two cores (page + model/SQLite workers), so once workers exceed
 * cores/2 they queue and the budget grows proportionally. Conservative on
 * purpose: this lane catches order-of-magnitude regressions (a hang, a second
 * model download), not a few seconds of drift.
 */
export function lowEndBudgetMs(
	workers: number,
	cores: number = availableParallelism(),
): number {
	const contention = Math.max(1, workers / Math.max(1, Math.floor(cores / 2)));
	return Math.ceil(LOW_END_BASE_BUDGET_MS * LOW_END_CPU_THROTTLE * contention);
}
