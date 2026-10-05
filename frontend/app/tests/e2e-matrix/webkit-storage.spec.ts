import { expect, test } from "@playwright/test";
import { bootScreen, screenSanctionedName } from "./journey";

/**
 * The runtime reports where the sanctions vector index lives on
 * <html data-aml-index-storage>: "opfs" (a persistent SQLite file whose page
 * cache is sized to the device) or "memory-fallback" (the whole index in wasm
 * heap, the iPhone out-of-memory risk, shown to the user as a notice).
 *
 * WebKit gives OPFS only to a persistent profile. Playwright's default context
 * is ephemeral, like Safari Private Browsing, and there
 * navigator.storage.getDirectory() rejects with UnknownError. So each mode is
 * asserted exactly, in the profile that should produce it.
 */

test("WebKit with a persistent profile keeps the vector index on OPFS", async ({
	playwright,
	baseURL,
}, testInfo) => {
	const context = await playwright.webkit.launchPersistentContext(
		testInfo.outputPath("webkit-profile"),
		{ baseURL },
	);
	try {
		const page = context.pages()[0] ?? (await context.newPage());
		await bootScreen(page);
		await expect(page.locator("html")).toHaveAttribute(
			"data-aml-index-storage",
			"opfs",
		);
		await expect(page.getByTestId("index-fallback-notice")).toHaveCount(0);
	} finally {
		await context.close();
	}
});

test("WebKit private-style (ephemeral) context falls back to memory and says so", async ({
	page,
}) => {
	await bootScreen(page);
	await expect(page.locator("html")).toHaveAttribute(
		"data-aml-index-storage",
		"memory-fallback",
	);
	// The fallback is never silent: the user sees the low-memory notice, and
	// screening still works.
	await expect(page.getByTestId("index-fallback-notice")).toBeVisible();
	await screenSanctionedName(page);
});
