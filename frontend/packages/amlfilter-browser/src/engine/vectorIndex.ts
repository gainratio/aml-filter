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
// Each list owns its own index, so the fallback is tracked per list: a later
// list opening on OPFS must not hide an earlier list that is still in memory.
const fallbackLists = new Set<string>();
let fallbackSnapshot: ReadonlyArray<string> = [];

/** Storage mode across open indexes: "memory-fallback" while any list is in memory. */
export function vectorIndexStorage(): VectorIndexStorage {
	return storage;
}

/** List ids whose index fell back to memory, sorted; a stable snapshot for useSyncExternalStore. */
export function vectorIndexFallbackLists(): ReadonlyArray<string> {
	return fallbackSnapshot;
}

/** useSyncExternalStore-compatible subscription to storage-mode changes. */
export function subscribeVectorIndexStorage(listener: () => void): () => void {
	storageListeners.add(listener);
	return () => storageListeners.delete(listener);
}

/** `aml-watchlist-<listId>` → `<listId>`; any other name is reported as itself. */
function listIdOf(indexName: string): string {
	const prefix = `${DEFAULT_INDEX_NAME}-`;
	return indexName.startsWith(prefix)
		? indexName.slice(prefix.length)
		: indexName;
}

function setStorage(indexName: string, mode: VectorIndexStorage): void {
	if (mode === "memory-fallback") {
		fallbackLists.add(listIdOf(indexName));
	} else {
		fallbackLists.delete(listIdOf(indexName));
	}
	fallbackSnapshot = [...fallbackLists].sort();
	const next = fallbackLists.size > 0 ? "memory-fallback" : mode;
	storage = next;
	if (typeof document !== "undefined") {
		document.documentElement.dataset.amlIndexStorage = next;
	}
	for (const listener of storageListeners) listener();
}

/** Count each open's outcome on <html data-aml-index-rebuilt/-reused> so a live smoke can prove a returning visitor's stale index was rebuilt. */
function countIndexOpen(outcome: "amlIndexRebuilt" | "amlIndexReused"): void {
	if (typeof document === "undefined") return;
	const { dataset } = document.documentElement;
	dataset[outcome] = String(Number(dataset[outcome] ?? 0) + 1);
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
/**
 * Bumped whenever the marker's preimage changes. ea0db1b's marker covered ids
 * and vectors but not the lookup keys, so an alias-only list update reused a
 * stale index; the new scheme name guarantees every marker written before this
 * fix mismatches and the index is rebuilt on the next load.
 */
const MARKER_SCHEME = "aml-index-marker/v2";

function toHex(digest: ArrayBuffer): string {
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

/** SHA-256 of the vector bytes, hashed in place (no full-matrix copy) unless the buffer is shared. */
function vectorsDigest(matrix: Float32Array): Promise<string> {
	const { buffer, byteOffset, byteLength } = matrix;
	return sha256Hex(
		buffer instanceof ArrayBuffer
			? new Uint8Array(buffer, byteOffset, byteLength)
			: new Uint8Array(buffer, byteOffset, byteLength).slice(),
	);
}

/** One SHA-256 per insert batch of lookup keys, so keys are never held for the whole list at once. */
async function lookupKeysDigests(
	ids: ReadonlyArray<string>,
	lookupKeysForId: (id: string) => ReadonlyArray<SqliteLookupKey>,
): Promise<string[]> {
	const encoder = new TextEncoder();
	const digests: string[] = [];
	for (let start = 0; start < ids.length; start += INSERT_BATCH_SIZE) {
		const batch = ids
			.slice(start, start + INSERT_BATCH_SIZE)
			.map((id) => lookupKeysForId(id).map((k) => [k.namespace, k.value]));
		digests.push(await sha256Hex(encoder.encode(JSON.stringify(batch))));
	}
	return digests;
}

/**
 * The identity of this index's content: the verified bundle's manifest hash
 * (so ANY signed list change forces a rebuild) plus, belt-and-braces, every
 * row's id, lookup keys and vector bytes, the engine version and the scheme.
 */
async function contentMarker(
	matrix: Float32Array,
	ids: ReadonlyArray<string>,
	dim: number,
	lookupKeysForId: (id: string) => ReadonlyArray<SqliteLookupKey>,
	bundleIdentity: string,
): Promise<string> {
	const preimage = JSON.stringify([
		MARKER_SCHEME,
		ENGINE_VERSION,
		bundleIdentity,
		dim,
		ids,
		await lookupKeysDigests(ids, lookupKeysForId),
		await vectorsDigest(matrix),
	]);
	return sha256Hex(new TextEncoder().encode(preimage));
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
		setStorage(name, "opfs");
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
		setStorage(name, "memory-fallback");
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
		bundleIdentity = "",
	) {
		if (matrix.length !== ids.length * dim) {
			throw new Error(
				`matrix has ${matrix.length} floats; expected ${ids.length * dim} (${ids.length} rows * ${dim} dim)`,
			);
		}
		this.#ids = [...ids];
		this.#dim = dim;
		this.#factory = factory;
		this.#ready = this.#initialize(
			matrix,
			ids,
			lookupKeysForId,
			name,
			bundleIdentity,
		);
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
		bundleIdentity: string,
	): Promise<AmlSqliteVectorIndex> {
		const index = await openWithMemoryFallback(this.#factory, name, this.#dim);
		try {
			const marker = await contentMarker(
				matrix,
				ids,
				this.#dim,
				lookupKeysForId,
				bundleIdentity,
			);
			if (await holdsExactly(index, marker, ids.length)) {
				countIndexOpen("amlIndexReused");
				return index;
			}
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
			countIndexOpen("amlIndexRebuilt");
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
