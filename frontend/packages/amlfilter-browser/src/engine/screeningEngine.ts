// The in-browser OFAC screen — a faithful port of the backend's no-Postgres
// screening path (aml_filter.bundle.screening.BundleScreeningSource.screen):
//
//   1. embed the query name with transformers.js MiniLM (same model as the
//      publisher), giving the `name_vector` signal via cosine over the
//      watchlist's stored, L2-normalized embeddings;
//   2. build the candidate set as a UNION — the vector index's top k*2, plus
//      every entity the lexical/phonetic index reaches (see below);
//   3. for each candidate, derive the lexical signal from a SequenceMatcher
//      ratio over canonical names, then run the ported scoring policy
//      (alias/dob/country signals + preset weights);
//   4. keep candidates at or above the threshold, sort by score, take top-k;
//   5. project to the backend's Match / SearchResponse shape.
//
// WHY THE UNION. Step 2 used to be vector top-k ONLY, with no similarity floor.
// Every scoring signal therefore only ever saw ~40 of 19,181 entities, and the
// vectors are built from primary names alone — so an entity reachable only
// through a published alias could not be retrieved at all, whatever it would
// have scored. Measured against the frozen OFAC SDN corpus, 39% of alias
// queries returned the right entity NOWHERE. See ./lexicalIndex for the two
// bounds that keep the union small.
//
// No FastAPI on this path — everything runs in the tab over the signed,
// verified watchlist (see ./watchlist).

import {
	EMPTY_IDENTIFIERS,
	type Entity,
	type Match,
	type OfacBundleMeta,
	type RetrievalChannel,
	type ScreenQuery,
	type ScreenResponse,
} from "./domain";
import type { Embedder } from "./embedder";
import { EMBEDDING_MODEL } from "./embedder";
import { LexicalIndex } from "./lexicalIndex";
import { canonicalize, normalizeDob } from "./normalize";
import {
	computeScore,
	PRESETS,
	type Preset,
	type ScoringWeights,
} from "./scoring";
import { sequenceRatio } from "./sequenceMatcher";
import type { VectorIndex } from "./vectorIndex";
import type { LoadedWatchlist } from "./watchlist";

/** Options for one screen call (defaults mirror the backend SearchQuery). */
export interface ScreenOptions {
	/** Preset whose weights/threshold to score with (default "balanced"). */
	readonly preset?: Preset;
}

/**
 * The lexical similarity signal: how close the query is to the CLOSEST name this
 * entity is published under, primary or alias.
 *
 * It used to compare against `name_canonical` alone. That made the signal blind
 * to exactly the thing the product promises: OFAC publishes "SALIM, Ahmad Fuad"
 * for Ayman al-Zawahiri, so a user typing that name was scored against
 * "al zawahiri ayman" — a string they did not type and would not recognise — and
 * came out under the floor. Taking the best over every published name only ever
 * RAISES the signal, so no (entity, query) pair scores lower than it did.
 *
 * The comparison itself is unchanged (see ./sequenceMatcher).
 */
function bestNameSimilarity(queryCanonical: string, entity: Entity): number {
	let best = sequenceRatio(queryCanonical, entity.name_canonical);
	for (const alias of entity.aliases) {
		if (best >= 1) {
			return best;
		}
		best = Math.max(best, sequenceRatio(queryCanonical, alias.name_canonical));
	}
	return best;
}

/** Synthesize the engine's OfacBundleMeta from a loaded watchlist. */
function metaOf(loaded: LoadedWatchlist): OfacBundleMeta {
	return {
		list_id: loaded.listId,
		version: loaded.version,
		entity_count: loaded.entities.size,
		embedding_model: EMBEDDING_MODEL,
		embedding_dim: loaded.index.dim,
	};
}

interface Scored {
	readonly score: number;
	readonly entity: Entity;
	readonly match: Match;
}

/**
 * One retrieval candidate: an entity id, its honest cosine to the query, and
 * every channel that reached it (provenance only — never scored).
 */
interface Candidate {
	readonly id: string;
	readonly score: number;
	readonly retrievedVia: ReadonlyArray<RetrievalChannel>;
}

