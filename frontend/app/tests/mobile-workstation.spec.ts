import { expect, test } from "@playwright/test";

async function expectNoHorizontalOverflow(
	page: import("@playwright/test").Page,
) {
	await expect
		.poll(() =>
			page.evaluate(
				() => document.documentElement.scrollWidth - window.innerWidth,
			),
		)
		.toBeLessThanOrEqual(0);
}

async function exerciseConstrainedResultWidths(
	page: import("@playwright/test").Page,
) {
	const unbrokenEvidence = "AML-UNBROKEN-EVIDENCE-ID-".repeat(8);
	await page
		.locator(".match-card")
		.first()
		.evaluate((card, value) => {
			for (const selector of [".match-card__name", ".match-card__fact dd"]) {
				const target = card.querySelector(selector);
				if (target !== null) target.textContent = value;
			}
		}, unbrokenEvidence);
	for (const width of [320, 390, 430]) {
		await page.setViewportSize({ width, height: 664 });
		await expectNoHorizontalOverflow(page);
	}
}

test("screening boots when WebKit exposes OPFS but cannot open it", async ({
	page,
}) => {
	test.setTimeout(180_000);
	const consoleErrors: string[] = [];
	const requestOrigins = new Set<string>();
	page.on("request", (request) => {
		requestOrigins.add(new URL(request.url()).origin);
	});
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	page.on("pageerror", (error) => consoleErrors.push(error.message));

	await page.goto("/screen");
	const expectedOrigin = new URL(page.url()).origin;
	const search = page.getByLabel("Search the sanctions list", { exact: true });
	await expectNoHorizontalOverflow(page);
	await expect(search).toBeEnabled({ timeout: 120_000 });
	await search.fill("Ivan Fakovich");
	await expect(page.getByText(/potential match/i).first()).toBeVisible({
		timeout: 30_000,
	});
	await expectNoHorizontalOverflow(page);
	await exerciseConstrainedResultWidths(page);

	await page.reload();
	await expect(search).toBeEnabled({ timeout: 120_000 });
	await expectNoHorizontalOverflow(page);
	await expect(
		page.getByRole("alert").filter({ hasText: "Browser memory limit reached" }),
	).toHaveCount(0);
	expect([...requestOrigins]).toEqual([expectedOrigin]);
	expect(consoleErrors).toEqual([]);
});

/**
 * Settings must be usable on constrained browsers without constructing the
 * ONNX/WASM model. This catches the production failure where Safari reported
 * an out-of-memory engine error before the user had requested screening.
 */
test("settings defers model/WASM allocation on mobile profiles", async ({
	page,
}) => {
	const modelRequests: string[] = [];
	const consoleErrors: string[] = [];
	page.on("request", (request) => {
		if (/\/(?:models|ort)\//.test(request.url())) {
			modelRequests.push(request.url());
		}
	});
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	page.on("pageerror", (error) => consoleErrors.push(error.message));

	await page.goto("/settings");
	const name = page.getByLabel("Analyst name", { exact: true });
	const dbError = page
		.getByRole("alert")
		.filter({ hasText: "Local workspace unavailable" });
	await expect(name.or(dbError)).toBeVisible({ timeout: 30_000 });
	// Playwright's bundled WebKit does not expose the OPFS/SQLite worker surface
	// used by the workstation (real iOS Safari does). Keep this result explicit
	// rather than treating an emulator limitation as a product pass/failure.
	if (await dbError.isVisible()) {
		test.skip(
			true,
			"Playwright WebKit lacks the OPFS/SQLite surface required by the workstation; verify on physical iOS Safari",
		);
	}

	await name.fill("Mobile Smoke Analyst");
	await page.getByRole("button", { name: "Start reviewing" }).click();

	await expect(
		page.getByRole("heading", { level: 1, name: "Settings" }),
	).toBeVisible();
	await expect(page.getByText("Loading settings…")).not.toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Cached lists" }),
	).toBeVisible();

	// Give background effects a chance to run. A settings visit must not fetch
	// the model or ORT WASM; screening routes own that explicit allocation.
	await page.waitForTimeout(500);
	expect(modelRequests).toEqual([]);
	expect(consoleErrors).toEqual([]);
});

/**
 * The search scope per device. A phone starts on US OFAC only (all four lists
 * eagerly ran iOS Safari out of memory, PR #71) and SAYS so, with a one-tap
 * switch to every list; that switch uses bounded streaming residency and must
 * find a name that exists only on the UK list. The desktop control searches all
 * four from the start.
 */
test("a phone says it searches US OFAC only and can include every list in one tap", async ({
	page,
}, testInfo) => {
	test.setTimeout(240_000);
	const consoleErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	page.on("pageerror", (error) => consoleErrors.push(error.message));

	await page.goto("/screen");
	const search = page.getByLabel("Search the sanctions list", { exact: true });
	await expect(search).toBeEnabled({ timeout: 120_000 });
	const scope = page.locator(".screen-scope");

	if (testInfo.project.name !== "desktop-control") {
		await expect(scope).toContainText(
			"Searching US OFAC only on this device, to save memory.",
		);
		await scope.getByRole("button", { name: "Search all 4 lists" }).click();
		await expect(search).toBeEnabled({ timeout: 120_000 });
		await expect(scope).toContainText("Each search takes a few seconds");
	}
	await expect(scope).toContainText("Searching 4 lists:");

	await search.fill("Imaginary Logistics Ltd");
	const top = page.locator(".match-card:has(.match-card__score)").first();
	await expect(top.locator(".match-card__name")).toHaveText(
		"Imaginary Logistics Ltd",
		{ timeout: 60_000 },
	);
	await expect(top.locator(".match-card__list")).toHaveText(
		"UK Sanctions List",
	);
	await expectNoHorizontalOverflow(page);
	await expect(
		page.getByRole("alert").filter({ hasText: "Browser memory limit reached" }),
	).toHaveCount(0);
	expect(consoleErrors).toEqual([]);
});
