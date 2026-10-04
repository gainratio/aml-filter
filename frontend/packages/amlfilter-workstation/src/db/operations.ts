// Pure SQL operations over the SqlDatabase facade — the worker dispatches one
// RPC kind to one function here. Semantics are PORTS of the observed backend
// contract, cited per function. Tested against real in-memory SQLite.

import {
	DuplicateReferenceError,
	InvalidResolutionError,
	NotFoundError,
} from "../errors";
import type {
	CreateCustomerPayload,
	CustomerPatch,
	CustomerRow,
	IdDocument,
	MatchEvent,
	MatchEventType,
	MatchTier,
	ResolutionStatus,
	ReviewFilters,
	ReviewRow,
	ReviewState,
	TieredMatch,
} from "../types";
import type { SqlDatabase, SqlValue } from "./sqlite";

function nowIso(): string {
	return new Date().toISOString();
}

/** All fields for one append-only match_events row. */
interface MatchEventInput {
	readonly matchId: string | null;
	readonly customerId: string;
	readonly ofacEntityId: string;
	readonly eventType: MatchEventType;
	readonly fromStatus: string | null;
	readonly toStatus: string | null;
	readonly reviewerId: string | null;
	readonly notes: string | null;
	readonly at: string;
}

/** Append one audit event. Lifecycle writes are INSERT-only; explicit customer
 * deletion erases that customer's ledger as part of the privacy boundary. */