/**
 * How many vector hits to over-fetch per requested result. Unchanged from the
 * vector-only engine — the union adds reach, it does not narrow this.
 */
const VECTOR_OVERFETCH = 2;

/** A loaded, query-ready OFAC screen over one synced bundle. */
export class ScreeningEngine {
	readonly #index: VectorIndex;
	readonly #entities: ReadonlyMap<string, Entity>;
	readonly #meta: OfacBundleMeta;
	readonly #embedder: Embedder;
	readonly #lexical: LexicalIndex;

	public constructor(
		index: VectorIndex,
		entities: ReadonlyMap<string, Entity>,
		meta: OfacBundleMeta,
		embedder: Embedder,
	) {
		this.#index = index;
		this.#entities = entities;
		this.#meta = meta;
		this.#embedder = embedder;
		this.#lexical = LexicalIndex.build(index, entities);
	}

	public get meta(): OfacBundleMeta {
		return this.#meta;
	}

	/** Every entity in the synced bundle — backs the search UI's browse/empty state. */
	public allEntities(): ReadonlyArray<Entity> {
		return [...this.#entities.values()];
	}

	/** Release the vector matrix when this engine was created for one streamed list. */
	public dispose(): void {
		this.#index.dispose();
	}

	/** Screen a query name against the synced bundle, in-tab (no backend). */
	public async screen(
		query: ScreenQuery,
		options: ScreenOptions = {},
	): Promise<ScreenResponse> {
		const queryVec = await this.#embedder.embed(query.name);
		return this.screenWithVector(query, queryVec, options);
	}

	/**
	 * Screen with an ALREADY-embedded query vector. This is the
	 * post-embed half of {@link screen}; the multi-list engine embeds the query
	 * ONCE and screens N lists by calling this per list with the shared vector.
	 */
	public async screenWithVector(
		query: ScreenQuery,
		queryVec: Float32Array,
		options: ScreenOptions = {},
	): Promise<ScreenResponse> {
		const start = Date.now();
		const preset = PRESETS[options.preset ?? "balanced"];
		const threshold = query.threshold ?? preset.threshold;
		const k = query.k ?? 20;
		const queryCanonical = canonicalize(query.name);

		const candidates = await this.#retrieve(queryVec, queryCanonical, k);
		const scored = this.#scoreCandidates(
			candidates,
			query,
			queryCanonical,
			preset.weights,
			threshold,
		);
		scored.sort((a, b) => b.score - a.score);
		const top = scored.slice(0, k);

		return {
			request_id: crypto.randomUUID(),
			matches: top.map((s) => s.match),
			list_versions_used: this.#versionsOf(top),
			execution_time_ms: Date.now() - start,
		};
	}

