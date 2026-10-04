// The watchlist domain shapes + the LoadedWatchlist builders shared across the
// engine. The ONLY load path is the signed, content-addressed BUNDLE (see
// bundleSource.ts): the delta-sync tier reassembles + content-hash-verifies each
// per-list file in the Worker, then hands the raw bytes to
// buildLoadedFromBundleFiles here, which parses the JSONL entities, wraps the
// binary `vectors.f32`, and projects the lean wire entities onto the domain
// Entity shape the scorer + UI consume.
//
// This module owns NO fetch + NO signature verification — trust lives in the
// sync tier (content-hash + the signed `/latest` pointer, fail-closed). What
// remains here is pure: the wire/domain types, the fail-closed shape narrows,
// and the build/project functions (binary bundle path + a base64-JSON test seam
// `buildLoadedWatchlist` the engine's unit tests drive over fixtures).
//
// Wire contract: docs/WATCHLIST_FORMAT.md.

import type { Alias, Entity, EntityType, RiskCategory } from "./domain";
import { lexicalKeysForEntity } from "./lexicalIndex";
import { canonicalize, normalizeDob } from "./normalize";
import { type AmlVectorIndexFactory, VectorIndex } from "./vectorIndex";

/** all-MiniLM-L6-v2 embedding dimension; the only dim the engine accepts. */
const EXPECTED_DIM = 384;
const FLOAT32_BYTES = 4;
/** Entity type assumed when the lean wire record omits it (scorer signal only). */
const DEFAULT_ENTITY_TYPE: EntityType = "PERSON";
/** The only risk buckets the engine accepts; any other value is rejected. */
const RISK_CATEGORIES: ReadonlySet<RiskCategory> = new Set([
	"SANCTION",
	"PEP",
	"CUSTOM",
	"WHITELIST",
]);

/** One screened entity exactly as it appears in `watchlist.json`. */
export interface WatchlistEntity {
	readonly entity_id: string;
	readonly name_canonical: string;
	readonly aliases: ReadonlyArray<string>;
	readonly dob: string | null;
	readonly countries: ReadonlyArray<string>;
	readonly risk_category: string;
	readonly source_list: string;
	readonly list_version: string;
}

/** The full `watchlist.json` document: entities + precomputed name vectors. */
export interface Watchlist {
	readonly listId: string;
	readonly version: string;
	readonly generatedAt: string;
	readonly model: string;
	readonly dim: number;
	readonly entities: ReadonlyArray<WatchlistEntity>;
	/** Base64 of a raw LE Float32 buffer, row-major, length entities.length*dim. */
	readonly vectors: string;
}

/** The tiny `watchlist.manifest.json` document, polled for version checks. */
export interface WatchlistManifest {
	readonly listId: string;
	readonly version: string;
	readonly generatedAt: string;
	readonly model: string;
	readonly dim: number;
	readonly entitiesCount: number;
}

/**
 * How fresh ONE list's data actually is, independent of when the bundle was
 * built. Mirrors the publisher's `ListFreshness` (amlfilter-publisher's
 * stageBundle.ts) — the wire contract both sides must agree on.
 *
 * WHY IT IS PER-LIST: one flaky upstream used to block every list from
 * refreshing. The publisher now refreshes each list independently and re-serves
 * the last good copy of any list it could not refresh, keeping that copy's
 * ORIGINAL `fetchedAt` and version. `catalog.generatedAt` therefore says nothing
 * about how old any individual list is, and a user screening against a
 * three-day-old EU list has to be able to see that.
 */
export interface ListFreshness {
	/** When THIS copy of the list was fetched from upstream (ISO-8601 UTC). */
	readonly fetchedAt: string;
	/** The upstream's own stated publication instant, when it publishes one. */
	readonly sourceUpdatedAt: string | null;
	/** True when the publish run could not refresh this list and re-served the
	 * last good copy. */
	readonly stale: boolean;
	/** The upstream failure that made it stale, verbatim. null when fresh. */
	readonly staleReason: string | null;
}

/** True when `value` is a string that parses as a real instant. Deliberately
 * lenient — it grades UPSTREAM-authored text (`sourceUpdatedAt`), whose format
 * is the feed's choice, not ours. Our OWN stamps go through
 * {@link isListInstant}, which is strict. */
