import { expect, test } from "@playwright/test";
import { bootScreen, collectErrors, screenSanctionedName } from "./journey";

// Claim: "the screen boots in every supported browser." Boot + one screening of
// the committed demo sanctioned name, with a clean console, per engine.
test("boots /screen and screens the demo sanctioned name", async ({ page }) => {
	const errors = collectErrors(page);
	const started = Date.now();
	await bootScreen(page);
	const bootMs = Date.now() - started;
	await screenSanctionedName(page);
	test.info().annotations.push({
		type: "timing",
		description: `boot ${bootMs} ms, boot+screen ${Date.now() - started} ms`,
	});
	expect(errors, "clean console").toEqual([]);
});