	/**
	 * The candidate union: vector top-k first (they already carry their cosine),
	 * then every lexical/phonetic candidate the vector scan did not reach. Their
	 * REAL cosines are resolved together in one named-row sqlite-vector scan;
	 * nothing is invented and the number of scans does not grow with candidate
	 * count. Nothing that reached the old engine is dropped — this only ever adds.
	 *
	 * Provenance rides alongside without touching that set or its order: an id
	 * is labelled `token`/`phonetic` only when it is in the (possibly capped)
	 * lexical candidate list AND the per-namespace lookup reached it, so a label
	 * never claims a channel that did not actually deliver the candidate.
	 */
	async #retrieve(
		queryVec: Float32Array,
		queryCanonical: string,
		k: number,
	): Promise<readonly Candidate[]> {
		const [vectorHits, lexicalAll] = await Promise.all([
			this.#index.search(queryVec, k * VECTOR_OVERFETCH),
			this.#lexical.candidates(queryCanonical),
		]);
		const vectorIds = new Set(vectorHits.map((hit) => hit.id));
		const lexicalIds = lexicalAll.filter((id) => !vectorIds.has(id));
		const [lexicalHits, channelsOf] = await Promise.all([
			lexicalIds.length === 0
				? Promise.resolve<
						ReadonlyArray<{ readonly id: string; readonly score: number }>
					>([])
				: this.#index.searchByIds(queryVec, lexicalIds),
			this.#provenance(queryCanonical, vectorIds, lexicalAll),
		]);
		return [...vectorHits, ...lexicalHits].map((hit) => ({
			id: hit.id,
			score: hit.score,
			retrievedVia: channelsOf(hit.id),
		}));
	}

	/** Channel labels per candidate id, in the fixed order vector, token, phonetic. */
	async #provenance(
		queryCanonical: string,
		vectorIds: ReadonlySet<string>,
		lexicalIds: readonly string[],
	): Promise<(id: string) => ReadonlyArray<RetrievalChannel>> {
		const lexical = new Set(lexicalIds);
		const reach =
			lexical.size === 0
				? null
				: await this.#lexical.provenance(queryCanonical);
		return (id) => {
			const channels: RetrievalChannel[] = [];
			if (vectorIds.has(id)) channels.push("vector");
			if (reach !== null && lexical.has(id)) {
				if (reach.token.has(id)) channels.push("token");
				if (reach.phonetic.has(id)) channels.push("phonetic");
			}
			return channels;
		};
	}

	#scoreCandidates(
		candidates: readonly Candidate[],
		query: ScreenQuery,
		queryCanonical: string,
		weights: ScoringWeights,
		threshold: number,
	): Scored[] {
		const out: Scored[] = [];
		for (const candidate of candidates) {
			const entity = this.#entities.get(candidate.id);
			if (entity === undefined) {
				continue;
			}
			const scored = this.#scoreOne(
				entity,
				candidate,
				query,
				queryCanonical,
				weights,
			);
			if (scored.score >= threshold) {
				out.push(scored);
			}
		}
		return out;
	}

	#scoreOne(
		entity: Entity,
		candidate: Candidate,
		query: ScreenQuery,
		queryCanonical: string,
		weights: ScoringWeights,
	): Scored {
		const result = computeScore(
			entity,
			{
				nameCanonical: queryCanonical,
				// The scorer's dob_match assumes ISO (it slices [0,4] for the year), so
				// canonicalize a human-typed query DOB ("12/04/1980", "10 Dec 1948") to
				// its ISO prefix here; null/empty/unparseable stays null. Idempotent on
				// already-ISO input, so the scoring golden is unaffected.
				dob:
					query.dob !== undefined && query.dob !== null
						? normalizeDob(query.dob)
						: null,
				country: query.country ?? null,
				entityType: query.entityType ?? null,
				vectorSimilarity: candidate.score,
				lexicalSimilarity: bestNameSimilarity(queryCanonical, entity),
			},
			weights,
		);
		const match: Match = {
			entity_id: entity.entity_id,
			score: result.score,
			entity_type: entity.entity_type,
			risk_category: entity.risk_category,
			source_list: entity.source_list,
			list_version: entity.list_version,
			primary_name: entity.primary_name,
			aliases: entity.aliases.map((a) => a.name),
			countries: entity.countries,
			nationalities: entity.nationalities ?? [],
			dob: entity.dob,
			addresses: entity.addresses ?? [],
			identifiers: entity.identifiers ?? EMPTY_IDENTIFIERS,
			reasons: result.reasons,
			explanation: result.summary,
			score_evidence: result.assay,
			// Provenance only: attached AFTER computeScore, which never sees it.
			retrieved_via: candidate.retrievedVia,
		};
		return { score: result.score, entity, match };
	}

	#versionsOf(scored: ReadonlyArray<Scored>): Readonly<Record<string, string>> {
		const versions: Record<string, string> = {};
		for (const { entity } of scored) {
			versions[entity.source_list] = entity.list_version;
		}
		return versions;
	}
}

/** Build a query-ready ScreeningEngine from a loaded, verified watchlist. */
export function createScreeningEngine(
	loaded: LoadedWatchlist,
	embedder: Embedder,
): ScreeningEngine {
	return new ScreeningEngine(
		loaded.index,
		loaded.entities,
		metaOf(loaded),
		embedder,
	);
}
