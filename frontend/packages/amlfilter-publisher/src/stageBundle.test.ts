// stageBundle lays out a deterministic staging tree that `edgeproc publish`
// chunks + signs into the content-addressed bundle. The tree the in-tab sync
// tier ultimately materializes is:
//   catalog.json                              (top-level registry)
//   <slug>/entities.jsonl                     (one WatchlistEntity per line)
//   <slug>/vectors.f32                        (raw LE Float32, entities*dim)
//   <slug>/meta.json                          (per-list metadata)
// Determinism (stable key order, fixed generatedAt) is load-bearing: the chunk
// + manifest hashes downstream are a pure function of these bytes.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	type ListFreshness,
	type StagedList,
	stageBundle,
} from "./stageBundle.ts";
import type { WatchlistEntity } from "./types.ts";

const GENERATED_AT = "2026-06-19T00:00:00Z";
const DIM = 3;

/** A list refreshed by this run: fetched now, from a source that dated itself. */
const FRESH: ListFreshness = {
	fetchedAt: GENERATED_AT,
	sourceUpdatedAt: "2026-06-18T12:00:00Z",
	stale: false,
	staleReason: null,
};

function entity(id: string, name: string): WatchlistEntity {
	return {
		entity_id: id,
		name_canonical: name,
		aliases: [],
		dob: null,
		countries: [],
		risk_category: "SANCTION",
		source_list: "OFAC_SDN",
		list_version: "demo-1",
	};
}

function lists(): readonly StagedList[] {
	return [
		{
			listId: "OFAC_SDN",
			slug: "ofac",
			title: "OFAC SDN",
			version: "demo-1",
			model: "Xenova/all-MiniLM-L6-v2",
			dim: DIM,
			entities: [entity("OFAC_SDN:0001", "ivan fakovich")],
			vectors: new Float32Array([1, 2, 3]),
			freshness: FRESH,
		},
		{
			listId: "EU_CONSOLIDATED",
			slug: "eu",
			title: "EU Consolidated",
			version: "demo-1",
			model: "Xenova/all-MiniLM-L6-v2",
			dim: DIM,
			entities: [
				entity("EU_CONSOLIDATED:0001", "alpha"),
				entity("EU_CONSOLIDATED:0002", "beta"),
			],
			vectors: new Float32Array([1, 0, 0, 0, 1, 0]),
			freshness: FRESH,
		},
	];
}

