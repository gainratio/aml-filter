// Non-Latin alias enrichment for the OFAC SDN list.
//
// THE GAP THIS CLOSES. Records come from Commerce's Consolidated Screening List
// (see csl.ts) because Treasury's own export is behind a bot-challenge WAF. CSL
// is complete on records — 19,181, cross-validated entity-for-entity — but it
// publishes names in Latin script only. Treasury's SDN_ADVANCED.XML additionally
// carries each designation's name in its ORIGINAL script, and the engine's
// canonicalize() preserves those scripts (it lowercases and folds diacritics, it
// does not transliterate). So without this module a Cyrillic, Arabic or CJK
// query can never match, no matter how exactly it is spelled.
//
// WHAT IT IS AND IS NOT. This is an ENRICHMENT, not a second record source. CSL
// remains the sole authority on WHICH entities are designated and on every
// field. This module contributes exactly one thing: additional alias STRINGS,
// attached to records that already exist, joined on the entity id that already
// cross-validates 19,181/19,181. It can never add, remove or alter a record.
//
// PROVENANCE. The bytes are Treasury's own published SDN_ADVANCED.XML. They are
// fetched through the OpenSanctions mirror because the origin is WAF-blocked —
// the mirror is TRANSPORT, not the author. That is still a weaker chain than the
// government-published CSL, which is exactly why it is confined to aliases and
// why the two sources are named separately everywhere the data is described.
//
// SCRIPT DETECTION. Every <NamePartValue> carries a ScriptID, and the file ships
// its own <ScriptValues> reference set mapping those ids to names. We read that
// set rather than hardcoding an id or guessing from codepoints, so a new script
// is classified correctly the day OFAC starts using it.
//
// FAIL SOFT, NEVER SILENT. A mirror outage yields an EMPTY enrichment, the
// bundle publishes CSL-only, and the caller reports which mode produced it.

import { fetchWithTimeout, streamResponseBody } from "./fetchWithTimeout.ts";
import type { SourceLine } from "./source.ts";

/** The script name this enrichment deliberately skips (CSL already has it). */
export const LATIN_SCRIPT = "Latin";

/** Treasury's SDN_ADVANCED.XML, mirrored. Overridable (no host lock-in). */
export const SDN_ALIAS_MIRROR_URL =
	process.env.SDN_ALIAS_MIRROR_URL ??
	"https://data.opensanctions.org/datasets/latest/us_ofac_sdn/source.xml";

/** ~125 MB, so it gets a longer deadline than the record feed. */
const MIRROR_TIMEOUT_MS = 240_000;
export const ALIAS_BODY_LIMITS = {
	maxBytes: 512 * 1024 * 1024,
	elapsedMs: MIRROR_TIMEOUT_MS,
	idleMs: 30_000,
} as const;

/** Non-Latin alias names, keyed by OFAC entity number (the XML's FixedRef). */
export interface AliasEnrichment {
	readonly byEntityNumber: ReadonlyMap<string, readonly string[]>;
	readonly aliasesFound: number;
	readonly byScript: ReadonlyMap<string, number>;
	/** High-water mark of the streaming window, for memory observability. */
	readonly peakBufferChars?: number;
}

/** The feed exceeded a size bound, so it was refused rather than consumed.
 *
 * This is a THROWN error precisely so the caller's fail-soft path can catch it.
 * A heap OOM cannot be caught — that is the entire reason these bounds exist. */
export class AliasFeedTooLargeError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "AliasFeedTooLargeError";
	}
}

/** Bounds that keep memory flat no matter what the far end sends. */
export interface StreamLimits {
	/** Hard ceiling on bytes read from the network. */
	readonly maxBytes: number;
	/** Hard ceiling on the rolling window (one record plus slack). */
	readonly maxWindowChars: number;
}