function appendEvent(db: SqlDatabase, event: MatchEventInput): void {
	db.exec(
		`INSERT INTO match_events (event_id, match_id, customer_id, ofac_entity_id,
		   event_type, from_status, to_status, reviewer_id, notes, at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			crypto.randomUUID(),
			event.matchId,
			event.customerId,
			event.ofacEntityId,
			event.eventType,
			event.fromStatus,
			event.toStatus,
			event.reviewerId,
			event.notes,
			event.at,
		],
	);
}

function asString(value: SqlValue | undefined): string {
	if (typeof value !== "string") {
		throw new Error(`expected string column, got ${typeof value}`);
	}
	return value;
}

function asNullableString(value: SqlValue | undefined): string | null {
	return typeof value === "string" ? value : null;
}

function asNumber(value: SqlValue | undefined): number {
	if (typeof value !== "number") {
		throw new Error(`expected numeric column, got ${typeof value}`);
	}
	return value;
}

function toCustomerRow(record: Record<string, SqlValue>): CustomerRow {
	return {
		customer_id: asString(record.customer_id),
		customer_reference: asString(record.customer_reference),
		name: asString(record.name),
		country: asNullableString(record.country),
		dob: asNullableString(record.dob),
		onboarding_status: asString(record.onboarding_status),
		kyc_risk_rating: asNullableString(record.kyc_risk_rating),
		id_documents: JSON.parse(asString(record.id_documents)) as IdDocument[],
		onboarded_by: asString(record.onboarded_by),
		screened_at: asNullableString(record.screened_at),
		screened_list_version: asNullableString(record.screened_list_version),
		created_at: asString(record.created_at),
		updated_at: asString(record.updated_at),
	};
}

function assertReferenceFree(db: SqlDatabase, reference: string): void {
	const existing = db.selectObjects(
		"SELECT customer_id FROM customers WHERE customer_reference = ?",
		[reference],
	);
	if (existing.length > 0) {
		// Same message shape as customers/service.py:76–78.
		throw new DuplicateReferenceError(
			`customer_reference '${reference}' already exists`,
		);
	}
}

function isUniqueReferenceViolation(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.includes(
			"UNIQUE constraint failed: customers.customer_reference",
		)
	);
}

/** The current match_id for a (customer, entity) pair — null if no row exists. */
function matchIdFor(
	db: SqlDatabase,
	customerId: string,
	ofacEntityId: string,
): string | null {
	const rows = db.selectObjects(
		"SELECT match_id FROM kyc_matches WHERE customer_id = ? AND ofac_entity_id = ?",
		[customerId, ofacEntityId],
	);
	return asNullableString(rows[0]?.match_id);
}

function requireCustomer(db: SqlDatabase, customerId: string): CustomerRow {
	const row = getCustomer(db, customerId);
	if (row === null) {
		throw new NotFoundError(`customer ${customerId} not found`);
	}
	return row;
}

/** Insert a customer; PENDING_REVIEW on create (customers/service.py:108). */
export function createCustomer(
	db: SqlDatabase,
	payload: CreateCustomerPayload,
): CustomerRow {
	assertReferenceFree(db, payload.customer_reference);
	const now = nowIso();
	const customerId = crypto.randomUUID();
	try {
		db.exec(
			`INSERT INTO customers (customer_id, customer_reference, name, country, dob,
			   onboarding_status, kyc_risk_rating, id_documents, onboarded_by, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'PENDING_REVIEW', NULL, ?, ?, ?, ?)`,
			[
				customerId,
				payload.customer_reference,
				payload.name,
				payload.country ?? null,
				payload.dob ?? null,
				JSON.stringify(payload.id_documents ?? []),
				payload.onboarded_by ?? "local",
				now,
				now,
			],
		);
	} catch (error) {
		// Check-then-insert race: keep the typed contract even when the SELECT
		// guard missed — same mapping as customers/service.py _persist_customer.
		if (isUniqueReferenceViolation(error)) {
			throw new DuplicateReferenceError(
				`customer_reference '${payload.customer_reference}' already exists`,
			);
		}
		throw error;
	}
	return requireCustomer(db, customerId);
}

/** Insert a validated import batch as one SQLite transaction. */
export function createCustomers(
	db: SqlDatabase,
	payloads: ReadonlyArray<CreateCustomerPayload>,
): CustomerRow[] {
	const created: CustomerRow[] = [];
	db.transaction(() => {
		for (const payload of payloads) created.push(createCustomer(db, payload));
	});
	return created;
}

export function listCustomers(db: SqlDatabase): CustomerRow[] {
	return db
		.selectObjects(
			"SELECT * FROM customers ORDER BY created_at DESC, customer_id DESC",
		)
		.map(toCustomerRow);
}

export function getCustomer(
	db: SqlDatabase,
	customerId: string,
): CustomerRow | null {
	const rows = db.selectObjects(
		"SELECT * FROM customers WHERE customer_id = ?",
		[customerId],
	);
	const first = rows[0];
	return first === undefined ? null : toCustomerRow(first);
}

export function updateCustomer(
	db: SqlDatabase,
	customerId: string,
	patch: CustomerPatch,
): CustomerRow {
	const existing = requireCustomer(db, customerId);
	if (
		patch.customer_reference !== undefined &&
		patch.customer_reference !== existing.customer_reference
	) {
		assertReferenceFree(db, patch.customer_reference);
	}
	// The COALESCE patch is intentionally additive — it cannot null-out a set
	// column. Empty name/country strings are normalized to null ("no change").
	// A changed name or country is a new identity that was never screened, so
	// the screening proof is voided in the same statement.
	const name = blankToNull(patch.name);
	const country = blankToNull(patch.country);
	const identityChanged =
		(name !== null && name !== existing.name) ||
		(country !== null && country !== existing.country);
	db.exec(
		`UPDATE customers SET
		   onboarding_status  = COALESCE(?, onboarding_status),
		   kyc_risk_rating    = COALESCE(?, kyc_risk_rating),
		   customer_reference = COALESCE(?, customer_reference),
		   name               = COALESCE(?, name),
		   country            = COALESCE(?, country),
		   screened_at           = CASE WHEN ? THEN NULL ELSE screened_at END,
		   screened_list_version = CASE WHEN ? THEN NULL ELSE screened_list_version END,
		   updated_at         = ?
		 WHERE customer_id = ?`,
		[
			patch.onboarding_status ?? null,
			patch.kyc_risk_rating ?? null,
			patch.customer_reference ?? null,
			name,
			country,
			identityChanged ? 1 : 0,
			identityChanged ? 1 : 0,
			nowIso(),
			customerId,
		],
	);
	return requireCustomer(db, customerId);
}

/**
 * Record that a customer was just screened against the lists stamped
 * `listVersion`. Called only AFTER the screen's matches were persisted, so a
 * failed screen or a crash in between leaves the customer unproven, never
 * falsely clear.
 */
export function markScreened(
	db: SqlDatabase,
	customerId: string,
	listVersion: string,
): CustomerRow {
	requireCustomer(db, customerId);
	db.exec(
		"UPDATE customers SET screened_at = ?, screened_list_version = ? WHERE customer_id = ?",
		[nowIso(), listVersion, customerId],
	);
	return requireCustomer(db, customerId);
}

/** Trim a patch field; an empty/whitespace string means "no change" (null). */
function blankToNull(value: string | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

export function deleteCustomer(db: SqlDatabase, customerId: string): void {
	requireCustomer(db, customerId);
	db.transaction(() => {
		// match_events intentionally has no FK because SUPPRESSED events can outlive
		// a match row. Customer deletion is the privacy boundary: erase that audit
		// history (reviewer id/notes included) along with the customer + cascaded
		// matches.
		//
		// The customer goes FIRST, and that order is load-bearing, not cosmetic.
		// match_events is append-only in the database itself (schema v4), and its
		// BEFORE DELETE trigger refuses any delete whose customer still exists. So
		// the trail can only be erased in the wake of the customer it belongs to —
		// which is the guarantee we want, and it means this pair of statements is
		// the only sequence that gets through. Swap the two lines and this throws.
		db.exec("DELETE FROM customers WHERE customer_id = ?", [customerId]);
		db.exec("DELETE FROM match_events WHERE customer_id = ?", [customerId]);
	});
}

// Mirrors the validation the server applies at api/v1/review.py:148.
const RESOLUTION_PATTERN = /^(FALSE_POSITIVE|TRUE_POSITIVE|RESOLVED)$/;

const REVIEW_SELECT = `
	SELECT m.match_id, m.ofac_entity_id, m.match_score, m.match_tier,
	       m.resolution_status, m.reviewer_id, m.review_notes, m.detected_at,
	       m.reasons, m.explanation, m.sanctioned_name, m.source_list,
	       m.list_version, m.review_state,
	       c.customer_id AS customer_id,
	       c.customer_reference AS customer_reference,
	       c.name AS customer_name
	FROM kyc_matches m
	JOIN customers c ON c.customer_id = m.customer_id`;

function toReviewRow(record: Record<string, SqlValue>): ReviewRow {
	return {
		match_id: asString(record.match_id),
		ofac_entity_id: asString(record.ofac_entity_id),
		tier: asString(record.match_tier) as MatchTier,
		match_score: asNumber(record.match_score),
		resolution_status: asString(record.resolution_status) as ResolutionStatus,
		reviewer_id: asNullableString(record.reviewer_id),
		review_notes: asNullableString(record.review_notes),
		detected_at: asString(record.detected_at),
		customer_id: asString(record.customer_id),
		customer_reference: asString(record.customer_reference),
		customer_name: asString(record.customer_name),
		sanctioned_name: asString(record.sanctioned_name),
		source_list: asString(record.source_list),
		list_version: asNullableString(record.list_version),
		reasons: JSON.parse(asString(record.reasons)) as ReviewRow["reasons"],
		explanation: asString(record.explanation),
		review_state: asString(record.review_state) as ReviewState,
	};
}

/**
 * Upsert screened matches for a customer. New pairs start PENDING
 * (match_tracker.py:127); an existing pair is refreshed with the new
 * score/tier and RESET to PENDING even if previously resolved
 * (match_tracker.py:88–104). Returns the affected rows as review rows.
 */
export function recordMatches(
	db: SqlDatabase,
	customerId: string,
	matches: ReadonlyArray<TieredMatch>,
): ReviewRow[] {
	requireCustomer(db, customerId);
	const detectedAt = nowIso();
	// One screening = one atomic write: a partially persisted match set is a
	// compliance hazard, so a mid-batch failure rolls back the whole set.
	db.transaction(() => {
		for (const match of matches) {
			const matchId = crypto.randomUUID();
			db.exec(
				`INSERT INTO kyc_matches (match_id, customer_id, ofac_entity_id, match_score,
			   match_tier, list_version, sanctioned_name, source_list, reasons,
			   explanation, detected_at, resolution_status, material_fingerprint, review_state)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, 'CURRENT')
			 ON CONFLICT (customer_id, ofac_entity_id) DO UPDATE SET
			   match_score = excluded.match_score,
			   match_tier = excluded.match_tier,
			   list_version = excluded.list_version,
			   sanctioned_name = excluded.sanctioned_name,
			   source_list = excluded.source_list,
			   reasons = excluded.reasons,
			   explanation = excluded.explanation,
			   detected_at = excluded.detected_at,
			   resolution_status = 'PENDING',
			   material_fingerprint = excluded.material_fingerprint,
			   review_state = 'CURRENT'`,
				[
					matchId,
					customerId,
					match.ofac_entity_id,
					match.score,
					match.tier,
					match.list_version,
					match.sanctioned_name,
					match.source_list,
					JSON.stringify(match.reasons),
					match.explanation,
					detectedAt,
					match.material_fingerprint,
				],
			);
			// DETECTED carries the row's CURRENT match_id; on an upsert collision
			// the inserted matchId is unused, so re-read the surviving id.
			appendEvent(db, {
				matchId: matchIdFor(db, customerId, match.ofac_entity_id),
				customerId,
				ofacEntityId: match.ofac_entity_id,
				eventType: "DETECTED",
				fromStatus: null,
				toStatus: "PENDING",
				reviewerId: null,
				notes: null,
				at: detectedAt,
			});
		}
	});
	// Re-read scoped to the customer (no board pagination): the LIMIT 100
	// board query would truncate fresh lower-scored rows out of the return.
	const ids = new Set(matches.map((m) => m.ofac_entity_id));
	return db
		.selectObjects(
			`${REVIEW_SELECT} WHERE m.customer_id = ? ORDER BY m.match_score DESC`,
			[customerId],
		)
		.map(toReviewRow)
		.filter((row) => ids.has(row.ofac_entity_id));
}

/** Prior disposition fields carried forward across a replaceMatches write. */
interface PriorDisposition {
	readonly resolution_status: ResolutionStatus;
	readonly resolved_at: string | null;
	readonly reviewer_id: string | null;
	readonly review_notes: string | null;
	readonly material_fingerprint: string | null;
	readonly review_state: ReviewState;
}

/** Snapshot each existing match's disposition + fingerprint, keyed by entity id. */
function existingDispositions(
	db: SqlDatabase,
	customerId: string,
): Map<string, PriorDisposition> {
	const rows = db.selectObjects(
		`SELECT ofac_entity_id, resolution_status, resolved_at, reviewer_id,
		        review_notes, material_fingerprint, review_state
		 FROM kyc_matches WHERE customer_id = ?`,
		[customerId],
	);
	const prior = new Map<string, PriorDisposition>();
	for (const row of rows) {
		prior.set(asString(row.ofac_entity_id), {
			resolution_status: asString(row.resolution_status) as ResolutionStatus,
			resolved_at: asNullableString(row.resolved_at),
			reviewer_id: asNullableString(row.reviewer_id),
			review_notes: asNullableString(row.review_notes),
			material_fingerprint: asNullableString(row.material_fingerprint),
			review_state: asString(row.review_state) as ReviewState,
		});
	}
	return prior;
}

const FRESH_DISPOSITION: PriorDisposition = {
	resolution_status: "PENDING",
	resolved_at: null,
	reviewer_id: null,
	review_notes: null,
	material_fingerprint: null,
	review_state: "CURRENT",
};

/**
 * Decide the carried disposition + the event (if any) for one replaced match.
 * Branches on the prior fingerprint (spec §6):
 *  - no prior            -> PENDING/CURRENT,  emit DETECTED
 *  - unchanged           -> carry forward,    suppress (no event)
 *  - changed             -> carry disposition, review_state=CHANGED, emit CHANGED
 *  - prior fp was NULL    -> adopt silently,   no event (first-time backfill)
 */
function planReplacement(
	prior: PriorDisposition | undefined,
	fingerprint: string,
): {
	readonly carried: PriorDisposition;
	readonly event: MatchEventType | null;
} {
	if (prior === undefined) {
		return {
			carried: { ...FRESH_DISPOSITION, material_fingerprint: fingerprint },
			event: "DETECTED",
		};
	}
	const base = { ...prior, material_fingerprint: fingerprint };
	if (prior.material_fingerprint === null) {
		return {
			carried: { ...base, review_state: prior.review_state },
			event: null,
		};
	}
	if (prior.material_fingerprint === fingerprint) {
		return { carried: prior, event: null };
	}
	return { carried: { ...base, review_state: "CHANGED" }, event: "CHANGED" };
}

/** Insert one replaced match with its carried disposition + fingerprint. */
function insertReplacedRow(
	db: SqlDatabase,
	customerId: string,
	match: TieredMatch,
	detectedAt: string,
	carried: PriorDisposition,
	matchId: string,
): void {
	db.exec(
		`INSERT INTO kyc_matches (match_id, customer_id, ofac_entity_id, match_score,
		   match_tier, list_version, sanctioned_name, source_list, reasons,
		   explanation, detected_at, resolution_status, resolved_at, reviewer_id,
		   review_notes, material_fingerprint, review_state)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			matchId,
			customerId,
			match.ofac_entity_id,
			match.score,
			match.tier,
			match.list_version,
			match.sanctioned_name,
			match.source_list,
			JSON.stringify(match.reasons),
			match.explanation,
			detectedAt,
			carried.resolution_status,
			carried.resolved_at,
			carried.reviewer_id,
			carried.review_notes,
			carried.material_fingerprint,
			carried.review_state,
		],
	);
}

