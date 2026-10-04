// buildLoadedFromBundleFiles: build a LoadedWatchlist from the MATERIALIZED
// per-list bundle files (entities.jsonl + vectors.f32 + meta.json) the
// content-addressed sync tier reassembles. These cover the entities + vectors
// round-trip, the fail-closed shape/length checks, and — the load-bearing one —
// SCORING PARITY: a list built from bundle files must screen byte-identically to
// the SAME data built from the base64 JSON path (buildLoadedWatchlist), so the
// bundle path changes nothing about the explainable score.

import { FlatVectorIndex } from "@gainratio/browser/vector";
import type { SqliteKeyedVectorRecord } from "@gainratio/browser/vector/sqlite";
import { describe, expect, it, vi } from "vitest";
import type { ScreenQuery } from "./domain";
import type { Embedder } from "./embedder";
import { createScreeningEngine } from "./screeningEngine";
import type { AmlVectorIndexFactory } from "./vectorIndex";
import {
	type BundleListFiles,
	buildLoadedFromBundleFiles,
	buildLoadedWatchlist,
	decodeVectorBytes,
	type Watchlist,
	type WatchlistEntity,
	WatchlistFormatError,
} from "./watchlist";

const DIM = 384;
const ENCODER = new TextEncoder();

/** Two axis-aligned entities (rows hit axis 0 / axis 1). */
function fixtureEntities(): WatchlistEntity[] {
	return [
		{
			entity_id: "OFAC_SDN:0001",
			name_canonical: "ivan fakovich",
			aliases: ["vanya fakovich"],
			dob: "1971-03-14",
			countries: ["RU"],
			risk_category: "SANCTION",
			source_list: "OFAC_SDN",
			list_version: "demo-1",
		},
		{
			entity_id: "OFAC_SDN:0002",
			name_canonical: "maria petrova",
			aliases: [],
			dob: null,
			countries: ["RU", "BY"],
			risk_category: "SANCTION",
			source_list: "OFAC_SDN",
			list_version: "demo-1",
		},
	];
}

/** The packed, row-major LE Float32 matrix for the fixture (axis 0 / axis 1). */
function fixtureMatrix(): Float32Array {
	const matrix = new Float32Array(2 * DIM);
	matrix[0 * DIM + 0] = 1;
	matrix[1 * DIM + 1] = 1;
	return matrix;
}

/** Raw vectors.f32 bytes for the fixture matrix. */
function fixtureVectorBytes(): Uint8Array {
	const matrix = fixtureMatrix();
	return new Uint8Array(matrix.buffer.slice(0));
}

/** entities.jsonl bytes (one entity JSON per line, trailing newline). */
function fixtureEntitiesJsonl(
	entities: readonly WatchlistEntity[],
): Uint8Array {
	return ENCODER.encode(
		`${entities.map((e) => JSON.stringify(e)).join("\n")}\n`,
	);
}

/** A complete, well-formed meta.json object — the shape the publisher stages. */
function metaObject(entitiesCount: number, dim = DIM): Record<string, unknown> {
	return {
		listId: "OFAC_SDN",
		version: "demo-1",
		generatedAt: "2026-06-22T00:00:00Z",
		model: "Xenova/all-MiniLM-L6-v2",
		dim,
		entitiesCount,
		fetchedAt: "2026-06-21T09:30:00Z",
		sourceUpdatedAt: "2026-06-20T00:00:00Z",
		stale: false,
		staleReason: null,
	};
}

/** meta.json bytes for the fixture. */
function fixtureMeta(entitiesCount: number, dim = DIM): Uint8Array {
	return ENCODER.encode(JSON.stringify(metaObject(entitiesCount, dim)));
}

/** A complete, valid set of bundle files for the fixture. */
function fixtureBundleFiles(): BundleListFiles {
	const entities = fixtureEntities();
	return {
		entitiesJsonl: fixtureEntitiesJsonl(entities),
		vectorsF32: fixtureVectorBytes(),
		meta: fixtureMeta(entities.length),
		manifestHash: "manifest-1",
	};
}

/** The fixture's bundle files with one meta.json field mutated or deleted. */
function filesWithMetaMutation(
	mutate: (meta: Record<string, unknown>) => void,
): BundleListFiles {
	const meta = metaObject(2);
	mutate(meta);
	return {
		...fixtureBundleFiles(),
		meta: ENCODER.encode(JSON.stringify(meta)),
	};
}

/** The equivalent JSON watchlist (same data, base64 vectors). */
function fixtureJsonWatchlist(): Watchlist {
	return {
		listId: "OFAC_SDN",
		version: "demo-1",
		generatedAt: "2026-06-22T00:00:00Z",
		model: "Xenova/all-MiniLM-L6-v2",
		dim: DIM,
		entities: fixtureEntities(),
		vectors: Buffer.from(fixtureMatrix().buffer).toString("base64"),
	};
}

