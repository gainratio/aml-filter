import { expect, test } from "@playwright/test";

/**
 * e2e-kyc — the right to erasure still works now that `match_events` is
 * append-only IN THE DATABASE (schema v4).
 *
 * Why this needs a browser and not another unit test. The unit suite proves the
 * triggers against `:memory:`; this proves the same code against the real
 * opfs-sahpool VFS, which is browser-only and which the workstation package's
 * vitest config explicitly defers to Playwright. Two things can only fail here:
 *
 *   1. `migrate()` verifies `PRAGMA recursive_triggers` took effect and throws if
 *      it did not. That check runs on the persistent connection, after
 *      `configurePersistentPrivacy` has already changed journal_mode and
 *      secure_delete. If the pragma did not hold under OPFS, the workstation
 *      would fail to boot at all and every assertion below would fall over.
 *
 *   2. `deleteCustomer` now deletes the customer BEFORE its events, because the
 *      BEFORE DELETE trigger refuses any delete whose customer still exists.
 *      That ordering is the only sequence the database permits, so if it were
 *      wrong the delete would abort and the row would stay on screen — which is
 *      exactly what this test would catch.
 *
 * The customer is deliberately a sanctioned name that is screened and then
 * DISPOSITIONED first, so the ledger genuinely holds events (with a reviewer
 * identity and notes on them) at the moment of deletion. Erasing an empty trail
 * would prove nothing.
 *
 * Driven against the MINIFIED production build over the COMMITTED signed bundle,
 * per the CLAUDE.md browser-validation mandate. `http://localhost` is a secure
 * context — REQUIRED for OPFS.
 */

// Entity OFAC_SDN:0001 in the committed signed OFAC list — the same name the
// journey and C1 specs match against.
const SANCTIONED_NAME = "Ivan Fakovich";
const CUSTOMER_REF = "CUST-ERASURE-001";
const ANALYST = "Erasure Analyst";
const REVIEW_NOTES = "Private review context that must not survive deletion.";

test("a customer with a non-empty audit trail can still be erased, trail and all", async ({
	page,
}) => {
	test.setTimeout(180_000);

	const consoleErrors: string[] = [];
	page.on("pageerror", (err) =>
		consoleErrors.push(`pageerror: ${err.message}`),
	);
	page.on("console", (msg) => {
		if (msg.type() === "error")
			consoleErrors.push(`console.error: ${msg.text()}`);
	});

	// The delete button goes through window.confirm; accept it.
	page.on("dialog", (dialog) => {
		void dialog.accept();
	});

	// --- Boot + the one-time analyst gate (a SQLite settings row). ----------
	await page.goto("/customers");
	await expect(page).toHaveTitle(/AML-Filter/i); // port-collision guard
	await expect(
		page.getByRole("heading", { name: /welcome to the workstation/i }),
	).toBeVisible();
	await page.locator("#analyst-name").fill(ANALYST);
	await page.getByRole("button", { name: /start reviewing/i }).click();
	await expect(
		page.getByRole("heading", { name: "KYC Customer Onboarding" }),
	).toBeVisible();

	// --- Onboard a sanctioned name: this writes a DETECTED event. -----------
	await page.locator("#customer-reference").fill(CUSTOMER_REF);
	await page.locator("#customer-name").fill(SANCTIONED_NAME);
	await page.locator("#customer-country").fill("RU");
	await page.getByRole("button", { name: "Onboard" }).click();
	await expect(page.locator(".alert-warning")).toContainText(
		/potential sanctions match/i,
		{ timeout: 120_000 }, // first run compiles the ~23 MB model in-tab
	);

	// --- Dispose of it with notes: this writes a DISPOSITIONED event carrying
	//     a reviewer identity, so the trail is genuinely non-empty. -----------
	await page.goto("/review");
	await expect(
		page.getByRole("heading", { name: "Review Board" }),
	).toBeVisible();
	const row = page.locator("tbody tr", { hasText: CUSTOMER_REF });
	await expect(row).toBeVisible();
	await row
		.getByRole("combobox", {
			name: new RegExp(`Disposition for ${CUSTOMER_REF}`),
		})
		.selectOption("FALSE_POSITIVE");
	await row
		.getByRole("textbox", { name: new RegExp(`Notes for ${CUSTOMER_REF}`) })
		.fill(REVIEW_NOTES);
	await row.getByRole("button", { name: "Resolve" }).click();
	await expect(row.locator(".badge", { hasText: "Not a match" })).toBeVisible();

	// The History drawer reads match_events directly — seeing both entries is the
	// proof the ledger is populated before we try to erase it.
	await row.getByRole("button", { name: /history/i }).click();
	await expect(page.getByText("Decision recorded")).toBeVisible();

	// --- Erase the customer. This is the ONE sanctioned removal, and it is the
	//     path whose statement order the append-only trigger constrains. -------
	await page.goto("/customers");
	const customerRow = page.locator("tbody tr", { hasText: CUSTOMER_REF });
	await expect(customerRow).toBeVisible();
	await customerRow.getByRole("button", { name: "Delete" }).click();

	// Gone from the list, and no "Failed to delete customer" banner — a trigger
	// refusal would surface exactly there instead of removing the row.
	await expect(
		page.getByRole("cell", { name: CUSTOMER_REF, exact: true }),
	).toHaveCount(0);
	await expect(page.getByText(/failed to delete customer/i)).toHaveCount(0);

	// --- It stays erased across a reload: the delete really hit OPFS, it was not
	//     just optimistic UI state. And the match it owned is gone from the board,
	//     which is the cascade working under the new statement order. -----------
	await page.reload();
	await expect(
		page.getByRole("heading", { name: "KYC Customer Onboarding" }),
	).toBeVisible();
	await expect(
		page.getByRole("cell", { name: CUSTOMER_REF, exact: true }),
	).toHaveCount(0);

	await page.goto("/review");
	await expect(
		page.getByRole("heading", { name: "Review Board" }),
	).toBeVisible();
	await expect(page.locator("tbody tr", { hasText: CUSTOMER_REF })).toHaveCount(
		0,
	);
	// The reviewer's notes went with it — the erasure is of the trail, not just
	// the customer row.
	await expect(page.getByText(REVIEW_NOTES)).toHaveCount(0);

	expect(consoleErrors).toEqual([]);
});
