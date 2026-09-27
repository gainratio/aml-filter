import { expect, test } from "@playwright/test";

/**
 * C1 — the Avow score-receipt journey, proven END-TO-END over the minified
 * production build: the engine SEALS each returned match into a signed
 * receipt at screen time, the dossier card DISPLAYS it beside the score, and
 * the card VERIFIES it against this install's own key (read from the same
 * localStorage the sealer signs with), rendering a fail-closed icon+text
 * verdict (WCAG 1.4.1 — never color-only).
 *
 * The guard is property-based, not shape-based. The second half breaks the
 * trust property for real: the engine pins its signing key at first seal
 * (createMatchReceiptSealer caches the key promise for its lifetime), so
 * overwriting the stored install seed AFTER a verified screen makes every
 * subsequent receipt arrive signed by a key that no longer matches the store.
 * The badge must drop to the distinct "untrusted signer" failure state — if
 * this guard can no longer go red, it is measuring shape, not the property.
 */

const MODEL_LOAD_TIMEOUT_MS = 160_000;
const RESULT_TIMEOUT_MS = 30_000;

// Mirrors INSTALL_SEED_KEY in packages/amlfilter-browser/src/engine/installKey.ts
// (a versioned wire constant). Asserted on purpose: a silent storage-key rename
// would de-couple signer and verifier, and this guard must fail loudly then.
const INSTALL_SEED_KEY = "amlfilter.install_signing_seed.v1";

test("seals → displays → verifies a score receipt in-browser; a rekeyed store fails closed", async ({
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

	// --- break the property, not the form: re-key the store under the sealer ---
	const seedSwapped = await page.evaluate((storageKey) => {
		const previous = localStorage.getItem(storageKey);
		const seed = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
			b.toString(16).padStart(2, "0"),
		).join("");
		localStorage.setItem(storageKey, seed);
		return previous !== null && previous !== seed;
	}, INSTALL_SEED_KEY);
	expect(
		seedSwapped,
		"a stored seed must have existed to swap — the sealer signed with it",
	).toBe(true);

	await search.fill("");
	await search.fill("fakovic");
	const rekeyedCard = page
		.locator(".match-card:has(.match-card__score)")
		.first();
	await expect(rekeyedCard.locator(".match-card__name")).toHaveText(
		"Ivan Fakovich",
		{ timeout: RESULT_TIMEOUT_MS },
	);
	const rekeyedBadge = rekeyedCard.locator(".match-card__head .receipt-status");
	await expect(rekeyedBadge).toHaveAttribute("data-status", "wrong-key", {
		timeout: RESULT_TIMEOUT_MS,
	});
	await expect(rekeyedBadge.locator(".receipt-status__text")).toHaveText(
		"Score proof from another device",
	);

	expect(
		errors,
		"console must stay clean through sign → verify → fail-closed",
	).toEqual([]);
});