/** A stub embedder returning the axis-0 direction — an exact hit for row 0. */
function axisZeroEmbedder(): Embedder {
	return {
		embed(): Promise<Float32Array> {
			const v = new Float32Array(DIM);
			v[0] = 1;
			return Promise.resolve(v);
		},
	};
}

describe("buildLoadedFromBundleFiles — entities + vectors round trip", () => {
	it("uses an aligned transferred vector buffer without copying it", () => {
		const bytes = fixtureVectorBytes();
		const matrix = decodeVectorBytes(bytes, DIM, 2);
		expect(matrix.buffer).toBe(bytes.buffer);
		expect(matrix.byteOffset).toBe(bytes.byteOffset);
	});

	it("copies an unaligned vector buffer to preserve Float32 alignment", () => {
		const aligned = fixtureVectorBytes();
		const wrapped = new Uint8Array(aligned.byteLength + 1);
		wrapped.set(aligned, 1);
		const unaligned = wrapped.subarray(1);
		const matrix = decodeVectorBytes(unaligned, DIM, 2);
		expect(matrix.buffer).not.toBe(unaligned.buffer);
		expect(matrix.byteOffset).toBe(0);
	});

	it("parses entities.jsonl into the id->Entity map with the wire projection", () => {
		const loaded = buildLoadedFromBundleFiles(fixtureBundleFiles());
		expect(loaded.listId).toBe("OFAC_SDN");
		expect(loaded.version).toBe("demo-1");
		expect([...loaded.entities.keys()].sort()).toEqual([
			"OFAC_SDN:0001",
			"OFAC_SDN:0002",
		]);
		const ivan = loaded.entities.get("OFAC_SDN:0001");
		// The same toEntity projection: title-cased display name, ISO dob lifted
		// into the array, canonicalized alias.
		expect(ivan?.primary_name).toBe("Ivan Fakovich");
		expect(ivan?.name_canonical).toBe("ivan fakovich");
		expect(ivan?.dob).toEqual(["1971-03-14"]);
		expect(ivan?.aliases[0]?.name).toBe("vanya fakovich");
		expect(ivan?.risk_category).toBe("SANCTION");
	});

	it("wraps vectors.f32 into a VectorIndex with one row per entity", async () => {
		const loaded = buildLoadedFromBundleFiles(fixtureBundleFiles());
		expect(loaded.index.ntotal).toBe(2);
		expect(loaded.index.dim).toBe(DIM);
		// Row 0 sits on axis 0 → the axis-0 query is an exact hit on entity 0.
		const q = new Float32Array(DIM);
		q[0] = 1;
		const hits = await loaded.index.search(q, 1);
		expect(hits[0]?.id).toBe("OFAC_SDN:0001");
		expect(hits[0]?.score).toBeCloseTo(1, 5);
	});
});

/** One persistent index file shared across loads, as OPFS is across visits. */
function sharedIndexFile() {
	const db = new (class extends FlatVectorIndex {
		public async insertKeyed(
			records: ReadonlyArray<SqliteKeyedVectorRecord>,
		): Promise<void> {
			await this.insert(records);
		}
		public lookupIds(): Promise<ReadonlyArray<string>> {
			return Promise.resolve([]);
		}
	})({ name: "x", dimension: DIM });
	const insertKeyed = vi.spyOn(db, "insertKeyed");
	const factory: AmlVectorIndexFactory = async () => db;
	return { insertKeyed, factory };
}

describe("buildLoadedFromBundleFiles — warm index bound to the signed bundle", () => {
	it("reuses the warm index for an identical bundle", async () => {
		const { insertKeyed, factory } = sharedIndexFile();
		await buildLoadedFromBundleFiles(
			fixtureBundleFiles(),
			factory,
		).index.ready();
		await buildLoadedFromBundleFiles(
			fixtureBundleFiles(),
			factory,
		).index.ready();
		expect(insertKeyed).toHaveBeenCalledTimes(1);
	});

	it("rebuilds when the verified manifest hash changes", async () => {
		const { insertKeyed, factory } = sharedIndexFile();
		await buildLoadedFromBundleFiles(
			fixtureBundleFiles(),
			factory,
		).index.ready();
		const next = { ...fixtureBundleFiles(), manifestHash: "manifest-2" };
		await buildLoadedFromBundleFiles(next, factory).index.ready();
		expect(insertKeyed).toHaveBeenCalledTimes(2);
	});

	it("rebuilds with the new alias's lookup keys after an alias-only update", async () => {
		const { insertKeyed, factory } = sharedIndexFile();
		await buildLoadedFromBundleFiles(
			fixtureBundleFiles(),
			factory,
		).index.ready();
		const entities = fixtureEntities().map((e, i) =>
			i === 0 ? { ...e, aliases: ["vanya fakovich", "zorro"] } : e,
		);
		const next = {
			...fixtureBundleFiles(),
			entitiesJsonl: fixtureEntitiesJsonl(entities),
		};
		await buildLoadedFromBundleFiles(next, factory).index.ready();
		expect(insertKeyed).toHaveBeenCalledTimes(2);
		const written = insertKeyed.mock.calls[1]?.[0] ?? [];
		const values = written.flatMap((r) =>
			(r.lookupKeys ?? []).map((k) => k.value),
		);
		expect(values).toContain("zorro");
	});
});

