// The BUNDLE load path: turn a content-addressed, signed bundle origin into the
// SAME (catalog + per-list LoadedWatchlist) shape the JSON path produces, so the
// EngineRuntime can screen from it unchanged.
//
// It drives `@gainratio/browser`'s signed delta-sync tier THROUGH A WORKER (EngineClient
// → the consumer-owned edgeproc.worker.ts entry): the Worker owns the durable CacheStore (OPFS sync access handles are
// Worker-only — opening the store or reading a chunk on the MAIN thread hangs), so
// the main thread only sends typed requests and awaits bytes. One `sync` against
// the bundle base URL fetches + verifies the signed `/latest` pointer
// (cache:no-store), verifies the manifest by content hash, delta-fetches only the
// missing chunks, re-verifies each chunk + each reassembled file, and atomically
// promotes into the durable store (so a reload re-uses chunks and an offline
// reload still screens). It then `readFile`s `catalog.json` + each enabled list's
// `<slug>/{entities.jsonl,vectors.f32,meta.json}` out of the store and projects
// them onto WatchlistCatalog / LoadedWatchlist on the main thread.
//
// Trust: the Worker fetches the pinned SAME-ORIGIN pubkey (from `pubkeyUrl`, no-store)
// and verifies fail-closed — any signature/hash mismatch (over fetched OR cached
// bytes) aborts the load. The pubkey is NEVER fetched from the bundle origin.

import {
	type SyncProgress as EdgeprocSyncProgress,
	EngineClient,
	type EngineStorageOptions,
	type EngineSyncOptions,
	type IndexedDbLayout,
	type SyncResult,
} from "@gainratio/browser";
import type { OnSyncProgress } from "./bundleProgress";
import EdgeprocWorker from "./edgeproc.worker?worker";
import {
	buildLoadedFromBundleFiles,
	buildLoadedWatchlistMetadataFromBundleFiles,
	type LoadedWatchlist,
	type LoadedWatchlistMetadata,
	resolveListFreshness,
	type WatchlistCatalog,
	type WatchlistCatalogEntry,
	WatchlistFormatError,
} from "./watchlist";

const DECODER = new TextDecoder();

/** The identity half of one entry in the materialized `catalog.json`. The
 * freshness block is deliberately NOT here: it is optional on the wire (every
 * bundle published before per-list freshness omits it) and is resolved through
 * the shared rule, not read field by field. */
interface BundleCatalogIdentity {
	readonly id: string;
	readonly title: string;
	readonly slug: string;
	readonly version: string;
	readonly entitiesCount: number;
}

/** Narrow the identity half of a materialized bundle catalog entry. */
function isBundleCatalogIdentity(
	value: unknown,
): value is BundleCatalogIdentity {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const e = value as Record<string, unknown>;
	return (
		typeof e.id === "string" &&
		typeof e.title === "string" &&
		typeof e.slug === "string" &&
		typeof e.version === "string" &&
		typeof e.entitiesCount === "number" &&
		Number.isFinite(e.entitiesCount)
	);
}

/** Project ONE catalog entry, resolving its age through the shared rule.
 *
 * `catalog.json` is the only place the settings UI can learn a list's age before
 * any list directory is downloaded, so an entry whose age cannot be resolved is
 * rejected rather than defaulted to fresh. A LEGACY entry (no `fetchedAt`) is
 * aged from the catalog's `generatedAt` — see `resolveListAge` in watchlist.ts
 * for why that is truthful, and for the condition under which it can be deleted. */
function toCatalogEntry(
	value: unknown,
	generatedAt: unknown,
): WatchlistCatalogEntry {
	const freshness = resolveListFreshness(value, generatedAt);
	if (!isBundleCatalogIdentity(value) || freshness === null) {
		throw new WatchlistFormatError(
			`bundle catalog has a malformed list entry (id, title, slug, version, entitiesCount and a resolvable age are all required): ${JSON.stringify(value)}`,
		);
	}
	return {
		id: value.id,
		title: value.title,
		version: value.version,
		entitiesCount: value.entitiesCount,
		// `slug/` mirrors the JSON catalog's `path` (e.g. "ofac/") so the slug is
		// recoverable for materialization via `entry.path.replace(/\/$/, "")`.
		path: `${value.slug}/`,
		// Carried, not recomputed: this is the ONLY place a caller can learn how
		// old the list actually is, so dropping it here would blind the UI.
		...freshness,
	};
}