function isInstantString(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** Exactly what `Date#toISOString()` emits, plus an explicit-offset variant.
 * Anything looser (a bare date, "3000", "last Tuesday") is refused rather than
 * guessed: `Date.parse("3000")` is the year 3000, and an age computed from that
 * reads as FRESH. */
const ISO_INSTANT =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** True when `value` is one of OUR stamps: a full ISO-8601 instant we wrote. */
function isListInstant(value: unknown): value is string {
	return (
		typeof value === "string" &&
		ISO_INSTANT.test(value) &&
		Number.isFinite(Date.parse(value))
	);
}

/** Which instant a list's age was measured from. `"generatedAt"` means the entry
 * predates per-list freshness and was aged from the bundle's own build stamp. */
export type ListAgeSource = "fetchedAt" | "generatedAt";

/** The instant one list is aged from, and where that instant came from. */
export interface ResolvedListAge {
	readonly at: string;
	readonly from: ListAgeSource;
}

/**
 * A list's freshness AS RESOLVED — the wire fields plus the anchor actually
 * used. Distinct from {@link ListFreshness}, which is the wire shape a
 * new-format bundle carries: a legacy entry has no wire freshness at all and
 * still resolves to a truthful age.
 */
export interface ResolvedListFreshness {
	/** The instant this list's data is aged from (see `agedFrom` for which). */
	readonly fetchedAt: string;
	readonly agedFrom: ListAgeSource;
	readonly sourceUpdatedAt: string | null;
	readonly stale: boolean;
	readonly staleReason: string | null;
}

/** True when the entry carries a per-list fetch instant AT ALL — the
 * new-format/legacy discriminator. An explicit `undefined` is ABSENT (the key
 * simply is not there in a pre-freshness bundle); a `null` or an empty string is
 * PRESENT and therefore corruption. */
export function hasFetchedAt(entry: unknown): boolean {
	return (
		typeof entry === "object" &&
		entry !== null &&
		(entry as Record<string, unknown>).fetchedAt !== undefined
	);
}

/**
 * THE canonical age rule. One function, consumed by every tier — the browser's
 * catalog + meta narrows, the publisher's carry-forward anchor, and the
 * publisher's published-freshness gate — so no copy of it can drift out of
 * agreement with another.
 *
 *   fetchedAt present + parseable -> aged from fetchedAt
 *   fetchedAt ABSENT              -> legacy bundle: aged from `catalogGeneratedAt`
 *   fetchedAt present + malformed -> null. Never laundered into the fallback.
 *   no usable anchor at all       -> null
 *
 * WHY THE LEGACY FALLBACK EXISTS. Every bundle published before per-list
 * freshness carries no `fetchedAt`, and in that model all lists were refreshed
 * together in one run — so the bundle's own `generatedAt` is a truthful age for
 * each of them. Without this, shipping the strict client against an
 * already-published bundle stops the deployed app loading its watchlist at all.
 *
 * REMOVAL CONDITION: once every published bundle carries per-list `fetchedAt`
 * (i.e. no origin the client may still be served can be pre-freshness), delete
 * the `generatedAt` fallback here — that removes it from all three call sites at
 * once, because they all read this one function.
 */
export function resolveListAge(
	entry: unknown,
	catalogGeneratedAt: unknown,
): ResolvedListAge | null {
	// A non-object is not a legacy entry, it is garbage — it gets no fallback.
	if (typeof entry !== "object" || entry === null) {
		return null;
	}
	if (hasFetchedAt(entry)) {
		const fetchedAt = (entry as Record<string, unknown>).fetchedAt;
		return isListInstant(fetchedAt)
			? { at: fetchedAt, from: "fetchedAt" }
			: null;
	}
	return isListInstant(catalogGeneratedAt)
		? { at: catalogGeneratedAt, from: "generatedAt" }
		: null;
}

/** `sourceUpdatedAt` narrowed: absent -> null, null -> null, a parseable string
 * -> itself. Anything else is corruption and fails the whole entry. */
function resolveSourceUpdatedAt(
	value: unknown,
): { readonly at: string | null } | null {
	if (value === undefined || value === null) {
		return { at: null };
	}
	return isInstantString(value) ? { at: value } : null;
}

/** The staleness pair narrowed. A NEW-format entry must carry both — reading a
 * dropped `stale` as "not stale" would let a corrupted field report the list
 * HEALTHY. A LEGACY entry predates the fields entirely, so absent means
 * not-stale; present-but-wrong is still corruption. */
function resolveStale(
	entry: Record<string, unknown>,
	required: boolean,
): { readonly stale: boolean; readonly staleReason: string | null } | null {
	const { stale, staleReason } = entry;
	if (stale === undefined ? required : typeof stale !== "boolean") {
		return null;
	}
	if (
		staleReason === undefined
			? required
			: !(staleReason === null || typeof staleReason === "string")
	) {
		return null;
	}
	return {
		stale: stale === true,
		staleReason: typeof staleReason === "string" ? staleReason : null,
	};
}

/**
 * THE canonical freshness rule: {@link resolveListAge} plus the companion shape
 * rule, in one place so the browser and the publisher cannot answer differently.
 *
 * Returns null — meaning REJECT — when the age cannot be resolved or the
 * staleness proof is malformed. A new-format entry must prove its staleness; a
 * legacy entry, which predates those fields, is read as not-stale.
 */
export function resolveListFreshness(
	entry: unknown,
	catalogGeneratedAt: unknown,
): ResolvedListFreshness | null {
	const age = resolveListAge(entry, catalogGeneratedAt);
	if (age === null) {
		return null;
	}
	const record = entry as Record<string, unknown>;
	// A new-format entry must SAY what upstream claimed, even if that is null.
	const isNewFormat = age.from === "fetchedAt";
	if (isNewFormat && record.sourceUpdatedAt === undefined) {
		return null;
	}
	const source = resolveSourceUpdatedAt(record.sourceUpdatedAt);
	const staleness = resolveStale(record, isNewFormat);
	if (source === null || staleness === null) {
		return null;
	}
	return {
		fetchedAt: age.at,
		agedFrom: age.from,
		sourceUpdatedAt: source.at,
		...staleness,
	};
}

/** One list entry in the signed catalog: id, title, version, count, dir path —
 * plus the RESOLVED per-list freshness the settings UI ages the list with. */
export interface WatchlistCatalogEntry extends ResolvedListFreshness {
	readonly id: string;
	readonly title: string;
	readonly version: string;
	readonly entitiesCount: number;
	/** Dir prefix under `watchlist/`, e.g. "ofac/" (trailing slash included). */
	readonly path: string;
}

/** The signed `catalog.json`: the manifest of every published list. */
export interface WatchlistCatalog {
	readonly schema: 1;
	readonly generatedAt: string;
	readonly lists: ReadonlyArray<WatchlistCatalogEntry>;
}

/** Raised when a watchlist document is structurally invalid (fail-closed). */
export class WatchlistFormatError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "WatchlistFormatError";
	}
}

