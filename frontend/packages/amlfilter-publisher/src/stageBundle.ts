// Stage a deterministic bundle tree for `edgeproc publish` to chunk + sign.
//
// `edgeproc publish` content-addresses every file under a --src dir: the chunk
// and manifest hashes are a PURE FUNCTION of these bytes, so this staging must
// be byte-stable. We therefore serialize with fixed key order (the WatchlistEntity
// schema order; sorted catalog/meta keys) and a caller-supplied `generatedAt`.
//
// Layout written under `outDir` (mirrored, after publish, into the bundle the
// in-tab sync tier materializes):
//   catalog.json                 { schemaVersion, generatedAt, lists:[{id,title,slug,version,entitiesCount,...freshness}] }
//   <slug>/entities.jsonl        one WatchlistEntity JSON per line (stable key order)
//   <slug>/vectors.f32           raw LE Float32, row-major (entities*dim)
//   <slug>/meta.json             { listId, version, generatedAt, model, dim, entitiesCount, ...freshness }
//
// PER-LIST FRESHNESS. `generatedAt` says when the BUNDLE was assembled, which is
// not the same as when each list was last refreshed from its upstream. When one
// feed is down the publisher re-serves that list's last good data (see
// buildRealBundle) — so every list carries its OWN `fetchedAt`/`stale` pair and
// keeps its OWN `version`. A screening tool that showed a three-day-old EU list
// under today's build date would be claiming coverage it does not have.
//
// These fields ride INSIDE the staged tree, so they inherit the existing trust
// chain for free: chunk hash -> file_sha256 -> manifest hash -> signed pointer.
// Nothing is added to /latest, so the pointer's canonical signing preimage, its
// signature and its monotonic anti-rollback `sequence` are untouched.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WatchlistEntity } from "./types.ts";
import { vectorsToBytes } from "./vectors.ts";

/** How fresh one list's data actually is, independent of the bundle build.
 *
 * Every staged list must carry this: a list published without a provable age is
 * a coverage claim nothing backs. */
export interface ListFreshness {
	/** When THIS copy of the list was fetched from upstream (ISO-8601 UTC). A
	 * carried-forward list keeps the instant it was ORIGINALLY fetched, so its
	 * age is its real age. */
	readonly fetchedAt: string;
	/** The upstream's own stated publication instant, when it publishes one. */
	readonly sourceUpdatedAt: string | null;
	/** True when this run could not refresh the list and re-served the last good
	 * copy. Never true for data fetched by this run. */
	readonly stale: boolean;
	/** The upstream failure that made it stale, verbatim. null when fresh. */
	readonly staleReason: string | null;
}

/** One list to stage: its catalog identity, entities, and packed name vectors. */
export interface StagedList {
	readonly listId: string;
	readonly slug: string;
	readonly title: string;
	readonly version: string;
	readonly model: string;
	readonly dim: number;
	readonly entities: readonly WatchlistEntity[];
	/** Row-major packed name vectors; length MUST equal entities.length * dim. */
	readonly vectors: Float32Array;
	/** Required: the age this list is actually being published with. */
	readonly freshness: ListFreshness;
}

/** Top-level catalog registry entry for a staged list. */
interface BundleCatalogList extends ListFreshness {
	readonly id: string;
	readonly title: string;
	readonly slug: string;
	readonly version: string;
	readonly entitiesCount: number;
}

/** The staged top-level `catalog.json`. */
interface BundleCatalog {
	readonly schemaVersion: 1;
	readonly generatedAt: string;
	readonly lists: readonly BundleCatalogList[];
}

/** The staged per-list `meta.json`. */
interface BundleListMeta extends ListFreshness {
	readonly listId: string;
	readonly version: string;
	readonly generatedAt: string;
	readonly model: string;
	readonly dim: number;
	readonly entitiesCount: number;
}

const ENCODER = new TextEncoder();

/** Pretty-JSON + trailing newline, fixed key order (matches publisher.toBytes). */
function jsonBytes(value: unknown): Uint8Array {
	return ENCODER.encode(`${JSON.stringify(value, null, 2)}\n`);
}

/** Serialize one entity with the fixed WatchlistEntity schema key order. */
function entityLine(e: WatchlistEntity): string {
	const ordered: WatchlistEntity = {
		entity_id: e.entity_id,
		name_canonical: e.name_canonical,
		aliases: e.aliases,
		dob: e.dob,
		countries: e.countries,
		risk_category: e.risk_category,
		source_list: e.source_list,
		list_version: e.list_version,
	};
	return JSON.stringify(ordered);
}

/** All entities as newline-delimited JSON (one per line, trailing newline). */
function entitiesJsonl(entities: readonly WatchlistEntity[]): Uint8Array {
	return ENCODER.encode(`${entities.map(entityLine).join("\n")}\n`);
}

function listMeta(list: StagedList, generatedAt: string): BundleListMeta {
	return {
		listId: list.listId,
		version: list.version,
		generatedAt,
		model: list.model,
		dim: list.dim,
		entitiesCount: list.entities.length,
		...list.freshness,
	};
}

function catalogEntry(list: StagedList): BundleCatalogList {
	return {
		id: list.listId,
		title: list.title,
		slug: list.slug,
		version: list.version,
		entitiesCount: list.entities.length,
		...list.freshness,
	};
}

async function stageOne(
	outDir: string,
	list: StagedList,
	generatedAt: string,
	includeSqlite: boolean,
): Promise<void> {
	const expected = list.entities.length * list.dim;
	if (list.vectors.length !== expected) {
		throw new Error(
			`list ${list.listId}: vectors length ${list.vectors.length} != entities*dim (${expected})`,
		);
	}
	const listDir = join(outDir, list.slug);
	await mkdir(listDir, { recursive: true });
	await writeFile(
		join(listDir, "entities.jsonl"),
		entitiesJsonl(list.entities),
	);
	await writeFile(join(listDir, "vectors.f32"), vectorsToBytes(list.vectors));
	await writeFile(
		join(listDir, "meta.json"),
		jsonBytes(listMeta(list, generatedAt)),
	);
	if (includeSqlite) {
		const { buildWatchlistSqlite, WATCHLIST_SQLITE_NAME } = await import(
			"./sqliteBundle.ts"
		);
		const sqliteBytes = await buildWatchlistSqlite(list, generatedAt);
		await writeFile(join(listDir, WATCHLIST_SQLITE_NAME), sqliteBytes);
	}
}

export interface StageBundleOptions {
	/** When true, also emit a canonical 4 KiB page-aligned `<slug>/watchlist.sqlite`. */
	readonly includeSqlite?: boolean;
}

/**
 * Write the deterministic staging tree for `lists` into `outDir`. `generatedAt`
 * is injected (ISO-8601 UTC) so identical (lists, generatedAt) ⇒ identical bytes.
 */
export async function stageBundle(
	outDir: string,
	lists: readonly StagedList[],
	generatedAt: string,
	options: StageBundleOptions = {},
): Promise<void> {
	await mkdir(outDir, { recursive: true });
	const includeSqlite = options.includeSqlite ?? true;
	for (const list of lists) {
		await stageOne(outDir, list, generatedAt, includeSqlite);
	}
	const catalog: BundleCatalog = {
		schemaVersion: 1,
		generatedAt,
		lists: lists.map(catalogEntry),
	};
	await writeFile(join(outDir, "catalog.json"), jsonBytes(catalog));
}
