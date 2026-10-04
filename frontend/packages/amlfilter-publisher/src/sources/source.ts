// The WatchlistSource adapter contract + the shared SourceLine shape.
//
// One adapter per upstream sanctions list (OFAC SDN, EU consolidated, UN
// consolidated, UK Sanctions List — asset-freeze only; id kept as UK_OFSI). Each adapter:
//   - fetchRaw(): pulls the raw list bytes off the network (real URLs), returning
//     a map of logical-name -> text (a list may publish more than one file, and
//     the file a list is READ from is not always published by the body that
//     DESIGNATES it — see csl.ts for why OFAC SDN arrives via Commerce's CSL).
//   - parse(raw, listVersion): maps those raw bytes into the publisher's neutral
//     SourceLine[] shape — fully deterministic, no network — and is the part the
//     fixture tests exercise.
//
// FOUNDATIONAL CROSS-LIST DECISION: every adapter stamps a NAMESPACED entity_id
// of the form `<source_list>:<rawId>` (e.g. "OFAC_SDN:12345",
// "EU_CONSOLIDATED:EU.1234.56"). The raw upstream ids are only unique within a
// single list; prefixing the source_list makes ids globally unique once multiple
// lists are merged into one engine. Use `namespacedId(listId, rawId)` so every
// adapter applies the same rule.

/** The raw bytes a source publishes, keyed by a logical file name.
 * (One list may publish several files, e.g. the UN/EU consolidated XML pair.) */
export type RawListBytes = Record<string, string>;

/** Immutable HTTP provenance captured with a source's canonical bytes. */
interface SourceTransportMetadata {
	readonly finalUrl: string;
	readonly etag: string | null;
	readonly lastModified: string | null;
}

/** One source fetch suitable for a hermetic downstream build. */
export interface SourceSnapshot {
	readonly raw: RawListBytes;
	readonly transport: SourceTransportMetadata;
	readonly sourceUpdatedAt: string;
}

/** Validate and normalize an upstream freshness instant for signed provenance. */
export function canonicalSourceTimestamp(
	sourceId: string,
	value: string,
): string {
	const calendar = /^(\d{4})-(\d{2})-(\d{2})(?=T|$)/.exec(value);
	if (calendar !== null && !isRealCalendarDate(calendar)) {
		throw new Error(`${sourceId}: freshness timestamp is invalid`);
	}
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) {
		throw new Error(`${sourceId}: freshness timestamp is invalid`);
	}
	return new Date(parsed).toISOString();
}

function isRealCalendarDate(parts: RegExpExecArray): boolean {
	const year = Number(parts[1]);
	const month = Number(parts[2]);
	const day = Number(parts[3]);
	const date = new Date(Date.UTC(year, month - 1, day));
	return (
		date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === day
	);
}

/** Build transport provenance from the exact response that supplied `raw`. */
export function sourceSnapshot(
	raw: RawListBytes,
	response: Response,
	requestedUrl: string,
	sourceUpdatedAt: string,
): SourceSnapshot {
	return {
		raw,
		transport: {
			finalUrl: response.url || requestedUrl,
			etag: response.headers.get("etag"),
			lastModified: response.headers.get("last-modified"),
		},
		sourceUpdatedAt,
	};
}

/** The neutral source record every adapter emits and the publisher consumes.
 * Identical field shape across all lists (this is the OFAC `SourceLine` promoted
 * to the shared contract). */
export interface SourceLine {
	/** Globally unique, namespaced id: `<source_list>:<rawId>`. */
	readonly entity_id: string;
	readonly primary_name: string;
	readonly entity_type: "PERSON" | "ORGANIZATION";
	readonly aliases: readonly { readonly name: string }[];
	readonly dob: readonly string[];
	readonly countries: readonly string[];
	readonly risk_category: string;
	readonly source_list: string;
	readonly list_version: string;
}

/** A publish-time adapter for one upstream sanctions list. */
export interface WatchlistSource {
	/** The list id, also the entity_id namespace (e.g. "OFAC_SDN"). */
	readonly id: string;
	/** Human-readable title for the catalog (e.g. "OFAC SDN"). */
	readonly title: string;
	/** Fetch the raw list bytes off the network (real URLs). */
	fetchRaw(): Promise<RawListBytes>;
	/** Fetch canonical bytes and the exact transport/source provenance together. */
	fetchSnapshot?(): Promise<SourceSnapshot>;
	/** Extract the upstream list's publication/update instant from its payload or
	 * transport metadata. Production publication rejects unprovably stale data. */
	sourceUpdatedAt?(raw: RawListBytes): string | undefined;
	/** Map raw bytes to neutral source lines — deterministic, no network. */
	parse(raw: RawListBytes, listVersion: string): SourceLine[];
}

/** Reserved raw-map entry for a transport-provided upstream update instant. */
export const SOURCE_UPDATED_AT_KEY = "__amlfilter_source_updated_at";

/** Build the namespaced entity_id every adapter must stamp. */
export function namespacedId(listId: string, rawId: string): string {
	return `${listId}:${rawId}`;
}

/** Canonical list ids (also the entity_id namespaces). */
export const OFAC_LIST_ID = "OFAC_SDN";
export const EU_LIST_ID = "EU_CONSOLIDATED";
export const UN_LIST_ID = "UN_CONSOLIDATED";
export const UK_LIST_ID = "UK_OFSI";
