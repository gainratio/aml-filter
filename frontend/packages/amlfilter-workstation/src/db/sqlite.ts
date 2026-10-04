// SQLite access facade over the OFFICIAL @sqlite.org/sqlite-wasm build. The
// worker opens the opfs-sahpool database (persistent, no COOP/COEP needed);
// unit tests open ":memory:" through the SAME build, so the SQL under test is
// the SQL that ships. The module's own TS types are loose in places, so this
// file is the single typed boundary (structural interfaces + one cast).

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

export type SqlValue = string | number | null;

/** The narrow database surface the rest of the package consumes. */
export interface SqlDatabase {
	exec(sql: string, bind?: ReadonlyArray<SqlValue>): void;
	selectObjects(
		sql: string,
		bind?: ReadonlyArray<SqlValue>,
	): Array<Record<string, SqlValue>>;
	/** Runs fn atomically (BEGIN/COMMIT); a throw rolls back every write. */
	transaction(fn: () => void): void;
	close(): void;
}

interface Oo1Db {
	exec(opts: { sql: string; bind?: SqlValue[] }): unknown;
	selectObjects(
		sql: string,
		bind?: SqlValue[],
	): Array<Record<string, SqlValue>>;
	transaction<T>(callback: (db: this) => T): T;
	close(): void;
}

interface SqliteModule {
	readonly oo1: { readonly DB: new (filename: string) => Oo1Db };
	installOpfsSAHPoolVfs(opts: {
		name: string;
		forceReinitIfPreviouslyFailed?: boolean;
	}): Promise<SahPoolUtil>;
}

/** The sahpool utility — exposes the persistent OPFS-backed DB constructor. */
interface SahPoolUtil {
	readonly OpfsSAHPoolDb: new (filename: string) => Oo1Db;
}

/**
 * The published .d.mts intentionally declares init() with NO parameters
 * (sqlite-wasm PR #129), but the Emscripten factory accepts a module config
 * at runtime — so the one cast lives here, on the init function.
 */
type SqliteInit = (opts?: {
	print?: (...args: ReadonlyArray<unknown>) => void;
	printErr?: (...args: ReadonlyArray<unknown>) => void;
}) => Promise<SqliteModule>;

let sqliteModulePromise: Promise<SqliteModule> | null = null;

// Memoized per JS realm: repeat sqlite3InitModule() calls return the SAME
// bootstrapped sqlite3 object anyway (it caches globally, warning and burning
// a redundant wasm instantiation per extra call) — so the worker's bounded
// acquisition retry (db/acquire.ts) must re-run only installOpfsSAHPoolVfs,
// not the module init. Reset on failure so a transient init error (e.g. wasm
// fetch) stays retryable exactly as before.
function loadSqlite(): Promise<SqliteModule> {
	if (sqliteModulePromise === null) {
		const init = sqlite3InitModule as unknown as SqliteInit;
		sqliteModulePromise = init({
			print: () => undefined,
			// Engine diagnostics (OPFS/constraint failures) must stay visible in the
			// worker for a fail-closed tool — never mute printErr.
			printErr: (...args) => console.error(...args),
		}).catch((error: unknown) => {
			sqliteModulePromise = null;
			throw error;
		});
	}
	return sqliteModulePromise;
}

function wrapDb(db: Oo1Db): SqlDatabase {
	return {
		exec: (sql, bind) => {
			db.exec({ sql, bind: bind === undefined ? undefined : [...bind] });
		},
		selectObjects: (sql, bind) =>
			db.selectObjects(sql, bind === undefined ? undefined : [...bind]),
		transaction: (fn) => {
			db.transaction(fn);
		},
		close: () => db.close(),
	};
}

/**
 * Harden a persistent customer database before schema or customer access.
 * `secure_delete` overwrites deleted SQLite cells. A truncating checkpoint
 * retires any legacy WAL, then DELETE journaling prevents committed PII from
 * lingering in a reusable WAL file. If the VFS cannot honor either boundary,
 * opening fails closed instead of overstating deletion guarantees.
 */
export function configurePersistentPrivacy(db: SqlDatabase): void {
	db.exec("PRAGMA secure_delete = ON");
	db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	const journalMode = db.selectObjects("PRAGMA journal_mode = DELETE")[0]
		?.journal_mode;
	if (journalMode !== "delete") {
		throw new Error(
			`persistent SQLite journal mode is ${String(journalMode)}; expected delete`,
		);
	}
	const secureDelete = db.selectObjects("PRAGMA secure_delete")[0]
		?.secure_delete;
	if (secureDelete !== 1) {
		throw new Error("persistent SQLite secure_delete is not enabled");
	}
}

/** An in-memory database — the unit-test seam (Node-safe, no OPFS). */
export async function openMemoryDatabase(): Promise<SqlDatabase> {
	const sqlite3 = await loadSqlite();
	return wrapDb(new sqlite3.oo1.DB(":memory:"));
}

/**
 * The persistent opfs-sahpool database — worker-only (sync access handles).
 * Rejects when another tab already holds the handle pool; callers surface
 * that as a clear "already open in another tab" message.
 *
 * forceReinitIfPreviouslyFailed: sqlite-wasm memoizes the install promise per
 * pool name INCLUDING rejections, so without this flag every later call in the
 * same worker replays the first failure verbatim — which would turn the
 * worker's bounded acquisition retry (db/acquire.ts) into a no-op.
 */
export async function openPersistentDatabase(
	poolName: string,
	filename: string,
): Promise<SqlDatabase> {
	const sqlite3 = await loadSqlite();
	const pool = await sqlite3.installOpfsSAHPoolVfs({
		name: poolName,
		forceReinitIfPreviouslyFailed: true,
	});
	const database = wrapDb(new pool.OpfsSAHPoolDb(filename));
	configurePersistentPrivacy(database);
	return database;
}
