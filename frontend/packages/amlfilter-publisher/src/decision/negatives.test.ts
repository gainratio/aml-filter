import { describe, expect, it } from "vitest";
import { buildOwnerIndex } from "../recall/labels.ts";
import type { SourceLine } from "../sources/source.ts";
import {
	buildCleanQueries,
	buildPlainQueries,
	buildTokenIndex,
} from "./negatives.ts";
import { PLAIN_FAMILY_NAMES, PLAIN_GIVEN_NAMES } from "./plainNames.ts";

function person(
	id: string,
	primary: string,
	aliases: string[] = [],
): SourceLine {
	return {
		entity_id: id,
		primary_name: primary,
		entity_type: "PERSON",
		aliases: aliases.map((name) => ({ name })),
		dob: [],
		countries: [],
		risk_category: "SANCTIONS",
		source_list: "OFAC_SDN",
		list_version: "v1",
	};
}

const CORPUS: readonly SourceLine[] = [
	person("OFAC_SDN:1", "IVANOV, Vladimir"),
	person("OFAC_SDN:2", "PETROV, Sergei"),
	person("OFAC_SDN:3", "SOKOLOV, Mikhail"),
	person("OFAC_SDN:4", "KUZNETSOV, Dmitri"),
	person("OFAC_SDN:5", "SMIRNOV, Andrei"),
];

function build(count: number, seed = 11): readonly { canonical: string }[] {
	return buildCleanQueries(CORPUS, buildOwnerIndex(CORPUS), count, seed);
}

describe("buildCleanQueries", () => {
	it("is deterministic for a seed", () => {
		expect(build(6).map((q) => q.canonical)).toEqual(
			build(6).map((q) => q.canonical),
		);
	});

	it("changes the questions when the seed changes", () => {
		expect(build(6, 11).map((q) => q.canonical)).not.toEqual(
			build(6, 99).map((q) => q.canonical),
		);
	});

	it("returns exactly the requested count, with no duplicates", () => {
		const out = build(8);
		expect(out).toHaveLength(8);
		expect(new Set(out.map((q) => q.canonical)).size).toBe(8);
	});

	it("builds every name from tokens the list itself publishes", () => {
		const listTokens = new Set(
			CORPUS.flatMap((l) =>
				l.primary_name.toLowerCase().replace(",", "").split(" "),
			),
		);
		for (const q of build(8)) {
			for (const token of q.canonical.split(" ")) {
				expect(listTokens.has(token)).toBe(true);
			}
		}
	});

	it("NEVER emits a name that is actually on the list", () => {
		// The whole point: a "negative" that is a published name is a mislabelled
		// positive, and it would be scored as a false positive when the engine
		// correctly returns its owner.
		const owners = buildOwnerIndex(CORPUS);
		for (const q of build(8)) {
			expect(owners.has(q.canonical)).toBe(false);
		}
	});

	it("rejects a recombination that lands on a real published alias", () => {
		// "vladimir petrov" is reachable by recombination; publishing it as an
		// alias of a real designation must remove it from the negative pool.
		const withAlias = [...CORPUS];
		withAlias[1] = person("OFAC_SDN:2", "PETROV, Sergei", ["Vladimir Petrov"]);
		const owners = buildOwnerIndex(withAlias);
		const out = buildCleanQueries(withAlias, owners, 8, 11);
		expect(out.map((q) => q.canonical)).not.toContain("vladimir petrov");
	});

	it("refuses to return a short set rather than moving the denominator", () => {
		// Five donors yield at most 5 x 4 = 20 ordered recombinations. Asking for
		// one more than that ceiling exercises the refusal without burning the
		// draw budget on an absurd count (10_000 requests meant 2M draws, 1-20 s).
		expect(() => build(21)).toThrow(/produced 20 of 21 requested/);
	});

	it("refuses a corpus with nothing to recombine", () => {
		expect(() => buildCleanQueries([], new Map(), 1, 1)).toThrow(
			/fewer than two recombinable/,
		);
	});

	it("ignores organizations — recombined org fragments are not names", () => {
		const orgs: readonly SourceLine[] = CORPUS.map((l) => ({
			...l,
			entity_type: "ORGANIZATION" as const,
		}));
		expect(() => buildCleanQueries(orgs, buildOwnerIndex(orgs), 1, 1)).toThrow(
			/fewer than two recombinable/,
		);
	});
});

describe("buildTokenIndex", () => {
	it("collects every canonical token of every published name", () => {
		const tokens = buildTokenIndex([
			{ ...CORPUS[0], aliases: [{ name: "Volodya Sokolov" }] } as SourceLine,
		]);
		expect([...tokens].sort()).toEqual([
			"ivanov",
			"sokolov",
			"vladimir",
			"volodya",
		]);
	});
});

describe("buildPlainQueries", () => {
	const owners = buildOwnerIndex(CORPUS);

	it("is deterministic, unique, and returns the requested count", () => {
		const a = buildPlainQueries(CORPUS, owners, 12, 4);
		expect(a).toEqual(buildPlainQueries(CORPUS, owners, 12, 4));
		expect(new Set(a.map((q) => q.canonical)).size).toBe(12);
	});

	it("draws only from the ordinary-name vocabulary", () => {
		for (const q of buildPlainQueries(CORPUS, owners, 12, 4)) {
			const [given, family] = q.canonical.split(" ");
			expect(PLAIN_GIVEN_NAMES).toContain(given);
			expect(PLAIN_FAMILY_NAMES).toContain(family);
		}
	});

	it("HAS ZERO TOKEN OVERLAP with any published name — that is the whole point", () => {
		// Overlap would fire the lexical gate's whole-token escape hatch, which is
		// exactly the variable this control group exists to hold at zero.
		const listTokens = buildTokenIndex(CORPUS);
		for (const q of buildPlainQueries(CORPUS, owners, 12, 4)) {
			for (const token of q.canonical.split(" ")) {
				expect(listTokens.has(token)).toBe(false);
			}
		}
	});

	it("discards a vocabulary name the list turns out to publish", () => {
		const collides = [
			...CORPUS,
			{
				...CORPUS[0],
				entity_id: "OFAC_SDN:9",
				primary_name: "Amelia Nobody",
			} as SourceLine,
		];
		const out = buildPlainQueries(collides, buildOwnerIndex(collides), 12, 4);
		expect(out.every((q) => !q.canonical.startsWith("amelia "))).toBe(true);
	});

	it("refuses to return a short set rather than moving the denominator", () => {
		// A list that publishes all but KEPT_GIVEN of the given names caps the
		// reachable plain names at KEPT_GIVEN x families; asking for one more must
		// refuse. Kept small on purpose: the budget is 200 draws per requested
		// name, and the old unreachable count of 10_000 cost 2M draws (1-20 s).
		const KEPT_GIVEN = 15;
		const blocker = person(
			"OFAC_SDN:99",
			"BLOCKER, Vocabulary",
			PLAIN_GIVEN_NAMES.slice(KEPT_GIVEN),
		);
		const lines = [...CORPUS, blocker];
		const reachable = KEPT_GIVEN * PLAIN_FAMILY_NAMES.length;
		expect(() =>
			buildPlainQueries(lines, buildOwnerIndex(lines), reachable + 1, 4),
		).toThrow(
			new RegExp(`produced ${reachable} of ${reachable + 1} requested plain`),
		);
	});
});
