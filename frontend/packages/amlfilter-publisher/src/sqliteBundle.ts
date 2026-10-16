// Build and decode canonical 4 KiB page-aligned `<slug>/watchlist.sqlite`
// files so `edgeproc publish` can emit 4 KiB page-level delta chunks for
// watchlist bundles.

import type { SqlRow, SqlStatement } from "@gainratio/browser/sql";
import { openNodeSqlDatabase } from "@gainratio/browser/sql/node";
import type { ListFreshness, StagedList } from "./stageBundle.ts";
import type { WatchlistEntity } from "./types.ts";

export const WATCHLIST_SQLITE_NAME = "watchlist.sqlite";
export const WATCHLIST_SQLITE_APP_ID = 0x414d4c46; // "AMLF"
export const WATCHLIST_SQLITE_USER_VERSION = 1;
const FLOAT32_BYTES = 4;

export interface WatchlistSqliteMeta extends ListFreshness {
	readonly listId: string;
	readonly version: string;
	readonly generatedAt: string;
	readonly model: string;
	readonly dim: number;
	readonly entitiesCount: number;
}

export interface DecodedWatchlistSqlite {
	readonly meta: WatchlistSqliteMeta;
	readonly entities: readonly WatchlistEntity[];
	readonly vectors: Float32Array;
}

const SCHEMA_STATEMENTS: readonly SqlStatement[] = [
	{ sql: "PRAGMA page_size = 4096" },
	{ sql: "PRAGMA journal_mode = DELETE" },
	{ sql: `PRAGMA application_id = ${WATCHLIST_SQLITE_APP_ID}` },
	{ sql: `PRAGMA user_version = ${WATCHLIST_SQLITE_USER_VERSION}` },
	{
		sql: `CREATE TABLE watchlist_meta (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			list_id TEXT NOT NULL,
			version TEXT NOT NULL,
			generated_at TEXT NOT NULL,
			model TEXT NOT NULL,
			dim INTEGER NOT NULL CHECK (dim > 0),
			entities_count INTEGER NOT NULL CHECK (entities_count >= 0),
			fetched_at TEXT NOT NULL,
			source_updated_at TEXT,
			stale INTEGER NOT NULL CHECK (stale IN (0, 1)),
			stale_reason TEXT
		)`,
	},
	{
		sql: `CREATE TABLE watchlist_entities (
			row_index INTEGER PRIMARY KEY,
			entity_id TEXT NOT NULL UNIQUE,
			name_canonical TEXT NOT NULL,
			aliases_json TEXT NOT NULL,
			dob TEXT,
			countries_json TEXT NOT NULL,
			risk_category TEXT NOT NULL,
			source_list TEXT NOT NULL,
			list_version TEXT NOT NULL,
			embedding BLOB NOT NULL
		)`,
	},
];

function rowEmbeddingBytes(
	vectors: Float32Array,
	rowIndex: number,
	dim: number,
): Uint8Array {
	const slice = vectors.subarray(rowIndex * dim, (rowIndex + 1) * dim);
	const out = new Uint8Array(dim * FLOAT32_BYTES);
	const view = new DataView(out.buffer);
	for (let i = 0; i < dim; i += 1) {
		view.setFloat32(i * FLOAT32_BYTES, slice[i] ?? 0, true);
	}
	return out;
}

/**
 * Build a deterministic, canonical 4 KiB page-aligned SQLite file containing
 * one list's metadata, entities, and packed Float32 embeddings.
 */
export async function buildWatchlistSqlite(
	list: StagedList,
	generatedAt: string,
): Promise<Uint8Array> {
	const expected = list.entities.length * list.dim;
	if (list.vectors.length !== expected) {
		throw new Error(
			`list ${list.listId}: vectors length ${list.vectors.length} != entities*dim (${expected})`,
		);
	}
	const db = await openNodeSqlDatabase({
		name: `watchlist-stage-${list.slug}`,
		memoryProfile: "full",
	});
	try {
		for (const stmt of SCHEMA_STATEMENTS) {
			await db.exec(stmt.sql);
		}
		const statements: SqlStatement[] = [
			{
				sql: `INSERT INTO watchlist_meta (
					id, list_id, version, generated_at, model, dim, entities_count,
					fetched_at, source_updated_at, stale, stale_reason
				) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				bind: [
					list.listId,
					list.version,
					generatedAt,
					list.model,
					list.dim,
					list.entities.length,
					list.freshness.fetchedAt,
					list.freshness.sourceUpdatedAt,
					list.freshness.stale ? 1 : 0,
					list.freshness.staleReason,
				],
			},
		];
		for (let i = 0; i < list.entities.length; i += 1) {
			const e = list.entities[i] as WatchlistEntity;
			statements.push({
				sql: `INSERT INTO watchlist_entities (
					row_index, entity_id, name_canonical, aliases_json, dob,
					countries_json, risk_category, source_list, list_version, embedding
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				bind: [
					i,
					e.entity_id,
					e.name_canonical,
					JSON.stringify(e.aliases),
					e.dob,
					JSON.stringify(e.countries),
					e.risk_category,
					e.source_list,
					e.list_version,
					rowEmbeddingBytes(list.vectors, i, list.dim),
				],
			});
		}
		await db.transaction(statements);
		await db.exec("VACUUM");
		return await db.exportDatabase();
	} finally {
		await db.close();
	}
}