/** Validate a parsed bundle catalog fail-closed and project it onto the engine's
 * WatchlistCatalog shape. */
function parseBundleCatalog(value: unknown): WatchlistCatalog {
	if (typeof value !== "object" || value === null) {
		throw new WatchlistFormatError("bundle catalog.json is not an object");
	}
	const c = value as Record<string, unknown>;
	if (c.schemaVersion !== 1) {
		throw new WatchlistFormatError(
			`bundle catalog schemaVersion is ${String(c.schemaVersion)}; expected 1`,
		);
	}
	if (typeof c.generatedAt !== "string") {
		throw new WatchlistFormatError(
			"bundle catalog is missing generatedAt — the only anchor a pre-per-list-freshness list can be aged from",
		);
	}
	if (!Array.isArray(c.lists)) {
		throw new WatchlistFormatError("bundle catalog is missing a lists[] array");
	}
	return {
		schema: 1,
		generatedAt: c.generatedAt,
		lists: c.lists.map((entry) => toCatalogEntry(entry, c.generatedAt)),
	};
}

/** The bundle slug for a (catalog-projected) entry: its `path` sans trailing slash. */
function slugOf(entry: WatchlistCatalogEntry): string {
	return entry.path.replace(/\/$/, "");
}

/** The catalog file, always in scope: it is what every other scope is derived from. */
const CATALOG_PATH = "catalog.json";
const CACHE_NAMESPACE = "amlfilter-watchlists-v1";
const INDEXED_DB_LAYOUT: IndexedDbLayout = {
	database: "aml-filter-signed-bundles-v1",
	store: "entries",
	separator: "/",
};

function forwardChunkProgress(
	onProgress: OnSyncProgress | undefined,
): ((progress: EdgeprocSyncProgress) => void) | undefined {
	if (onProgress === undefined) return undefined;
	return (progress) => {
		if (progress.phase !== "chunks") return;
		onProgress({
			fetched: progress.fetchedChunks,
			total: progress.totalChunks,
			bytes: progress.bytesFetched,
		});
	};
}

/**
 * Translate a list selection into the manifest paths a sync must cover: the
 * catalog, plus one `slug/` directory prefix per selected list.
 *
 * `undefined` means "no selection expressed", which keeps the pre-scoping
 * behavior of syncing every list. An EMPTY array is a real selection of nothing
 * and correctly yields the catalog alone — it must not be confused with the
 * undefined case, which is why this is an explicit branch and not a falsy check.
 * An id that is not in the catalog is ignored; the catalog is the source of truth
 * for existence, matching how the runtime filters lists.
 */