/** A loaded watchlist: the cosine index, the id->Entity map, and the version. */
export interface LoadedWatchlist {
	readonly index: VectorIndex;
	readonly entities: ReadonlyMap<string, Entity>;
	readonly version: string;
	readonly listId: string;
}

/** Entity metadata retained by the bounded-residency streaming engine. */
export interface LoadedWatchlistMetadata {
	readonly entities: ReadonlyMap<string, Entity>;
	readonly version: string;
	readonly listId: string;
}

const DECODER = new TextDecoder();

/** Decode a base64 string into raw bytes (browser atob, no Buffer dependency). */
function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		out[i] = binary.charCodeAt(i);
	}
	return out;
}

/** Decode the base64 Float32 buffer, validating dim and the row count. */
function decodeVectors(
	base64: string,
	dim: number,
	entityCount: number,
): Float32Array {
	const bytes = base64ToBytes(base64);
	if (bytes.byteLength !== entityCount * dim * FLOAT32_BYTES) {
		throw new WatchlistFormatError(
			`vectors are ${bytes.byteLength} bytes; expected ${entityCount * dim * FLOAT32_BYTES} (${entityCount} entities * ${dim} dim * ${FLOAT32_BYTES})`,
		);
	}
	// Copy into a fresh, 4-byte-aligned buffer: atob output may not be aligned,
	// and Float32Array requires a 4-byte-aligned byteOffset.
	return new Float32Array(bytes.slice().buffer);
}

