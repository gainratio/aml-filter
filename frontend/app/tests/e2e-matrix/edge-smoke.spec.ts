import { expect, test } from "@playwright/test";
import {
	bootScreen,
	collectErrors,
	edgeInstalled,
	screenSanctionedName,
} from "./journey";

// Detect, don't fail: Edge is not installable in every runner (no macOS Edge
// on a bare Mac, no Edge in the Linux Dagger image unless installed). Skipping
// before any fixture runs means Playwright never tries to launch the channel.
test.skip(
	!edgeInstalled(),
	`Microsoft Edge is not installed on this ${process.platform} runner; the msedge channel cannot launch`,
);

test("Edge boots /screen and screens the demo sanctioned name", async ({
	page,
}) => {
	const errors = collectErrors(page);
	await bootScreen(page);
	await screenSanctionedName(page);
	expect(errors, "clean console").toEqual([]);
});
