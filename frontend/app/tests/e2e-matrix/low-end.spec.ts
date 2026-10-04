import { expect, test } from "@playwright/test";
import {
	bootScreen,
	collectErrors,
	LOW_END_CPU_THROTTLE,
	lowEndBudgetMs,
	screenSanctionedName,
} from "./journey";

// Claim: the screen stays usable on low-end hardware. Chromium with a 4x CDP
// CPU throttle and a phone-sized viewport must boot and screen once inside a
// budget that scales with how many browsers share this runner (see
// lowEndBudgetMs for the formula).
test("boots and screens under 4x CPU throttling within budget", async ({
	page,
	context,
}) => {
	const budget = lowEndBudgetMs(test.info().config.workers);
	test.setTimeout(budget + 60_000);
	const errors = collectErrors(page);
	const cdp = await context.newCDPSession(page);
	await cdp.send("Emulation.setCPUThrottlingRate", {
		rate: LOW_END_CPU_THROTTLE,
	});
	const started = Date.now();
	await bootScreen(page);
	await screenSanctionedName(page);
	const elapsed = Date.now() - started;
	test.info().annotations.push({
		type: "timing",
		description: `boot+screen ${elapsed} ms (budget ${budget} ms)`,
	});
	expect(elapsed, `boot + one screening within ${budget} ms`).toBeLessThan(
		budget,
	);
	expect(errors, "clean console").toEqual([]);
});