/** Title-case a canonical (lowercase) name for display, e.g. "ivan fakovich". */
function displayName(canonical: string): string {
	return canonical
		.split(" ")
		.filter((word) => word.length > 0)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

/** Project a lean wire alias name onto the domain Alias shape. */
function toAlias(name: string): Alias {
	return { name, name_canonical: canonicalize(name), source: "" };
}

/**
 * Lift a single wire dob string into the domain Entity's `dob: string[]`,
 * canonicalized to an ISO prefix. An absent or unparseable dob yields [] (no
 * DOB) so the scorer never sees a non-ISO string it would slice a junk year
 * from. Idempotent on already-ISO values.
 */
function normalizeEntityDob(dob: string | null): string[] {
	if (dob === null) {
		return [];
	}
	const iso = normalizeDob(dob);
	return iso !== null ? [iso] : [];
}

/** Narrow a wire risk_category to the domain union fail-closed, else throw. */
function assertRiskCategory(value: string, entityId: string): RiskCategory {
	if (RISK_CATEGORIES.has(value as RiskCategory)) {
		return value as RiskCategory;
	}
	throw new WatchlistFormatError(
		`entity ${entityId} has risk_category "${value}"; expected one of ${[...RISK_CATEGORIES].join(", ")}`,
	);
}

/**
 * Project a lean watchlist entity onto the domain Entity the scorer + UI use.
 * The wire shape omits entity_type and a display primary_name and carries a
 * single dob string; we default the type, title-case the canonical for display,
 * and lift the dob into the array shape the scorer's dob signal expects. The dob
 * is canonicalized to an ISO prefix via normalizeDob so even a cached/older
 * catalog whose value was not ISO at publish time still matches (the scorer's
 * dob_match assumes ISO + slices [0,4]); idempotent on already-ISO values, and
 * an unparseable value drops to no-DOB rather than reaching the scorer as junk.
 */
function toEntity(wire: WatchlistEntity): Entity {
	return {
		entity_id: wire.entity_id,
		entity_type: DEFAULT_ENTITY_TYPE,
		primary_name: displayName(wire.name_canonical),
		name_canonical: wire.name_canonical,
		aliases: wire.aliases.map(toAlias),
		dob: normalizeEntityDob(wire.dob),
		countries: wire.countries,
		nationalities: [],
		addresses: [],
		risk_category: assertRiskCategory(wire.risk_category, wire.entity_id),
		source_list: wire.source_list,
		list_version: wire.list_version,
	};
}

/** Validate the watchlist header fields fail-closed before building the index. */
function assertWatchlistShape(watchlist: Watchlist): void {
	if (watchlist.dim !== EXPECTED_DIM) {
		throw new WatchlistFormatError(
			`watchlist dim is ${watchlist.dim}; expected ${EXPECTED_DIM}`,
		);
	}
	if (
		!Array.isArray(watchlist.entities) ||
		typeof watchlist.vectors !== "string"
	) {
		throw new WatchlistFormatError(
			"watchlist is missing entities[] or vectors",
		);
	}
}

/**
 * The shared index + id->Entity build, given the wire entities and an
 * already-decoded Float32 matrix. Both the base64 JSON path ({@link buildLoaded})
 * and the binary bundle path ({@link buildLoadedFromBundleFiles}) funnel through
 * here so the projection — `toEntity`, the row↔id ordering, the VectorIndex
 * construction — is byte-identical, and scoring is therefore identical regardless
 * of how the bytes arrived. Row i of `matrix` is the embedding of
 * `wireEntities[i].name_canonical`; the VectorIndex ctor enforces the same
 * length invariant the byte-length checks already proved.
 */
function buildLoadedFromMatrix(
	wireEntities: ReadonlyArray<WatchlistEntity>,
	matrix: Float32Array,
	dim: number,
	version: string,
	listId: string,
	vectorIndexFactory?: AmlVectorIndexFactory,
): LoadedWatchlist {
	const ids = wireEntities.map((e) => e.entity_id);
	const entities = new Map<string, Entity>();
	for (const wire of wireEntities) {
		entities.set(wire.entity_id, toEntity(wire));
	}
	return {
		index: new VectorIndex(
			matrix,
			ids,
			dim,
			vectorIndexFactory,
			(id) => {
				const entity = entities.get(id);
				return entity === undefined ? [] : lexicalKeysForEntity(entity);
			},
			`aml-watchlist-${listId}`,
		),
		entities,
		version,
		listId,
	};
}

/** Build the cosine index + id->Entity map from a verified, parsed watchlist. */
function buildLoaded(watchlist: Watchlist): LoadedWatchlist {
	assertWatchlistShape(watchlist);
	const matrix = decodeVectors(
		watchlist.vectors,
		watchlist.dim,
		watchlist.entities.length,
	);
	return buildLoadedFromMatrix(
		watchlist.entities,
		matrix,
		watchlist.dim,
		watchlist.version,
		watchlist.listId,
	);
}

/** Build a LoadedWatchlist from already-verified, parsed JSON (test seam). */
export function buildLoadedWatchlist(watchlist: Watchlist): LoadedWatchlist {
	return buildLoaded(watchlist);
}

/** The per-list `meta.json` the content-addressed bundle stages (mirror of the
 * publisher's BundleListMeta). Carries the version + dim + count the bundle path
 * needs; the version becomes the LoadedWatchlist version (catalog cross-check
 * happens in the runtime, against the bundle catalog entry).
 *
 * The freshness block is OPTIONAL on the wire because every bundle published
 * before per-list freshness omits it — such a meta is aged from its own
 * `generatedAt` (see {@link resolveListAge}). It is validated here, but the
 * catalog is what the UI actually ages a list from. */
export interface BundleListMeta {
	readonly listId: string;
	readonly version: string;
	readonly generatedAt: string;
	readonly model: string;
	readonly dim: number;
	readonly entitiesCount: number;
	readonly fetchedAt?: string;
	readonly sourceUpdatedAt?: string | null;
	readonly stale?: boolean;
	readonly staleReason?: string | null;
}

/** The identity + geometry half of a bundle meta, narrowed.
 *
 * `generatedAt` and `model` were DECLARED on BundleListMeta but never narrowed —
 * a guard that typed two fields it never checked. Both are validated here. */
function hasBundleMetaShape(m: Record<string, unknown>): boolean {
	return (
		typeof m.listId === "string" &&
		typeof m.version === "string" &&
		isInstantString(m.generatedAt) &&
		typeof m.model === "string" &&
		m.model.length > 0 &&
		typeof m.dim === "number" &&
		Number.isFinite(m.dim) &&
		typeof m.entitiesCount === "number" &&
		Number.isFinite(m.entitiesCount)
	);
}

/** Narrow a materialized, JSON-parsed bundle meta fail-closed — including the
 * per-list freshness, which must RESOLVE (see {@link resolveListFreshness}). A
 * pre-freshness meta carries no `fetchedAt` and is aged from its own
 * `generatedAt`; a meta whose `fetchedAt` is present but malformed is rejected. */
function assertBundleListMeta(value: unknown): asserts value is BundleListMeta {
	if (typeof value !== "object" || value === null) {
		throw new WatchlistFormatError("bundle meta.json is not an object");
	}
	const m = value as Record<string, unknown>;
	if (!hasBundleMetaShape(m)) {
		throw new WatchlistFormatError(
			`bundle meta.json is malformed: ${JSON.stringify(value)}`,
		);
	}
	if (resolveListFreshness(m, m.generatedAt) === null) {
		throw new WatchlistFormatError(
			`bundle meta.json has no provable freshness (a fetchedAt that is present must parse, and must come with sourceUpdatedAt, stale and staleReason): ${JSON.stringify(value)}`,
		);
	}
}

/** Narrow a single JSON-parsed entities.jsonl line to a WatchlistEntity. */
function assertWatchlistEntity(
	value: unknown,
	line: number,
): asserts value is WatchlistEntity {
	if (typeof value !== "object" || value === null) {
		throw new WatchlistFormatError(
			`entities.jsonl line ${line} is not an object`,
		);
	}
	const e = value as Record<string, unknown>;
	if (
		typeof e.entity_id !== "string" ||
		typeof e.name_canonical !== "string" ||
		!Array.isArray(e.aliases) ||
		!Array.isArray(e.countries) ||
		typeof e.risk_category !== "string" ||
		typeof e.source_list !== "string" ||
		typeof e.list_version !== "string" ||
		(e.dob !== null && typeof e.dob !== "string")
	) {
		throw new WatchlistFormatError(
			`entities.jsonl line ${line} is a malformed entity`,
		);
	}
}

/** Parse newline-delimited entity JSON (one WatchlistEntity per line, fail-closed
 * on any malformed line). Blank lines (incl. the trailing newline) are skipped. */
function parseEntitiesJsonl(jsonl: string): WatchlistEntity[] {
	const entities: WatchlistEntity[] = [];
	const lines = jsonl.split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const text = lines[i]?.trim() ?? "";
		if (text.length === 0) {
			continue;
		}
		const parsed: unknown = JSON.parse(text);
		assertWatchlistEntity(parsed, i + 1);
		entities.push(parsed);
	}
	return entities;
}

