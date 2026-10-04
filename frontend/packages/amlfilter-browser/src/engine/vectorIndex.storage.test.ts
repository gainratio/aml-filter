import { FlatVectorIndex } from "@gainratio/browser/vector";
import {
	createSqliteVectorIndex,
	type SqliteKeyedVectorRecord,
	type SqliteLookupKey,
} from "@gainratio/browser/vector/sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AmlVectorIndexFactory,
	VectorIndex,
	vectorIndexStorage,
} from "./vectorIndex";

/** A Flat index with the keyed-insert + exact-lookup surface the AML adapter needs. */
class KeyedFlat extends FlatVectorIndex {
	readonly #postings = new Map<string, Set<string>>();

	public async insertKeyed(
		records: ReadonlyArray<SqliteKeyedVectorRecord>,
	): Promise<void> {
		await this.insert(records);
		for (const { id, lookupKeys } of records) {
			for (const key of lookupKeys ?? []) {
				const posting = this.#postings.get(postingKey(key)) ?? new Set();
				posting.add(id);
				this.#postings.set(postingKey(key), posting);
			}
		}
	}

	public override async clear(): Promise<number> {
		this.#postings.clear();
		return super.clear();
	}

	public lookupIds(
		keys: ReadonlyArray<SqliteLookupKey>,
	): Promise<ReadonlyArray<string>> {
		const hits = keys.flatMap((key) => [
			...(this.#postings.get(postingKey(key)) ?? []),
		]);
		return Promise.resolve([...new Set(hits)].sort());
	}
}

function postingKey(key: SqliteLookupKey): string {
	return `${key.namespace}\u0000${key.value}`;
}

const alias = (value: string): SqliteLookupKey => ({ namespace: "t", value });

function indexBuildCounts(): { rebuilt: number; reused: number } {
	const { amlIndexRebuilt, amlIndexReused } = document.documentElement.dataset;
	return {
		rebuilt: Number(amlIndexRebuilt ?? 0),
		reused: Number(amlIndexReused ?? 0),
	};
}

/** Hex SHA-256 marker exactly as ea0db1b wrote it: engine version, dim, ids and vectors only. */
async function legacyMarker(
	vectors: Float32Array,
	rowIds: ReadonlyArray<string>,
	dim: number,
): Promise<string> {
	const head = new TextEncoder().encode(JSON.stringify(["4.0.0", dim, rowIds]));
	const bytes = new Uint8Array(head.length + vectors.byteLength);
	bytes.set(head);
	bytes.set(new Uint8Array(vectors.buffer), head.length);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

const matrix = new Float32Array([1, 0, 0, 1]);
const ids = ["entity-1", "entity-2"];
const toward1 = new Float32Array([1, 0]);

describe("VectorIndex storage: persistent OPFS index, visible memory fallback", () => {
	beforeEach(() => vi.clearAllMocks());
	afterEach(() => vi.restoreAllMocks());

	it("opens the persistent OPFS index with the auto memory profile", async () => {
		const index = new VectorIndex(matrix, ids, 2);
		await index.ready();
		expect(createSqliteVectorIndex).toHaveBeenCalledTimes(1);
		expect(createSqliteVectorIndex).toHaveBeenCalledWith({
			name: "aml-watchlist",
			dimension: 2,
			persistence: "opfs",
			memoryProfile: "auto",
		});
		expect(vectorIndexStorage()).toBe("opfs");
	});

	it("names the database per list so concurrent lists never share rows", async () => {
		const index = new VectorIndex(
			matrix,
			ids,
			2,
			undefined,
			undefined,
			"aml-watchlist-ofac",
		);
		await index.ready();
		expect(createSqliteVectorIndex).toHaveBeenCalledWith(
			expect.objectContaining({ name: "aml-watchlist-ofac" }),
		);
	});

	it("clears rows a previous session left in the persistent file", async () => {
		const stale = new KeyedFlat({ name: "x", dimension: 2 });
		await stale.insert([
			{ id: "ghost", vector: new Float32Array([1, 0]), metadata: {} },
		]);
		const factory: AmlVectorIndexFactory = async () => stale;
		const index = new VectorIndex(matrix, ids, 2, factory);
		const hits = await index.search(toward1, 5);
		expect(hits.map((h) => h.id)).not.toContain("ghost");
		expect(hits.map((h) => h.id).sort()).toEqual(ids);
	});

	it("falls back to in-memory SQLite only when OPFS cannot open, and says so", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.mocked(createSqliteVectorIndex).mockRejectedValueOnce(
			new Error("OPFS unavailable"),
		);
		const index = new VectorIndex(matrix, ids, 2);
		await expect(index.search(toward1, 1)).resolves.toEqual([
			{ id: "entity-1", score: 1 },
		]);
		const calls = vi.mocked(createSqliteVectorIndex).mock.calls;
		expect(calls.map(([o]) => o.persistence)).toEqual(["opfs", "memory"]);
		// The whole index sits in the heap, so a capped profile would hit SQLITE_NOMEM.
		expect(calls[1]?.[0].memoryProfile).toBe("full");
		expect(vectorIndexStorage()).toBe("memory-fallback");
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("in-memory"),
			expect.anything(),
		);
	});

	it("fails closed when even the in-memory fallback cannot open", async () => {
		vi.mocked(createSqliteVectorIndex)
			.mockRejectedValueOnce(new Error("OPFS unavailable"))
			.mockRejectedValueOnce(new Error("no wasm"));
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const index = new VectorIndex(matrix, ids, 2);
		await expect(index.ready()).rejects.toThrow("no wasm");
	});

	describe("warm reuse of the persistent index", () => {
		function shared() {
			const db = new KeyedFlat({ name: "x", dimension: 2 });
			const insertKeyed = vi.spyOn(db, "insertKeyed");
			const factory: AmlVectorIndexFactory = async () => db;
			return { db, insertKeyed, factory };
		}

		it("reuses rows written for the same verified content", async () => {
			const { insertKeyed, factory } = shared();
			await new VectorIndex(matrix, ids, 2, factory).ready();
			expect(insertKeyed).toHaveBeenCalledTimes(1);
			const warm = new VectorIndex(matrix, ids, 2, factory);
			await expect(warm.search(toward1, 1)).resolves.toEqual([
				{ id: "entity-1", score: 1 },
			]);
			expect(insertKeyed).toHaveBeenCalledTimes(1);
		});

		it("rebuilds when the stored marker belongs to different content", async () => {
			const { insertKeyed, factory } = shared();
			await new VectorIndex(matrix, ids, 2, factory).ready();
			const changed = new Float32Array([0, 1, 1, 0]);
			const next = new VectorIndex(changed, ids, 2, factory);
			await expect(next.search(toward1, 1)).resolves.toEqual([
				{ id: "entity-2", score: 1 },
			]);
			expect(insertKeyed).toHaveBeenCalledTimes(2);
		});

		it("rebuilds when the file holds extra rows beside the marked ones", async () => {
			const { db, insertKeyed, factory } = shared();
			await new VectorIndex(matrix, ids, 2, factory).ready();
			await db.insert([
				{ id: "ghost", vector: new Float32Array([1, 0]), metadata: {} },
			]);
			const hits = await new VectorIndex(matrix, ids, 2, factory).search(
				toward1,
				5,
			);
			expect(hits.map((h) => h.id)).not.toContain("ghost");
			expect(insertKeyed).toHaveBeenCalledTimes(2);
		});

		it("counts reuses and rebuilds on the document so a live smoke can see them", async () => {
			const { factory } = shared();
			const before = indexBuildCounts();
			await new VectorIndex(matrix, ids, 2, factory).ready();
			await new VectorIndex(matrix, ids, 2, factory).ready();
			const after = indexBuildCounts();
			expect(after.rebuilt - before.rebuilt).toBe(1);
			expect(after.reused - before.reused).toBe(1);
		});

		it("rebuilds when only an alias changed, and the new alias is found", async () => {
			const { db, insertKeyed, factory } = shared();
			const keysV1 = (id: string) => (id === "entity-1" ? [alias("ivan")] : []);
			await new VectorIndex(matrix, ids, 2, factory, keysV1, "l", "m1").ready();
			const keysV2 = (id: string) =>
				id === "entity-1" ? [alias("ivan"), alias("vanya")] : [];
			const next = new VectorIndex(matrix, ids, 2, factory, keysV2, "l", "m1");
			await expect(next.lookupIds([alias("vanya")], 10)).resolves.toEqual([
				"entity-1",
			]);
			expect(insertKeyed).toHaveBeenCalledTimes(2);
			expect(await db.lookupIds([alias("vanya")])).toEqual(["entity-1"]);
		});

		it("rebuilds when only an entity id changed", async () => {
			const { insertKeyed, factory } = shared();
			await new VectorIndex(matrix, ids, 2, factory).ready();
			const renamed = ["entity-1", "entity-3"];
			const next = new VectorIndex(matrix, renamed, 2, factory);
			const hits = await next.search(new Float32Array([0, 1]), 1);
			expect(hits.map((h) => h.id)).toEqual(["entity-3"]);
			expect(insertKeyed).toHaveBeenCalledTimes(2);
		});

		it("rebuilds when the verified manifest hash changed, even for identical rows", async () => {
			const { insertKeyed, factory } = shared();
			const noKeys = () => [];
			await new VectorIndex(matrix, ids, 2, factory, noKeys, "l", "m1").ready();
			await new VectorIndex(matrix, ids, 2, factory, noKeys, "l", "m2").ready();
			expect(insertKeyed).toHaveBeenCalledTimes(2);
		});

		it("reuses rows for an identical bundle (same manifest hash and keys)", async () => {
			const { insertKeyed, factory } = shared();
			const keys = (id: string) => [alias(id)];
			await new VectorIndex(matrix, ids, 2, factory, keys, "l", "m1").ready();
			await new VectorIndex(matrix, ids, 2, factory, keys, "l", "m1").ready();
			expect(insertKeyed).toHaveBeenCalledTimes(1);
		});

		it("rebuilds a warm index whose marker was written by the old marker scheme", async () => {
			const { db, insertKeyed, factory } = shared();
			const old = await legacyMarker(matrix, ids, 2);
			await db.insert(
				ids.map((id, row) => ({
					id,
					vector: matrix.subarray(row * 2, (row + 1) * 2),
					metadata: { entityId: id, content: old },
				})),
			);
			insertKeyed.mockClear();
			await new VectorIndex(matrix, ids, 2, factory).ready();
			expect(insertKeyed).toHaveBeenCalledTimes(1);
		});

		it("rebuilds instead of failing when the stored database is corrupt", async () => {
			const { db, insertKeyed, factory } = shared();
			await new VectorIndex(matrix, ids, 2, factory).ready();
			vi.spyOn(db, "stats").mockRejectedValueOnce(new Error("malformed"));
			const warm = new VectorIndex(matrix, ids, 2, factory);
			await expect(warm.search(toward1, 1)).resolves.toEqual([
				{ id: "entity-1", score: 1 },
			]);
			expect(insertKeyed).toHaveBeenCalledTimes(2);
		});
	});
});
