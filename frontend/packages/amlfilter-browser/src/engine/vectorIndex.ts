// AML's watchlist-facing adapter over the shared SQLite + sqlite-vector
// browser runtime. The derived query index lives in a persistent SQLite file on
// OPFS with SQLite's own page cache sized to the device (memoryProfile "auto":
// iOS gets the smallest cache), so the 48 MB index is NOT held in WebAssembly
// heap next to the embedding model. Each list owns one database file (named by
// list id) that is cleared and rebuilt on open, so no stale rows or per-version
// files survive. In-memory SQLite is a last resort used only when OPFS cannot
// open (private browsing, another tab owns the file); it is logged and exposed
// through vectorIndexStorage() so the UI can say so. All semantic scoring still
// runs through sqlite-vector in a Worker.

import type { VectorIndex as SharedVectorIndex } from "@gainratio/browser/vector";
import {
	createSqliteVectorIndex,
	type SqliteKeyedVectorRecord,
	type SqliteLookupKey,
	type SqliteVectorWorkerOptions,
} from "@gainratio/browser/vector/sqlite";
import { ENGINE_VERSION } from "./version";

/** A scored retrieval hit: an entity id and its cosine similarity to the query. */
export interface VectorHit {
	readonly id: string;
	readonly score: number;
}

/** Where the query index lives: pending, persistent OPFS, or the visible last-resort memory fallback. */
export type VectorIndexStorage = "pending" | "opfs" | "memory-fallback";

let storage: VectorIndexStorage = "pending";
const storageListeners = new Set<() => void>();

/** Current storage mode of the most recently opened index. */
export function vectorIndexStorage(): VectorIndexStorage {
	return storage;
}

/** useSyncExternalStore-compatible subscription to storage-mode changes. */
export function subscribeVectorIndexStorage(listener: () => void): () => void {
	storageListeners.add(listener);
	return () => storageListeners.delete(listener);
}

function setStorage(next: VectorIndexStorage): void {
	storage = next;
	if (typeof document !== "undefined") {
		document.documentElement.dataset.amlIndexStorage = next;
	}
	for (const listener of storageListeners) listener();
}

const DEFAULT_INDEX_NAME = "aml-watchlist";
const INSERT_BATCH_SIZE = 512;
const EMPTY_LOOKUP_KEYS: readonly SqliteLookupKey[] = [];

/** Environment adapter: browser Worker in product, in-process SQLite in Node evals. */
interface AmlSqliteVectorIndex extends SharedVectorIndex {
	insertKeyed(records: ReadonlyArray<SqliteKeyedVectorRecord>): Promise<void>;
	lookupIds(
		keys: ReadonlyArray<SqliteLookupKey>,
		maxDocumentFrequency: number,
	): Promise<ReadonlyArray<string>>;
}

export type AmlVectorIndexFactory = (
	options: SqliteVectorWorkerOptions,
) => Promise<AmlSqliteVectorIndex>;

const MARKER_KEY = "content";