/** Insert one replaced match and append its lifecycle event per planReplacement. */
function insertReplacedMatch(
	db: SqlDatabase,
	customerId: string,
	match: TieredMatch,
	detectedAt: string,
	prior: PriorDisposition | undefined,
): void {
	const { carried, event } = planReplacement(prior, match.material_fingerprint);
	const matchId = crypto.randomUUID();
	insertReplacedRow(db, customerId, match, detectedAt, carried, matchId);
	if (event !== null) {
		appendEvent(db, {
			matchId,
			customerId,
			ofacEntityId: match.ofac_entity_id,
			eventType: event,
			fromStatus: prior?.resolution_status ?? null,
			toStatus: carried.resolution_status,
			reviewerId: null,
			notes: null,
			at: detectedAt,
		});
	}
}

/** Emit a SUPPRESSED event for each prior entity absent from the new set. */
function emitSuppressions(
	db: SqlDatabase,
	customerId: string,
	prior: Map<string, PriorDisposition>,
	next: ReadonlySet<string>,
	at: string,
): void {
	for (const [entityId, disposition] of prior) {
		if (next.has(entityId)) {
			continue;
		}
		appendEvent(db, {
			matchId: null,
			customerId,
			ofacEntityId: entityId,
			eventType: "SUPPRESSED",
			fromStatus: disposition.resolution_status,
			toStatus: null,
			reviewerId: null,
			notes: null,
			at,
		});
	}
}

