import { expect, type Page, test } from "@playwright/test";

/**
 * The /customers row and the /screen result copy, driven like a person in real
 * Chromium against the production build and the committed signed demo bundle.
 *
 * Guards three user-facing promises:
 *   1. A clean customer reads "No matches" — never the raw `PENDING_REVIEW`
 *      onboarding code, no raw enum anywhere in the row, and never the
 *      workstation's internal `local` actor id.
 *   2. Each row is one compact action group (Edit, Delete) with no dropdowns,
 *      and it still fits a phone-width viewport without the page scrolling
 *      sideways.
 *   3. On /screen, "N potential match(es)" is never next to a cap note that
 *      claims to be "showing" more cards than are on screen.
 *
 * Screenshots go to UX_SHOT_DIR when it is set (a validation run), else nowhere.
 */

const MODEL_LOAD_TIMEOUT_MS = 160_000;
const CLEAN_REF = "E2E-CLEAN-001";
// A made-up name with nothing like it on any list.
const CLEAN_NAME = "Quillon Vantressa Obbledorf";
const SHOT_DIR = process.env.UX_SHOT_DIR;

async function shot(page: Page, name: string): Promise<void> {
	if (SHOT_DIR) {
		await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
	}
}

function collectErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
	});
	return errors;
}

test("a clean customer row reads in plain words with one compact action group", async ({
	page,
}) => {
	test.setTimeout(240_000);
	const errors = collectErrors(page);

	await page.goto("/customers");
	await expect(page).toHaveTitle(/AML-Filter/i);
	await expect(
		page.getByRole("heading", { name: /welcome to the workstation/i }),
	).toBeVisible();
	await page.locator("#analyst-name").fill("E2E Analyst");
	await page.getByRole("button", { name: /start reviewing/i }).click();
	await expect(
		page.getByRole("heading", { name: "KYC Customer Onboarding" }),
	).toBeVisible();

	// Onboarded with no analyst name typed, so the store stamps `local`.
	await page.locator("#customer-reference").fill(CLEAN_REF);
	await page.locator("#customer-name").fill(CLEAN_NAME);
	await page.getByRole("button", { name: "Onboard" }).click();
	await expect(page.locator(".alert-success")).toContainText(
		/no sanctions matches/i,
		{ timeout: 120_000 },
	);

	const row = page.locator("tbody tr", { hasText: CLEAN_REF });
	await expect(row).toBeVisible();
	await expect(row.getByText("No matches")).toBeVisible();
	await expect(row.getByText("Awaiting approval")).toBeVisible();
	await expect(row.getByText("Not rated")).toBeVisible();
	await expect(row.getByText("No name given")).toBeVisible();
	const rowText = (await row.textContent()) ?? "";
	expect(rowText).not.toMatch(/PENDING_REVIEW|UNRATED|pending review/i);
	expect(rowText).not.toMatch(/\blocal\b/);

	await expect(row.getByRole("combobox")).toHaveCount(0);
	const actions = row.getByRole("group", { name: `Actions for ${CLEAN_REF}` });
	await expect(actions.getByRole("button")).toHaveCount(2);
	await shot(page, "ux-customers-row");

	// Edit opens one labelled editor; status reads in words there too.
	await row.getByRole("button", { name: `Edit ${CLEAN_REF}` }).click();
	const editor = page.getByRole("group", { name: `Editing ${CLEAN_REF}` });
	await expect(editor).toBeVisible();
	await expect(
		editor.getByLabel(`Status for ${CLEAN_REF}`).locator("option:checked"),
	).toHaveText("Awaiting approval");
	await shot(page, "ux-customers-editor");
	await editor.getByRole("button", { name: "Cancel" }).click();

	// Phone width: the row still fits; the page never scrolls sideways.
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(row).toBeVisible();
	// Every value and both actions are on screen, not behind a sideways scroll.
	for (const target of [
		row.getByText("No matches"),
		row.getByRole("button", { name: `Edit ${CLEAN_REF}` }),
		row.getByRole("button", { name: `Delete ${CLEAN_REF}` }),
	]) {
		const box = await target.boundingBox();
		expect(box, "element has a layout box").not.toBeNull();
		// Right edge inside the 390px viewport (a box clipped by the table's
		// scroll container still reports its true page x).
		expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
	}
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - window.innerWidth,
	);
	expect(overflow).toBeLessThanOrEqual(0);
	await shot(page, "ux-customers-phone");

	expect(errors, `in-browser errors:\n${errors.join("\n")}`).toEqual([]);
});

test("/screen never shows a match count next to a 'showing N' cap it does not show", async ({
	page,
}) => {
	test.setTimeout(240_000);
	const errors = collectErrors(page);

	await page.goto("/screen", { waitUntil: "domcontentloaded" });
	const search = page.getByPlaceholder("Search a name, e.g. Ivan Fakovich");
	await expect(search).toBeEnabled({ timeout: MODEL_LOAD_TIMEOUT_MS });
	// "Jane Smith" is the live-site report; the demo bundle is synthetic, so a
	// broad token ("bank") is also run to reach a fuller candidate list. The
	// unit suite pins the exact 1-of-25 case; here every outcome must hold the
	// same invariant on the real build.
	for (const query of ["Jane Smith", "bank"]) {
		await search.fill(query);
		await assertCopyIsConsistent(page);
		await shot(page, `ux-screen-${query.toLowerCase().replace(/\s+/g, "-")}`);
	}

	expect(errors, `in-browser errors:\n${errors.join("\n")}`).toEqual([]);
});

async function assertCopyIsConsistent(page: Page): Promise<void> {
	await expect(page.getByText("Searching…")).toHaveCount(0, {
		timeout: 30_000,
	});
	await expect(
		page
			.locator(
				".screen-results__count, .screen-results__none, .screen-results--clear",
			)
			.first(),
	).toBeVisible({ timeout: 30_000 });
	const count = page.locator(".screen-results__count");
	if ((await count.count()) > 0) {
		const text = (await count.textContent()) ?? "";
		const n = Number(/^(\d+) potential match/.exec(text)?.[1]);
		expect(Number.isInteger(n), `count line: ${text}`).toBe(true);
		// The count is exactly the primary cards on screen.
		await expect(
			page.locator(".screen-results > .screen-results__list > .match-card"),
		).toHaveCount(n);
	}
	const capped = page.locator(".screen-results__capped");
	if ((await capped.count()) > 0) {
		await expect(capped).not.toContainText(/showing/i);
		await expect(capped).toContainText("closest names");
	}
}
