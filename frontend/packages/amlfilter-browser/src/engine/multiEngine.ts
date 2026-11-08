// The multi-list in-browser screen — Theme A wave 2. One warm embedder, N
// loaded watchlists (one ScreeningEngine per list), one scoring contract.
//
// The query is embedded ONCE; each per-list ScreeningEngine is driven via its
// async screenWithVector(...) with the shared vector. The per-list
// matches are concatenated, re-sorted by score, and truncated to top-k, so a
// strong hit in ANY list surfaces. Per-list thresholds let one list set a
// stricter bar without suppressing another list's strong hit.
//
// It satisfies the same `screen(query): Promise<ScreenResponse>` shape as a
// single ScreeningEngine, so onboarding/rescan/review consume it unchanged.

import type { Entity, Match, ScreenQuery, ScreenResponse } from "./domain";
import type { Embedder } from "./embedder";
import {
	createMatchReceiptSealer,
	type MatchReceiptSealer,
} from "./matchReceipts";
import {
	createScreeningEngine,
	type ScreeningEngine,
	type ScreenOptions,
} from "./screeningEngine";
import type { LoadedWatchlist } from "./watchlist";

/** Per-list score floors: a default for every list + optional overrides by id. */
export interface ListThresholds {
	readonly default: number;
	readonly perList?: Readonly<Record<string, number>>;
}

/** One loaded list paired with its query-ready engine. */
interface ListEngine {
	readonly listId: string;
	readonly version: string;
	readonly engine?: ScreeningEngine;
	readonly source?: StreamingListSource;
}

/** Metadata plus a one-shot loader used by the bounded-residency path. */
export interface StreamingListSource {
	readonly listId: string;
	readonly version: string;
	readonly entities: ReadonlyMap<string, Entity>;
	readonly load: () => Promise<LoadedWatchlist>;
}