/** ~4x the July 2026 feed (125.7 MB): a runaway guard, not a tight fit. */
const MAX_ALIAS_FEED_BYTES = 512 * 1024 * 1024;
/** The largest real <DistinctParty> measured is 69 KB; 8 MB is ~120x slack. */
const MAX_WINDOW_CHARS = 8 * 1024 * 1024;

const PARTY_OPEN = "<DistinctParty ";
const PARTY_CLOSE = "</DistinctParty>";
const SCRIPTS_CLOSE = "</ScriptValues>";

/** An enrichment that contributes nothing — the fail-soft value. */
export const NO_ENRICHMENT: AliasEnrichment = {
	byEntityNumber: new Map(),
	aliasesFound: 0,
	byScript: new Map(),
};

const SCRIPT_RE = /<Script\b[^>]*\bID="(\d+)"[^>]*>([^<]*)<\/Script>/g;
const PARTY_RE = /<DistinctParty FixedRef="(\d+)">([\s\S]*?)<\/DistinctParty>/g;
const DOC_NAME_RE = /<DocumentedName\b[^>]*>([\s\S]*?)<\/DocumentedName>/g;
const NAME_PART_RE = /<NamePartValue\b([^>]*)>([^<]*)<\/NamePartValue>/g;
const SCRIPT_ID_RE = /ScriptID="(\d+)"/;

/** XML entity references that appear in OFAC name values. */
function decodeXml(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
		.replace(/&amp;/g, "&");
}

/** ScriptID -> script name, read from the file's own reference set. */
function scriptNames(xml: string): ReadonlyMap<string, string> {
	const names = new Map<string, string>();
	SCRIPT_RE.lastIndex = 0;
	let match = SCRIPT_RE.exec(xml);
	while (match !== null) {
		if (match[1] !== undefined && match[2] !== undefined) {
			names.set(match[1], match[2].trim());
		}
		match = SCRIPT_RE.exec(xml);
	}
	return names;
}

/** One rendered name: its parts joined in document order, plus its script. */
interface RenderedName {
	readonly text: string;
	readonly script: string;
}

/** Every <DocumentedName> inside one party, as rendered text + script. */
function renderedNames(
	body: string,
	scripts: ReadonlyMap<string, string>,
): readonly RenderedName[] {
	const out: RenderedName[] = [];
	DOC_NAME_RE.lastIndex = 0;
	let doc = DOC_NAME_RE.exec(body);
	while (doc !== null) {
		const parts: string[] = [];
		let scriptId: string | undefined;
		NAME_PART_RE.lastIndex = 0;
		let part = NAME_PART_RE.exec(doc[1] ?? "");
		while (part !== null) {
			const id = SCRIPT_ID_RE.exec(part[1] ?? "");
			if (id?.[1] !== undefined) {
				scriptId = id[1];
			}
			const value = decodeXml(part[2] ?? "").trim();
			if (value !== "") {
				parts.push(value);
			}
			part = NAME_PART_RE.exec(doc[1] ?? "");
		}
		if (parts.length > 0) {
			out.push({
				text: parts.join(" "),
				script: (scriptId && scripts.get(scriptId)) || "Unknown",
			});
		}
		doc = DOC_NAME_RE.exec(body);
	}
	return out;
}

/** Mutable accumulator shared by the whole-string and streaming parsers, so
 * both produce byte-identical results from one implementation. */
interface Collector {
	readonly byEntityNumber: Map<string, string[]>;
	readonly byScript: Map<string, number>;
	aliasesFound: number;
	peakBufferChars: number;
}

function newCollector(): Collector {
	return {
		byEntityNumber: new Map(),
		byScript: new Map(),
		aliasesFound: 0,
		peakBufferChars: 0,
	};
}