function wantedPathsFor(
	catalog: WatchlistCatalog,
	enabledLists: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> | undefined {
	if (enabledLists === undefined) {
		return undefined;
	}
	const selected = catalog.lists.filter((entry) =>
		enabledLists.includes(entry.id),
	);
	return [CATALOG_PATH, ...selected.map((entry) => `${slugOf(entry)}/`)];
}

/** The worker-backed sync client seam the bundle source drives: `sync` runs the
 * delta-sync in the Worker (where browser storage is isolated), `readFile` materializes a synced
 * file's bytes out of the Worker's store. {@link EngineClient} satisfies it in the
 * browser; unit tests inject an in-process fake over a MemoryCacheStore. */
export interface BundleEngineClient {
	sync(
		baseUrl: string,
		pubkeyUrl: string,
		options?: EngineSyncOptions,
	): Promise<SyncResult>;
	readFile(path: string): Promise<Uint8Array>;
	clear(options?: EngineStorageOptions): Promise<void>;
	terminate?(): void;
}

/** The client seam the bundle source depends on; defaulted to a spawned Worker
 * EngineClient. Injectable so unit tests drive the committed bundle over an
 * in-memory store + an fs-backed fetch (the sharedBundleParity pattern) with no
 * Worker/browser storage. */
export interface BundleSourceDeps {
	readonly createClient: () => BundleEngineClient;
}

const defaultBundleSourceDeps: BundleSourceDeps = {
	createClient: () => new EngineClient(new EdgeprocWorker()),
};

/** How long "Clear cached lists" may wait for the storage Worker before it gives
 * up. The clear waits on the cross-tab sync Web Lock, so another tab mid-sync can
 * hold it; a bounded wait turns "stuck behind that tab" into an error the user can
 * act on instead of a spinner that never ends. */
export const CLEAR_BUNDLE_STORE_TIMEOUT_MS = 30_000;

/**
 * Drop the durable bundle store WITHOUT syncing first — the "Clear cached lists"
 * affordance and the in-app way out of a refused sync.
 *
 * Runs the library's own `EngineClient.clear()` in a temporary storage Worker,
 * which takes the same cross-tab sync Web Lock as a sync and removes every OPFS
 * chunk + manifest, the active pointer, AND the IndexedDB rollback floor for this
 * app's namespace/layout. It deliberately does NOT open a bundle source: since
 * edgeproc-browser #13 the stored pointer stays the anti-rollback floor across a
 * key change, so a visitor whose floor refuses the served pointer (a
 * `RollbackError`) could never clear a cache whose clear first had to sync.
 *
 * Only the signed-list cache is touched — the customer SQLite database lives in a
 * separate Worker and OPFS file this never opens.
 */
export async function clearBundleStore(
	deps: BundleSourceDeps = defaultBundleSourceDeps,
	timeoutMs: number = CLEAR_BUNDLE_STORE_TIMEOUT_MS,
): Promise<void> {
	const client = deps.createClient();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(
				new Error(
					`clearing cached lists timed out after ${timeoutMs} ms (another AML-Filter tab may be syncing)`,
				),
			);
		}, timeoutMs);
	});
	try {
		await Promise.race([
			client.clear({
				cacheNamespace: CACHE_NAMESPACE,
				indexedDbLayout: INDEXED_DB_LAYOUT,
			}),
			deadline,
		]);
	} finally {
		clearTimeout(timer);
		client.terminate?.();
	}
}

/** A synced bundle, exposing the SAME catalog + per-list loaders the runtime's
 * JSON path exposes — but reading from the materialized, content-verified store. */
export interface BundleSource {
	/** The bundle catalog projected onto the engine's WatchlistCatalog shape. */
	loadCatalog(): WatchlistCatalog;
	/** Build ONE list's LoadedWatchlist from its materialized bundle files,
	 * cross-checking the catalog/meta versions (fail-closed). */
	loadList(entry: WatchlistCatalogEntry): Promise<LoadedWatchlist>;
	/** Build browseable entity metadata without materializing vectors. */
	loadListMetadata?(
		entry: WatchlistCatalogEntry,
	): Promise<LoadedWatchlistMetadata>;
	/** The promoted bundle version (the signed `/latest` pointer's version). */
	version(): string;
	/** Drop the durable store (every chunk + manifest + the active pointer) — the
	 * "Clear cached lists" affordance; the next sync re-fetches + re-verifies. */
	clear(): Promise<void>;
	/** Terminate the source's sync Worker when this memoized source is evicted. */
	dispose?(): void;
}

/**
 * Delta-sync the bundle at `baseUrl` into the durable store (fail-closed verify in
 * the Worker against the pinned same-origin key at `pubkeyUrl`), then materialize +
 * validate its catalog, and return a {@link BundleSource} the runtime drives exactly
 * like the JSON loaders. The sync tier falls back to the cached active version when
 * offline (NetworkError on `/latest`), so a reload with no network still resolves.
 */
