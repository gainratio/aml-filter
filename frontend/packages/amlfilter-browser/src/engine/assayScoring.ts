import {
	type AdditiveRequest,
	type AdditiveTerm,
	additive,
	type ScoreResult,
} from "@gainratio/assay";
import { classifyTier, type MatchTier, STRONG_TIER_FLOOR } from "./tiering";

export const SCORING_POLICY_VERSION = "amlfilter.additive.v2";

export interface ScoringSignalValues {
	readonly name_vector: number;
	readonly name_sequence: number;
	readonly alias_match: number;
	readonly dob_match: number;
	readonly country_match: number;
}

export interface ScoringSignalWeights {
	readonly name_vector: number;
	readonly name_sequence: number;
	readonly alias_match: number;
	readonly dob_match: number;
	readonly country_match: number;
}

export interface ScoringPolicyDecision {
	readonly accepted: boolean;
	readonly threshold: number;
	readonly tier: MatchTier;
}

interface TermDefinition {
	readonly id: keyof ScoringSignalValues;
	readonly label: string;
}

const TERM_DEFINITIONS: ReadonlyArray<TermDefinition> = [
	{ id: "name_vector", label: "Name vector similarity" },
	{ id: "name_sequence", label: "Name sequence similarity" },
	{ id: "alias_match", label: "Alias match" },
	{ id: "dob_match", label: "Date of birth match" },
	{ id: "country_match", label: "Country match" },
];

function term(
	definition: TermDefinition,
	signals: ScoringSignalValues,
	weights: ScoringSignalWeights,
): AdditiveTerm {
	return {
		id: definition.id,
		label: definition.label,
		value: signals[definition.id],
		coefficient: weights[definition.id],
		operation: "add",
		interval: null,
	};
}

function request(
	signals: ScoringSignalValues,
	weights: ScoringSignalWeights,
): AdditiveRequest {
	return {
		method: "additive",
		method_version: SCORING_POLICY_VERSION,
		terms: TERM_DEFINITIONS.map((definition) =>
			term(definition, signals, weights),
		),
		clamp: "clamp",
		intercept: 0,
	};
}

export function calculateAssayScore(
	signals: ScoringSignalValues,
	weights: ScoringSignalWeights,
): ScoreResult {
	return additive(request(signals, weights));
}

export function scoringPolicyDecision(
	result: ScoreResult,
	threshold: number,
): ScoringPolicyDecision {
	return {
		accepted: result.score >= threshold,
		threshold,
		tier: classifyTier(result.score, threshold, STRONG_TIER_FLOOR),
	};
}
