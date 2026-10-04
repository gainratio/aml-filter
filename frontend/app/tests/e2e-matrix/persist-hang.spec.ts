import { expect, test } from "@playwright/test";
import {
	bootScreen,
	collectErrors,
	forcePersistHang,
	persistCalls,
	screenSanctionedName,
} from "./journey";

// Firefox shows a permission prompt for navigator.storage.persist() and leaves
// the promise pending until the user answers. Awaiting it hung boot forever.
// Force that deterministically in every engine: persist() never settles, and
// boot must still complete and screen.
test("boots and screens while storage.persist() never settles", async ({
	page,
}) => {
	const errors = collectErrors(page);
	await forcePersistHang(page);
	await bootScreen(page);
	expect(await persistCalls(page), "the app asked for persistence").toBe(1);
	await screenSanctionedName(page);
	expect(errors, "clean console").toEqual([]);
});
