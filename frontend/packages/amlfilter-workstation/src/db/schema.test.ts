import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, SCHEMA_VERSION } from "./schema";
import { openMemoryDatabase, type SqlDatabase } from "./sqlite";

/** Stand up a v1-shaped DB by hand and record it as version 1 in the ledger, so
 *  migrate() sees current=1 and applies only the additive v2 step. This is the
 *  frozen v1 DDL — it intentionally lacks the v2 columns/table. */
function seedV1(db: SqlDatabase): void {
	db.exec("PRAGMA foreign_keys = ON");
	db.exec(
		`CREATE TABLE customers (
			customer_id TEXT PRIMARY KEY, customer_reference TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL, country TEXT,
			onboarding_status TEXT NOT NULL DEFAULT 'DRAFT', kyc_risk_rating TEXT,
			id_documents TEXT NOT NULL DEFAULT '[]', onboarded_by TEXT NOT NULL DEFAULT 'local',
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
	);
	db.exec(
		`CREATE TABLE kyc_matches (
			match_id TEXT PRIMARY KEY,
			customer_id TEXT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
			ofac_entity_id TEXT NOT NULL, match_score REAL NOT NULL, match_tier TEXT NOT NULL,
			list_version TEXT, sanctioned_name TEXT NOT NULL, source_list TEXT NOT NULL,
			reasons TEXT NOT NULL, explanation TEXT NOT NULL, detected_at TEXT NOT NULL,
			resolution_status TEXT NOT NULL DEFAULT 'PENDING', resolved_at TEXT,
			reviewer_id TEXT, review_notes TEXT, UNIQUE (customer_id, ofac_entity_id))`,
	);
	db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	db.exec(
		`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`,
	);
	db.exec(
		"INSERT INTO schema_migrations (version, applied_at) VALUES (1, 't')",
	);
}

describe("schema migrations", () => {
	let db: SqlDatabase;

	beforeEach(async () => {
		db = await openMemoryDatabase();
	});

	afterEach(() => {
		db.close();
	});

	it("creates schema v1 (customers, kyc_matches, settings)", () => {
		expect(migrate(db)).toBe(SCHEMA_VERSION);
		const names = db
			.selectObjects(
				"SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
			)
			.map((row) => row.name);
		expect(names).toContain("customers");
		expect(names).toContain("kyc_matches");
		expect(names).toContain("settings");
		expect(names).toContain("schema_migrations");
	});

	it("is idempotent — a second migrate is a no-op", () => {
		migrate(db);
		expect(migrate(db)).toBe(SCHEMA_VERSION);
		// One row per applied version (v1 + v2); a second migrate adds none.
		const rows = db.selectObjects(
			"SELECT COUNT(*) AS n FROM schema_migrations",
		);
		expect(rows[0]?.n).toBe(SCHEMA_VERSION);
	});

	it("applies v2 — review-state columns, match_events, and its indexes", () => {
		expect(migrate(db)).toBe(SCHEMA_VERSION);
		const columns = db
			.selectObjects("SELECT name FROM pragma_table_info('kyc_matches')")
			.map((row) => row.name);
		expect(columns).toContain("material_fingerprint");
		expect(columns).toContain("review_state");
		const tables = db
			.selectObjects(
				"SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
			)
			.map((row) => row.name);
		expect(tables).toContain("match_events");
		const indexes = db
			.selectObjects(
				"SELECT name FROM sqlite_schema WHERE type = 'index' ORDER BY name",
			)
			.map((row) => row.name);
		expect(indexes).toContain("idx_match_events_match");
		expect(indexes).toContain("idx_match_events_entity");
	});

	it("upgrades a v1-shaped DB additively, preserving existing rows", () => {
		// Stand up a v1 DB by hand (the frozen v1 DDL), seed a customer + match,
		// then migrate to HEAD and assert the new columns backfilled with the
		// documented defaults and the pre-existing row survived.
		seedV1(db);
		db.exec(
			`INSERT INTO customers (customer_id, customer_reference, name, created_at, updated_at)
			 VALUES ('c1', 'REF-1', 'Ivan', 't', 't')`,
		);
		db.exec(
			`INSERT INTO kyc_matches (match_id, customer_id, ofac_entity_id, match_score,
			   match_tier, sanctioned_name, source_list, reasons, explanation, detected_at)
			 VALUES ('m1', 'c1', 'e1', 0.9, 'STRONG', 'X', 'OFAC_SDN', '[]', 'x', 't')`,
		);
		expect(migrate(db)).toBe(SCHEMA_VERSION);
		const rows = db.selectObjects(
			"SELECT match_id, review_state, material_fingerprint FROM kyc_matches WHERE match_id = 'm1'",
		);
		expect(rows[0]?.review_state).toBe("CURRENT");
		expect(rows[0]?.material_fingerprint).toBeNull();
	});

	it("applies v3 — a nullable dob column on customers", () => {
		expect(migrate(db)).toBe(SCHEMA_VERSION);
		const columns = db
			.selectObjects("SELECT name FROM pragma_table_info('customers')")
			.map((row) => row.name);
		expect(columns).toContain("dob");
	});

	it("upgrades a v2-shaped DB to HEAD additively, backfilling dob = NULL", () => {
		// Stand up a v1 DB by hand and run migrate, landing it at v2 with a row,
		// then re-record it at v2 and migrate again so only the additive later steps
		// run. The pre-existing customer must survive with dob backfilled NULL,
		// and the ledger must record HEAD.
		seedV1(db);
		db.exec(
			`INSERT INTO customers (customer_id, customer_reference, name, created_at, updated_at)
			 VALUES ('c1', 'REF-1', 'Ivan', 't', 't')`,
		);
		expect(migrate(db)).toBe(SCHEMA_VERSION);
		const rows = db.selectObjects(
			"SELECT customer_id, dob FROM customers WHERE customer_id = 'c1'",
		);
		expect(rows[0]?.customer_id).toBe("c1");
		expect(rows[0]?.dob).toBeNull();
		const maxVersion = db.selectObjects(
			"SELECT MAX(version) AS v FROM schema_migrations",
		);
		expect(maxVersion[0]?.v).toBe(SCHEMA_VERSION);
	});

	it("applies v5 — screening-proof columns, backfilled NULL so no old row reads as screened", () => {
		seedV1(db);
		db.exec(
			`INSERT INTO customers (customer_id, customer_reference, name, created_at, updated_at)
			 VALUES ('c1', 'REF-1', 'Ivan', 't', 't')`,
		);
		expect(migrate(db)).toBe(SCHEMA_VERSION);
		expect(SCHEMA_VERSION).toBe(5);
		const rows = db.selectObjects(
			"SELECT screened_at, screened_list_version FROM customers WHERE customer_id = 'c1'",
		);
		expect(rows[0]?.screened_at).toBeNull();
		expect(rows[0]?.screened_list_version).toBeNull();
	});

	it("applies v4 — the match_events append-only triggers", () => {
		expect(migrate(db)).toBe(SCHEMA_VERSION);
		const triggers = db
			.selectObjects(
				"SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name",
			)
			.map((row) => row.name);
		expect(triggers).toContain("match_events_no_update");
		expect(triggers).toContain("match_events_no_delete");
	});

	it("upgrades a v3-shaped DB by adding the triggers to an existing ledger", () => {
		// The guard has to reach databases that already hold audit history, not just
		// freshly-created ones — otherwise every existing user keeps the unguarded
		// table. Land a DB at v3 with a real event in it, re-record it at v3, then
		// migrate: the event must survive and the triggers must now bind it.
		seedV1(db);
		migrate(db);
		db.exec(
			`INSERT INTO customers (customer_id, customer_reference, name, created_at, updated_at)
			 VALUES ('c1', 'REF-1', 'Ivan', 't', 't')`,
		);
		db.exec(
			`INSERT INTO match_events (event_id, match_id, customer_id, ofac_entity_id,
			   event_type, at)
			 VALUES ('ev1', 'm1', 'c1', 'e1', 'DETECTED', 't')`,
		);
		db.exec("DROP TRIGGER match_events_no_update");
		db.exec("DROP TRIGGER match_events_no_delete");
		// Roll the ledger back to v3 exactly: later steps (v5's columns) are undone
		// too, so the migration re-runs v4 and everything after it.
		db.exec("ALTER TABLE customers DROP COLUMN screened_at");
		db.exec("ALTER TABLE customers DROP COLUMN screened_list_version");
		db.exec("DELETE FROM schema_migrations WHERE version >= 4");

		expect(migrate(db)).toBe(SCHEMA_VERSION);

		expect(db.selectObjects("SELECT event_id FROM match_events")).toHaveLength(
			1,
		);
		expect(() =>
			db.exec(
				"UPDATE match_events SET event_type = 'X' WHERE event_id = 'ev1'",
			),
		).toThrow(/append-only/i);
	});

	it("enforces foreign keys — a match for an unknown customer is rejected", () => {
		migrate(db);
		expect(() =>
			db.exec(
				`INSERT INTO kyc_matches (match_id, customer_id, ofac_entity_id, match_score,
				   match_tier, sanctioned_name, source_list, reasons, explanation, detected_at)
				 VALUES ('m1', 'missing', 'e1', 0.9, 'STRONG', 'X', 'OFAC_SDN', '[]', 'x', 't')`,
			),
		).toThrow(/FOREIGN KEY/i);
	});

	it("applies a version atomically — a failing v2 step rolls back its partial DDL", () => {
		// Stand up a v1 DB recorded at version 1, but pre-create a `match_events`
		// table so v2's `CREATE TABLE match_events` throws AFTER its two
		// `ALTER TABLE ... ADD COLUMN` statements have run. Without a transaction
		// around applyVersion, those ALTERs land while the ledger stays at 1 — a
		// re-run would then hit "duplicate column". With a transaction, the whole
		// v2 step rolls back: no new columns, no match_events shape change, no
		// ledger row, leaving the DB cleanly at v1.
		seedV1(db);
		db.exec("CREATE TABLE match_events (event_id TEXT PRIMARY KEY)");

		expect(() => migrate(db)).toThrow();

		// Ledger still at v1 — the v2 step did not record.
		const maxVersion = db.selectObjects(
			"SELECT MAX(version) AS v FROM schema_migrations",
		);
		expect(maxVersion[0]?.v).toBe(1);
		// No partial columns from the rolled-back ALTERs.
		const columns = db
			.selectObjects("SELECT name FROM pragma_table_info('kyc_matches')")
			.map((row) => row.name);
		expect(columns).not.toContain("material_fingerprint");
		expect(columns).not.toContain("review_state");
		// The conflicting pre-existing table is untouched by the rollback.
		const eventCols = db
			.selectObjects("SELECT name FROM pragma_table_info('match_events')")
			.map((row) => row.name);
		expect(eventCols).toEqual(["event_id"]);
	});
});
