// Test support: the install-key SQL seam backed by a REAL in-memory SQLite
// (the official @sqlite.org/sqlite-wasm build), so the schema, CHECK
// constraints and transactions under test are the ones that ship. jsdom has no
// module Worker or OPFS, so production's openSqlDatabase cannot run here.
//
// "Persistence" is simulated per store: every open of the same store returns
// the same connection, the way reopening the OPFS file would.

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type {
	InstallKeySql,
	InstallKeySqlOpener,
	SqlBind,
	SqlRow,
	SqlStatement,
	SqlStorage,
} from "../engine/installKeyStore";

interface Oo1Db {
	exec(opts: {
		sql: string;
		bind?: unknown;
		returnValue: "resultRows";
		rowMode: "object";
	}): Array<Record<string, unknown>>;
	changes(): number;
	close(): void;
}

interface SqliteModule {
	readonly oo1: { readonly DB: new (filename: string) => Oo1Db };
}

type SqliteInit = (opts?: {
	print?: () => void;
	printErr?: () => void;
}) => Promise<SqliteModule>;

let modulePromise: Promise<SqliteModule> | null = null;

function loadSqlite(): Promise<SqliteModule> {
	modulePromise ??= (sqlite3InitModule as unknown as SqliteInit)({
		print: () => undefined,
		printErr: () => undefined,
	});
	return modulePromise;
}

function rows(db: Oo1Db, sql: string, bind?: SqlBind): SqlRow[] {
	return db.exec({
		sql,
		bind,
		returnValue: "resultRows",
		rowMode: "object",
	}) as SqlRow[];
}

/** Hooks a test uses to simulate a crash inside a transaction. */
export interface MemorySqlFaults {
	/** Throw from the Nth statement of the next transaction (0-based). */
	failTransactionAt?: number | undefined;
}

/** A store whose opens all reach one in-memory database. */
export interface MemoryInstallKeySql {
	readonly open: InstallKeySqlOpener;
	readonly faults: MemorySqlFaults;
	/** Opens performed so far (the "how many Worker spins" counter). */
	opens(): number;
	/** Read-only peek for assertions. */
	query(sql: string, bind?: SqlBind): Promise<SqlRow[]>;
}

function runTransaction(
	db: Oo1Db,
	statements: ReadonlyArray<SqlStatement>,
	faults: MemorySqlFaults,
): ReadonlyArray<ReadonlyArray<SqlRow>> {
	const failAt = faults.failTransactionAt;
	faults.failTransactionAt = undefined;
	rows(db, "BEGIN IMMEDIATE");
	try {
		const results = statements.map((statement, index) => {
			if (index === failAt) {
				throw new Error("simulated crash mid-transaction");
			}
			return "rows" in statement ? [] : rows(db, statement.sql, statement.bind);
		});
		rows(db, "COMMIT");
		return results;
	} catch (error) {
		rows(db, "ROLLBACK");
		throw error;
	}
}

/** Build a memory-backed install-key store. */
export async function memoryInstallKeySql(
	storage: SqlStorage = { persistence: "opfs", pool: "test", file: "test" },
): Promise<MemoryInstallKeySql> {
	const sqlite = await loadSqlite();
	const db = new sqlite.oo1.DB(":memory:");
	const faults: MemorySqlFaults = {};
	let opens = 0;
	const connection: InstallKeySql = {
		storage,
		exec: async (sql, bind) => {
			rows(db, sql, bind);
			return { changes: db.changes(), lastInsertRowid: 0 };
		},
		query: async <R extends SqlRow = SqlRow>(sql: string, bind?: SqlBind) =>
			rows(db, sql, bind) as R[],
		transaction: async (statements) => ({
			changes: 0,
			results: runTransaction(db, statements, faults),
		}),
		close: async () => undefined,
	};
	return {
		open: async () => {
			opens += 1;
			return connection;
		},
		faults,
		opens: () => opens,
		query: async (sql, bind) => rows(db, sql, bind),
	};
}
