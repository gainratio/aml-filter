import { expect, type Page, type Route, test } from "@playwright/test";
import { bootScreen, watchConsole } from "../e2e-live/liveSmoke";

/**
 * The live smoke's own checks still go red when the signed pointer TRULY fails.
 *
 * A failed live smoke rolls production back, and the smoke excuses one
 * `net::ERR_ABORTED` on `/bundle/origin/latest` (see e2e-live/failedRequests.ts).
 * These tests prove that excuse never hides a real pointer failure: with the
 * pointer aborted, answered 500, or tampered with, the smoke's boot check
 * (`bootScreen`) and console watch (`watchConsole`) must report it. A fresh
 * context has no cached bundle, so the app has nothing to fall back to and
 * must fail closed. The unrouted control proves the same checks pass when the
 * pointer is fine, so a red here is the routing, not a broken harness.
 */

const POINTER = "**/bundle/origin/latest";

interface SmokeVerdict {
	/** `null` when /screen booted; otherwise why `bootScreen` refused. */
	readonly bootFailure: string | null;
	readonly problems: ReadonlyArray<string>;
}

async function runSmokeChecks(page: Page): Promise<SmokeVerdict> {
	const watch = watchConsole(page);
	await page.goto("/screen", { waitUntil: "domcontentloaded" });
	const bootFailure = await bootScreen(page).then(
		() => null,
		(error: unknown) =>
			error instanceof Error ? error.message : String(error),
	);
	await watch.settled();
	return { bootFailure, problems: [...watch.problems] };
}

/** The real signed pointer with its sequence bumped: still valid JSON, but the
 * Ed25519 signature no longer covers it. */
async function tamperedPointer(route: Route): Promise<void> {
	const response = await route.fetch();
	const pointer = (await response.json()) as Record<string, unknown>;
	expect(typeof pointer.sequence, "the pointer carries a sequence").toBe(
		"number",
	);
	const tampered = { ...pointer, sequence: Number(pointer.sequence) + 1 };
	await route.fulfill({ response, body: JSON.stringify(tampered) });
}

test.describe.configure({ timeout: 240_000 });

test("control: an untouched pointer boots with a clean console", async ({
	page,
}) => {
	const verdict = await runSmokeChecks(page);
	expect(verdict.bootFailure).toBeNull();
	expect(verdict.problems).toEqual([]);
});

test("a pointer aborted with no response fails the smoke", async ({ page }) => {
	await page.route(POINTER, (route) => route.abort("aborted"));
	const verdict = await runSmokeChecks(page);
	expect(verdict.bootFailure, "boot must fail closed").not.toBeNull();
	expect(verdict.problems).toContainEqual(
		expect.stringMatching(
			/^requestfailed: .*\/bundle\/origin\/latest \(net::ERR_ABORTED\)$/,
		),
	);
});

test("a pointer answered 500 fails the smoke", async ({ page }) => {
	await page.route(POINTER, (route) =>
		route.fulfill({ status: 500, body: "upstream error" }),
	);
	const verdict = await runSmokeChecks(page);
	expect(verdict.bootFailure, "boot must fail closed").not.toBeNull();
});

test("a tampered pointer fails the smoke", async ({ page }) => {
	await page.route(POINTER, tamperedPointer);
	const verdict = await runSmokeChecks(page);
	expect(verdict.bootFailure, "boot must fail closed").not.toBeNull();
});
