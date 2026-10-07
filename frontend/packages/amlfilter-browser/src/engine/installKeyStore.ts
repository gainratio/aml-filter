// Where the install signing seed lives: one `install_key` row in a small
// SQLite database on OPFS, opened through the @gainratio/browser SQL seam.
//
// This file is the ONLY place that names "@gainratio/browser/sql" for the key.
// SQLite is the system of record for app data — never IndexedDB or
// localStorage. When the browser refuses OPFS, the seam opens SQLite in
// memory and SAYS SO; this module keeps that one in-memory database for the
// life of the tab and reports `persistence.kind === "memory"`, so the UI can
// tell the user plainly that the key will not survive the tab.
//
// Sessions are short: each operation opens, works and closes, so a second tab
// is never locked out of the key for longer than one operation.

import {
	openSqlDatabase,
	type SqlBind,
	type SqlDatabase,
	type SqlDatabaseOptions,
	type SqlRow,
	type SqlStatement,
	type SqlStorage,
	type SqlTransactionResult,
} from "@gainratio/browser/sql";

export type { SqlBind, SqlRow, SqlStatement, SqlStorage };

/** Stable database name (the seam hashes it into the OPFS pool name). */
export const INSTALL_KEY_DATABASE = "amlfilter-install-key";

/**
 * The slice of the seam's SqlDatabase this store uses. Only the statement-list
 * form of `transaction`: since 0.3 the seam also has a callback form, and this
 * store never needs it.
 */
export interface InstallKeySql
	extends Pick<SqlDatabase, "storage" | "exec" | "query" | "close"> {
	transaction(
		statements: ReadonlyArray<SqlStatement>,
	): Promise<SqlTransactionResult>;
}

/** Opens one session on the install-key database. */
export type InstallKeySqlOpener = () => Promise<InstallKeySql>;

/** Where the key lives this session. */
export type InstallKeyPersistence =
	| { readonly kind: "opfs" }
	| { readonly kind: "memory"; readonly reason: string };

/** How a row came to exist. */
export type InstallKeyOrigin = "generated" | "migrated" | "imported";

/** The stored key. `seedHex` is a secret: never log it. */
export interface StoredInstallKey {
	readonly seedHex: string;
	readonly publicKeyHex: string;
}

/** Metadata about a corrupt seed. Never the value itself. */
export interface QuarantineRecord {
	readonly sha256: string;
	readonly valueLength: number;
	readonly quarantinedAt: string;
	readonly source: string;
}

/** The key store cannot be used here (e.g. another tab holds it). */
export class InstallKeyUnavailable extends Error {
	override readonly name = "InstallKeyUnavailable";
}

const HEX32 = "length(%s) = 64 AND %s NOT GLOB '*[^0-9a-f]*'" as const;

