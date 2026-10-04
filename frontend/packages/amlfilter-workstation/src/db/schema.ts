// Schema v1 — mirrors the verified backend rows (spec §5 sketch) with the
// local deltas the page contracts force: no tenant_id (single implicit local
// tenant → uniqueness on customer_reference alone); name/country live on the
// customer (the server keeps them on the linked WHITELIST Entity, which has
// no local equivalent); kyc_matches carries sanctioned_name + source_list
// because the review board renders them and there is no local entity table
// to join (the only entity store is the read-only signed bundle).

import type { SqlDatabase } from "./sqlite";

export const SCHEMA_VERSION = 5;

const MIGRATION_V1: ReadonlyArray<string> = [
	`CREATE TABLE customers (
		customer_id        TEXT PRIMARY KEY,
		customer_reference TEXT NOT NULL UNIQUE,
		name               TEXT NOT NULL,
		country            TEXT,
		onboarding_status  TEXT NOT NULL DEFAULT 'DRAFT',
		kyc_risk_rating    TEXT,
		id_documents       TEXT NOT NULL DEFAULT '[]',
		onboarded_by       TEXT NOT NULL DEFAULT 'local',
		created_at         TEXT NOT NULL,
		updated_at         TEXT NOT NULL
	)`,
	`CREATE TABLE kyc_matches (
		match_id          TEXT PRIMARY KEY,
		customer_id       TEXT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
		ofac_entity_id    TEXT NOT NULL,
		match_score       REAL NOT NULL,
		match_tier        TEXT NOT NULL,
		list_version      TEXT,
		sanctioned_name   TEXT NOT NULL,
		source_list       TEXT NOT NULL,
		reasons           TEXT NOT NULL,
		explanation       TEXT NOT NULL,
		detected_at       TEXT NOT NULL,
		resolution_status TEXT NOT NULL DEFAULT 'PENDING',
		resolved_at       TEXT,
		reviewer_id       TEXT,
		review_notes      TEXT,
		UNIQUE (customer_id, ofac_entity_id)
	)`,
	"CREATE INDEX idx_kyc_matches_review ON kyc_matches (resolution_status, match_tier)",
	"CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
];

// v2 — additive only (no data loss): the material-change fingerprint + a
// re-review flag on each match, plus an append-only-during-lifecycle
// match_events audit ledger (explicit customer deletion erases its rows).
// review_state defaults CURRENT so every pre-existing row backfills to "clean";
// material_fingerprint is nullable so migrated rows are flagged "never seen a
// fingerprint" and adopt one silently on the first replaceMatches (no false
// CHANGED event). match_id is nullable on an event so a SUPPRESSED entity (which
// has no surviving row) can still be recorded.
const MIGRATION_V2: ReadonlyArray<string> = [
	"ALTER TABLE kyc_matches ADD COLUMN material_fingerprint TEXT",
	"ALTER TABLE kyc_matches ADD COLUMN review_state TEXT NOT NULL DEFAULT 'CURRENT'",
	`CREATE TABLE match_events (
		event_id       TEXT PRIMARY KEY,
		match_id       TEXT,
		customer_id    TEXT NOT NULL,
		ofac_entity_id TEXT NOT NULL,
		event_type     TEXT NOT NULL,
		from_status    TEXT,
		to_status      TEXT,
		reviewer_id    TEXT,
		notes          TEXT,
		at             TEXT NOT NULL
	)`,
	"CREATE INDEX idx_match_events_match ON match_events(match_id)",
	"CREATE INDEX idx_match_events_entity ON match_events(customer_id, ofac_entity_id)",
];

// v3 — additive only: a nullable date-of-birth on the customer, so DOB-based
// screening can run end to end (the browser engine's ScreenQuery already accepts
// `dob`). Migrated rows backfill to NULL (DOB unknown).
const MIGRATION_V3: ReadonlyArray<string> = [
	"ALTER TABLE customers ADD COLUMN dob TEXT",
];

