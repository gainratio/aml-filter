import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import { plainExplanation } from "./plainExplanation";

const t = i18n.getFixedT("en", "screen");

// Every summary the parity-locked engine emits in its frozen golden snapshot.
// If the engine grows a phrase this module does not map, the jargon check below
// goes red instead of the phrase leaking onto the result card.
const GOLDEN = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../packages/amlfilter-browser/src/engine/__fixtures__/scoring/golden.json",
);
const summaries = [
	...new Set(
		[...readFileSync(GOLDEN, "utf8").matchAll(/"summary": "([^"]*)"/g)].map(
			(m) => m[1] ?? "",
		),
	),
];

describe("plainExplanation over every golden engine summary", () => {
	it("found the golden summaries", () => {
		expect(summaries.length).toBeGreaterThan(3);
	});

	it.each(summaries)("%s → plain words", (summary) => {
		const text = plainExplanation(summary, t);
		expect(text).not.toMatch(/vector|similarity|DOB|Match due to|confidence/);
	});

	it("maps a full strong summary phrase by phrase", () => {
		expect(
			plainExplanation(
				"Match due to: strong vector similarity, strong name match, DOB match, country match",
				t,
			),
		).toBe(
			"Why it matched: the names are very alike, the spelling is very close, the date of birth matches, the country matches",
		);
	});

	it("passes an unknown line through rather than dropping it", () => {
		expect(plainExplanation("Something new", t)).toBe("Something new");
	});
});