/** SHA-256 over the verified vectors, ids and engine version: the identity of this index's content. */
async function contentMarker(
	matrix: Float32Array,
	ids: ReadonlyArray<string>,
	dim: number,
): Promise<string> {
	const head = new TextEncoder().encode(
		JSON.stringify([ENGINE_VERSION, dim, ids]),
	);
	const bytes = new Uint8Array(head.length + matrix.byteLength);
	bytes.set(head);
	bytes.set(
		new Uint8Array(matrix.buffer, matrix.byteOffset, matrix.byteLength),
		head.length,
	);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

/** True only if every row, and nothing else, was written for this marker. Any doubt (including a corrupt file) is false. */
async function holdsExactly(
	index: AmlSqliteVectorIndex,
	marker: string,
	rows: number,
): Promise<boolean> {
	try {
		const total = (await index.stats()).vectorCount;
		const marked = (await index.stats({ [MARKER_KEY]: marker })).vectorCount;
		return rows > 0 && total === rows && marked === rows;
	} catch {
		return false;
	}
}

/** Persistent OPFS first; in-memory SQLite only if that cannot open, loudly. */
async function openWithMemoryFallback(
	factory: AmlVectorIndexFactory,
	name: string,
	dimension: number,
): Promise<AmlSqliteVectorIndex> {
	try {
		const index = await factory({
			name,
			dimension,
			persistence: "opfs",
			memoryProfile: "auto",
		});
		setStorage("opfs");
		return index;
	} catch (cause) {
		console.warn(
			"AML vector index: OPFS unavailable, using the in-memory fallback (higher memory use)",
			cause,
		);
		// The whole index lives in the heap here, so a capped profile would fail with SQLITE_NOMEM.
		const index = await factory({
			name,
			dimension,
			persistence: "memory",
			memoryProfile: "full",
		});
		setStorage("memory-fallback");
		return index;
	}
}

/** Loaded, query-ready vector index over the decoded watchlist vectors. */
export class VectorIndex {
	readonly #dim: number;
	readonly #ready: Promise<AmlSqliteVectorIndex>;
	readonly #factory: AmlVectorIndexFactory;
	#ids: ReadonlyArray<string>;
	#disposed = false;

	public constructor(
		matrix: Float32Array,
		ids: ReadonlyArray<string>,
		dim: number,
		factory: AmlVectorIndexFactory = createSqliteVectorIndex,
		lookupKeysForId: (id: string) => ReadonlyArray<SqliteLookupKey> = () =>
			EMPTY_LOOKUP_KEYS,
		name: string = DEFAULT_INDEX_NAME,
	) {
		if (matrix.length !== ids.length * dim) {
			throw new Error(
				`matrix has ${matrix.length} floats; expected ${ids.length * dim} (${ids.length} rows * ${dim} dim)`,
			);
		}
		this.#ids = [...ids];
		this.#dim = dim;
		this.#factory = factory;
		this.#ready = this.#initialize(matrix, ids, lookupKeysForId, name);
	}

	public get ntotal(): number {
		return this.#disposed ? 0 : this.#ids.length;
	}

	public get dim(): number {
		return this.#dim;
	}

	/** Wait until the Worker, SQLite runtime, and all rows are query-ready. */
	public async ready(): Promise<void> {
		await this.#openIndex();
	}

	/** Release the SQLite Worker after a streamed list has been scored. */
	public dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#ids = [];
		void this.#ready.then((index) => index.dispose()).catch(() => undefined);
	}

	public idAt(row: number): string {
		this.#assertOpen();
		const id = this.#ids[row];
		if (id === undefined) {
			throw new RangeError(`row ${row} out of range`);
		}
		return id;
	}

	/** Cosines for known candidates in one sqlite-vector scan. */
	public async searchByIds(
		queryVec: Float32Array,
		ids: ReadonlyArray<string>,
	): Promise<ReadonlyArray<VectorHit>> {
		this.#assertQueryDimension(queryVec);
		const unique = [...new Set(ids)];
		for (const id of unique) {
			this.#assertKnownId(id);
		}
		const index = await this.#openIndex();
		return (await index.searchByIds(queryVec, unique)).map(
			({ id, distance }) => ({ id, score: distanceToSimilarity(distance) }),
		);
	}

	/** Resolve exact lexical/phonetic keys through SQLite's bounded postings. */
	public async lookupIds(
		keys: ReadonlyArray<SqliteLookupKey>,
		maxDocumentFrequency: number,
	): Promise<ReadonlyArray<string>> {
		this.#assertOpen();
		return (await this.#openIndex()).lookupIds(keys, maxDocumentFrequency);
	}

	/** Exact cosine top-k, retaining deterministic id tie breaking. */
	public async search(
		queryVec: Float32Array,
		k: number,
	): Promise<ReadonlyArray<VectorHit>> {
		this.#assertOpen();
		this.#assertQueryDimension(queryVec);
		const index = await this.#openIndex();
		return (await index.search(queryVec, normalizedLimit(k, this.ntotal))).map(
			({ id, distance }) => ({ id, score: distanceToSimilarity(distance) }),
		);
	}

	async #initialize(
		matrix: Float32Array,
		ids: ReadonlyArray<string>,
		lookupKeysForId: (id: string) => ReadonlyArray<SqliteLookupKey>,
		name: string,
	): Promise<AmlSqliteVectorIndex> {
		const index = await openWithMemoryFallback(this.#factory, name, this.#dim);
		try {
			const marker = await contentMarker(matrix, ids, this.#dim);
			if (await holdsExactly(index, marker, ids.length)) return index;
			// Missing, mismatched or partial rows: rebuild, never serve stale ones.
			await index.clear();
			for (let start = 0; start < ids.length; start += INSERT_BATCH_SIZE) {
				const end = Math.min(start + INSERT_BATCH_SIZE, ids.length);
				await index.insertKeyed(
					ids.slice(start, end).map((id, offset) => {
						const row = start + offset;
						return {
							id,
							vector: matrix.subarray(row * this.#dim, (row + 1) * this.#dim),
							metadata: { entityId: id, [MARKER_KEY]: marker },
							lookupKeys: lookupKeysForId(id),
						};
					}),
				);
			}
			return index;
		} catch (error) {
			await index.dispose();
			throw error;
		}
	}

	async #openIndex(): Promise<AmlSqliteVectorIndex> {
		this.#assertOpen();
		const index = await this.#ready;
		this.#assertOpen();
		return index;
	}

	#assertOpen(): void {
		if (this.#disposed) {
			throw new Error("vector index has been disposed");
		}
	}

	#assertQueryDimension(queryVec: Float32Array): void {
		if (queryVec.length !== this.#dim) {
			throw new Error(
				`query vector has ${queryVec.length} dims; index is ${this.#dim}`,
			);
		}
	}

	#assertKnownId(id: string): void {
		this.#assertOpen();
		if (!this.#ids.includes(id)) {
			throw new RangeError(
				`entity id ${JSON.stringify(id)} is not in this index`,
			);
		}
	}
}

function normalizedLimit(limit: number, size: number): number {
	if (Number.isNaN(limit) || limit <= 0) return 0;
	if (limit === Number.POSITIVE_INFINITY) return size;
	return Math.min(Math.trunc(limit), size);
}

function distanceToSimilarity(distance: number): number {
	return 1 - distance;
}
