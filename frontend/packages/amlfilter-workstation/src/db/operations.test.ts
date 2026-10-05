import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DuplicateReferenceError,
	InvalidResolutionError,
	NotFoundError,
} from "../errors";
import type { TieredMatch } from "../types";
import {
	createCustomer,
	createCustomers,
	deleteCustomer,
	getCustomer,
	getMatchEvents,
	getSetting,
	listCustomers,
	listReviewMatches,
	markScreened,
	recordMatches,
	replaceMatches,
	resolveMatch,
	setSetting,
	updateCustomer,
} from "./operations";
import { migrate } from "./schema";
import { openMemoryDatabase, type SqlDatabase } from "./sqlite";

let db: SqlDatabase;

beforeEach(async () => {
	db = await openMemoryDatabase();
	migrate(db);
});

afterEach(() => {
	db.close();
});

describe("createCustomer", () => {
	it("persists the row with PENDING_REVIEW and local defaults", () => {
		const row = createCustomer(db, {
			customer_reference: "REF-001",
			name: "Ivan Fakovich",
			country: "RU",
		});
		// The backend onboarding service inserts PENDING_REVIEW, not the DRAFT
		// column default (customers/service.py:108).
		expect(row.onboarding_status).toBe("PENDING_REVIEW");
		expect(row.onboarded_by).toBe("local");
		expect(row.id_documents).toEqual([]);
		expect(row.kyc_risk_rating).toBeNull();
		expect(row.customer_id).toMatch(/[0-9a-f-]{36}/);
		expect(getCustomer(db, row.customer_id)).toEqual(row);
	});

	it("rejects a duplicate customer_reference with the typed error", () => {
		createCustomer(db, { customer_reference: "REF-001", name: "A" });
		// Mirrors customers/service.py:67–78 (_reject_duplicate_reference).
		expect(() =>
			createCustomer(db, { customer_reference: "REF-001", name: "B" }),
		).toThrow(DuplicateReferenceError);
		expect(listCustomers(db)).toHaveLength(1);
	});

	it("persists and reads back a nullable dob", () => {
		const withDob = createCustomer(db, {
			customer_reference: "REF-DOB",
			name: "Ivan Fakovich",
			dob: "1975-03-02",
		});
		expect(withDob.dob).toBe("1975-03-02");
		expect(getCustomer(db, withDob.customer_id)?.dob).toBe("1975-03-02");

		const withoutDob = createCustomer(db, {
			customer_reference: "REF-NODOB",
			name: "Ann",
		});
		expect(withoutDob.dob).toBeNull();
	});

	it("round-trips id_documents as structured data", () => {
		const docs = [
			{
				doc_type: "PASSPORT",
				number: "X1",
				issuing_country: "RU",
				expiry: null,
			},
		];
		const row = createCustomer(db, {
			customer_reference: "REF-002",
			name: "A",
			id_documents: docs,
		});
		expect(row.id_documents).toEqual(docs);
	});

	it("creates a batch atomically when a later reference is duplicated", () => {
		createCustomer(db, { customer_reference: "EXISTING", name: "Existing" });
		expect(() =>
			createCustomers(db, [
				{ customer_reference: "BATCH-1", name: "One" },
				{ customer_reference: "EXISTING", name: "Collision" },
			]),
		).toThrow(DuplicateReferenceError);
		expect(listCustomers(db).map((row) => row.customer_reference)).toEqual([
			"EXISTING",
		]);
	});
});

