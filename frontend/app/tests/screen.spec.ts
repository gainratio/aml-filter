import { expect, test } from "@playwright/test";

// The in-browser OFAC screening page is a PUBLIC route (no auth) that boots the
// signed-bundle sync + MiniLM embedder in Web Workers on mount. A full sync +
// model download needs a served bundle origin and ~23 MB of weights, which is a
// heavier integration lane (covered by the C1 spec); this spec validates the
// page's static shell, its public-route reachability, and the attribution
// footer — all of which render immediately, before the async bootstrap resolves.

test.describe("In-browser OFAC screening page", () => {
	test("is reachable without logging in", async ({ page }) => {
		await page.goto("http://localhost:5173/screen");
		await expect(page).toHaveURL(/.*screen/);
		await expect(page.locator("h1")).toContainText("Search the sanctions list");
	});

	test("explains it runs in the browser with nothing leaving the device", async ({
		page,
	}) => {
		await page.goto("http://localhost:5173/screen");
		// "leaves your device" appears in both the lede and the footer; scope to
		// the lede so the locator resolves to a single element.
		await expect(page.locator(".screen-page__lede")).toContainText(
			"leaves your device",
		);
	});

	test("renders the search box and example chips", async ({ page }) => {
		await page.goto("http://localhost:5173/screen");
		await expect(
			page.getByPlaceholder("Search a name, e.g. Ivan Fakovich"),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Ivan Fakovich" }),
		).toBeVisible();
	});

	test("shows a boot/status banner while the bundle loads", async ({
		page,
	}) => {
		await page.goto("http://localhost:5173/screen");
		// role=status (booting) or role=alert (error) — either proves the runtime
		// kicked off; both are deterministic without a served bundle.
		await expect(
			page.locator('[role="status"], [role="alert"]').first(),
		).toBeVisible();
	});

	test("credits the public OFAC list in the footer (attribution)", async ({
		page,
	}) => {
		await page.goto("http://localhost:5173/screen");
		// Scope to the footer: "OFAC" also appears in the page lede, so a bare
		// getByText would be a strict-mode multi-match.
		const footer = page.locator("footer.screen-footer");
		await expect(footer).not.toContainText("demo");
		await expect(footer).toContainText("Not legal or compliance advice");
		await expect(footer).toContainText("OFAC");
		await expect(footer).toContainText("NOTICE");
	});

	test("is linked from the global nav", async ({ page }) => {
		await page.goto("http://localhost:5173/");
		await page.click("text=Screen");
		await expect(page).toHaveURL(/.*screen/);
	});
});
