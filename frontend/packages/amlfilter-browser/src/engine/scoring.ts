// The scoring policy and preset weights/threshold — the source of truth for
// scoring (originally ported from the retired Python backend's
// DefaultScoringPolicy; no Python scorer remains). Produces an explainable
// result: a list of weighted MatchSignals, a clamped total score, and a
// plain-language summary. Pure + deterministic; locked by the frozen golden in
// __fixtures__/scoring/golden.json.

import type { ScoreResult as AssayScoreResult } from "@gainratio/assay";
import {
	calculateAssayScore,
	type ScoringSignalValues,
	type ScoringSignalWeights,
} from "./assayScoring";
import type { Alias, Entity, MatchReason } from "./domain";
import { tokenSetSimilarity, tokenSortSimilarity } from "./fuzzyText";

/** The named weights for the five scoring signals (mirrors ScoringWeights). */
export interface ScoringWeights {
	readonly name_vector: number;
	readonly name_sequence: number;
	readonly alias_match: number;
	readonly dob_match: number;
	readonly country_match: number;
}

/** Weights + threshold for one named preset. */
export interface PresetConfig {
	readonly weights: ScoringWeights;
	readonly threshold: number;
}

/** The preset name (mirrors the backend's Literal). */
export type Preset = "strict" | "balanced" | "lenient";

/**
 * Preset weights/threshold.
 *
 * `alias_match` was raised in all three presets (#101) from the weights the
 * retired Python backend used; nothing else moved. This file is the scoring
 * source of truth — there is no second implementation to keep in step — and the
 * frozen golden locks it. Signal order, tiers, descriptions and the clamp are
 * unchanged from the original port.
 *
 * WHY. The live /screen page sends a combined-score floor of 0.30 (Balanced).
 * With `alias_match` at 0.10 an exact hit on a name OFAC itself publishes for
 * that entity contributed 0.10 — by arithmetic, below the floor. The signal
 * could never lift an entity on its own; it was decorative. An entity findable
 * ONLY through a published alias — the product's whole promise — scored as if
 * the alias did not exist. Balanced's 0.35 is set so one exact alias hit clears
 * 0.30 with margin and nothing else has to be true.
 *
 * WHY THE OTHER FOUR WEIGHTS DID NOT MOVE. Paying for the alias raise out of
 * `name_vector` would have LOWERED every score that has no alias hit, and the
 * preset thresholds (0.75 / 0.65 / 0.55) are calibrated against the old sums —
 * a perfect primary-name match would have stopped clearing its own preset. This
 * change is therefore purely additive: no (entity, query) pair scores lower than
 * it did, and only pairs with a real alias hit score higher.
 *
 * The consequence, stated plainly: the weights no longer sum to 1.0 (Balanced
 * sums to 1.25), so the score is a clamped weighted sum rather than a weighted
 * average, and a match strong on every signal at once saturates at 1.0 sooner
 * than it used to. That is the intended reading — five independent signals all
 * agreeing IS a 1.0.
 *
 * Across presets the ordering carries the levels' meaning: Strict trusts an
 * alias least (an alias is a weaker identity claim than a designation's own
 * name) and Lenient trusts it most.
 */
export const PRESETS: Readonly<Record<Preset, PresetConfig>> = {
	strict: {
		weights: {
			name_vector: 0.6,
			name_sequence: 0.25,
			alias_match: 0.2,
			dob_match: 0.05,
			country_match: 0.05,
		},
		threshold: 0.75,
	},
	balanced: {
		weights: {
			name_vector: 0.55,
			name_sequence: 0.2,
			alias_match: 0.35,
			dob_match: 0.1,
			country_match: 0.05,
		},
		threshold: 0.65,
	},
	lenient: {
		weights: {
			name_vector: 0.5,
			name_sequence: 0.15,
			alias_match: 0.4,
			dob_match: 0.1,
			country_match: 0.1,
		},
		threshold: 0.55,
	},
};

const STRONG_SIMILARITY_THRESHOLD = 0.8;
const DOB_HALF_MATCH_THRESHOLD = 0.5;