describe("stageBundle", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "aml-stage-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("writes one entities.jsonl line per entity, stable key order", async () => {
		await stageBundle(dir, lists(), GENERATED_AT);
		const jsonl = await readFile(join(dir, "ofac", "entities.jsonl"), "utf8");
		const rows = jsonl.split("\n").filter((l) => l.length > 0);
		expect(rows).toHaveLength(1);
		// Round-trips to the same entity with version-invariant wire `list_version`
		// (`meta.json` carries the list version so Gear-CDC reuses unchanged rows).
		expect(JSON.parse(rows[0] as string)).toEqual({
			entity_id: "OFAC_SDN:0001",
			name_canonical: "ivan fakovich",
			aliases: [],
			dob: null,
			countries: [],
			risk_category: "SANCTION",
			source_list: "OFAC_SDN",
			list_version: "",
		});
		// Stable key order: keys serialize in the fixed schema order.
		expect((rows[0] as string).indexOf('"entity_id"')).toBeLessThan(
			(rows[0] as string).indexOf('"name_canonical"'),
		);
	});

	test("keeps entities.jsonl byte-identical across daily version bumps for Gear-CDC deduplication", async () => {
		await stageBundle(dir, lists(), GENERATED_AT);
		const day1 = await readFile(join(dir, "ofac", "entities.jsonl"));

		const dir2 = await mkdtemp(join(tmpdir(), "aml-stage-day2-"));
		try {
			const bumped = lists().map((l) => ({
				...l,
				version: "2026-10-20",
				entities: l.entities.map((e) => ({ ...e, list_version: "2026-10-20" })),
			}));
			await stageBundle(dir2, bumped, "2026-10-20T06:00:00Z");
			const day2 = await readFile(join(dir2, "ofac", "entities.jsonl"));
			expect(day2).toEqual(day1);
		} finally {
			await rm(dir2, { recursive: true, force: true });
		}
	});

	test("writes vectors.f32 as raw LE Float32 bytes", async () => {
		await stageBundle(dir, lists(), GENERATED_AT);
		const buf = await readFile(join(dir, "eu", "vectors.f32"));
		expect(buf.byteLength).toBe(6 * 4); // 2 entities * dim 3 * 4 bytes
		const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
		const expected = [1, 0, 0, 0, 1, 0];
		for (let i = 0; i < expected.length; i += 1) {
			expect(view.getFloat32(i * 4, true)).toBe(expected[i]);
		}
	});

	test("writes a per-list meta.json", async () => {
		await stageBundle(dir, lists(), GENERATED_AT);
		const meta = JSON.parse(
			await readFile(join(dir, "eu", "meta.json"), "utf8"),
		);
		expect(meta).toEqual({
			listId: "EU_CONSOLIDATED",
			version: "demo-1",
			generatedAt: GENERATED_AT,
			model: "Xenova/all-MiniLM-L6-v2",
			dim: DIM,
			entitiesCount: 2,
			fetchedAt: GENERATED_AT,
			sourceUpdatedAt: "2026-06-18T12:00:00Z",
			stale: false,
			staleReason: null,
		});
	});

	test("writes a top-level catalog.json listing every list", async () => {
		await stageBundle(dir, lists(), GENERATED_AT);
		const catalog = JSON.parse(
			await readFile(join(dir, "catalog.json"), "utf8"),
		);
		expect(catalog).toEqual({
			schemaVersion: 1,
			generatedAt: GENERATED_AT,
			lists: [
				{
					id: "OFAC_SDN",
					title: "OFAC SDN",
					slug: "ofac",
					version: "demo-1",
					entitiesCount: 1,
					fetchedAt: GENERATED_AT,
					sourceUpdatedAt: "2026-06-18T12:00:00Z",
					stale: false,
					staleReason: null,
				},
				{
					id: "EU_CONSOLIDATED",
					title: "EU Consolidated",
					slug: "eu",
					version: "demo-1",
					entitiesCount: 2,
					fetchedAt: GENERATED_AT,
					sourceUpdatedAt: "2026-06-18T12:00:00Z",
					stale: false,
					staleReason: null,
				},
			],
		});
	});

	// The whole point of per-list freshness: a list this run could NOT refresh
	// must carry the age it ACTUALLY has, not the age of the run that re-served
	// it. If `fetchedAt` were restamped to `generatedAt`, a three-day-old EU list
	// would read as published-today — a silent coverage lie.
	test("a carried-forward list keeps its OWN fetchedAt and is marked stale", async () => {
		const stale: ListFreshness = {
			fetchedAt: "2026-06-16T00:00:00Z",
			sourceUpdatedAt: "2026-06-15T09:00:00Z",
			stale: true,
			staleReason: "EU request failed: 500 Internal Server Error",
		};
		const [ofac, eu] = lists() as [StagedList, StagedList];
		await stageBundle(
			dir,
			[ofac, { ...eu, version: "demo-0", freshness: stale }],
			GENERATED_AT,
		);

		const meta = JSON.parse(
			await readFile(join(dir, "eu", "meta.json"), "utf8"),
		);
		expect(meta.fetchedAt).toBe("2026-06-16T00:00:00Z");
		expect(meta.stale).toBe(true);
		expect(meta.staleReason).toMatch(/500 Internal Server Error/);
		// It also keeps its OWN version — it was not rebuilt today.
		expect(meta.version).toBe("demo-0");
		// generatedAt is when the BUNDLE was assembled; it must not masquerade
		// as when this list was refreshed.
		expect(meta.generatedAt).toBe(GENERATED_AT);

		const catalog = JSON.parse(
			await readFile(join(dir, "catalog.json"), "utf8"),
		);
		const entry = catalog.lists.find(
			(l: { id: string }) => l.id === "EU_CONSOLIDATED",
		);
		expect(entry).toMatchObject({
			version: "demo-0",
			fetchedAt: "2026-06-16T00:00:00Z",
			stale: true,
		});
		// The fresh list alongside it is untouched — one stale feed does not
		// contaminate the lists that DID refresh.
		const ofacEntry = catalog.lists.find(
			(l: { id: string }) => l.id === "OFAC_SDN",
		);
		expect(ofacEntry).toMatchObject({ stale: false, fetchedAt: GENERATED_AT });
	});

	test("rejects a list whose vectors length != entities*dim (fail loud)", async () => {
		const bad: readonly StagedList[] = [
			{
				listId: "OFAC_SDN",
				slug: "ofac",
				title: "OFAC SDN",
				version: "demo-1",
				model: "Xenova/all-MiniLM-L6-v2",
				dim: DIM,
				entities: [entity("OFAC_SDN:0001", "x")],
				vectors: new Float32Array([1, 2]), // expected dim*1 = 3
				freshness: FRESH,
			},
		];
		await expect(stageBundle(dir, bad, GENERATED_AT)).rejects.toThrow(
			/vectors length/,
		);
	});

	test("is byte-deterministic across two stagings", async () => {
		await stageBundle(dir, lists(), GENERATED_AT);
		const a = await readFile(join(dir, "catalog.json"));
		const aMeta = await readFile(join(dir, "eu", "meta.json"));
		const aJsonl = await readFile(join(dir, "eu", "entities.jsonl"));

		const dir2 = await mkdtemp(join(tmpdir(), "aml-stage2-"));
		await stageBundle(dir2, lists(), GENERATED_AT);
		expect(await readFile(join(dir2, "catalog.json"))).toEqual(a);
		expect(await readFile(join(dir2, "eu", "meta.json"))).toEqual(aMeta);
		expect(await readFile(join(dir2, "eu", "entities.jsonl"))).toEqual(aJsonl);
		await rm(dir2, { recursive: true, force: true });
	});
});