describe("updateCustomer / deleteCustomer", () => {
	it("patches status and risk rating, bumping updated_at fields only", () => {
		const row = createCustomer(db, { customer_reference: "R", name: "A" });
		const updated = updateCustomer(db, row.customer_id, {
			onboarding_status: "ACTIVE",
			kyc_risk_rating: "HIGH",
		});
		expect(updated.onboarding_status).toBe("ACTIVE");
		expect(updated.kyc_risk_rating).toBe("HIGH");
		expect(updated.customer_reference).toBe("R");
	});

	it("patches name and country, leaving blank fields unchanged", () => {
		const row = createCustomer(db, {
			customer_reference: "R",
			name: "Old Name",
			country: "US",
		});
		const updated = updateCustomer(db, row.customer_id, {
			name: "New Name",
			country: "",
		});
		// name changed; an empty-string country is "no change" (stays US).
		expect(updated.name).toBe("New Name");
		expect(updated.country).toBe("US");
	});

	it("rejects an update that steals another customer's reference", () => {
		createCustomer(db, { customer_reference: "R1", name: "A" });
		const second = createCustomer(db, { customer_reference: "R2", name: "B" });
		expect(() =>
			updateCustomer(db, second.customer_id, { customer_reference: "R1" }),
		).toThrow(DuplicateReferenceError);
	});

	it("throws NotFoundError for an unknown customer", () => {
		expect(() =>
			updateCustomer(db, "nope", { kyc_risk_rating: "LOW" }),
		).toThrow(NotFoundError);
	});

	it("deleteCustomer removes the row", () => {
		const row = createCustomer(db, { customer_reference: "R", name: "A" });
		deleteCustomer(db, row.customer_id);
		expect(getCustomer(db, row.customer_id)).toBeNull();
	});
});

function makeTiered(overrides: Partial<TieredMatch> = {}): TieredMatch {
	return {
		ofac_entity_id: "DEMO_SDN:0001",
		score: 0.91,
		tier: "STRONG",
		sanctioned_name: "Ivan Fakovich",
		source_list: "DEMO_SDN",
		list_version: "2026-05-01",
		reasons: [
			{
				signal: "name_vector",
				value: 0.91,
				weight: 0.55,
				contribution: 0.5,
				description: "Vector similarity",
			},
		],
		explanation: "Match due to: strong vector similarity",
		material_fingerprint: "fp-default",
		...overrides,
	};
}