/** Take every non-Latin name from ONE <DistinctParty> body. */
function collectParty(
	into: Collector,
	ref: string,
	body: string,
	scripts: ReadonlyMap<string, string>,
): void {
	const seen = new Set(into.byEntityNumber.get(ref) ?? []);
	for (const name of renderedNames(body, scripts)) {
		if (name.script === LATIN_SCRIPT || seen.has(name.text)) {
			continue;
		}
		seen.add(name.text);
		const list = into.byEntityNumber.get(ref) ?? [];
		list.push(name.text);
		into.byEntityNumber.set(ref, list);
		into.byScript.set(name.script, (into.byScript.get(name.script) ?? 0) + 1);
		into.aliasesFound += 1;
	}
}

function finish(collector: Collector): AliasEnrichment {
	return {
		byEntityNumber: collector.byEntityNumber,
		aliasesFound: collector.aliasesFound,
		byScript: collector.byScript,
		peakBufferChars: collector.peakBufferChars,
	};
}

/** Extract every non-Latin name OFAC publishes, keyed by entity number.
 * Whole-string form — for fixtures and tests. Production uses the streaming
 * form below, which never materializes the feed. */
export function parseNonLatinAliases(xml: string): AliasEnrichment {
	const scripts = scriptNames(xml);
	const collector = newCollector();
	PARTY_RE.lastIndex = 0;
	let party = PARTY_RE.exec(xml);
	while (party !== null) {
		collectParty(collector, party[1] ?? "", party[2] ?? "", scripts);
		party = PARTY_RE.exec(xml);
	}
	return finish(collector);
}

/** Consume complete <DistinctParty> blocks from `window`, returning the
 * unconsumed remainder. Regions that can no longer contain a record start are
 * dropped, so the window tracks ONE record rather than the whole feed — the
 * 26 MB of reference data before the first record and the 17 MB after the last
 * are discarded as they stream past. */
function drainParties(
	into: Collector,
	window: string,
	scripts: ReadonlyMap<string, string>,
): string {
	let cursor = 0;
	for (;;) {
		const start = window.indexOf(PARTY_OPEN, cursor);
		if (start === -1) {
			// No record start left: keep only enough tail to rejoin a split tag.
			const keepFrom = Math.max(cursor, window.length - PARTY_OPEN.length);
			return window.slice(keepFrom);
		}
		const end = window.indexOf(PARTY_CLOSE, start);
		if (end === -1) {
			return window.slice(start); // partial record — wait for more bytes
		}
		const block = window.slice(start, end);
		const ref = /^<DistinctParty FixedRef="(\d+)"/.exec(block);
		if (ref?.[1] !== undefined) {
			collectParty(into, ref[1], block, scripts);
		}
		cursor = end + PARTY_CLOSE.length;
	}
}

/** Stream the feed and extract aliases incrementally.
 *
 * Memory is bounded by the rolling window, not the payload: the feed may be any
 * size and the heap stays flat. A bound breach THROWS (catchable) instead of
 * letting the heap abort (not catchable). */
export async function parseNonLatinAliasesFromStream(
	chunks: AsyncIterable<Uint8Array>,
	limits: Partial<StreamLimits> = {},
): Promise<AliasEnrichment> {
	const maxBytes = limits.maxBytes ?? MAX_ALIAS_FEED_BYTES;
	const maxWindowChars = limits.maxWindowChars ?? MAX_WINDOW_CHARS;
	const collector = newCollector();
	// `stream: true` keeps multi-byte codepoints intact across chunk edges —
	// without it every Cyrillic/Arabic character split by a boundary is mangled.
	const decoder = new TextDecoder("utf-8");
	let scripts: ReadonlyMap<string, string> | null = null;
	let window = "";
	let bytes = 0;

	for await (const chunk of chunks) {
		bytes += chunk.byteLength;
		if (bytes > maxBytes) {
			throw new AliasFeedTooLargeError(
				`alias feed exceeded ${maxBytes} bytes — refusing to keep reading`,
			);
		}
		window += decoder.decode(chunk, { stream: true });
		if (scripts === null) {
			const end = window.indexOf(SCRIPTS_CLOSE);
			if (end !== -1) {
				scripts = scriptNames(window.slice(0, end));
			}
		}
		if (scripts !== null) {
			window = drainParties(collector, window, scripts);
		}
		collector.peakBufferChars = Math.max(
			collector.peakBufferChars,
			window.length,
		);
		if (window.length > maxWindowChars) {
			throw new AliasFeedTooLargeError(
				`alias feed window exceeded ${maxWindowChars} chars without a complete record — refusing to buffer further`,
			);
		}
	}
	window += decoder.decode();
	if (scripts !== null) {
		drainParties(collector, window, scripts);
	}
	return finish(collector);
}

