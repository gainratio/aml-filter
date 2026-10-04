import { expect, type Page, test } from "@playwright/test";

/**
 * C1 — the Avow score-receipt journey, proven END-TO-END over the minified
 * production build: the engine SEALS each returned match into a signed
 * receipt at screen time, the dossier card DISPLAYS it beside the score, and
 * the card VERIFIES it against this install's own key (the SQLite
 * install_key row the sealer signs with), rendering a fail-closed icon+text
 * verdict (WCAG 1.4.1 — never color-only).
 *
 * The guard is property-based, not shape-based. The second half breaks the
 * trust property for real, through the product: a second tab resets the
 * signing key in Settings (behind its warning). The receipt already on screen
 * in the first tab was signed by the OLD key, so its badge must drop to the
 * distinct "untrusted signer" state; a fresh screen then signs with the NEW
 * key and verifies again. If this guard can no longer go red, it is measuring
 * shape, not the property.
 */

const MODEL_LOAD_TIMEOUT_MS = 160_000;
const RESULT_TIMEOUT_MS = 30_000;

// Mirrors INSTALL_SEED_KEY in packages/amlfilter-browser/src/engine/installKey.ts:
// the localStorage key OLD releases kept the seed under. Nothing may write it now.
const INSTALL_SEED_KEY = "amlfilter.install_signing_seed.v1";
const ANALYST = "C1 Analyst";

function watchErrors(page: Page, errors: string[]): void {
	page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
	page.on("console", (msg) => {
		if (msg.type() === "error") {
			errors.push(`console.error: ${msg.text()}`);
		}
	});
}

/** Open Settings in a second tab and reset the signing key through its warning. */
async function resetKeyInAnotherTab(settings: Page): Promise<void> {
	await settings.goto("/settings", { waitUntil: "domcontentloaded" });
	const analyst = settings.locator("#analyst-name");
	const publicKey = settings.getByTestId("signing-public-key");
	await expect(analyst.or(publicKey)).toBeVisible({ timeout: 60_000 });
	if (await analyst.isVisible()) {
		await analyst.fill(ANALYST);
		await analyst.press("Enter");
	}
	await expect(publicKey).toHaveText(/^[0-9a-f]{64}$/, { timeout: 60_000 });
	const before = await publicKey.textContent();

	await settings.getByRole("button", { name: "Reset signing key…" }).click();
	await expect(
		settings.getByText(
			/can then only be verified with the public key you exported/,
		),
	).toBeVisible();
	await settings
		.getByRole("button", { name: "Delete the key and make a new one" })
		.click();
	await expect(settings.getByText(/Signing key reset/)).toBeVisible();
	await expect(publicKey).not.toHaveText(before ?? "");
}

test("seals → displays → verifies a score receipt in-browser; a reset key fails closed", async ({
	page,
	context,
}) => {
	test.setTimeout(300_000);

	const errors: string[] = [];
	watchErrors(page, errors);

	await page.goto("/screen", { waitUntil: "domcontentloaded" });
	const search = page.getByPlaceholder("Search a name, e.g. Ivan Fakovich");
	await expect(search).toBeVisible();

	// Bootstrap = sync + verify the signed bundle + model download + compile.
	// Race readiness against the error banner so a real boot failure reports
	// immediately instead of looking like a disabled-input hang.
	const alert = page.locator('[role="alert"]');
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

	// --- sign → display → verify: the scored match carries a VERIFIED receipt ---
	await search.fill("Ivan Fakovich");
	const scoredCard = page
		.locator(".match-card:has(.match-card__score)")
		.first();
	await expect(scoredCard.locator(".match-card__name")).toHaveText(
		"Ivan Fakovich",
		{ timeout: RESULT_TIMEOUT_MS },
	);
	const badge = scoredCard.locator(".match-card__head .receipt-status");
	await expect(badge).toHaveAttribute("data-status", "verified", {
		timeout: RESULT_TIMEOUT_MS,
	});
	// Icon + word label — the verdict must survive without color.
	await expect(badge.locator(".receipt-status__text")).toHaveText(
		"Score unaltered",
	);
	await expect(badge.locator(".receipt-status__icon")).toHaveAttribute(
		"aria-hidden",
		"true",
	);
	// Beside the score, not instead of it.
	await expect(scoredCard.locator(".match-card__score")).not.toBeEmpty();

	// The full receipt panel is one disclosure away.
	await scoredCard.locator("details.match-card__receipt > summary").click();
	const panel = scoredCard.locator("section.receipt-panel");
	await expect(panel).toBeVisible();
	await expect(panel).toContainText("Ed25519");
	await expect(panel).toContainText("input fingerprint");

	// The key lives in SQLite on OPFS (no "temporary key" notice), and nothing
	// was written to localStorage.
	await expect(page.getByText(/signing key is temporary/)).toHaveCount(0);
	expect(
		await page.evaluate((key) => localStorage.getItem(key), INSTALL_SEED_KEY),
	).toBeNull();

	// --- break the property, not the form: reset the key from another tab ---
	const settings = await context.newPage();
	watchErrors(settings, errors);
	await resetKeyInAnotherTab(settings);

	// The receipt on screen was signed by the retired key: fail closed.
	await expect(badge).toHaveAttribute("data-status", "wrong-key", {
		timeout: RESULT_TIMEOUT_MS,
	});
	await expect(badge.locator(".receipt-status__text")).toHaveText(
		"Score proof from another device",
	);

	// A fresh screen signs with the NEW key and verifies again.
	await search.fill("");
	await search.fill("fakovic");
	const rekeyedCard = page
		.locator(".match-card:has(.match-card__score)")
		.first();
	await expect(rekeyedCard.locator(".match-card__name")).toHaveText(
		"Ivan Fakovich",
		{ timeout: RESULT_TIMEOUT_MS },
	);
	await expect(
		rekeyedCard.locator(".match-card__head .receipt-status"),
	).toHaveAttribute("data-status", "verified", { timeout: RESULT_TIMEOUT_MS });

	expect(
		errors,
		"console must stay clean through sign → verify → fail-closed",
	).toEqual([]);
});