/**
 * The alias tiers.
 *
 * FULL and PARTIAL are the two that already existed (exact string, substring
 * containment) and neither has moved — an alias that scored 1.0 or 0.5 before
 * still does. FUZZY is new and deliberately worth half of PARTIAL: containment
 * is a fact about the strings, while a token-set ratio is a judgement about
 * them, and it is the tier that fires on strangers.
 *
 * That difference was measured, not assumed. Scoring FUZZY at PARTIAL's 0.5
 * dropped canonical recall@1 from 0.9965 to 0.9330 against the frozen corpus:
 * searching an entity's own exact name stopped putting that entity first,
 * because some other designation with a loosely similar alias picked up the same
 * 0.175 nudge. At 0.25 the nudge is small enough to reorder near-ties without
 * overturning an exact name match, and canonical recall@1 comes back.
 */
const ALIAS_FULL = 1.0;
const ALIAS_PARTIAL = 0.5;
const ALIAS_FUZZY = 0.25;

/**
 * Word-order-tolerant agreement above which an alias counts as a FULL match.
 *
 * Range 0.90–1.0. Sanctions feeds publish surname-first ("SALIM, Ahmad Fuad")
 * and users type given-name-first; canonicalization already deletes the comma
 * that carried that convention, so string equality was scoring one writing of a
 * name as a perfect hit and the other as no hit at all. token_sort_ratio makes
 * the two agree while still counting every word, so a genuinely different
 * person is not swept in: "vladimir ivanov" against the alias "vladimir ivanov
 * ii" scores 0.909 and stays at the partial tier, which is why this line sits
 * at 0.95 and not at 0.90. Lower it and Jr/II/Sr distinctions start reading as
 * the same person.
 */
const ALIAS_FULL_SORT_RATIO = 0.95;

/**
 * Agreement above which an alias counts as a PARTIAL match.
 *
 * Range 0.5–0.8. token_SET is the right tool for this tier specifically because
 * it forgives extra words: "Musa Muhammad Abu Marzuk" should still reach the
 * alias "MARZUK, Musa Abu".
 *
 * THE ERROR RATE AT THIS CUT IS MEASURED, AND THE MEASUREMENT IS COMMITTED.
 * `packages/amlfilter-publisher/src/decision/pairStudy.ts` scores every published
 * (primary name, alias) pair in the frozen OFAC snapshot against a seeded set of
 * cross-designation pairs, using this exact function; `eval/` turns that into
 * recall and a false-positive rate with `assay`. The numbers live in
 * `eval/baselines/decision-baseline.json` under `study`, beside the same two
 * rates for the Double Metaphone rule this engine deliberately refuses to decide
 * with (see ./fuzzyText). Run `pnpm --filter @amlfilter/publisher run
 * measure-decision` to regenerate them.
 *
 * This comment used to quote "82.8% recall at a 0.37% false-positive rate" from
 * a script that was never committed. It is struck rather than corrected: an
 * unreproducible number is not evidence, whatever it says, and the committed
 * study now reports different figures because the populations it builds are
 * defined in code rather than remembered.
 */
const ALIAS_FUZZY_SET_RATIO = 0.6;

/** The result of scoring one (entity, query) pair. */
export interface ScoreResult {
	readonly score: number;
	readonly reasons: ReadonlyArray<MatchReason>;
	readonly summary: string;
	readonly assay: AssayScoreResult;
}

/** The query fields scoring reads (canonical name precomputed by the caller). */
export interface ScoringQuery {
	readonly nameCanonical: string;
	readonly dob: string | null;
	readonly country: string | null;
	readonly entityType: string | null;
	readonly vectorSimilarity: number;
	readonly lexicalSimilarity: number;
}

interface Accumulator {
	readonly reasons: MatchReason[];
}

function isStrong(similarity: number | null): boolean {
	return similarity !== null && similarity > STRONG_SIMILARITY_THRESHOLD;
}

function addWeighted(
	acc: Accumulator,
	name: string,
	score: number,
	weight: number,
	description: string,
	valueOverride?: number | string,
): void {
	const contribution = weight * score;
	acc.reasons.push({
		signal: name,
		value: valueOverride ?? score,
		weight,
		contribution,
		description,
	});
}

