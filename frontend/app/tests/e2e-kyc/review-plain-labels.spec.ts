import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * Claim: "the Review board shows plain words, never raw codes."
 *
 * Onboard a name that is in the committed signed demo bundle (Ivan Fakovich is
 * OFAC_SDN:0001), open /review, and read what a person actually sees: the
 * rendered text of the main region. The codes (OFAC_SDN, FALSE_POSITIVE, …) must
 * stay the data (option values, exports) and never reach the screen. The
 * disposition select must also show its chosen option in full at a laptop and a
 * phone width (it used to clip to "FALSE_POSI").
 */

const SANCTIONED_NAME = "Ivan Fakovich";
const CUSTOMER_REF = "CUST-PLAIN-001";
const ANALYST = "Plain Words Analyst";
const RAW_CODE =
	/\b(UK_OFSI|OFAC_SDN|EU_CONSOLIDATED|UN_CONSOLIDATED|FALSE_POSITIVE|TRUE_POSITIVE|PENDING_REVIEW|PENDING|STRONG|POSSIBLE)\b/;

function collectConsoleErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
	});
	return errors;
}

async function onboardSanctionedCustomer(page: Page): Promise<void> {
	await page.goto("/customers");
	await expect(page).toHaveTitle(/AML-Filter/i); // port-collision guard
	await page.locator("#analyst-name").fill(ANALYST);
	await page.getByRole("button", { name: /start reviewing/i }).click();
	await expect(
		page.getByRole("heading", { name: "KYC Customer Onboarding" }),
	).toBeVisible();
	await page.locator("#customer-reference").fill(CUSTOMER_REF);
	await page.locator("#customer-name").fill(SANCTIONED_NAME);
	await page.locator("#customer-country").fill("RU");
	await page.getByRole("button", { name: "Onboard" }).click();
	await expect(page.locator(".alert-warning")).toContainText(
		/potential sanctions match/i,
		{ timeout: 120_000 }, // first run downloads the model
	);
}

/** The select shows its chosen option whole: nothing scrolled or squeezed. */
async function expectSelectFullyVisible(select: Locator): Promise<void> {
	const fit = await select.evaluate((el) => {
		const node = el as HTMLSelectElement;
		// The select's natural width: a detached-from-layout clone sized to its
		// own content. The rendered select must be at least that wide.
		const probe = node.cloneNode(true) as HTMLSelectElement;
		probe.style.cssText =
			"position:absolute;visibility:hidden;width:max-content;min-width:0";
		document.body.appendChild(probe);
		const natural = probe.getBoundingClientRect().width;
		probe.remove();
		return {
			scrollWidth: node.scrollWidth,
			clientWidth: node.clientWidth,
			rendered: node.getBoundingClientRect().width,
			natural,
		};
	});
	expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth + 1);
	expect(fit.rendered).toBeGreaterThanOrEqual(fit.natural - 1);
}

test("the Review board shows plain words, never raw codes", async ({
	page,
}) => {
	test.setTimeout(180_000);
	// Declare the all-list throughput capability, as local-kyc-journey does.
	await page.addInitScript(() => {
		Object.defineProperty(navigator, "deviceMemory", {
			configurable: true,
			value: 16,
		});
	});
	const consoleErrors = collectConsoleErrors(page);

	await page.setViewportSize({ width: 1024, height: 800 });
	await onboardSanctionedCustomer(page);

	await page.goto("/review");
	await expect(
		page.getByRole("heading", { name: "Review Board" }),
	).toBeVisible();
	const row = page.locator("tbody tr", { hasText: CUSTOMER_REF });
	await expect(row).toBeVisible();

	// Plain words on screen: the list's name, the tier, the status.
	await expect(row.locator(".badge", { hasText: "US OFAC" })).toBeVisible();
	await expect(
		row.locator(".badge", { hasText: /^(Strong|Possible)$/ }),
	).toBeVisible();
	await expect(
		row.locator(".badge", { hasText: "Needs review" }),
	).toBeVisible();

	// No raw code anywhere in what a person reads.
	const mainText = await page.locator("main").innerText();
	expect(mainText).not.toMatch(RAW_CODE);

	// The codes are still the data behind the words.
	const disposition = row.getByRole("combobox", {
		name: new RegExp(`Disposition for ${CUSTOMER_REF}`),
	});
	await expect(disposition).toHaveValue("FALSE_POSITIVE");
	await expect(disposition.locator("option:checked")).toHaveText("Not a match");

	await expectSelectFullyVisible(disposition);
	await page.setViewportSize({ width: 390, height: 844 });
	await expectSelectFullyVisible(disposition);

	expect(
		consoleErrors,
		`browser console errors:\n${consoleErrors.join("\n")}`,
	).toEqual([]);
});