/**
 * Authoritative "this is the customer's complete current match set" write —
 * the rescan primitive. In ONE transaction: snapshot prior dispositions,
 * DELETE every existing match for the customer, then INSERT the new set,
 * carrying forward `resolution_status`/`resolved_at`/`reviewer_id`/`review_notes`
 * for any entity that still matches (a still-matching, previously-resolved hit
 * keeps its disposition — unlike recordMatches, which resets to PENDING).
 * Entities absent from the new set are cleared by the DELETE. Atomic: a
 * mid-batch failure rolls back the whole replacement.
 */
export function replaceMatches(
	db: SqlDatabase,
	customerId: string,
	matches: ReadonlyArray<TieredMatch>,
): ReviewRow[] {
	requireCustomer(db, customerId);
	const detectedAt = nowIso();
	const nextEntities = new Set(matches.map((m) => m.ofac_entity_id));
	db.transaction(() => {
		const prior = existingDispositions(db, customerId);
		db.exec("DELETE FROM kyc_matches WHERE customer_id = ?", [customerId]);
		for (const match of matches) {
			insertReplacedMatch(
				db,
				customerId,
				match,
				detectedAt,
				prior.get(match.ofac_entity_id),
			);
		}
		// Prior entities that dropped out of the new set are SUPPRESSED.
		emitSuppressions(db, customerId, prior, nextEntities, detectedAt);
	});
	return db
		.selectObjects(
			`${REVIEW_SELECT} WHERE m.customer_id = ? ORDER BY m.match_score DESC`,
			[customerId],
		)
		.map(toReviewRow);
}

