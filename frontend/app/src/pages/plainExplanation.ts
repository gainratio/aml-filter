/**
 * The engine's one-line score summary, in words a visitor reads.
 *
 * The engine's `explanation` ("Match due to: strong vector similarity, alias
 * match" / "Low confidence match (score: 0.492)") is part of the parity-locked
 * scoring contract (frozen golden snapshot), so it is NOT reworded at the
 * source. This maps its fixed phrases to plain copy at render time. A phrase it
 * does not know passes through unchanged, so a future engine phrase is shown
 * as-is rather than dropped.
 */
import type { TFunction } from "i18next";

const MATCHED_PREFIX = "Match due to: ";
const WEAK_PREFIX = "Low confidence match";

const PART_KEY: Readonly<Record<string, string>> = {
	"strong vector similarity": "strongVector",
	"strong name match": "strongName",
	"alias match": "alias",
	"DOB match": "dob",
	"country match": "country",
};

export function plainExplanation(explanation: string, t: TFunction): string {
	if (explanation.startsWith(WEAK_PREFIX)) {
		return t("dossier.explain.weak");
	}
	if (!explanation.startsWith(MATCHED_PREFIX)) {
		return explanation;
	}
	const reasons = explanation
		.slice(MATCHED_PREFIX.length)
		.split(", ")
		.map((part) => {
			const key = PART_KEY[part];
			return key === undefined ? part : t(`dossier.explain.parts.${key}`);
		})
		.join(", ");
	return t("dossier.explain.matched", { reasons });
}