/**
 * How well ONE alias answers the query, on three tiers.
 *
 * The tiers used to be string equality (1.0) and substring (0.5) and nothing
 * else, which made the signal blind to the two ways real feeds differ from real
 * typing: word order and spelling. Both new tiers only ever RAISE an alias's
 * score — an alias that scored 1.0 or 0.5 before still does.
 */
function aliasTier(alias: Alias, query: string): number {
	const canonical = alias.name_canonical.toLowerCase();
	if (query === canonical) {
		return ALIAS_FULL;
	}
	if (tokenSortSimilarity(query, canonical) >= ALIAS_FULL_SORT_RATIO) {
		return ALIAS_FULL;
	}
	if (canonical.includes(query) || query.includes(canonical)) {
		return ALIAS_PARTIAL;
	}
	return tokenSetSimilarity(query, canonical) >= ALIAS_FUZZY_SET_RATIO
		? ALIAS_FUZZY
		: 0.0;
}

function aliasMatch(
	aliases: ReadonlyArray<Alias>,
	queryCanonical: string,
): { readonly score: number; readonly name: string | null } {
	const query = queryCanonical.toLowerCase();
	// Score EVERY alias, not just the first that partially hits. A full alias
	// match anywhere must never be shadowed by an earlier PARTIAL one — that
	// shadowing silently dropped an exact-alias-only entity to a half score and,
	// near the threshold, out of the results entirely (a false clear). The first
	// partial's name is retained so a partial-only entity scores exactly as
	// before; a full hit returns immediately, since nothing can beat it.
	let best: { readonly score: number; readonly name: string | null } = {
		score: 0.0,
		name: null,
	};
	for (const alias of aliases) {
		const tier = aliasTier(alias, query);
		if (tier === ALIAS_FULL) {
			return { score: ALIAS_FULL, name: alias.name };
		}
		if (tier > best.score) {
			best = { score: tier, name: alias.name };
		}
	}
	return best;
}

function dobMatch(
	dobs: ReadonlyArray<string>,
	queryDob: string | null,
): { readonly score: number; readonly desc: string } {
	if (queryDob === null || dobs.length === 0) {
		return { score: 0.0, desc: "No DOB provided or entity has no DOB" };
	}
	const queryYear = queryDob.slice(0, 4);
	for (const dob of dobs) {
		if (dob === queryDob) {
			return { score: 1.0, desc: `Exact DOB match: ${dob}` };
		}
		if (dob.slice(0, 4) === queryYear) {
			return { score: 0.5, desc: `Year match: ${queryYear}` };
		}
	}
	return { score: 0.0, desc: "No DOB match" };
}

function countryMatch(
	countries: ReadonlyArray<string>,
	queryCountry: string | null,
): { readonly score: number; readonly desc: string } {
	if (queryCountry === null || countries.length === 0) {
		return {
			score: 0.0,
			desc: "No country provided or entity has no countries",
		};
	}
	const queryUpper = queryCountry.toUpperCase();
	const entityUpper = new Set(countries.map((c) => c.toUpperCase()));
	if (!entityUpper.has(queryUpper)) {
		return {
			score: 0.0,
			desc: `No country match: ${queryUpper} not in ${formatCountrySet(entityUpper)}`,
		};
	}
	if (entityUpper.size === 1) {
		return { score: 1.0, desc: `Exact country match: ${queryUpper}` };
	}
	return {
		score: 1.0 / entityUpper.size,
		desc: `Country match: ${queryUpper} in ${formatCountrySet(entityUpper)}`,
	};
}

// Render a country set as a sorted, bracketed list. Sorted (not insertion order)
// so it is deterministic; the frozen scoring golden pins this exact form.
function formatCountrySet(countries: ReadonlySet<string>): string {
	return `[${[...countries].sort().join(", ")}]`;
}

