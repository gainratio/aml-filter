import { expect, test } from "@playwright/test";

/**
 * C1 — the search box covers every list the home page names, in plain words.
 *
 * The home page promises four lists (US OFAC, EU, UN, UK). A stranger typing a
 * name that is ONLY on the UK list used to get a wrong-person OFAC card back,
 * because /screen loaded OFAC alone. This drives the minified production build
 * against the COMMITTED signed demo bundle + pinned key (desktop Chromium, so
 * the all-lists scope): "Imaginary Logistics Ltd" is UK_OFSI:0002 and exists on
 * no other list. It must be the top result, tagged "UK Sanctions List", and the
 * card must carry no engine jargon or raw list codes.
 */

const MODEL_LOAD_TIMEOUT_MS = 160_000;
const RESULT_TIMEOUT_MS = 30_000;
const UK_ONLY_NAME = "Imaginary Logistics Ltd";
const JARGON =
	/\b(UK_OFSI|OFAC_SDN|EU_CONSOLIDATED|UN_CONSOLIDATED|name_vector|name_sequence|alias_match|SANCTION)\b|[Vv]ector|Metaphone|Score receipt|\bVerified\b/;

test("a UK-only name is found from /screen and tagged with its list in plain words", async ({
	page,
}) => {
	test.setTimeout(240_000);
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
	});

	await page.goto("/screen");
	const search = page.getByRole("searchbox", {
		name: "Search the sanctions list",
	});
	await expect(search).toBeEnabled({ timeout: MODEL_LOAD_TIMEOUT_MS });

	// The page says which lists it searches — all four, by plain name.
	const scope = page.locator(".screen-scope");
	await expect(scope).toContainText("Searching 4 lists:", {
		timeout: RESULT_TIMEOUT_MS,
	});
	for (const name of ["US OFAC", "EU", "UN", "UK Sanctions List"]) {
		await expect(scope).toContainText(name);
	}

	await search.fill(UK_ONLY_NAME);
	const top = page.locator(".match-card:has(.match-card__score)").first();
	await expect(top.locator(".match-card__name")).toHaveText(UK_ONLY_NAME, {
		timeout: RESULT_TIMEOUT_MS,
	});
	await expect(top.locator(".match-card__list")).toHaveText(
		"UK Sanctions List",
	);

	// Open the score breakdown: plain labels, no engine terms anywhere in results.
	await top.locator("summary", { hasText: "Why this score?" }).click();
	await expect(top.locator(".match-card__signal dt").first()).toBeVisible();
	const resultsText = await page.locator(".screen-results").innerText();
	expect(resultsText).not.toMatch(JARGON);

	expect(errors, "clean console").toEqual([]);
});
