import { FlatVectorIndex } from "@edgeproc/browser/vector";
import { createSqliteVectorIndex } from "@edgeproc/browser/vector/sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VectorIndex } from "./vectorIndex";

describe("VectorIndex shared SQLite-vector adapter", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("builds a persistent OPFS SQLite-vector index and preserves AML hits", async () => {
		const matrix = new Float32Array([1, 0, 0, 1]);
		const ids = ["entity-1", "entity-2"];
		const index = new VectorIndex(matrix, ids, 2);
		const query = new Float32Array([0, 1]);

		await expect(index.search(query, 1)).resolves.toEqual([
			{ id: "entity-2", score: 1 },
		]);
		expect(createSqliteVectorIndex).toHaveBeenCalledWith({
			name: "aml-watchlist",
			dimension: 2,
			persistence: "opfs",
			memoryProfile: "auto",
		});
		await expect(index.searchByIds(query, ["entity-1"])).resolves.toEqual([
			{ id: "entity-1", score: 0 },
		]);
		expect(index.idAt(0)).toBe("entity-1");
	});

	it("releases the shared index and closes the AML view", async () => {
		const index = new VectorIndex(
			new Float32Array([1, 0, 0, 1]),
			["entity-1", "entity-2"],
			2,
		);
		await index.search(new Float32Array([1, 0]), 1);

		index.dispose();

		expect(index.ntotal).toBe(0);
		await expect(index.search(new Float32Array([1, 0]), 1)).rejects.toThrow(
			"vector index has been disposed",
		);
	});

	it("accepts the same SQLite contract through an environment-specific factory", async () => {
		class KeyedFlatVectorIndex extends FlatVectorIndex {
			public async insertKeyed(
				records: Parameters<FlatVectorIndex["insert"]>[0],
			): Promise<void> {
				await this.insert(records);
			}

			public lookupIds(): Promise<ReadonlyArray<string>> {
				return Promise.resolve([]);
			}
		}
		const factory = vi.fn(
			async (options: { name: string; dimension: number }) =>
				new KeyedFlatVectorIndex(options),
		);
		const index = new VectorIndex(
			new Float32Array([1, 0]),
			["entity-1"],
			2,
			factory,
		);

		await expect(index.search(new Float32Array([1, 0]), 1)).resolves.toEqual([
			{ id: "entity-1", score: 1 },
		]);
		expect(factory).toHaveBeenCalledWith({
			name: "aml-watchlist",
			dimension: 2,
			persistence: "opfs",
			memoryProfile: "auto",
		});
	});

	it("exposes an explicit readiness boundary for boot to await", async () => {
		const index = new VectorIndex(new Float32Array([1, 0]), ["entity-1"], 2);

		await expect(index.ready()).resolves.toBeUndefined();
	});

	it("stores lexical postings beside vectors and resolves bounded candidates", async () => {
		const lookupKeysForId = vi.fn((id: string) =>
			id === "entity-1"
				? [{ namespace: "token", value: "salim" }]
				: [{ namespace: "token", value: "petrov" }],
		);
		const index = new VectorIndex(
			new Float32Array([1, 0, 0, 1]),
			["entity-1", "entity-2"],
			2,
			undefined,
			lookupKeysForId,
		);
		// Key objects are produced only after the asynchronous SQLite boundary,
		// rather than materialized for the whole watchlist at construction time.
		expect(lookupKeysForId).not.toHaveBeenCalled();
		await index.ready();
		expect(lookupKeysForId).toHaveBeenCalledTimes(2);

		await expect(
			index.lookupIds([{ namespace: "token", value: "salim" }], 1),
		).resolves.toEqual(["entity-1"]);
	});
});
