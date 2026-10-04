// Lexical + phonetic candidate generation over the same SQLite database that
// stores the watchlist vectors. TypeScript creates exact token and
// Double-Metaphone keys; SQLite owns postings, document-frequency filtering,
// and deterministic id lookup. Final scoring remains unchanged.

import type { SqliteLookupKey } from "@gainratio/browser/vector/sqlite";
import type { Entity } from "./domain";
import { phoneticKeys, tokenSetSimilarity } from "./fuzzyText";
import type { VectorIndex } from "./vectorIndex";

export const MAX_DOCUMENT_FREQUENCY_RATIO = 0.01;
export const MAX_LEXICAL_CANDIDATES = 600;

const MAX_LOOKUP_QUERY_KEYS = 64;
const TOKEN_NAMESPACE = "token";
const PHONETIC_NAMESPACE = "phonetic";

function namesOf(entity: Entity): readonly string[] {
	const names = new Set<string>();
	if (entity.name_canonical.length > 0) names.add(entity.name_canonical);
	for (const alias of entity.aliases) {
		if (alias.name_canonical.length > 0) names.add(alias.name_canonical);
	}
	return [...names];
}

function appendNameKeys(
	name: string,
	keys: SqliteLookupKey[],
	seen: Set<string>,
): void {
	for (const token of name.split(" ")) {
		if (token.length === 0) continue;
		appendKey(TOKEN_NAMESPACE, token, keys, seen);
		for (const key of phoneticKeys(token)) {
			appendKey(PHONETIC_NAMESPACE, key, keys, seen);
		}
	}
}

function appendKey(
	namespace: string,
	value: string,
	keys: SqliteLookupKey[],
	seen: Set<string>,
): void {
	const identity = `${namespace}\u0000${value}`;
	if (seen.has(identity)) return;
	seen.add(identity);
	keys.push({ namespace, value });
}

/** Exact lookup keys persisted beside one entity's vector row. */
export function lexicalKeysForEntity(
	entity: Entity,
): ReadonlyArray<SqliteLookupKey> {
	const keys: SqliteLookupKey[] = [];
	const seen = new Set<string>();
	for (const name of namesOf(entity)) appendNameKeys(name, keys, seen);
	return keys;
}

function lexicalKeysForQuery(
	queryCanonical: string,
): readonly SqliteLookupKey[] {
	const keys: SqliteLookupKey[] = [];
	const seen = new Set<string>();
	appendNameKeys(queryCanonical, keys, seen);
	return keys.slice(0, MAX_LOOKUP_QUERY_KEYS);
}

/**
 * Which lexical channel(s) reached each entity for one query: the ids an exact
 * TOKEN key reached, and the ids a Double-Metaphone PHONETIC key reached. An id
 * reached by both appears in both sets.
 *
 * Truthful under SQLite's document-frequency semantic: `lookupIds` drops each
 * over-common key INDIVIDUALLY (`GROUP BY key HAVING COUNT(*) <= cap`), so a
 * key's eligibility does not depend on which other keys ride in the same
 * query. Splitting the query's keys by namespace therefore partitions exactly
 * the union `candidates` draws from — no id gains or loses a channel by the
 * split. Provenance is context for a reviewer; it never feeds a score.
 */
export interface LexicalProvenance {
	readonly token: ReadonlySet<string>;
	readonly phonetic: ReadonlySet<string>;
}

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

/** SQLite-backed lexical candidate view for one immutable watchlist. */
export class LexicalIndex {
	readonly #index: VectorIndex;
	readonly #entities: ReadonlyMap<string, Entity>;
	readonly #maxDocumentFrequency: number;

	private constructor(
		index: VectorIndex,
		entities: ReadonlyMap<string, Entity>,
	) {
		this.#index = index;
		this.#entities = entities;
		this.#maxDocumentFrequency = Math.max(
			1,
			Math.ceil(entities.size * MAX_DOCUMENT_FREQUENCY_RATIO),
		);
	}

	public static build(
		index: VectorIndex,
		entities: ReadonlyMap<string, Entity>,
	): LexicalIndex {
		return new LexicalIndex(index, entities);
	}

	public get maxDocumentFrequency(): number {
		return this.#maxDocumentFrequency;
	}

	public async candidates(queryCanonical: string): Promise<readonly string[]> {
		const hits = await this.#index.lookupIds(
			lexicalKeysForQuery(queryCanonical),
			this.#maxDocumentFrequency,
		);
		return hits.length <= MAX_LEXICAL_CANDIDATES
			? hits
			: this.#closest(queryCanonical, hits);
	}

	/**
	 * Per-channel reach for one query, from the SAME key list `candidates` uses
	 * (including its key-count slice) split by namespace, under the SAME
	 * document-frequency cap: at most two extra SQLite lookups per query, never
	 * one per candidate. Read-only beside `candidates` — it does not change
	 * which ids `candidates` returns, nor their order.
	 */
	public async provenance(queryCanonical: string): Promise<LexicalProvenance> {
		const keys = lexicalKeysForQuery(queryCanonical);
		const [token, phonetic] = await Promise.all([
			this.#reach(keys, TOKEN_NAMESPACE),
			this.#reach(keys, PHONETIC_NAMESPACE),
		]);
		return { token, phonetic };
	}

	async #reach(
		keys: readonly SqliteLookupKey[],
		namespace: string,
	): Promise<ReadonlySet<string>> {
		const scoped = keys.filter((key) => key.namespace === namespace);
		if (scoped.length === 0) return EMPTY_IDS;
		return new Set(
			await this.#index.lookupIds(scoped, this.#maxDocumentFrequency),
		);
	}

	#similarity(queryCanonical: string, id: string): number {
		let best = 0;
		const entity = this.#entities.get(id);
		if (entity === undefined) return best;
		for (const name of namesOf(entity)) {
			best = Math.max(best, tokenSetSimilarity(queryCanonical, name));
		}
		return best;
	}

	#closest(queryCanonical: string, hits: readonly string[]): readonly string[] {
		const scored = hits.map((id) => ({
			id,
			score: this.#similarity(queryCanonical, id),
		}));
		scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
		return scored.slice(0, MAX_LEXICAL_CANDIDATES).map((s) => s.id);
	}
}