describe("recordMatches", () => {
	it("creates rows as PENDING with the customer denormalized (match_tracker.py:127)", () => {
		const customer = createCustomer(db, {
			customer_reference: "R",
			name: "Ann",
		});
		const rows = recordMatches(db, customer.customer_id, [makeTiered()]);
		expect(rows).toHaveLength(1);
		const row = rows[0];
		if (row === undefined) throw new Error("row missing");
		expect(row.resolution_status).toBe("PENDING");
		expect(row.tier).toBe("STRONG");
		expect(row.customer_reference).toBe("R");
		expect(row.customer_name).toBe("Ann");
		expect(row.sanctioned_name).toBe("Ivan Fakovich");
		expect(row.reasons[0]?.signal).toBe("name_vector");
	});

	it("re-screen of an existing pair resets a resolved match to PENDING with the new score/tier (match_tracker.py:88–104)", () => {
		const customer = createCustomer(db, {
			customer_reference: "R",
			name: "Ann",
		});
		const [first] = recordMatches(db, customer.customer_id, [makeTiered()]);
		if (first === undefined) throw new Error("row missing");
		resolveMatch(db, first.match_id, "FALSE_POSITIVE", "alice", "noise");

		const [again] = recordMatches(db, customer.customer_id, [
			makeTiered({ score: 0.7, tier: "POSSIBLE" }),
		]);
		if (again === undefined) throw new Error("row missing");
		expect(again.match_id).toBe(first.match_id); // same pair, same row
		expect(again.resolution_status).toBe("PENDING");
		expect(again.match_score).toBe(0.7);
		expect(again.tier).toBe("POSSIBLE");
	});

	it("deleting the customer cascades its matches", () => {
		const customer = createCustomer(db, {
			customer_reference: "R",
			name: "Ann",
		});
		recordMatches(db, customer.customer_id, [makeTiered()]);
		deleteCustomer(db, customer.customer_id);
		expect(listReviewMatches(db, {})).toHaveLength(0);
	});

	it("deleting the customer also erases its audit events and reviewer notes", () => {
		const customer = createCustomer(db, {
			customer_reference: "R-PRIVATE",
			name: "Private Person",
		});
		const [match] = recordMatches(db, customer.customer_id, [makeTiered()]);
		if (match === undefined) throw new Error("match missing");
		resolveMatch(
			db,
			match.match_id,
			"FALSE_POSITIVE",
			"analyst@example.test",
			"Contains private review context",
		);
		expect(getMatchEvents(db, match.match_id)).not.toHaveLength(0);

		deleteCustomer(db, customer.customer_id);

		expect(
			db.selectObjects("SELECT * FROM match_events WHERE customer_id = ?", [
				customer.customer_id,
			]),
		).toEqual([]);
	});

	it("returns the persisted rows even when 100+ higher-scored matches exist elsewhere", () => {
		// Regression: the return read used the board-paginated query (LIMIT 100,
		// score DESC, no customer filter), so once the table held 100 stronger
		// rows a fresh lower-scored screening returned [] despite a good write.
		const crowd = createCustomer(db, {
			customer_reference: "R-CROWD",
			name: "Crowd",
		});
		recordMatches(
			db,
			crowd.customer_id,
			Array.from({ length: 101 }, (_, i) =>
				makeTiered({ ofac_entity_id: `e-high-${i}`, score: 0.99 }),
			),
		);

		const late = createCustomer(db, {
			customer_reference: "R-LATE",
			name: "Late Low",
		});
		const rows = recordMatches(db, late.customer_id, [
			makeTiered({ ofac_entity_id: "e-low", score: 0.1, tier: "WEAK" }),
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.ofac_entity_id).toBe("e-low");
	});
});

describe("listReviewMatches", () => {
	it("filters by tier and resolution status, strongest first (review.py:117–139)", () => {
		const customer = createCustomer(db, {
			customer_reference: "R",
			name: "Ann",
		});
		recordMatches(db, customer.customer_id, [
			makeTiered({ ofac_entity_id: "e-strong", score: 0.9, tier: "STRONG" }),
			makeTiered({ ofac_entity_id: "e-weak", score: 0.3, tier: "WEAK" }),
			makeTiered({
				ofac_entity_id: "e-possible",
				score: 0.7,
				tier: "POSSIBLE",
			}),
		]);
		const all = listReviewMatches(db, {});
		expect(all.map((r) => r.ofac_entity_id)).toEqual([
			"e-strong",
			"e-possible",
			"e-weak",
		]);
		expect(listReviewMatches(db, { tier: "STRONG" })).toHaveLength(1);

		const [strong] = listReviewMatches(db, { tier: "STRONG" });
		if (strong === undefined) throw new Error("row missing");
		resolveMatch(db, strong.match_id, "TRUE_POSITIVE");
		expect(listReviewMatches(db, { resolutionStatus: "PENDING" })).toHaveLength(
			2,
		);
	});
});

describe("resolveMatch", () => {
	it("applies resolution + reviewer + notes and stamps resolved_at", () => {
		const customer = createCustomer(db, {
			customer_reference: "R",
			name: "Ann",
		});
		const [row] = recordMatches(db, customer.customer_id, [makeTiered()]);
		if (row === undefined) throw new Error("row missing");
		const resolved = resolveMatch(
			db,
			row.match_id,
			"FALSE_POSITIVE",
			"alice",
			"noise",
		);
		expect(resolved.resolution_status).toBe("FALSE_POSITIVE");
		expect(resolved.reviewer_id).toBe("alice");
		expect(resolved.review_notes).toBe("noise");
	});

	it("re-resolution overwrites unconditionally — no PENDING-only guard (match_tracker.py:251–266)", () => {
		const customer = createCustomer(db, {
			customer_reference: "R",
			name: "Ann",
		});
		const [row] = recordMatches(db, customer.customer_id, [makeTiered()]);
		if (row === undefined) throw new Error("row missing");
		resolveMatch(db, row.match_id, "FALSE_POSITIVE", "alice", "noise");
		const flipped = resolveMatch(db, row.match_id, "TRUE_POSITIVE");
		expect(flipped.resolution_status).toBe("TRUE_POSITIVE");
		// reviewer/notes only overwritten when provided (the Python None-guard).
		expect(flipped.reviewer_id).toBe("alice");
		expect(flipped.review_notes).toBe("noise");
	});

	it("rejects values outside the API regex (review.py:148)", () => {
		const customer = createCustomer(db, {
			customer_reference: "R",
			name: "Ann",
		});
		const [row] = recordMatches(db, customer.customer_id, [makeTiered()]);
		if (row === undefined) throw new Error("row missing");
		expect(() => resolveMatch(db, row.match_id, "PENDING")).toThrow(
			InvalidResolutionError,
		);
		expect(() => resolveMatch(db, row.match_id, "nonsense")).toThrow(
			InvalidResolutionError,
		);
	});

	it("throws NotFoundError for an unknown match id", () => {
		expect(() => resolveMatch(db, "nope", "RESOLVED")).toThrow(NotFoundError);
	});
});

describe("settings", () => {
	it("returns null when unset, then round-trips and overwrites", () => {
		expect(getSetting(db, "analyst_name")).toBeNull();
		setSetting(db, "analyst_name", "Avery Analyst");
		expect(getSetting(db, "analyst_name")).toBe("Avery Analyst");
		setSetting(db, "analyst_name", "Blake");
		expect(getSetting(db, "analyst_name")).toBe("Blake");
	});
});

// Review-carryforward hardening (Task-4/5 reviews), beyond the plan text.

describe("recordMatches atomicity", () => {
	it("a mid-batch insert failure rolls back the whole match set", () => {
		const customer = createCustomer(db, {
			customer_reference: "R",
			name: "Ann",
		});
		// Fault injection: NOT NULL violation on the second row of the batch.
		const broken = makeTiered({
			ofac_entity_id: "e-broken",
			sanctioned_name: null as unknown as string,
		});
		expect(() =>
			recordMatches(db, customer.customer_id, [makeTiered(), broken]),
		).toThrow();
		// A partial screening write is a compliance hazard — all or nothing.
		expect(listReviewMatches(db, {})).toHaveLength(0);
	});
});

describe("replaceMatches", () => {
	it("inserts a fresh match set as PENDING for a customer with no prior matches", () => {
		const customer = createCustomer(db, {
			customer_reference: "R",
			name: "Ann",
		});
		const rows = replaceMatches(db, customer.customer_id, [
			makeTiered({ ofac_entity_id: "e-a", score: 0.9, tier: "STRONG" }),
			makeTiered({ ofac_entity_id: "e-b", score: 0.7, tier: "POSSIBLE" }),
		]);
		expect(rows.map((r) => r.ofac_entity_id)).toEqual(["e-a", "e-b"]);
		expect(rows.every((r) => r.resolution_status === "PENDING")).toBe(true);
	});

	it("PRESERVES a prior resolution (status + resolved_at + reviewer + notes) for a still-matching entity", () => {
		// THE KEY DIFFERENCE FROM recordMatches: a still-matching, previously
		// resolved hit keeps its disposition rather than being reset to PENDING.
		const customer = createCustomer(db, {
			customer_reference: "R",
			name: "Ann",
		});
		const [first] = recordMatches(db, customer.customer_id, [
			makeTiered({ ofac_entity_id: "e-keep" }),
		]);
		if (first === undefined) throw new Error("row missing");
		resolveMatch(db, first.match_id, "FALSE_POSITIVE", "alice", "noise");
		const resolvedAtBefore = db.selectObjects(
			"SELECT resolved_at FROM kyc_matches WHERE customer_id = ?",
			[customer.customer_id],
		)[0]?.resolved_at;
		expect(typeof resolvedAtBefore).toBe("string");

		const [again] = replaceMatches(db, customer.customer_id, [
			makeTiered({ ofac_entity_id: "e-keep", score: 0.7, tier: "POSSIBLE" }),
		]);
		if (again === undefined) throw new Error("row missing");
		expect(again.resolution_status).toBe("FALSE_POSITIVE");
		expect(again.reviewer_id).toBe("alice");
		expect(again.review_notes).toBe("noise");
		// The refreshed score/tier carry through alongside the preserved disposition.
		expect(again.match_score).toBe(0.7);
		expect(again.tier).toBe("POSSIBLE");
		// resolved_at preserved (not nulled, not re-stamped to detection time).
		const resolvedAtAfter = db.selectObjects(
			"SELECT resolved_at FROM kyc_matches WHERE customer_id = ?",
			[customer.customer_id],
		)[0]?.resolved_at;
		expect(resolvedAtAfter).toBe(resolvedAtBefore);
	});

	it("DROPS a stale hit whose entity is absent from the new set, preserving the survivor", () => {
		const customer = createCustomer(db, {
			customer_reference: "R",
			name: "Ann",
		});
		const rows = recordMatches(db, customer.customer_id, [
			makeTiered({ ofac_entity_id: "e-a" }),
			makeTiered({ ofac_entity_id: "e-b" }),
		]);
		const a = rows.find((r) => r.ofac_entity_id === "e-a");
		if (a === undefined) throw new Error("row missing");
		resolveMatch(db, a.match_id, "FALSE_POSITIVE", "alice");

		const after = replaceMatches(db, customer.customer_id, [
			makeTiered({ ofac_entity_id: "e-a" }),
		]);
		expect(after.map((r) => r.ofac_entity_id)).toEqual(["e-a"]);
		expect(after[0]?.resolution_status).toBe("FALSE_POSITIVE");
		// e-b is gone entirely.
		expect(listReviewMatches(db, {}).map((r) => r.ofac_entity_id)).toEqual([
			"e-a",
		]);
	});

	it("with an empty array clears ALL of a customer's matches", () => {
		const customer = createCustomer(db, {
			customer_reference: "R",
			name: "Ann",
		});
		recordMatches(db, customer.customer_id, [
			makeTiered({ ofac_entity_id: "e-a" }),
			makeTiered({ ofac_entity_id: "e-b" }),
		]);
		const after = replaceMatches(db, customer.customer_id, []);
		expect(after).toHaveLength(0);
		expect(listReviewMatches(db, {})).toHaveLength(0);
	});

	it("throws NotFoundError for an unknown customer", () => {
		expect(() => replaceMatches(db, "nope", [makeTiered()])).toThrow(
			NotFoundError,
		);
	});

	it("only affects the target customer — a second customer's matches are untouched", () => {
		const one = createCustomer(db, { customer_reference: "R1", name: "A" });
		const two = createCustomer(db, { customer_reference: "R2", name: "B" });
		recordMatches(db, one.customer_id, [makeTiered({ ofac_entity_id: "e-1" })]);
		recordMatches(db, two.customer_id, [makeTiered({ ofac_entity_id: "e-2" })]);

		replaceMatches(db, one.customer_id, []);

		const twoRows = listReviewMatches(db, {}).filter(
			(r) => r.customer_id === two.customer_id,
		);
		expect(twoRows.map((r) => r.ofac_entity_id)).toEqual(["e-2"]);
	});

	it("rolls back the whole replacement on a mid-batch insert failure", () => {
		const customer = createCustomer(db, {
			customer_reference: "R",
			name: "Ann",
		});
		recordMatches(db, customer.customer_id, [
			makeTiered({ ofac_entity_id: "e-existing" }),
		]);
		const broken = makeTiered({
			ofac_entity_id: "e-broken",
			sanctioned_name: null as unknown as string,
		});
		expect(() =>
			replaceMatches(db, customer.customer_id, [makeTiered(), broken]),
		).toThrow();
		// All-or-nothing: the prior set survives intact, no partial delete/insert.
		expect(listReviewMatches(db, {}).map((r) => r.ofac_entity_id)).toEqual([
			"e-existing",
		]);
	});
});

describe("match_events audit trail", () => {
	it("records a DETECTED event per new match in recordMatches", () => {
		const customer = createCustomer(db, {
			customer_reference: "R",
			name: "Ann",
		});
		const [row] = recordMatches(db, customer.customer_id, [
			makeTiered({ ofac_entity_id: "e-a" }),
		]);
		if (row === undefined) throw new Error("row missing");
		const events = getMatchEvents(db, row.match_id);
		expect(events.map((e) => e.event_type)).toEqual(["DETECTED"]);
		expect(events[0]?.to_status).toBe("PENDING");
		expect(events[0]?.match_id).toBe(row.match_id);
	});

	it("records DISPOSITIONED with from/to status on resolveMatch", () => {
		const customer = createCustomer(db, {
			customer_reference: "R",
			name: "Ann",
		});
		const [row] = recordMatches(db, customer.customer_id, [
			makeTiered({ ofac_entity_id: "e-a" }),
		]);
		if (row === undefined) throw new Error("row missing");
		resolveMatch(db, row.match_id, "FALSE_POSITIVE", "alice", "noise");
		const events = getMatchEvents(db, row.match_id);
		expect(events.map((e) => e.event_type)).toEqual([
			"DETECTED",
			"DISPOSITIONED",
		]);
		const dispo = events[1];
		expect(dispo?.from_status).toBe("PENDING");
		expect(dispo?.to_status).toBe("FALSE_POSITIVE");
		expect(dispo?.reviewer_id).toBe("alice");
		expect(dispo?.notes).toBe("noise");
	});

	it("returns history from BEFORE and AFTER a replaceMatches match_id rotation", () => {
		const customer = createCustomer(db, {
			customer_reference: "R",
			name: "Ann",
		});
		const [first] = recordMatches(db, customer.customer_id, [
			makeTiered({ ofac_entity_id: "e-a", material_fingerprint: "fp1" }),
		]);
		if (first === undefined) throw new Error("row missing");
		resolveMatch(db, first.match_id, "FALSE_POSITIVE", "alice");
		// A rescan with a CHANGED fingerprint rotates the match_id and emits CHANGED.
		const [second] = replaceMatches(db, customer.customer_id, [
			makeTiered({ ofac_entity_id: "e-a", material_fingerprint: "fp2" }),
		]);
		if (second === undefined) throw new Error("row missing");
		expect(second.match_id).not.toBe(first.match_id);
		// Querying by the CURRENT match_id surfaces the full pair history, including
		// the events recorded against the now-deleted prior row.
		const events = getMatchEvents(db, second.match_id);
		expect(events.map((e) => e.event_type)).toEqual([
			"DETECTED",
			"DISPOSITIONED",
			"CHANGED",
		]);
	});
});

describe("replaceMatches re-review (material fingerprint)", () => {
	function seed(reference: string): string {
		const customer = createCustomer(db, {
			customer_reference: reference,
			name: "Ann",
		});
		return customer.customer_id;
	}

	it("NO prior -> PENDING/CURRENT, stores the fingerprint, emits DETECTED", () => {
		const id = seed("R");
		const [row] = replaceMatches(db, id, [
			makeTiered({ ofac_entity_id: "e-a", material_fingerprint: "fp1" }),
		]);
		if (row === undefined) throw new Error("row missing");
		expect(row.resolution_status).toBe("PENDING");
		expect(row.review_state).toBe("CURRENT");
		expect(getMatchEvents(db, row.match_id).map((e) => e.event_type)).toEqual([
			"DETECTED",
		]);
	});

	it("UNCHANGED fingerprint -> carry disposition + state, suppress (no event)", () => {
		const id = seed("R");
		const [first] = recordMatches(db, id, [
			makeTiered({ ofac_entity_id: "e-a", material_fingerprint: "fp1" }),
		]);
		if (first === undefined) throw new Error("row missing");
		resolveMatch(db, first.match_id, "FALSE_POSITIVE", "alice");
		const eventsBefore = getMatchEvents(db, first.match_id).length;
		const [again] = replaceMatches(db, id, [
			makeTiered({ ofac_entity_id: "e-a", material_fingerprint: "fp1" }),
		]);
		if (again === undefined) throw new Error("row missing");
		expect(again.resolution_status).toBe("FALSE_POSITIVE");
		expect(again.review_state).toBe("CURRENT");
		// No new event was appended for the unchanged, suppressed hit.
		expect(getMatchEvents(db, again.match_id).length).toBe(eventsBefore);
	});

	it("CHANGED fingerprint -> carry disposition, set CHANGED, emit CHANGED", () => {
		const id = seed("R");
		const [first] = recordMatches(db, id, [
			makeTiered({ ofac_entity_id: "e-a", material_fingerprint: "fp1" }),
		]);
		if (first === undefined) throw new Error("row missing");
		resolveMatch(db, first.match_id, "FALSE_POSITIVE", "alice", "noise");
		const [again] = replaceMatches(db, id, [
			makeTiered({ ofac_entity_id: "e-a", material_fingerprint: "fp2" }),
		]);
		if (again === undefined) throw new Error("row missing");
		// Disposition NEVER cleared; review_state flips to CHANGED.
		expect(again.resolution_status).toBe("FALSE_POSITIVE");
		expect(again.reviewer_id).toBe("alice");
		expect(again.review_notes).toBe("noise");
		expect(again.review_state).toBe("CHANGED");
		expect(getMatchEvents(db, again.match_id).at(-1)?.event_type).toBe(
			"CHANGED",
		);
	});

	it("NULL prior fingerprint (migrated row) -> adopt silently, NO CHANGED event", () => {
		const id = seed("R");
		// Simulate a migrated row: insert with a NULL material_fingerprint directly.
		const matchId = crypto.randomUUID();
		db.exec(
			`INSERT INTO kyc_matches (match_id, customer_id, ofac_entity_id, match_score,
			   match_tier, sanctioned_name, source_list, reasons, explanation, detected_at,
			   resolution_status, review_state)
			 VALUES (?, ?, 'e-a', 0.9, 'STRONG', 'X', 'OFAC_SDN', '[]', 'x', 't', 'PENDING', 'CURRENT')`,
			[matchId, id],
		);
		const [again] = replaceMatches(db, id, [
			makeTiered({ ofac_entity_id: "e-a", material_fingerprint: "fp-new" }),
		]);
		if (again === undefined) throw new Error("row missing");
		expect(again.review_state).toBe("CURRENT");
		const stored = db.selectObjects(
			"SELECT material_fingerprint FROM kyc_matches WHERE customer_id = ?",
			[id],
		)[0]?.material_fingerprint;
		expect(stored).toBe("fp-new");
		// No CHANGED event: the backfill is silent.
		expect(
			getMatchEvents(db, again.match_id).map((e) => e.event_type),
		).not.toContain("CHANGED");
	});

	it("entity absent from the new set -> SUPPRESSED event (match_id null)", () => {
		const id = seed("R");
		recordMatches(db, id, [
			makeTiered({ ofac_entity_id: "e-gone", material_fingerprint: "fp1" }),
			makeTiered({ ofac_entity_id: "e-stay", material_fingerprint: "fp2" }),
		]);
		replaceMatches(db, id, [
			makeTiered({ ofac_entity_id: "e-stay", material_fingerprint: "fp2" }),
		]);
		// History for the suppressed entity survives (queried by entity pair).
		const suppressed = db
			.selectObjects(
				"SELECT event_type, match_id FROM match_events WHERE ofac_entity_id = 'e-gone' ORDER BY at",
			)
			.map((r) => r.event_type);
		expect(suppressed).toContain("SUPPRESSED");
	});

	it("re-dispositioning a CHANGED match resets review_state to CURRENT", () => {
		const id = seed("R");
		const [first] = recordMatches(db, id, [
			makeTiered({ ofac_entity_id: "e-a", material_fingerprint: "fp1" }),
		]);
		if (first === undefined) throw new Error("row missing");
		resolveMatch(db, first.match_id, "FALSE_POSITIVE", "alice");
		const [changed] = replaceMatches(db, id, [
			makeTiered({ ofac_entity_id: "e-a", material_fingerprint: "fp2" }),
		]);
		if (changed === undefined) throw new Error("row missing");
		expect(changed.review_state).toBe("CHANGED");
		const after = resolveMatch(db, changed.match_id, "TRUE_POSITIVE", "bob");
		expect(after.review_state).toBe("CURRENT");
	});
});

describe("listReviewMatches filters (review_state + needsReview)", () => {
	function seedTwo(): string {
		const customer = createCustomer(db, {
			customer_reference: "R",
			name: "Ann",
		});
		const id = customer.customer_id;
		const [a] = recordMatches(db, id, [
			makeTiered({ ofac_entity_id: "e-a", material_fingerprint: "fp1" }),
		]);
		if (a === undefined) throw new Error("row missing");
		// Dispose e-a, then CHANGE its fingerprint so it becomes CHANGED.
		resolveMatch(db, a.match_id, "FALSE_POSITIVE", "alice");
		replaceMatches(db, id, [
			makeTiered({ ofac_entity_id: "e-a", material_fingerprint: "fp2" }),
			makeTiered({ ofac_entity_id: "e-b", material_fingerprint: "fp3" }),
		]);
		return id;
	}

	it("filters to review_state = CHANGED", () => {
		seedTwo();
		const rows = listReviewMatches(db, { reviewState: "CHANGED" });
		expect(rows.map((r) => r.ofac_entity_id)).toEqual(["e-a"]);
		expect(rows[0]?.review_state).toBe("CHANGED");
	});

	it("needsReview returns PENDING OR CHANGED matches", () => {
		seedTwo();
		// e-a: dispositioned FALSE_POSITIVE but CHANGED; e-b: PENDING. Both qualify.
		const rows = listReviewMatches(db, { needsReview: true });
		expect(new Set(rows.map((r) => r.ofac_entity_id))).toEqual(
			new Set(["e-a", "e-b"]),
		);
	});

	it("exposes review_state on every ReviewRow", () => {
		const customer = createCustomer(db, {
			customer_reference: "R",
			name: "Ann",
		});
		recordMatches(db, customer.customer_id, [
			makeTiered({ ofac_entity_id: "e" }),
		]);
		expect(listReviewMatches(db, {})[0]?.review_state).toBe("CURRENT");
	});
});

describe("createCustomer check-then-insert race", () => {
	it("maps a db-level UNIQUE reference violation to DuplicateReferenceError", () => {
		createCustomer(db, { customer_reference: "REF-RACE", name: "A" });
		// Simulate the race: the SELECT guard sees no row, yet the INSERT still
		// collides on the UNIQUE constraint (customers/service.py _persist_customer).
		const racy: SqlDatabase = {
			...db,
			selectObjects: (sql, bind) =>
				sql.includes("customer_reference = ?")
					? []
					: db.selectObjects(sql, bind),
		};
		expect(() =>
			createCustomer(racy, { customer_reference: "REF-RACE", name: "B" }),
		).toThrow(DuplicateReferenceError);
	});
});

describe("screening proof (markScreened)", () => {
	function customer() {
		return createCustomer(db, {
			customer_reference: "REF-P",
			name: "Ann Example",
			country: "GB",
		});
	}

	it("a new customer carries no proof of screening", () => {
		const row = customer();
		expect(row.screened_at).toBeNull();
		expect(row.screened_list_version).toBeNull();
	});

	it("records when and against which lists the customer was screened", () => {
		const row = customer();
		const marked = markScreened(db, row.customer_id, "OFAC_SDN@v1|UN@v2");
		expect(marked.screened_list_version).toBe("OFAC_SDN@v1|UN@v2");
		expect(marked.screened_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(listCustomers(db)[0]?.screened_list_version).toBe(
			"OFAC_SDN@v1|UN@v2",
		);
	});

	it("refuses to mark a customer that does not exist", () => {
		expect(() => markScreened(db, "missing", "v")).toThrow(NotFoundError);
	});

	it("a name or country change voids the proof: the new identity was never screened", () => {
		const row = customer();
		markScreened(db, row.customer_id, "v1");
		expect(
			updateCustomer(db, row.customer_id, { name: "Ann Renamed" })
				.screened_list_version,
		).toBeNull();
		markScreened(db, row.customer_id, "v1");
		expect(
			updateCustomer(db, row.customer_id, { country: "FR" }).screened_at,
		).toBeNull();
	});

	it("a status/risk change or an unchanged name keeps the proof", () => {
		const row = customer();
		markScreened(db, row.customer_id, "v1");
		const after = updateCustomer(db, row.customer_id, {
			onboarding_status: "ACTIVE",
			kyc_risk_rating: "LOW",
			name: "Ann Example",
			country: "GB",
		});
		expect(after.screened_list_version).toBe("v1");
	});
});