/** Wrap the raw `vectors.f32` bytes as a Float32Array, validating dim + the row
 * count against the entity count (the binary mirror of decodeVectors' base64
 * check). Copies into a fresh 4-byte-aligned buffer (the materialized bytes may
 * sit at an unaligned byteOffset). */
export function decodeVectorBytes(
	bytes: Uint8Array,
	dim: number,
	entityCount: number,
): Float32Array {
	if (bytes.byteLength !== entityCount * dim * FLOAT32_BYTES) {
		throw new WatchlistFormatError(
			`vectors.f32 is ${bytes.byteLength} bytes; expected ${entityCount * dim * FLOAT32_BYTES} (${entityCount} entities * ${dim} dim * ${FLOAT32_BYTES})`,
		);
	}
	// Sync worker responses are transferred with ownership of their backing
	// buffer. Reuse that buffer whenever the view is aligned: copying a large
	// list here creates a second full matrix at the exact point where iOS Safari
	// is already close to its WebAssembly/tab memory ceiling. Materialized views
	// can still be unaligned in tests or alternate clients, so retain the safe
	// aligned-copy fallback for that case.
	if (bytes.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0) {
		return new Float32Array(
			bytes.buffer,
			bytes.byteOffset,
			bytes.byteLength / Float32Array.BYTES_PER_ELEMENT,
		);
	}
	return new Float32Array(bytes.slice().buffer);
}