/** What one enrichment pass contributed. */
export interface EnrichmentResult {
	readonly lines: readonly SourceLine[];
	readonly aliasesAdded: number;
	readonly entitiesEnriched: number;
}

/** The `OFAC_SDN:` prefix stripped back to the bare entity number. */
function entityNumber(entityId: string): string {
	const colon = entityId.indexOf(":");
	return colon === -1 ? entityId : entityId.slice(colon + 1);
}

/** Append non-Latin aliases to the records that already exist.
 *
 * Never adds, removes or reorders records, and never replaces an alias — a name
 * the record already carries (case-insensitively) is skipped, so re-running is
 * idempotent and a mirror hiccup can never inflate the list. */
export function applyAliasEnrichment(
	lines: readonly SourceLine[],
	enrichment: AliasEnrichment,
): EnrichmentResult {
	let aliasesAdded = 0;
	let entitiesEnriched = 0;
	const enriched = lines.map((line) => {
		const extra = enrichment.byEntityNumber.get(entityNumber(line.entity_id));
		if (extra === undefined || extra.length === 0) {
			return line;
		}
		const have = new Set(
			[line.primary_name, ...line.aliases.map((a) => a.name)].map((n) =>
				n.toLowerCase(),
			),
		);
		const fresh = extra.filter((name) => {
			const key = name.toLowerCase();
			if (have.has(key)) {
				return false;
			}
			have.add(key);
			return true;
		});
		if (fresh.length === 0) {
			return line;
		}
		aliasesAdded += fresh.length;
		entitiesEnriched += 1;
		return {
			...line,
			aliases: [...line.aliases, ...fresh.map((name) => ({ name }))],
		};
	});
	return { lines: enriched, aliasesAdded, entitiesEnriched };
}

/** Fetch Treasury's SDN_ADVANCED.XML through the mirror.
 *
 * Throws on any failure; the caller decides whether that degrades the bundle to
 * CSL-only or fails the build (the deploy degrades, the nightly fails). */
export async function fetchNonLatinAliases(
	limits: Partial<StreamLimits> = {},
): Promise<AliasEnrichment> {
	const response = await fetchAliasResponse();
	// STREAMED, never buffered: `response.text()` on this ~125 MB feed would
	// materialize it (and its UTF-16 expansion) on the heap. An OOM there is
	// fatal and uncatchable, so the fail-soft path would never run and the
	// deploy would die on an unrelated third party's payload growing.
	return parseNonLatinAliasesFromStream(
		streamResponseBody(
			response,
			"OFAC SDN aliases (Treasury SDN_ADVANCED.XML via mirror)",
			{
				...ALIAS_BODY_LIMITS,
				maxBytes: limits.maxBytes ?? MAX_ALIAS_FEED_BYTES,
				sizeError: (maxBytes: number) =>
					new AliasFeedTooLargeError(
						`alias feed exceeded ${maxBytes} bytes — refusing to keep reading`,
					),
			},
		),
		limits,
	);
}

/** Fetch the exact alias response so snapshotting and parsing share one seam. */
export function fetchAliasResponse(): Promise<Response> {
	return fetchWithTimeout(
		SDN_ALIAS_MIRROR_URL,
		"OFAC SDN aliases (Treasury SDN_ADVANCED.XML via mirror)",
		MIRROR_TIMEOUT_MS,
	);
}
