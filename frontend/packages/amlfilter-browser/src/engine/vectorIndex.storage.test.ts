import { FlatVectorIndex } from "@edgeproc/browser/vector";
import { createSqliteVectorIndex } from "@edgeproc/browser/vector/sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AmlVectorIndexFactory,
	VectorIndex,
	vectorIndexStorage,
} from "./vectorIndex";

/** A Flat index with the keyed-insert surface the AML adapter needs. */
class KeyedFlat extends FlatVectorIndex {
	public async insertKeyed(
		records: Parameters<FlatVectorIndex["insert"]>[0],
	): Promise<void> {
		await this.insert(records);
	}
	public lookupIds(): Promise<ReadonlyArray<string>> {
		return Promise.resolve([]);
	}
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
});