describe("buildLoadedFromBundleFiles — fail-closed validation", () => {
	it("rejects a vectors.f32 of the wrong byte length", () => {
		const files = fixtureBundleFiles();
		const truncated: BundleListFiles = {
			...files,
			vectorsF32: files.vectorsF32.slice(0, files.vectorsF32.byteLength - 4),
		};
		expect(() => buildLoadedFromBundleFiles(truncated)).toThrow(
			WatchlistFormatError,
		);
	});

	it("rejects a meta.json with a non-384 dim", () => {
		const files: BundleListFiles = {
			...fixtureBundleFiles(),
			meta: fixtureMeta(2, 128),
		};
		expect(() => buildLoadedFromBundleFiles(files)).toThrow(/dim/);
	});

	it("rejects when entities.jsonl line count disagrees with meta.entitiesCount", () => {
		const files: BundleListFiles = {
			...fixtureBundleFiles(),
			meta: fixtureMeta(5),
		};
		expect(() => buildLoadedFromBundleFiles(files)).toThrow(
			WatchlistFormatError,
		);
	});

	it("rejects a malformed entities.jsonl line fail-closed", () => {
		const files: BundleListFiles = {
			...fixtureBundleFiles(),
			entitiesJsonl: ENCODER.encode('{"entity_id":"x"}\n'),
			meta: fixtureMeta(1),
		};
		expect(() => buildLoadedFromBundleFiles(files)).toThrow(
			WatchlistFormatError,
		);
	});
});