export async function openBundleSource(
	baseUrl: string,
	pubkeyUrl: string,
	deps: BundleSourceDeps = defaultBundleSourceDeps,
	onProgress?: OnSyncProgress,
	enabledLists?: ReadonlyArray<string>,
): Promise<BundleSource> {
	const client = deps.createClient();
	try {
		// TWO-PHASE SYNC.
		//
		// The bundle carries one directory per watchlist, and /screen's default
		// selection is OFAC SDN alone — so a cold boot has no business downloading
		// the EU, UK and UN directories it will never read (527 of the 1,296 chunks
		// and 18.4 MB of the 46.7 MB, measured against the live 2026-08-01 bundle).
		//
		// But the id -> slug mapping lives in `catalog.json`, INSIDE the bundle. So
		// phase one syncs the catalog alone (one chunk, ~700 bytes), and phase two
		// syncs the directories the selection actually resolves to.
		//
		// Both phases are complete, independent, fail-closed syncs: each re-fetches
		// the no-store `/latest` pointer, re-checks its ed25519 signature, re-checks
		// the manifest's content-address, and re-runs the anti-rollback sequence
		// gate. Splitting the FETCH did not split the VERIFY. Phase two costs one
		// extra pointer fetch (256 bytes); its manifest request is a conditional GET
		// against an immutable content-addressed URL.
		await client.sync(baseUrl, pubkeyUrl, {
			expectedBundleId: null,
			expectedChannel: null,
			wantedPaths: [CATALOG_PATH],
			cacheNamespace: CACHE_NAMESPACE,
			indexedDbLayout: INDEXED_DB_LAYOUT,
		});

		const catalog = parseBundleCatalog(
			JSON.parse(DECODER.decode(await client.readFile(CATALOG_PATH))),
		);

		// `onProgress` threads the cold-sync per-chunk ticks up to the boot banner;
		// undefined on reload/version-poll paths (no banner to feed).
		const wantedPaths = wantedPathsFor(catalog, enabledLists);
		const progress = forwardChunkProgress(onProgress);
		const result = await client.sync(baseUrl, pubkeyUrl, {
			expectedBundleId: null,
			expectedChannel: null,
			...(wantedPaths === undefined ? {} : { wantedPaths }),
			cacheNamespace: CACHE_NAMESPACE,
			indexedDbLayout: INDEXED_DB_LAYOUT,
			...(progress === undefined ? {} : { onProgress: progress }),
		});

		const loadList = async (
			entry: WatchlistCatalogEntry,
		): Promise<LoadedWatchlist> => {
			const slug = slugOf(entry);
			const [entitiesJsonl, vectorsF32, meta] = await Promise.all([
				client.readFile(`${slug}/entities.jsonl`),
				client.readFile(`${slug}/vectors.f32`),
				client.readFile(`${slug}/meta.json`),
			]);
			const loaded = buildLoadedFromBundleFiles({
				entitiesJsonl,
				vectorsF32,
				meta,
				manifestHash: result.manifestHash,
			});
			if (loaded.version !== entry.version) {
				throw new WatchlistFormatError(
					`bundle list ${entry.id} version skew: catalog ${entry.version}, meta ${loaded.version}`,
				);
			}
			return loaded;
		};
		const loadListMetadata = async (
			entry: WatchlistCatalogEntry,
		): Promise<LoadedWatchlistMetadata> => {
			const slug = slugOf(entry);
			const [entitiesJsonl, meta] = await Promise.all([
				client.readFile(`${slug}/entities.jsonl`),
				client.readFile(`${slug}/meta.json`),
			]);
			const loaded = buildLoadedWatchlistMetadataFromBundleFiles({
				entitiesJsonl,
				meta,
			});
			if (loaded.version !== entry.version || loaded.listId !== entry.id) {
				throw new WatchlistFormatError(
					`bundle list ${entry.id} metadata skew: catalog ${entry.version}, metadata ${loaded.listId}@${loaded.version}`,
				);
			}
			return loaded;
		};
		let disposed = false;
		const dispose = (): void => {
			if (disposed) {
				return;
			}
			disposed = true;
			client.terminate?.();
		};

		return {
			loadCatalog: () => catalog,
			loadList,
			loadListMetadata,
			version: () => result.version,
			clear: async () => {
				// Release this source's Worker (and its storage handles) BEFORE the
				// clear's own Worker takes the sync lock.
				dispose();
				await clearBundleStore(deps);
			},
			dispose,
		};
	} catch (error) {
		// A failed bootstrap must not strand a storage Worker. The runtime retries by
		// dropping this source; terminate the failed client before surfacing the
		// original error so the retry starts with a bounded worker count.
		client.terminate?.();
		throw error;
	}
}