/** Review-board rows: a plain JOIN suffices locally (no entity fan-out). */
export function listReviewMatches(
	db: SqlDatabase,
	filters: ReviewFilters,
): ReviewRow[] {
	const clauses: string[] = [];
	const bind: SqlValue[] = [];
	if (filters.tier !== undefined) {
		clauses.push("m.match_tier = ?");
		bind.push(filters.tier);
	}
	if (filters.resolutionStatus !== undefined) {
		clauses.push("m.resolution_status = ?");
		bind.push(filters.resolutionStatus);
	}
	if (filters.reviewState !== undefined) {
		clauses.push("m.review_state = ?");
		bind.push(filters.reviewState);
	}
	if (filters.needsReview === true) {
		// Needs attention: still PENDING OR materially CHANGED since disposition.
		clauses.push(
			"(m.resolution_status = 'PENDING' OR m.review_state = 'CHANGED')",
		);
	}
	const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
	// Strongest first, paginated — mirrors review.py:139.
	bind.push(filters.limit ?? 100, filters.offset ?? 0);
	return db
		.selectObjects(
			`${REVIEW_SELECT}${where} ORDER BY m.match_score DESC LIMIT ? OFFSET ?`,
			bind,
		)
		.map(toReviewRow);
}

function reviewRowById(db: SqlDatabase, matchId: string): ReviewRow {
	const rows = db
		.selectObjects(`${REVIEW_SELECT} WHERE m.match_id = ?`, [matchId])
		.map(toReviewRow);
	const first = rows[0];
	if (first === undefined) {
		throw new NotFoundError(`match ${matchId} not found`);
	}
	return first;
}