function hexCheck(column: string): string {
	return HEX32.replaceAll("%s", column);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS install_key (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	seed_hex TEXT NOT NULL CHECK (${hexCheck("seed_hex")}),
	public_key_hex TEXT NOT NULL CHECK (${hexCheck("public_key_hex")}),
	origin TEXT NOT NULL CHECK (origin IN ('generated', 'migrated', 'imported')),
	created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS install_key_quarantine (
	id INTEGER PRIMARY KEY,
	sha256 TEXT NOT NULL,
	value_length INTEGER NOT NULL,
	quarantined_at TEXT NOT NULL,
	source TEXT NOT NULL
) STRICT;
`;

const SELECT_KEY =
	"SELECT seed_hex, public_key_hex FROM install_key WHERE id = 1";

const INSERT_KEY = `INSERT INTO install_key
	(id, seed_hex, public_key_hex, origin, created_at) VALUES (1, ?, ?, ?, ?)`;

function toStored(row: SqlRow | undefined): StoredInstallKey | null {
	if (row === undefined) {
		return null;
	}
	return {
		seedHex: String(row.seed_hex),
		publicKeyHex: String(row.public_key_hex),
	};
}

function persistenceOf(storage: SqlStorage): InstallKeyPersistence {
	return storage.persistence === "opfs"
		? { kind: "opfs" }
		: { kind: "memory", reason: storage.reason };
}

/** One open session on the install-key database. */
export interface InstallKeyDb {
	readonly persistence: InstallKeyPersistence;
	read(): Promise<StoredInstallKey | null>;
	/** Insert unless a row exists; returns whichever row won. */
	insertIfAbsent(
		seedHex: string,
		publicKeyHex: string,
		origin: InstallKeyOrigin,
	): Promise<StoredInstallKey>;
	replace(
		seedHex: string,
		publicKeyHex: string,
		origin: InstallKeyOrigin,
	): Promise<void>;
	clear(): Promise<void>;
	quarantine(record: QuarantineRecord): Promise<void>;
	close(): Promise<void>;
}

function keyBind(
	seedHex: string,
	publicKeyHex: string,
	origin: InstallKeyOrigin,
): SqlBind {
	return [seedHex, publicKeyHex, origin, new Date().toISOString()];
}

function sessionOver(sql: InstallKeySql): InstallKeyDb {
	return {
		persistence: persistenceOf(sql.storage),
		read: async () => toStored((await sql.query(SELECT_KEY))[0]),
		insertIfAbsent: async (seedHex, publicKeyHex, origin) => {
			const { results } = await sql.transaction([
				{
					// ON CONFLICT, not INSERT OR IGNORE: OR IGNORE also swallows a
					// CHECK violation, which would hide a malformed seed.
					sql: `${INSERT_KEY} ON CONFLICT(id) DO NOTHING`,
					bind: keyBind(seedHex, publicKeyHex, origin),
				},
				{ sql: SELECT_KEY },
			]);
			const stored = toStored(results[1]?.[0]);
			if (stored === null) {
				throw new Error("install_key row missing after insert");
			}
			return stored;
		},
		replace: async (seedHex, publicKeyHex, origin) => {
			await sql.transaction([
				{ sql: "DELETE FROM install_key" },
				{ sql: INSERT_KEY, bind: keyBind(seedHex, publicKeyHex, origin) },
			]);
		},
		clear: async () => {
			await sql.exec("DELETE FROM install_key");
		},
		quarantine: async (record) => {
			await sql.exec(
				`INSERT INTO install_key_quarantine
					(sha256, value_length, quarantined_at, source) VALUES (?, ?, ?, ?)`,
				[
					record.sha256,
					record.valueLength,
					record.quarantinedAt,
					record.source,
				],
			);
		},
		close: () => sql.close(),
	};
}

/** Open a session and make sure the schema exists. */
export async function openInstallKeyDb(
	open: InstallKeySqlOpener,
): Promise<InstallKeyDb> {
	const sql = await open();
	try {
		await sql.exec(SCHEMA);
	} catch (error) {
		await sql.close();
		throw error;
	}
	return sessionOver(sql);
}

type SeamOpen = (options: SqlDatabaseOptions) => Promise<InstallKeySql>;

/**
 * The production opener. OPFS sessions really close (the pool is free for
 * other tabs). An OPFS refusal yields one in-memory database kept for the tab.
 * "pool-in-use" means another tab holds the real key: refuse rather than
 * invent a second one.
 */
export function sqlInstallKeyOpener(
	open: SeamOpen = openSqlDatabase,
): InstallKeySqlOpener {
	let memory: InstallKeySql | null = null;
	return async () => {
		if (memory !== null) {
			return memory;
		}
		const db = await open({ name: INSTALL_KEY_DATABASE, fallback: "memory" });
		if (db.storage.persistence === "opfs") {
			return db;
		}
		if (db.storage.reason === "pool-in-use") {
			await db.close();
			throw new InstallKeyUnavailable(
				"the signing key is in use by another tab",
			);
		}
		memory = { ...db, storage: db.storage, close: async () => undefined };
		return memory;
	};
}
