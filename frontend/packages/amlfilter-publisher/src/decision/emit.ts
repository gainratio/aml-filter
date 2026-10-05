// Screen every labelled query and every generated negative, and record what the
// user would have been shown.
//
// The screen call is INJECTED, exactly as it is in the recall harness, so this
// module is unit-testable against a fake engine with a handful of entities. The
// real run passes the production `ScreeningEngine.screen`.
//
// EXPECTED-BUT-MISSING IS EMITTED. When an entity that legitimately answers the
// query does not come back at all, a row is still written for it (`retrieved:
// false`, score 0). It is a true match the product did not show — a false
// negative — and a harness that only recorded what came back could not count it.
// That is the exact blindness this whole exercise exists to remove.

import type { Match, ScreenResponse } from "@amlfilter/browser";
import type { LabelledQuery } from "../recall/labels.ts";
import type {
	DecisionSegment,
	EmittedCandidate,
	EmittedQuery,
} from "./artifact.ts";
import {
	type CandidateFacts,
	isKept,
	isPrimary,
	lexicalOf,
	tokenContainmentOf,
} from "./decide.ts";
import { DECISION_LEVELS } from "./levels.ts";
import type { CleanQuery } from "./negatives.ts";

/** Screen one name and return the full scored match list, in rank order. */
export type RankedScreen = (query: string) => Promise<ScreenResponse>;

/** Progress ping so a multi-minute run is not a silent terminal. */
export type OnProgress = (done: number, total: number) => void;

/** A query to screen, with the entity ids that legitimately answer it. */
export interface ScreenTarget {
	readonly query: string;
	readonly expected: ReadonlySet<string>;
}

/** The three facts a decision reads, pulled off one returned match. */
function factsOf(match: Match, query: string): CandidateFacts {
	return {
		score: match.score,
		lexical: lexicalOf(match),
		tokenContainment: tokenContainmentOf(match, query),
	};
}

/** The levels at which these facts would have been shown, and led. */
function verdicts(facts: CandidateFacts): {
	readonly kept: readonly string[];
	readonly primary: readonly string[];
} {
	return {
		kept: DECISION_LEVELS.filter((l) => isKept(facts, l)).map((l) => l.level),
		primary: DECISION_LEVELS.filter((l) => isPrimary(facts, l)).map(
			(l) => l.level,
		),
	};
}

function candidateOf(
	match: Match,
	query: string,
	rank: number,
	expected: ReadonlySet<string>,
): EmittedCandidate {
	const facts = factsOf(match, query);
	return {
		entityId: match.entity_id,
		rank,
		retrieved: true,
		score: facts.score,
		lexical: facts.lexical,
		tokenContainment: facts.tokenContainment,
		expected: expected.has(match.entity_id),
		...verdicts(facts),
	};
}

/**
 * A row for each acceptable entity the engine never returned.
 *
 * Score 0 and no verdicts: nothing was shown, at any level. It is a true match
 * the product did not surface, and it is counted as one.
 */
function missingRows(
	expected: ReadonlySet<string>,
	returned: ReadonlySet<string>,
): readonly EmittedCandidate[] {
	return [...expected]
		.filter((id) => !returned.has(id))
		.map((entityId) => ({
			entityId,
			rank: null,
			retrieved: false,
			score: 0,
			lexical: 0,
			tokenContainment: false,
			expected: true,
			kept: [],
			primary: [],
		}));
}

/** Screen one query and build its emitted row. */
export async function screenOne(
	target: ScreenTarget,
	segment: DecisionSegment,
	id: number,
	screen: RankedScreen,
): Promise<EmittedQuery> {
	const response = await screen(target.query);
	const returned = response.matches.map((m, i) =>
		candidateOf(m, target.query, i + 1, target.expected),
	);
	const seen = new Set(returned.map((c) => c.entityId));
	return {
		kind: "query",
		id,
		segment,
		query: target.query,
		expected: [...target.expected],
		candidates: [...returned, ...missingRows(target.expected, seen)],
	};
}

/** Everything one segment's emission needs. */
export interface EmitSegmentInput {
	readonly segment: DecisionSegment;
	readonly targets: readonly ScreenTarget[];
	readonly screen: RankedScreen;
	/** Ids continue across segments so every query in a run is uniquely keyed. */
	readonly startId: number;
	readonly onProgress?: OnProgress;
}

/** Screen every query in one segment, in order. */
export async function emitSegment(
	input: EmitSegmentInput,
): Promise<readonly EmittedQuery[]> {
	const out: EmittedQuery[] = [];
	for (const target of input.targets) {
		out.push(
			await screenOne(
				target,
				input.segment,
				input.startId + out.length,
				input.screen,
			),
		);
		input.onProgress?.(out.length, input.targets.length);
	}
	return out;
}

/** A labelled retrieval query as a screen target. */
export function targetOf(query: LabelledQuery): ScreenTarget {
	return { query: query.query, expected: query.expected };
}

/** A generated negative as a screen target — nothing legitimately answers it. */
export function cleanTargetOf(query: CleanQuery): ScreenTarget {
	return { query: query.query, expected: new Set<string>() };
}