interface RawMetaRow {
	readonly list_id: string;
	readonly version: string;
	readonly generated_at: string;
	readonly model: string;
	readonly dim: number;
	readonly entities_count: number;
	readonly fetched_at: string;
	readonly source_updated_at: string | null;
	readonly stale: number;
	readonly stale_reason: string | null;
}

interface RawEntityRow {
	readonly row_index: number;
	readonly entity_id: string;
	readonly name_canonical: string;
	readonly aliases_json: string;
	readonly dob: string | null;
	readonly countries_json: string;
	readonly risk_category: string;
	readonly source_list: string;
	readonly list_version: string;
	readonly embedding: Uint8Array;
}

/**
 * Validate and decode a canonical `watchlist.sqlite` file back into metadata,
 * `WatchlistEntity[]`, and a packed `Float32Array` matrix.
 */
export async function readWatchlistSqlite(
	bytes: Uint8Array,
): Promise<DecodedWatchlistSqlite> {
	const db = await openNodeSqlDatabase({
		name: "watchlist-decode",
		memoryProfile: "full",
	});
	try {
		await db.importDatabase(bytes, {
			expectedSchema: {
				applicationId: WATCHLIST_SQLITE_APP_ID,
				userVersion: WATCHLIST_SQLITE_USER_VERSION,
			},
		});
		const metaRows = await db.query<RawMetaRow & SqlRow>(
			`SELECT list_id, version, generated_at, model, dim, entities_count,
				fetched_at, source_updated_at, stale, stale_reason
			 FROM watchlist_meta WHERE id = 1`,
		);
		const metaRow = metaRows[0];
		if (metaRow === undefined) {
			throw new Error("watchlist.sqlite is missing watchlist_meta row");
		}
		const meta: WatchlistSqliteMeta = {
			listId: metaRow.list_id,
			version: metaRow.version,
			generatedAt: metaRow.generated_at,
			model: metaRow.model,
			dim: metaRow.dim,
			entitiesCount: metaRow.entities_count,
			fetchedAt: metaRow.fetched_at,
			sourceUpdatedAt: metaRow.source_updated_at,
			stale: metaRow.stale === 1,
			staleReason: metaRow.stale_reason,
		};
		const rows = await db.query<RawEntityRow & SqlRow>(
			`SELECT row_index, entity_id, name_canonical, aliases_json, dob,
				countries_json, risk_category, source_list, list_version, embedding
			 FROM watchlist_entities ORDER BY row_index ASC`,
		);
		if (rows.length !== meta.entitiesCount) {
			throw new Error(
				`watchlist.sqlite row count ${rows.length} != meta.entitiesCount ${meta.entitiesCount}`,
			);
		}
		const entities: WatchlistEntity[] = [];
		const vectors = new Float32Array(rows.length * meta.dim);
		const expectedBytes = meta.dim * FLOAT32_BYTES;
		for (let i = 0; i < rows.length; i += 1) {
			const row = rows[i] as RawEntityRow;
			if (row.embedding.byteLength !== expectedBytes) {
				throw new Error(
					`watchlist.sqlite row ${i} embedding is ${row.embedding.byteLength} bytes; expected ${expectedBytes}`,
				);
			}
			const view = new DataView(
				row.embedding.buffer,
				row.embedding.byteOffset,
				row.embedding.byteLength,
			);
			for (let d = 0; d < meta.dim; d += 1) {
				vectors[i * meta.dim + d] = view.getFloat32(d * FLOAT32_BYTES, true);
			}
			entities.push({
				entity_id: row.entity_id,
				name_canonical: row.name_canonical,
				aliases: JSON.parse(row.aliases_json) as string[],
				dob: row.dob,
				countries: JSON.parse(row.countries_json) as string[],
				risk_category: row.risk_category,
				source_list: row.source_list,
				list_version: row.list_version,
			});
		}
		return { meta, entities, vectors };
	} finally {
		await db.close();
	}
}