/**
 * Resolve a match — the OBSERVED backend contract, ported as-is:
 * regex-validated resolution (review.py:148), unconditional overwrite of
 * status + resolved_at, reviewer/notes only overwritten when provided
 * (match_tracker.py:251–266). No PENDING-only transition guard exists
 * on either side.
 */
export function resolveMatch(
	db: SqlDatabase,
	matchId: string,
	resolution: string,
	reviewerId?: string,
	notes?: string,
): ReviewRow {
	if (!RESOLUTION_PATTERN.test(resolution)) {
		throw new InvalidResolutionError(
			`invalid resolution_status '${resolution}'`,
		);
	}
	// Read BEFORE the UPDATE so the event records the true prior status.
	const before = reviewRowById(db, matchId);
	const at = nowIso();
	// Re-dispositioning a CHANGED match clears the re-review flag (CURRENT): the
	// reviewer has now looked at the changed facts.
	db.exec(
		`UPDATE kyc_matches SET
		   resolution_status = ?,
		   resolved_at = ?,
		   reviewer_id = COALESCE(?, reviewer_id),
		   review_notes = COALESCE(?, review_notes),
		   review_state = 'CURRENT'
		 WHERE match_id = ?`,
		[resolution, at, reviewerId ?? null, notes ?? null, matchId],
	);
	appendEvent(db, {
		matchId,
		customerId: before.customer_id,
		ofacEntityId: before.ofac_entity_id,
		eventType: resolution === "PENDING" ? "REOPENED" : "DISPOSITIONED",
		fromStatus: before.resolution_status,
		toStatus: resolution,
		reviewerId: reviewerId ?? null,
		notes: notes ?? null,
		at,
	});
	return reviewRowById(db, matchId);
}

/** The append-only audit trail for a match, surviving match_id rotation. */
export function getMatchEvents(
	db: SqlDatabase,
	matchId: string,
): ReadonlyArray<MatchEvent> {
	// Resolve the (customer, entity) pair from the current row so history before
	// a replaceMatches rotation (recorded against the now-deleted match_id) is
	// still returned. If the row is gone, fall back to match_id-only lookup.
	const pair = db.selectObjects(
		"SELECT customer_id, ofac_entity_id FROM kyc_matches WHERE match_id = ?",
		[matchId],
	)[0];
	const rows =
		pair === undefined
			? db.selectObjects(
					"SELECT * FROM match_events WHERE match_id = ? ORDER BY at, rowid",
					[matchId],
				)
			: db.selectObjects(
					`SELECT * FROM match_events
					 WHERE match_id = ? OR (customer_id = ? AND ofac_entity_id = ?)
					 ORDER BY at, rowid`,
					[matchId, asString(pair.customer_id), asString(pair.ofac_entity_id)],
				);
	return rows.map(toMatchEvent);
}

function toMatchEvent(record: Record<string, SqlValue>): MatchEvent {
	return {
		event_id: asString(record.event_id),
		match_id: asNullableString(record.match_id),
		customer_id: asString(record.customer_id),
		ofac_entity_id: asString(record.ofac_entity_id),
		event_type: asString(record.event_type) as MatchEventType,
		from_status: asNullableString(record.from_status),
		to_status: asNullableString(record.to_status),
		reviewer_id: asNullableString(record.reviewer_id),
		notes: asNullableString(record.notes),
		at: asString(record.at),
	};
}

export function getSetting(db: SqlDatabase, key: string): string | null {
	const rows = db.selectObjects("SELECT value FROM settings WHERE key = ?", [
		key,
	]);
	return asNullableString(rows[0]?.value);
}

export function setSetting(db: SqlDatabase, key: string, value: string): void {
	db.exec(
		"INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
		[key, value],
	);
}
