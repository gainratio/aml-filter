// euSource edge behavior: the nameAlias fallback (first/last join when
// wholeName is missing or blank), the birthdate year fallback and blank-date
// guard, empty/missing countryIso2Code guards, missing logicalId/subjectType
// defaults, and fetchRaw against a stubbed fetch (keyed file + non-OK failure).

import { afterEach, describe, expect, test, vi } from "vitest";
import { rejectionAfterBackoff } from "./backoffTestClock.ts";
import { EU_RAW_FILE, euSource } from "./euSource.ts";

const EDGE_XML = [
	"<export>",
	'<sanctionEntity logicalId="1">',
	'<subjectType code="person"/>',
	'<nameAlias wholeName="Whole Name"/>',
	'<nameAlias wholeName="  "/>',
	'<nameAlias firstName="First" lastName="Last"/>',
	'<nameAlias firstName="OnlyFirst"/>',
	'<birthdate year="1970"/>',
	'<citizenship countryIso2Code="FR"/>',
	'<citizenship countryIso2Code=""/>',
	'<address countryIso2Code="DE"/>',
	"<address/>",
	"</sanctionEntity>",
	"<sanctionEntity>",
	'<birthdate birthdate=""/>',
	"</sanctionEntity>",
	"</export>",
].join("");

describe("euSource.parse edge cases", () => {
	test("falls back to first/last name joins, year DOB, and filters empty codes", () => {
		const [person] = euSource.parse({ [EU_RAW_FILE]: EDGE_XML }, "v1");
		expect(person?.entity_id).toBe("EU_CONSOLIDATED:1");
		expect(person?.entity_type).toBe("PERSON");
		expect(person?.primary_name).toBe("Whole Name");
		// blank wholeName alias falls back to an empty join and is filtered out;
		// first/last and first-only joins survive.
		expect(person?.aliases).toEqual([
			{ name: "First Last" },
			{ name: "OnlyFirst" },
		]);
		expect(person?.dob).toEqual(["1970"]); // birthdate attr absent -> year
		expect(person?.countries).toEqual(["DE", "FR"]); // sorted, empties dropped
		expect(person?.list_version).toBe("v1");
	});

	test("an entity with no ids, names, type, or dates degrades to safe defaults", () => {
		const [, bare] = euSource.parse({ [EU_RAW_FILE]: EDGE_XML }, "v1");
		expect(bare?.entity_id).toBe("EU_CONSOLIDATED:");
		expect(bare?.entity_type).toBe("ORGANIZATION");
		expect(bare?.primary_name).toBe("");
		expect(bare?.aliases).toEqual([]);
		expect(bare?.dob).toEqual([]); // birthdate attr present but blank
		expect(bare?.countries).toEqual([]);
	});

	test("a raw map missing the file parses to an empty list", () => {
		expect(euSource.parse({}, "v1")).toEqual([]);
	});
});

describe("euSource.fetchRaw", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("returns the XML keyed by the logical file name", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (): Promise<Response> => new Response("<export/>")),
		);
		await expect(euSource.fetchRaw()).resolves.toEqual({
			[EU_RAW_FILE]: "<export/>",
		});
	});

	test("extracts the upstream generation instant", () => {
		expect(
			euSource.sourceUpdatedAt?.({
				[EU_RAW_FILE]: '<export generationDate="2026-07-01T10:11:12Z"/>',
			}),
		).toBe("2026-07-01T10:11:12Z");
	});

	test("rejects an impossible upstream generation date", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async (): Promise<Response> =>
					new Response('<export generationDate="2026-02-31T00:00:00Z"/>'),
			),
		);

		await expect(euSource.fetchSnapshot?.()).rejects.toThrow(
			/EU_CONSOLIDATED.*freshness timestamp.*invalid/i,
		);
	});

	test("rejects with the status on a non-OK response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async (): Promise<Response> =>
					new Response("nope", { status: 502, statusText: "Bad Gateway" }),
			),
		);
		// The rejection now comes from the shared fetch seam (which also owns the
		// retry budget), so assert the STATUS it must name rather than the prose
		// around it — the style ofacSource.edge.test.ts already uses.
		const error = await rejectionAfterBackoff(() => euSource.fetchRaw());
		expect(error.message).toContain("failed: 502 Bad Gateway");
	});
});