/** A multi-list, in-tab screen: one embed, N lists, one scoring contract. */
export class MultiListScreeningEngine {
	readonly #lists: ListEngine[];
	readonly #embedder: Embedder;
	readonly #thresholds: ListThresholds;
	readonly #sealer: MatchReceiptSealer;
	#resident: {
		readonly listId: string;
		readonly engine: ScreeningEngine;
	} | null = null;
	#screenTail: Promise<void> = Promise.resolve();
	#disposed = false;
	#draining = false;
	#activeScreens = 0;
	#cleanupComplete = false;
	#drainWaiters: Array<() => void> = [];

	public constructor(
		lists: ReadonlyArray<ListEngine>,
		embedder: Embedder,
		thresholds: ListThresholds,
		// Injectable for tests; the production factories below always install the
		// real sealer, so the signing path is never opt-in.
		sealer: MatchReceiptSealer = createMatchReceiptSealer(),
	) {
		this.#lists = [...lists];
		this.#embedder = embedder;
		this.#thresholds = thresholds;
		this.#sealer = sealer;
	}

	/** Every entity across every list — backs the search UI's browse view. */
	public allEntities(): ReadonlyArray<Entity> {
		if (this.#disposed) {
			return [];
		}
		return this.#lists.flatMap(
			(l) =>
				l.engine?.allEntities() ?? [...(l.source?.entities.values() ?? [])],
		);
	}

	/** Each list's loaded version, keyed by list id — for the composite stamp. */
	public listVersions(): Readonly<Record<string, string>> {
		const out: Record<string, string> = {};
		for (const l of this.#lists) {
			out[l.listId] = l.version;
		}
		return out;
	}

	/** The effective score floor for a list: per-list override, else query, else default. */
	#thresholdFor(listId: string, query: ScreenQuery): number {
		return (
			this.#thresholds.perList?.[listId] ??
			query.threshold ??
			this.#thresholds.default
		);
	}

	/** Release the one cached streamed index and any eager indexes. */
	public dispose(): void {
		if (this.#disposed) {
			return;
		}
		this.#disposed = true;
		this.#draining = false;
		if (this.#activeScreens > 0) {
			return;
		}
		this.#cleanup();
	}

	/** Mark this engine disposed and wait for a running screen to finish. */
	public async disposeWhenIdle(): Promise<void> {
		if (!this.#disposed) {
			this.#disposed = true;
			this.#draining = true;
			if (this.#activeScreens === 0) {
				this.#cleanup();
			}
		}
		if (this.#cleanupComplete) {
			return;
		}
		await new Promise<void>((resolve) => this.#drainWaiters.push(resolve));
	}

	#cleanup(): void {
		if (this.#cleanupComplete) {
			return;
		}
		this.#cleanupComplete = true;
		this.#resident?.engine.dispose();
		this.#resident = null;
		for (const list of this.#lists) {
			list.engine?.dispose();
		}
		// Drop metadata references as well as vector matrices. This matters on
		// mobile where the entity maps and WASM model compete for the same tab heap.
		this.#lists.length = 0;
		for (const resolve of this.#drainWaiters.splice(0)) {
			resolve();
		}
	}

	/** Serialize screens so two mobile queries cannot materialize indexes together. */
	public screen(
		query: ScreenQuery,
		options: ScreenOptions = {},
	): Promise<ScreenResponse> {
		const run = this.#screenTail.then(() => {
			if (this.#disposed) {
				throw new Error("multi-list engine has been disposed");
			}
			this.#activeScreens += 1;
			return this.#screenNow(query, options).finally(() => {
				this.#activeScreens -= 1;
				if (this.#disposed && this.#activeScreens === 0) {
					this.#cleanup();
				}
			});
		});
		this.#screenTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** Screen across every list with a single shared query embedding. */
	async #screenNow(
		query: ScreenQuery,
		options: ScreenOptions,
	): Promise<ScreenResponse> {
		const start = Date.now();
		const queryVec = await this.#embedder.embed(query.name);
		const matches: Match[] = [];
		const versions: Record<string, string> = {};
		if (this.#lists.every((list) => list.engine !== undefined)) {
			const responses = await Promise.all(
				this.#lists.map((list) => {
					if (this.#disposed && !this.#draining) {
						throw new Error("multi-list engine has been disposed");
					}
					const threshold = this.#thresholdFor(list.listId, query);
					return (list.engine as ScreeningEngine).screenWithVector(
						{ ...query, threshold },
						queryVec,
						options,
					);
				}),
			);
			for (const res of responses) {
				matches.push(...res.matches);
				Object.assign(versions, res.list_versions_used);
			}
		} else {
			for (const list of this.#lists) {
				if (this.#disposed && !this.#draining) {
					throw new Error("multi-list engine has been disposed");
				}
				let engine = list.engine;
				let streamed = false;
				try {
					if (engine === undefined) {
						if (this.#resident?.listId !== list.listId) {
							this.#resident?.engine.dispose();
							this.#resident = null;
							const loaded = await list.source?.load();
							if (loaded === undefined) {
								throw new Error(`list ${list.listId} has no loader`);
							}
							if (this.#disposed && !this.#draining) {
								loaded.index.dispose();
								throw new Error("multi-list engine has been disposed");
							}
							if (
								loaded.listId !== list.listId ||
								loaded.version !== list.version
							) {
								loaded.index.dispose();
								throw new Error(
									`streamed list ${list.listId} metadata mismatch`,
								);
							}
							this.#resident = {
								listId: list.listId,
								engine: createScreeningEngine(loaded, this.#embedder),
							};
						}
						engine = this.#resident?.engine;
						streamed = true;
					}
					const threshold = this.#thresholdFor(list.listId, query);
					const res = await engine.screenWithVector(
						{ ...query, threshold },
						queryVec,
						options,
					);
					matches.push(...res.matches);
					Object.assign(versions, res.list_versions_used);
				} catch (error) {
					if (streamed && this.#resident?.listId === list.listId) {
						this.#resident.engine.dispose();
						this.#resident = null;
					}
					throw error;
				}
			}
		}
		matches.sort((a, b) => b.score - a.score);
		// Seal AFTER sort + top-k so we sign only what the caller actually receives
		// — never the truncated tail. Signing lives here (not in the synchronous
		// per-list screenWithVector) because Ed25519 signing is async.
		const top = matches.slice(0, query.k ?? 20);
		const sealed = await this.#sealer.seal(top, {
			query,
			listVersions: versions,
			possibleThresholdFor: (match) =>
				this.#thresholdFor(match.source_list, query),
		});
		return {
			request_id: crypto.randomUUID(),
			matches: sealed,
			list_versions_used: versions,
			execution_time_ms: Date.now() - start,
		};
	}
}

/** Build a MultiListScreeningEngine: one ScreeningEngine per list, one embedder. */
export function createMultiListScreeningEngine(
	loadedLists: ReadonlyArray<LoadedWatchlist>,
	embedder: Embedder,
	thresholds: ListThresholds,
): MultiListScreeningEngine {
	const lists = loadedLists.map((loaded) => ({
		listId: loaded.listId,
		version: loaded.version,
		engine: createScreeningEngine(loaded, embedder),
	}));
	return new MultiListScreeningEngine(lists, embedder, thresholds);
}

/** Build a multi-list engine that releases each vector index after screening. */
export function createStreamingMultiListScreeningEngine(
	sources: ReadonlyArray<StreamingListSource>,
	embedder: Embedder,
	thresholds: ListThresholds,
): MultiListScreeningEngine {
	return new MultiListScreeningEngine(
		sources.map((source) => ({
			listId: source.listId,
			version: source.version,
			source,
		})),
		embedder,
		thresholds,
	);
}
