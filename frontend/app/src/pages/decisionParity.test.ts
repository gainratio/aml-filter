// The decision harness measures at the thresholds THIS FILE'S neighbours define.
//
// frontend/packages/amlfilter-publisher/src/decision/ screens the frozen OFAC
// corpus and records, per (query, entity) pair, whether the user would have been
// shown it. Precision, recall, F1, FPR and FNR are then computed from those rows
// in Python. Every one of those numbers is a statement about `strictness.ts` —
// so if the harness's copy of the levels or of the gate drifts from the app's,
// the committed metrics describe a product nobody uses.
//
// The harness cannot import the app (it is a private, browser-typed package), so
// it carries its own copy. This test is the seam that makes the copy honest: it
// imports BOTH and drives them over the same cases. Two checks, and the second is
// the one that matters —
//
//   1. the level literals are identical, field by field;
//   2. the app's real `passesStrictness` / `partitionForPresentation` and the
//      harness's `isKept` / `isPrimary` agree on every case in a boundary grid.
//
// If this fails, the app changed the decision. Update
// packages/amlfilter-publisher/src/decision/{levels,decide}.ts to match and
// re-measure (`pnpm --filter @amlfilter/publisher run gate:decision`), because
// the committed floors describe the OLD decision until you do.

import { EMPTY_IDENTIFIERS, type Match } from "@amlfilter/browser";
import { describe, expect, it } from "vitest";
import {
	isKept,
	isPrimary,
} from "../../../packages/amlfilter-publisher/src/decision/decide.ts";
import { DECISION_LEVELS } from "../../../packages/amlfilter-publisher/src/decision/levels.ts";
import {
	LEVEL,
	partitionForPresentation,
	passesStrictness,
	STRICTNESS_LEVELS,
} from "./strictness";

/** A match carrying an exact lexical signal and a controllable name. */
function match(score: number, lexical: number, primaryName: string): Match {
	return {
		entity_id: "OFAC_SDN:1",
		score,
		entity_type: "PERSON",
		risk_category: "SANCTION",
		source_list: "OFAC_SDN",
		list_version: "v1",
		primary_name: primaryName,
		aliases: [],
		countries: [],
		nationalities: [],
		dob: [],
		addresses: [],
		identifiers: EMPTY_IDENTIFIERS,
		reasons: [
			{
				signal: "name_sequence",
				value: lexical,
				weight: 0.2,
				contribution: 0,
				description: "",
			},
		],
		explanation: "",
	} as Match;
}

// Boundary-dense on purpose: every level floor, every minLexical, and the
// Balanced display line, each probed just below, exactly at, and just above.
const SCORES = [0, 0.29, 0.3, 0.31, 0.39, 0.4, 0.41, 0.49, 0.5, 0.75, 1];
const LEXICALS = [0, 0.34, 0.35, 0.36, 0.49, 0.5, 0.51, 0.8, 1];
// One name that shares a whole token with the query and one that shares none —
// the escape hatch is the part of the gate most likely to drift.
const NAMES = ["IVANOV, Vladimir", "Zzyzx Qqqq"];
const QUERY = "Vladimir Petrov";

describe("decision harness parity — the level literals", () => {
	it("mirrors every field of every level the app defines", () => {
		expect(DECISION_LEVELS).toEqual(STRICTNESS_LEVELS);
	});

	it("still pins Balanced to floor 0.30 / minLexical 0.35 / line 0.40", () => {
		// Asserted against literals on purpose. Comparing a constant to itself
		// would pass at any value and guard nothing.
		expect(LEVEL.balanced.floor).toBe(0.3);
		expect(LEVEL.balanced.minLexical).toBe(0.35);
		expect(LEVEL.balanced.displayFloor).toBe(0.4);
	});

	it("still pins Lenient and Strict", () => {
		expect(LEVEL.lenient).toEqual({
			level: "lenient",
			floor: 0.3,
			minLexical: 0,
			displayFloor: 0,
		});
		expect(LEVEL.strict).toEqual({
			level: "strict",
			floor: 0.4,
			minLexical: 0.5,
			displayFloor: 0,
		});
	});

	it("still defaults the /screen control to Balanced — the level being gated", () => {
		expect(LEVEL.balanced.level).toBe("balanced");
	});
});

/** The app's own verdict for one match at one level, via its real functions. */
function appVerdict(
	m: Match,
	level: (typeof STRICTNESS_LEVELS)[number],
): { kept: boolean; primary: boolean } {
	// The engine floor is applied by `engine.screen(threshold: level.floor)`, so
	// the app-side reproduction applies it here before its two real functions.
	const passesGate =
		m.score >= level.floor && passesStrictness(m, QUERY, level);
	const partition = partitionForPresentation(
		passesGate ? [m] : [],
		QUERY,
		level,
	);
	const kept = partition.primary.length + partition.lowConfidence.length === 1;
	const primary = partition.primary.length === 1;
	return { kept, primary };
}

describe("decision harness parity — the rule itself", () => {
	it.each(STRICTNESS_LEVELS.map((l) => [l.level, l] as const))(
		"agrees with the app on every boundary case at %s",
		(_name, level) => {
			const harnessLevel = DECISION_LEVELS.find((d) => d.level === level.level);
			if (harnessLevel === undefined) {
				throw new Error(`the decision harness has no level "${level.level}"`);
			}
			let cases = 0;
			for (const score of SCORES) {
				for (const lexical of LEXICALS) {
					for (const primaryName of NAMES) {
						const m = match(score, lexical, primaryName);
						const facts = {
							score,
							lexical,
							tokenContainment: primaryName === "IVANOV, Vladimir",
						};
						const app = appVerdict(m, level);
						expect({
							kept: isKept(facts, harnessLevel),
							primary: isPrimary(facts, harnessLevel),
						}).toEqual(app);
						cases += 1;
					}
				}
			}
			// A grid that silently emptied would make this test vacuously true.
			expect(cases).toBe(SCORES.length * LEXICALS.length * NAMES.length);
		},
	);
});