function summarize(
	finalScore: number,
	vectorSimilarity: number,
	lexicalSimilarity: number,
	aliasScore: number,
	dobScore: number,
	countryScore: number,
): string {
	const parts: string[] = [];
	if (isStrong(vectorSimilarity)) {
		parts.push("strong vector similarity");
	}
	if (isStrong(lexicalSimilarity)) {
		parts.push("strong name match");
	}
	if (aliasScore > 0) {
		parts.push("alias match");
	}
	if (dobScore >= DOB_HALF_MATCH_THRESHOLD) {
		parts.push("DOB match");
	}
	if (countryScore > 0) {
		parts.push("country match");
	}
	if (parts.length > 0) {
		return `Match due to: ${parts.join(", ")}`;
	}
	return `Low confidence match (score: ${finalScore.toFixed(3)})`;
}

/** Add the vector and Ratcliff/Obershelp sequence signals in stable order. */
function addNameSignals(
	acc: Accumulator,
	weights: ScoringWeights,
	q: ScoringQuery,
): void {
	addWeighted(
		acc,
		"name_vector",
		q.vectorSimilarity,
		weights.name_vector,
		`Vector similarity: ${q.vectorSimilarity.toFixed(3)}`,
	);
	addWeighted(
		acc,
		"name_sequence",
		q.lexicalSimilarity,
		weights.name_sequence,
		`Sequence similarity: ${q.lexicalSimilarity.toFixed(3)}`,
	);
}

function signalValues(
	query: ScoringQuery,
	aliasScore: number,
	dobScore: number,
	countryScore: number,
): ScoringSignalValues {
	return {
		name_vector: query.vectorSimilarity,
		name_sequence: query.lexicalSimilarity,
		alias_match: aliasScore,
		dob_match: dobScore,
		country_match: countryScore,
	};
}

function boundedSimilarity(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function boundedNameSignals(query: ScoringQuery): ScoringQuery {
	return {
		...query,
		vectorSimilarity: boundedSimilarity(query.vectorSimilarity),
		lexicalSimilarity: boundedSimilarity(query.lexicalSimilarity),
	};
}

function addEntityTypeSignal(
	acc: Accumulator,
	entity: Entity,
	queryEntityType: string | null,
): void {
	const desc =
		queryEntityType === null
			? "No entity type specified in query"
			: entity.entity_type.toUpperCase() === queryEntityType.toUpperCase()
				? `Entity type match: ${entity.entity_type}`
				: `Entity type mismatch: ${entity.entity_type} != ${queryEntityType}`;
	const score =
		queryEntityType !== null &&
		entity.entity_type.toUpperCase() === queryEntityType.toUpperCase()
			? 1.0
			: 0.0;
	acc.reasons.push({
		signal: "entity_type_match",
		value: score,
		weight: 0.0,
		contribution: 0.0,
		description: desc,
	});
}

/** Compute (score, reasons, summary) for one (entity, query) pair. */
export function computeScore(
	entity: Entity,
	query: ScoringQuery,
	weights: ScoringWeights,
): ScoreResult {
	const scoringQuery = boundedNameSignals(query);
	const acc: Accumulator = { reasons: [] };
	addNameSignals(acc, weights, scoringQuery);

	const alias = aliasMatch(entity.aliases, query.nameCanonical);
	if (alias.score > 0) {
		addWeighted(
			acc,
			"alias_match",
			alias.score,
			weights.alias_match,
			alias.name !== null ? `Alias match: ${alias.name}` : "No alias match",
			alias.name ?? "",
		);
	}

	const dob = dobMatch(entity.dob, query.dob);
	if (dob.score > 0 || query.dob !== null) {
		addWeighted(acc, "dob_match", dob.score, weights.dob_match, dob.desc);
	}

	const country = countryMatch(entity.countries, query.country);
	if (country.score > 0 || query.country !== null) {
		addWeighted(
			acc,
			"country_match",
			country.score,
			weights.country_match,
			country.desc,
		);
	}

	addEntityTypeSignal(acc, entity, query.entityType);
	const assay = calculateAssayScore(
		signalValues(scoringQuery, alias.score, dob.score, country.score),
		weights as ScoringSignalWeights,
	);
	const finalScore = assay.score;
	return {
		score: finalScore,
		reasons: acc.reasons,
		assay,
		summary: summarize(
			finalScore,
			scoringQuery.vectorSimilarity,
			scoringQuery.lexicalSimilarity,
			alias.score,
			dob.score,
			country.score,
		),
	};
}
