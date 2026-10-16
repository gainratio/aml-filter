import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	buildWatchlistSqlite,
	readWatchlistSqlite,
	WATCHLIST_SQLITE_NAME,
} from "./sqliteBundle.ts";
import {
	type ListFreshness,
	type StagedList,
	stageBundle,
} from "./stageBundle.ts";
import type { WatchlistEntity } from "./types.ts";

const GENERATED_AT = "2026-06-19T00:00:00Z";
const DIM = 3;

const FRESH: ListFreshness = {
	fetchedAt: GENERATED_AT,
	sourceUpdatedAt: "2026-06-18T12:00:00Z",
	stale: false,
	staleReason: null,
};

function sampleEntity(id: string, name: string): WatchlistEntity {
	return {
		entity_id: id,
		name_canonical: name,
		aliases: ["alias one"],
		dob: "1975-01-01",
		countries: ["RU"],
		risk_category: "SANCTION",
		source_list: "OFAC_SDN",
		list_version: "demo-1",
	};
}

function sampleList(): StagedList {
	return {
		listId: "OFAC_SDN",
		slug: "ofac",
		title: "OFAC SDN",
		version: "demo-1",
		model: "Xenova/all-MiniLM-L6-v2",
		dim: DIM,
		entities: [
			sampleEntity("OFAC_SDN:0001", "ivan fakovich"),
			sampleEntity("OFAC_SDN:0002", "maria petrova"),
		],
		vectors: new Float32Array([1, 2, 3, 0.25, -0.5, 0.75]),
		freshness: FRESH,
	};
}

describe("sqliteBundle", () => {
	test("builds a canonical 4 KiB page-aligned SQLite file and round-trips metadata, entities, and vectors", async () => {
		const list = sampleList();
		const bytes = await buildWatchlistSqlite(list, GENERATED_AT);

		expect(new TextDecoder().decode(bytes.subarray(0, 16))).toBe(
			"SQLite format 3\0",
		);
		expect(bytes.byteLength % 4096).toBe(0);
		const pageSize = ((bytes[16] ?? 0) << 8) | (bytes[17] ?? 0);
		expect(pageSize).toBeGreaterThanOrEqual(4096);
		expect(pageSize % 4096).toBe(0);

		const decoded = await readWatchlistSqlite(bytes);
		expect(decoded.meta).toEqual({
			listId: "OFAC_SDN",
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
		expect(decoded.entities).toEqual(list.entities);
		expect(Array.from(decoded.vectors)).toEqual(Array.from(list.vectors));
	});

	test("is byte-deterministic across repeated builds and writes watchlist.sqlite when includeSqlite is enabled", async () => {
		const list = sampleList();
		const first = await buildWatchlistSqlite(list, GENERATED_AT);
		const second = await buildWatchlistSqlite(list, GENERATED_AT);
		expect(second).toEqual(first);

		const dir = await mkdtemp(join(tmpdir(), "aml-sqlite-stage-"));
		try {
			await stageBundle(dir, [list], GENERATED_AT, { includeSqlite: true });
			const staged = new Uint8Array(
				await readFile(join(dir, "ofac", WATCHLIST_SQLITE_NAME)),
			);
			expect(staged).toEqual(first);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