/** The materialized per-list bundle files the bundle path feeds to the builder. */
export interface BundleListFiles {
	/** Raw bytes of `<slug>/entities.jsonl` (one WatchlistEntity JSON per line). */
	readonly entitiesJsonl: Uint8Array;
	/** Raw bytes of `<slug>/vectors.f32` (row-major LE Float32, entities*dim). */
	readonly vectorsF32: Uint8Array;
	/** Raw bytes of `<slug>/meta.json` (the per-list BundleListMeta). */
	readonly meta: Uint8Array;
}

/** Build browseable metadata without materializing the vector matrix. */
export function buildLoadedWatchlistMetadataFromBundleFiles(
	files: Pick<BundleListFiles, "entitiesJsonl" | "meta">,
): LoadedWatchlistMetadata {
	const meta: unknown = JSON.parse(DECODER.decode(files.meta));
	assertBundleListMeta(meta);
	if (meta.dim !== EXPECTED_DIM) {
		throw new WatchlistFormatError(
			`bundle list ${meta.listId} dim is ${meta.dim}; expected ${EXPECTED_DIM}`,
		);
	}
	const wireEntities = parseEntitiesJsonl(DECODER.decode(files.entitiesJsonl));
	if (wireEntities.length !== meta.entitiesCount) {
		throw new WatchlistFormatError(
			`bundle list ${meta.listId}: entities.jsonl has ${wireEntities.length} lines; meta.json says ${meta.entitiesCount}`,
		);
	}
	const entities = new Map<string, Entity>();
	for (const wire of wireEntities) {
		entities.set(wire.entity_id, toEntity(wire));
	}
	return { entities, listId: meta.listId, version: meta.version };
}

/**
 * Build a LoadedWatchlist from the MATERIALIZED, already-verified per-list bundle
 * files (the content-addressed sync tier reassembles + content-hash-verifies each
 * file before handing the bytes here). The JSONL entities are parsed to the same
 * WatchlistEntity[] the JSON path uses; the raw vectors.f32 bytes are wrapped as
 * a Float32Array with the SAME exact-length check; the SAME projection + index
 * builder runs — so scoring is byte-identical to a JSON-built list of the same
 * data. dim is read from meta.json and pinned to EXPECTED_DIM, fail-closed.
 */
export function buildLoadedFromBundleFiles(
	files: BundleListFiles,
	vectorIndexFactory?: AmlVectorIndexFactory,
): LoadedWatchlist {
	const meta: unknown = JSON.parse(DECODER.decode(files.meta));
	assertBundleListMeta(meta);
	if (meta.dim !== EXPECTED_DIM) {
		throw new WatchlistFormatError(
			`bundle list ${meta.listId} dim is ${meta.dim}; expected ${EXPECTED_DIM}`,
		);
	}
	const entities = parseEntitiesJsonl(DECODER.decode(files.entitiesJsonl));
	if (entities.length !== meta.entitiesCount) {
		throw new WatchlistFormatError(
			`bundle list ${meta.listId}: entities.jsonl has ${entities.length} lines; meta.json says ${meta.entitiesCount}`,
		);
	}
	const matrix = decodeVectorBytes(files.vectorsF32, meta.dim, entities.length);
	return buildLoadedFromMatrix(
		entities,
		matrix,
		meta.dim,
		meta.version,
		meta.listId,
		vectorIndexFactory,
	);
}
