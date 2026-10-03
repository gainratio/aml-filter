// TS mirror of the aml-filter backend domain contract — the SAME shapes the
// native (Python) screening path produces, so the in-browser screen returns a
// structurally identical SearchResponse. Single source of truth for the browser tier.
//
// Backend originals:
//   - Entity / Alias       -> aml_filter/domain/entity.py
//   - SearchQuery          -> aml_filter/domain/search.py
//   - Match / MatchReason  -> aml_filter/domain/search.py
//   - SearchResponse       -> aml_filter/domain/search.py
//   - OfacBundleMeta       -> aml_filter/bundle/meta.py

import type { ScoreResult as AssayScoreResult } from "@gainratio/assay";
import type { SignedReceipt } from "@gainratio/avow";
import type { MatchScoreSubject } from "./scoreReceipt";

/** PERSON or ORGANIZATION — the only entity types OFAC screening recognizes. */
export type EntityType = "PERSON" | "ORGANIZATION";

/** The risk bucket a matched entity falls in. */
export type RiskCategory = "SANCTION" | "PEP" | "CUSTOM" | "WHITELIST";

/** One known alias for an entity (mirrors backend Alias). */
export interface Alias {
	readonly name: string;
	readonly name_canonical: string;
	readonly source: string;
}

/** Government / financial identifiers for an entity (mirrors backend identifiers). */
export interface Identifiers {
	readonly passport: ReadonlyArray<string>;
	readonly national_id: ReadonlyArray<string>;
	/** Other id kinds keyed by label, e.g. {"swift": ["FAKEXXXX"]}. */
	readonly other: Readonly<Record<string, ReadonlyArray<string>>>;
}

/** Empty identifiers — the normalized default when a bundle line omits them. */
export const EMPTY_IDENTIFIERS: Identifiers = {
	passport: [],
	national_id: [],
	other: {},
};

/**
 * One screened entity, exactly as one line of `entities.jsonl`. The
 * dossier fields (nationalities/addresses/identifiers) are optional because
 * older or minimal bundles may omit them; the screen normalizes them onto the
 * Match. Unknown extras (raw_source, etc.) are tolerated by structural typing.
 */
export interface Entity {
	readonly entity_id: string;
	readonly entity_type: EntityType;
	readonly primary_name: string;
	readonly name_canonical: string;
	readonly aliases: ReadonlyArray<Alias>;
	/** ISO date strings (YYYY-MM-DD), matching Pydantic's JSON date encoding. */
	readonly dob: ReadonlyArray<string>;
	/** ISO 3166-1 alpha-2 country codes. */
	readonly countries: ReadonlyArray<string>;
	/** ISO 3166-1 alpha-2 nationality codes. */
	readonly nationalities?: ReadonlyArray<string>;
	readonly addresses?: ReadonlyArray<string>;
	readonly identifiers?: Identifiers;
	readonly risk_category: RiskCategory;
	readonly source_list: string;
	readonly list_version: string;
}

/** Typed metadata for one published OFAC bundle (`ofac_meta.json`). */
export interface OfacBundleMeta {
	readonly list_id: string;
	readonly version: string;
	readonly entity_count: number;
	readonly embedding_model: string;
	readonly embedding_dim: number;
}

/** A screening query — the browser-tier mirror of the backend SearchQuery. */
export interface ScreenQuery {
	readonly name: string;
	/** ISO date string (YYYY-MM-DD), or null when not supplied. */
	readonly dob?: string | null;
	/** ISO 3166-1 alpha-2, or null. */
	readonly country?: string | null;
	readonly entityType?: EntityType | null;
	/** Score floor a match must clear (defaults to the preset threshold). */
	readonly threshold?: number;
	/** Max matches to return. */
	readonly k?: number;
}

/** One explanation reason for a match (mirrors backend MatchReason). */
export interface MatchReason {
	readonly signal: string;
	readonly value: number | string;
	readonly weight: number | null;
	readonly contribution: number | null;
	readonly description: string | null;
}

/**
 * A retrieval channel that brought an entity into the candidate set:
 * `vector` — the embedding (meaning) top-k; `token` — an exact shared name
 * token; `phonetic` — a shared Double-Metaphone (sound-alike) key.
 */
export type RetrievalChannel = "vector" | "token" | "phonetic";

/**
 * A matched entity with score and explanation (mirrors backend Match), widened
 * with the dossier fields the in-browser search surfaces. Dossier fields are
 * always present (normalized to empty when the source entity omits them).
 */
export interface Match {
	readonly entity_id: string;
	readonly score: number;
	readonly entity_type: EntityType;
	readonly risk_category: RiskCategory;
	readonly source_list: string;
	readonly list_version: string;
	readonly primary_name: string;
	readonly aliases: ReadonlyArray<string>;
	readonly countries: ReadonlyArray<string>;
	readonly nationalities: ReadonlyArray<string>;
	readonly dob: ReadonlyArray<string>;
	readonly addresses: ReadonlyArray<string>;
	readonly identifiers: Identifiers;
	readonly reasons: ReadonlyArray<MatchReason>;
	readonly explanation: string;
	/** Exact Assay additive result from which `score` and reasons were derived. */
	readonly score_evidence?: AssayScoreResult;
	/**
	 * Browser-tier ONLY: every retrieval channel that reached this entity, in
	 * the fixed order vector, token, phonetic. Provenance for the reviewer —
	 * NEVER an input to the score, reasons, explanation, evidence, the signed
	 * receipt, or the workstation's material fingerprint. Optional because a
	 * stored or pre-provenance match does not carry it.
	 */
	readonly retrieved_via?: ReadonlyArray<RetrievalChannel>;
	/**
	 * Browser-tier ONLY (no backend twin): the signed Avow receipt sealing this
	 * match's score, tier, and screening context. Optional because it depends on
	 * a usable install key — see matchReceipts.ts. Never an input to scoring.
	 */
	readonly score_receipt?: SignedReceipt<MatchScoreSubject>;
}

/** Response from in-browser screening (mirrors backend SearchResponse). */
export interface ScreenResponse {
	readonly request_id: string;
	readonly matches: ReadonlyArray<Match>;
	readonly list_versions_used: Readonly<Record<string, string>>;
	readonly execution_time_ms: number;
}
