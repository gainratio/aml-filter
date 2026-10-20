// carryForwardList — re-serve ONE list from the already-published bundle when
// its upstream feed is unreachable.
//
// WHY. The four sanctions feeds used to be required together: a 500 from the EU
// webgate blocked the OFAC refresh too, and OFAC is the list every visitor
// screens against by default. A European outage aged the data for users who
// never enabled EU. Requiring all four is the right instinct — a screening tool
// that silently ships a partial watchlist is worse than one that ships nothing —
// but the coupling was wrong. Each list can be refreshed, and therefore failed,
// on its own.
//
// WHAT THIS DOES. Fetch the currently-published origin, re-verify the WHOLE
// trust chain (signed /latest against the pinned key -> manifest content-address
// -> every chunk through the client's zstd-decompress -> sha256 rule -> each
// file against its file_sha256), and hand back one list's records and vectors.
//
// WHAT IT DELIBERATELY DOES NOT DO. It never relaxes a check, never returns a
// partial list, and above all never restamps the age. The carried list keeps its
// ORIGINAL `version` and its ORIGINAL fetch instant and is marked `stale` with
// the upstream failure attached, so the age a user sees is the age they have.
//
// FAIL-CLOSED. Anything that cannot be proven is refused, and the caller treats
// a refusal as "this list is unavailable" rather than "this list is fine":
//   - a pointer that does not verify
//   - a chunk or file that fails its content address
//   - a slug the published bundle does not contain
//   - a list whose age cannot be established or parsed  <- never assume "fresh"
//   - a record count or vector width that disagrees with the published meta
//   - a list carried for longer than `maxCarriedAgeDays`  <- see CEILING below
//
// CEILING. Re-serving the last good copy is right for a bad afternoon and wrong
// forever. Without a cap, a frozen upstream is carried every day while the
// publish pipeline stays green — which is exactly what happened to UK_OFSI from
// 2026-09-01, the feed having stopped updating on 2026-06-03. `maxCarriedAgeDays`
// is the per-list twin of `mirrorPublishedOrigin`'s `maxServedAgeDays`: past it
// the carry REFUSES and the publish goes red, because a silently ancient
// sanctions list is worse than a loud failure. Unset means no ceiling, so a
// caller that has not chosen one keeps the old fail-soft behaviour.
//
// The trust chain is unchanged by this module: nothing is re-signed, nothing is
// added to /latest, and the monotonic anti-rollback `sequence` is untouched.

import { decompressAndVerify } from "@amlfilter/browser/engine";
import { resolveListAge } from "@amlfilter/browser/watchlist";
import type { ListFreshness } from "./stageBundle.ts";
import type { WatchlistEntity } from "./types.ts";
import { bytesToVectors } from "./vectors.ts";
import {
	fetchAndVerifyManifest,
	fetchAndVerifyPointer,
	type OriginFetch,
} from "./verifyPublishedOrigin.ts";

/** A list could not be carried forward from the published bundle. */
export class CarryForwardError extends Error {
	public constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "CarryForwardError";
	}
}

/** One list re-served from the published bundle, with its real age. */
export interface CarriedList {
	readonly listId: string;
	readonly slug: string;
	readonly title: string;
	readonly version: string;
	readonly model: string;
	readonly dim: number;
	readonly entities: readonly WatchlistEntity[];
	readonly vectors: Float32Array;
	readonly freshness: ListFreshness;
}

export interface CarryForwardInput {
	readonly baseUrl: string;
	readonly fetchBytes: OriginFetch;
	readonly pubkey: Uint8Array;
	/** The published list directory to re-serve (e.g. "eu"). */
	readonly slug: string;
	/** The upstream failure that forced the carry-forward, recorded verbatim. */
	readonly reason: string;
	readonly now?: () => Date;
	/** Days a list may be re-served before the carry is refused. Unset = no cap. */
	readonly maxCarriedAgeDays?: number;
}

/** The published `<slug>/meta.json` fields this module relies on. */
interface PublishedMeta {
	readonly listId: string;
	readonly version: string;
	readonly model: string;
	readonly dim: number;
	readonly entitiesCount: number;
	/** Absent on every bundle published before per-list freshness existed. */
	readonly fetchedAt?: string;
	readonly sourceUpdatedAt?: string | null;
	/** When the BUNDLE was assembled — the migration fallback for `fetchedAt`. */
	readonly generatedAt?: string;
}

const DECODER = new TextDecoder();