// THE GUARD THAT HAS TO BE ABLE TO FAIL.
//
// `meta.json` declares how old this list's data actually is. A screening tool
// that cannot age a list cannot honestly serve it: showing a three-day-old EU
// list with no warning is a coverage claim nothing backs. So every freshness
// field is REQUIRED and validated — never defaulted, never invented. A missing
// `fetchedAt` is NOT "fetched now"; a missing `stale` is NOT `false`.
//
// The pre-existing hole closed here: `generatedAt` and `model` were DECLARED on
// BundleListMeta but never narrowed, so any garbage in those fields sailed
// through typed as `string`.
describe("assertBundleListMeta — per-list freshness, fail-closed", () => {
	it("accepts a meta.json carrying complete, parseable freshness", () => {
		const loaded = buildLoadedFromBundleFiles(fixtureBundleFiles());
		expect(loaded.listId).toBe("OFAC_SDN");
	});

	it("accepts a stale meta.json with a null sourceUpdatedAt and a reason", () => {
		const files = filesWithMetaMutation((m) => {
			m.stale = true;
			m.staleReason = "EU feed returned HTTP 500";
			m.sourceUpdatedAt = null;
		});
		expect(() => buildLoadedFromBundleFiles(files)).not.toThrow();
	});

	// CONTRACT REVERSED, deliberately. This test used to assert that a meta.json
	// with no `fetchedAt` is REJECTED. That contract was wrong and it was a
	// production deploy hazard: every bundle published before per-list freshness —
	// including the one aml-filter.com serves — has no per-list `fetchedAt` in its
	// meta, so the strict client would refuse to load the deployed watchlist. A
	// legacy meta is now aged from its OWN `generatedAt`. A `fetchedAt` that is
	// PRESENT and malformed is still rejected (the three tests below).
	it("ACCEPTS a legacy meta.json with no freshness block, aged from generatedAt", () => {
		const files = filesWithMetaMutation((m) => {
			delete m.fetchedAt;
			delete m.sourceUpdatedAt;
			delete m.stale;
			delete m.staleReason;
		});
		expect(() => buildLoadedFromBundleFiles(files)).not.toThrow();
	});

	it("REJECTS a legacy meta.json whose generatedAt cannot be parsed", () => {
		const files = filesWithMetaMutation((m) => {
			delete m.fetchedAt;
			m.generatedAt = "whenever";
		});
		expect(() => buildLoadedFromBundleFiles(files)).toThrow(
			WatchlistFormatError,
		);
	});

	it("REJECTS an empty-string fetchedAt", () => {
		const files = filesWithMetaMutation((m) => {
			m.fetchedAt = "";
		});
		expect(() => buildLoadedFromBundleFiles(files)).toThrow(/freshness/);
	});

	it("REJECTS an unparseable fetchedAt", () => {
		const files = filesWithMetaMutation((m) => {
			m.fetchedAt = "last Tuesday";
		});
		expect(() => buildLoadedFromBundleFiles(files)).toThrow(/freshness/);
	});

	it("REJECTS a non-string fetchedAt (an epoch number is not the wire type)", () => {
		const files = filesWithMetaMutation((m) => {
			m.fetchedAt = 1_782_000_000_000;
		});
		expect(() => buildLoadedFromBundleFiles(files)).toThrow(/freshness/);
	});

	it("REJECTS a missing stale flag — absence is NOT 'fresh'", () => {
		const files = filesWithMetaMutation((m) => {
			delete m.stale;
		});
		expect(() => buildLoadedFromBundleFiles(files)).toThrow(/freshness/);
	});

	it('REJECTS a stringly-typed stale flag ("yes" is not a boolean)', () => {
		const files = filesWithMetaMutation((m) => {
			m.stale = "yes";
		});
		expect(() => buildLoadedFromBundleFiles(files)).toThrow(/freshness/);
	});

	it("REJECTS a missing sourceUpdatedAt — null must be stated, not implied", () => {
		const files = filesWithMetaMutation((m) => {
			delete m.sourceUpdatedAt;
		});
		expect(() => buildLoadedFromBundleFiles(files)).toThrow(/freshness/);
	});

	it("REJECTS an unparseable sourceUpdatedAt", () => {
		const files = filesWithMetaMutation((m) => {
			m.sourceUpdatedAt = "not-a-date";
		});
		expect(() => buildLoadedFromBundleFiles(files)).toThrow(/freshness/);
	});

	it("REJECTS a missing staleReason", () => {
		const files = filesWithMetaMutation((m) => {
			delete m.staleReason;
		});
		expect(() => buildLoadedFromBundleFiles(files)).toThrow(/freshness/);
	});

	it("REJECTS a non-string, non-null staleReason", () => {
		const files = filesWithMetaMutation((m) => {
			m.staleReason = 500;
		});
		expect(() => buildLoadedFromBundleFiles(files)).toThrow(/freshness/);
	});

	it("REJECTS an unparseable generatedAt (the pre-existing unnarrowed hole)", () => {
		const files = filesWithMetaMutation((m) => {
			m.generatedAt = "whenever";
		});
		expect(() => buildLoadedFromBundleFiles(files)).toThrow(
			WatchlistFormatError,
		);
	});

	it("REJECTS a non-string model (the pre-existing unnarrowed hole)", () => {
		const files = filesWithMetaMutation((m) => {
			m.model = 42;
		});
		expect(() => buildLoadedFromBundleFiles(files)).toThrow(
			WatchlistFormatError,
		);
	});

	it("REJECTS an empty model", () => {
		const files = filesWithMetaMutation((m) => {
			m.model = "";
		});
		expect(() => buildLoadedFromBundleFiles(files)).toThrow(
			WatchlistFormatError,
		);
	});
});

describe("buildLoadedFromBundleFiles — scoring parity with the JSON path", () => {
	it("screens byte-identically to a JSON-built list of the same data", async () => {
		const embedder = axisZeroEmbedder();
		const fromBundle = createScreeningEngine(
			buildLoadedFromBundleFiles(fixtureBundleFiles()),
			embedder,
		);
		const fromJson = createScreeningEngine(
			buildLoadedWatchlist(fixtureJsonWatchlist()),
			embedder,
		);
		const query: ScreenQuery = {
			name: "ivan fakovich",
			dob: "1971-03-14",
			country: "RU",
			threshold: 0.1,
			k: 20,
		};
		const bundleRes = await fromBundle.screen(query);
		const jsonRes = await fromJson.screen(query);
		// The matches array (score + reasons + explanation) must be identical
		// regardless of how the bytes arrived — the only thing that differs is
		// request_id / execution_time_ms (drop those before comparing).
		expect(bundleRes.matches).toEqual(jsonRes.matches);
		// And the DOB signal really fired (this is a DOB-bearing entity).
		const ivan = bundleRes.matches.find((m) => m.entity_id === "OFAC_SDN:0001");
		expect(ivan?.reasons.some((r) => r.signal === "dob_match")).toBe(true);
	});
});