// v4 — additive only: the append-only claim on match_events, moved out of code
// comments and into the storage engine.
//
// Until v4 the ledger was append-only only in the sense that every statement we
// happened to write was an INSERT. That is discipline, not enforcement: SQLite
// accepted `UPDATE match_events SET to_status = ...` and `DELETE FROM
// match_events` without complaint, so a future code path, a stray migration, or
// a devtools console could rewrite a reviewer's disposition and leave no trace.
//
// UPDATE is refused outright — no lifecycle operation has ever needed one.
//
// DELETE is refused while the row's customer still exists. That is the exact
// shape of the one sanctioned removal: deleting a customer is the privacy
// boundary, it is all-or-nothing, and it destroys the customer record itself.
// So a single event cannot be picked out of a live customer's trail, and the
// trail cannot be truncated — but the right to erasure still works, provided
// the caller erases the customer first (see deleteCustomer's ordering).
const MIGRATION_V4: ReadonlyArray<string> = [
	`CREATE TRIGGER match_events_no_update
	 BEFORE UPDATE ON match_events
	 BEGIN
	   SELECT RAISE(ABORT, 'match_events is append-only: UPDATE is refused');
	 END`,
	`CREATE TRIGGER match_events_no_delete
	 BEFORE DELETE ON match_events
	 WHEN EXISTS (SELECT 1 FROM customers WHERE customer_id = OLD.customer_id)
	 BEGIN
	   SELECT RAISE(ABORT, 'match_events is append-only: DELETE is refused while the customer exists');
	 END`,
];

// v5 — additive only: positive proof that a customer was screened. A customer
// must never read "No matches" unless it was screened, and screened against the
// lists loaded now: an import whose screening failed, or a row screened under an
// older list set, has no matches either. `screened_list_version` is the
// composite stamp of the lists the screen ran against; `screened_at` is when.
// Existing rows backfill NULL — unproven until the next screen marks them.
const MIGRATION_V5: ReadonlyArray<string> = [
	"ALTER TABLE customers ADD COLUMN screened_at TEXT",
	"ALTER TABLE customers ADD COLUMN screened_list_version TEXT",
];

/** Ordered migration ledger: index i holds the step that takes vi → v(i+1). */
const MIGRATIONS: ReadonlyArray<ReadonlyArray<string>> = [
	MIGRATION_V1,
	MIGRATION_V2,
	MIGRATION_V3,
	MIGRATION_V4,
	MIGRATION_V5,
];

function currentVersion(db: SqlDatabase): number {
	db.exec(
		`CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at TEXT NOT NULL
		)`,
	);
	const rows = db.selectObjects(
		"SELECT MAX(version) AS v FROM schema_migrations",
	);
	const v = rows[0]?.v;
	return typeof v === "number" ? v : 0;
}

/** Apply one ordered migration step and record it in the ledger — atomically.
 * The version's DDL statements and the ledger insert run inside a single
 * transaction, so a crash mid-step rolls back every partial statement and
 * leaves the ledger un-incremented (a clean re-run, no "duplicate column"). */
function applyVersion(db: SqlDatabase, version: number): void {
	db.transaction(() => {
		for (const sql of MIGRATIONS[version - 1] ?? []) {
			db.exec(sql);
		}
		db.exec(
			"INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
			[version, new Date().toISOString()],
		);
	});
}

/**
 * Turn on recursive triggers, and refuse to proceed if that did not take.
 *
 * This is not a tuning knob — it closes a hole straight through the append-only
 * guard. `INSERT OR REPLACE` resolves a primary-key conflict by deleting the old
 * row first, and SQLite fires DELETE triggers for that implicit delete ONLY when
 * recursive_triggers is on (it is off by default). With it off, one REPLACE
 * swaps a forged event in under an existing event_id and the BEFORE DELETE
 * trigger never runs. The setting is per-connection and is not stored in the
 * file, so every connection has to re-assert it — which is why it lives here,
 * in the function every connection already calls.
 */
function enableRecursiveTriggers(db: SqlDatabase): void {
	db.exec("PRAGMA recursive_triggers = ON");
	const enabled = db.selectObjects("PRAGMA recursive_triggers")[0]
		?.recursive_triggers;
	if (enabled !== 1) {
		throw new Error(
			"SQLite recursive_triggers is off; the match_events append-only guard would be bypassable by INSERT OR REPLACE",
		);
	}
}

/**
 * Bring the database to schema HEAD; per-connection pragmas included. Applies
 * every migration whose version is greater than the recorded current version,
 * in order, recording each in schema_migrations — so a v1 DB upgrades to v2
 * by running only the additive v2 step. Idempotent: a HEAD DB applies nothing.
 */
export function migrate(db: SqlDatabase): number {
	db.exec("PRAGMA foreign_keys = ON");
	enableRecursiveTriggers(db);
	const from = currentVersion(db);
	for (let version = from + 1; version <= SCHEMA_VERSION; version += 1) {
		applyVersion(db, version);
	}
	return SCHEMA_VERSION;
}