/** Re-serve one list from the live published bundle, verified and marked stale. */
export async function carryForwardList(
	input: CarryForwardInput,
): Promise<CarriedList> {
	const { baseUrl, fetchBytes, pubkey, slug } = input;
	const pointer = await fetchAndVerifyPointer(baseUrl, fetchBytes, pubkey);
	const { manifest } = await fetchAndVerifyManifest(
		baseUrl,
		fetchBytes,
		pointer,
	);
	const files = await materializeListFiles(baseUrl, fetchBytes, manifest, slug);
	const meta = parseMeta(slug, files);
	const entities = parsePublishedEntities(
		slug,
		DECODER.decode(requireFile(slug, files, "entities.jsonl")),
		meta.version,
	);
	const vectors = bytesToVectors(requireFile(slug, files, "vectors.f32"));
	assertPopulation(slug, meta, entities.length, vectors.length);

	const fetchedAt = publishedFetchedAt(slug, meta);
	assertWithinCarryCeiling(slug, fetchedAt, input);

	return {
		listId: meta.listId,
		slug,
		title: titleFor(meta.listId, files, slug),
		version: meta.version,
		model: meta.model,
		dim: meta.dim,
		entities,
		vectors,
		freshness: {
			fetchedAt,
			sourceUpdatedAt: meta.sourceUpdatedAt ?? null,
			stale: true,
			staleReason: input.reason,
		},
	};
}

/** Refuse a list that has been re-served for longer than the caller allows. */
function assertWithinCarryCeiling(
	slug: string,
	fetchedAt: string,
	input: CarryForwardInput,
): void {
	const { maxCarriedAgeDays } = input;
	if (maxCarriedAgeDays === undefined) {
		return;
	}
	const now = (input.now ?? (() => new Date()))();
	const ageDays = Math.floor(
		(now.getTime() - Date.parse(fetchedAt)) / 86_400_000,
	);
	if (ageDays > maxCarriedAgeDays) {
		throw new CarryForwardError(
			`${slug} was last refreshed ${ageDays} days ago (${fetchedAt}), past the ${maxCarriedAgeDays}-day ceiling for re-serving an unrefreshed sanctions list`,
		);
	}
}

/** Fetch, decode-verify and reassemble every published file under `<slug>/`,
 * plus the catalog (which carries the list's display title). */
async function materializeListFiles(
	baseUrl: string,
	fetchBytes: OriginFetch,
	manifest: { readonly files: ReadonlyArray<unknown> },
	slug: string,
): Promise<ReadonlyMap<string, Uint8Array>> {
	const prefix = `${slug}/`;
	const wanted = manifest.files
		.map(asManifestFile)
		.filter((f) => f.path.startsWith(prefix) || f.path === "catalog.json");
	if (!wanted.some((f) => f.path.startsWith(prefix))) {
		throw new CarryForwardError(
			`published bundle has no "${slug}/" list to carry forward`,
		);
	}
	const out = new Map<string, Uint8Array>();
	for (const file of wanted) {
		out.set(file.path, await materializeOne(baseUrl, fetchBytes, file));
	}
	return out;
}

/** One published file: every chunk decode-verified, then the whole file
 * re-checked against its own content address. */
async function materializeOne(
	baseUrl: string,
	fetchBytes: OriginFetch,
	file: ManifestFile,
): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	for (const chunk of file.chunks) {
		const compressed = await fetchBytes(`${baseUrl}/chunk/${chunk.hash}`);
		// THE client rule: zstd-decompress, then sha256(plaintext) == its name.
		parts.push(await decompressAndVerify(chunk.hash, compressed));
	}
	const bytes = concat(parts);
	if ((await sha256Hex(bytes)) !== file.file_sha256) {
		throw new CarryForwardError(
			`published file ${file.path} failed its content-address check`,
		);
	}
	return bytes;
}

interface ManifestFile {
	readonly path: string;
	readonly file_sha256: string;
	readonly chunks: ReadonlyArray<{ readonly hash: string }>;
}

/** Narrow one manifest entry, requiring the fields the carry-forward trusts.
 * `file_sha256` is required here even though the shared manifest narrow does
 * not demand it: without it a reassembled file has no whole-file address. */
function asManifestFile(value: unknown): ManifestFile {
	const file = value as Partial<ManifestFile>;
	if (
		typeof file?.path !== "string" ||
		typeof file.file_sha256 !== "string" ||
		!Array.isArray(file.chunks) ||
		!file.chunks.every(
			(c) => typeof (c as { hash?: unknown })?.hash === "string",
		)
	) {
		throw new CarryForwardError(
			`published manifest entry is malformed: ${JSON.stringify(value)}`,
		);
	}
	return file as ManifestFile;
}

function requireFile(
	slug: string,
	files: ReadonlyMap<string, Uint8Array>,
	name: string,
): Uint8Array {
	const bytes = files.get(`${slug}/${name}`);
	if (bytes === undefined) {
		throw new CarryForwardError(
			`published bundle is missing ${slug}/${name}; refusing to carry a partial list`,
		);
	}
	return bytes;
}

/**
 * The exact inverse of stageBundle's `entityLine`: read back the published
 * `entities.jsonl` as WatchlistEntity records.
 *
 * Strict on purpose. These records go straight back into a signed sanctions
 * bundle, so a line that is not a well-formed entity must abort the carry —
 * never be skipped, which would silently shrink the list.
 */
function parsePublishedEntities(
	slug: string,
	jsonl: string,
	listVersion: string,
): readonly WatchlistEntity[] {
	return jsonl
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line, index) =>
			asPublishedEntity(slug, line, index + 1, listVersion),
		);
}

function asPublishedEntity(
	slug: string,
	line: string,
	lineNo: number,
	listVersion: string,
): WatchlistEntity {
	let parsed: Partial<WatchlistEntity>;
	try {
		parsed = JSON.parse(line);
	} catch (cause) {
		throw new CarryForwardError(
			`published ${slug}/entities.jsonl line ${lineNo} is not JSON`,
			{ cause },
		);
	}
	const strings = [
		"entity_id",
		"name_canonical",
		"risk_category",
		"source_list",
		"list_version",
	] as const;
	const wellFormed =
		strings.every((key) => typeof parsed[key] === "string") &&
		Array.isArray(parsed.aliases) &&
		Array.isArray(parsed.countries) &&
		(parsed.dob === null || typeof parsed.dob === "string");
	if (!wellFormed) {
		throw new CarryForwardError(
			`published ${slug}/entities.jsonl line ${lineNo} is not a well-formed entity`,
		);
	}
	return {
		...(parsed as WatchlistEntity),
		list_version: parsed.list_version || listVersion,
	};
}

function parseMeta(
	slug: string,
	files: ReadonlyMap<string, Uint8Array>,
): PublishedMeta {
	const meta = JSON.parse(
		DECODER.decode(requireFile(slug, files, "meta.json")),
	) as Partial<PublishedMeta>;
	if (
		typeof meta?.listId !== "string" ||
		typeof meta.version !== "string" ||
		typeof meta.model !== "string" ||
		!Number.isFinite(meta.dim) ||
		!Number.isFinite(meta.entitiesCount)
	) {
		throw new CarryForwardError(`published ${slug}/meta.json is malformed`);
	}
	return meta as PublishedMeta;
}

/**
 * The instant this data was last actually obtained.
 *
 * The rule itself is NOT here — it is `resolveListAge` in
 * `@amlfilter/browser/watchlist`, the one predicate the browser's bundle-open
 * path reads too. This used to be a second copy of it, and the two copies
 * disagreed on the live bundle: the publisher aged a pre-freshness list from
 * `generatedAt` and re-served it while the browser rejected the same bytes.
 *
 * MIGRATION: bundles published before per-list freshness carry no `fetchedAt`,
 * so `generatedAt` — when that bundle was assembled — is the fallback (see
 * `resolveListAge` for why that is truthful, and for its removal condition). A
 * list we cannot age is refused outright: defaulting to "now" would relabel
 * three-day-old sanctions data as current, which is the exact failure this
 * whole change exists to prevent.
 */
export function publishedFetchedAt(
	slug: string,
	meta: {
		readonly fetchedAt?: string;
		readonly generatedAt?: string;
	},
): string {
	const age = resolveListAge(meta, meta.generatedAt);
	if (age === null) {
		throw new CarryForwardError(
			`published ${slug}/meta.json has no parseable age (fetchedAt/generatedAt); refusing to re-serve a list whose staleness cannot be stated`,
		);
	}
	return age.at;
}

/** A carried list must match the population its published meta declares —
 * a truncated re-serve is a silently smaller sanctions list. */
export function assertPopulation(
	slug: string,
	meta: { readonly entitiesCount: number; readonly dim: number },
	entities: number,
	vectorValues: number,
): void {
	if (entities !== meta.entitiesCount) {
		throw new CarryForwardError(
			`published ${slug} has ${entities} entities but its meta declares ${meta.entitiesCount}`,
		);
	}
	if (vectorValues !== entities * meta.dim) {
		throw new CarryForwardError(
			`published ${slug} vectors hold ${vectorValues} values but ${entities} entities * dim ${meta.dim} = ${entities * meta.dim}`,
		);
	}
}

/** The display title from the published catalog, falling back to the list id. */
function titleFor(
	listId: string,
	files: ReadonlyMap<string, Uint8Array>,
	slug: string,
): string {
	const raw = files.get("catalog.json");
	if (raw === undefined) {
		return listId;
	}
	const catalog = JSON.parse(DECODER.decode(raw)) as {
		readonly lists?: ReadonlyArray<{ slug?: string; title?: string }>;
	};
	const entry = catalog.lists?.find((l) => l.slug === slug);
	return typeof entry?.title === "string" ? entry.title : listId;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.byteLength, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.byteLength;
	}
	return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
