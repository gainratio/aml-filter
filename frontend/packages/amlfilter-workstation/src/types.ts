// The KYC workstation domain contract. Field names mirror the verified backend
// rows (db/models.py Customer + WhitelistBlacklistMatch and api/v1/review.py's
// ReviewMatchRow) so the local tier and the server tier stay one product.

/**
 * Review tier for a match, ordered by descending strength (scoring/tiers.py:20).
 * Defined ONCE in @amlfilter/browser (its signed score receipt stamps a tier)
 * and re-exported here, so the two tiers cannot drift apart.
 */
import type { MatchTier } from "@amlfilter/browser";

export type { MatchTier };

/**
 * Whether a match still reflects the facts a reviewer last saw. CURRENT = the
 * disposition (if any) is still valid; CHANGED = the watchlist entity moved
 * materially since it was last dispositioned and needs a fresh look. Set by
 * replaceMatches on a fingerprint change; reset to CURRENT on re-disposition.
 */
export type ReviewState = "CURRENT" | "CHANGED";

/**
 * One append-only audit entry on a match's lifecycle. Lifecycle operations never
 * rewrite history, so a screened pair survives match-row rotation. Explicit
 * customer deletion erases the customer's events as the privacy boundary.
 */
export type MatchEventType =
	| "DETECTED"
	| "DISPOSITIONED"
	| "REOPENED"
	| "CHANGED"
	| "SUPPRESSED";

/** A single append-only match-lifecycle event (match_events row). */
export interface MatchEvent {
	readonly event_id: string;
	/** The match row this event was recorded against; null for SUPPRESSED. */
	readonly match_id: string | null;
	readonly customer_id: string;
	readonly ofac_entity_id: string;
	readonly event_type: MatchEventType;
	readonly from_status: string | null;
	readonly to_status: string | null;
	readonly reviewer_id: string | null;
	readonly notes: string | null;
	/** ISO-8601 timestamp. */
	readonly at: string;
}

/** Disposition lifecycle (db/models.py:336 column comment). */
export type ResolutionStatus =
	| "PENDING"
	| "FALSE_POSITIVE"
	| "TRUE_POSITIVE"
	| "RESOLVED";

/** One identity document supplied during onboarding (api/v1/customers.py). */
export interface IdDocument {
	readonly doc_type: string;
	readonly number: string;
	readonly issuing_country: string;
	readonly expiry?: string | null;
}

/** A persisted KYC customer (local mirror of backend `customers`). */
export interface CustomerRow {
	readonly customer_id: string;
	readonly customer_reference: string;
	readonly name: string;
	readonly country: string | null;
	/** ISO date string (YYYY-MM-DD), or null when not supplied. */
	readonly dob: string | null;
	readonly onboarding_status: string;
	readonly kyc_risk_rating: string | null;
	readonly id_documents: ReadonlyArray<IdDocument>;
	readonly onboarded_by: string;
	/** When the customer was last screened; null = never (or identity changed since). */
	readonly screened_at: string | null;
	/** Composite stamp of the lists that screen ran against; null = unproven. */
	readonly screened_list_version: string | null;
	readonly created_at: string;
	readonly updated_at: string;
}

/** Payload to insert a customer row (dup-rejection on customer_reference). */
export interface CreateCustomerPayload {
	readonly customer_reference: string;
	readonly name: string;
	readonly country?: string | null;
	/** ISO date string (YYYY-MM-DD), or null/absent when not supplied. */
	readonly dob?: string | null;
	readonly onboarded_by?: string;
	readonly id_documents?: ReadonlyArray<IdDocument>;
}

/** Partial customer update (mirrors CustomerUpdateRequest in app api.ts). */
export interface CustomerPatch {
	readonly onboarding_status?: string;
	readonly kyc_risk_rating?: string;
	readonly customer_reference?: string;
	/** Screened identity name. Empty string is treated as "no change". */
	readonly name?: string;
	/** ISO2 country. Empty string is treated as "no change". */
	readonly country?: string;
}

/** One explanation reason — same shape as @amlfilter/browser MatchReason. */
export interface MatchReasonJson {
	readonly signal: string;
	readonly value: number | string;
	readonly weight: number | null;
	readonly contribution: number | null;
	readonly description: string | null;
}

/** A screened + tiered match, ready to persist for the review board. */
export interface TieredMatch {
	readonly ofac_entity_id: string;
	readonly score: number;
	readonly tier: MatchTier;
	readonly sanctioned_name: string;
	readonly source_list: string;
	readonly list_version: string | null;
	readonly reasons: ReadonlyArray<MatchReasonJson>;
	readonly explanation: string;
	/**
	 * Stable hash of the screened identity pair (customer profile + entity
	 * identity-bearing fields). Lets a rescan tell "the same hit, re-seen" from
	 * "the hit materially changed" so a reviewer's disposition is only
	 * re-surfaced when the underlying facts actually moved. See fingerprint.ts.
	 */
	readonly material_fingerprint: string;
}

/** A review-board row: match + denormalized customer fields (review.py:31). */
export interface ReviewRow {
	readonly match_id: string;
	readonly ofac_entity_id: string;
	readonly tier: MatchTier;
	readonly match_score: number;
	readonly resolution_status: ResolutionStatus;
	readonly reviewer_id: string | null;
	readonly review_notes: string | null;
	readonly detected_at: string;
	readonly customer_id: string;
	readonly customer_reference: string;
	readonly customer_name: string;
	readonly sanctioned_name: string;
	readonly source_list: string;
	readonly list_version: string | null;
	readonly reasons: ReadonlyArray<MatchReasonJson>;
	readonly explanation: string;
	/** Whether this match changed materially since it was last dispositioned. */
	readonly review_state: ReviewState;
}

/** Review-board filters (review.py:128–139 query params, camelCased). */
export interface ReviewFilters {
	readonly tier?: MatchTier;
	readonly resolutionStatus?: ResolutionStatus;
	/** Filter to matches in a given review state (CURRENT vs CHANGED). */
	readonly reviewState?: ReviewState;
	/**
	 * When true, return only matches that need attention: still PENDING OR
	 * materially CHANGED since their last disposition.
	 */
	readonly needsReview?: boolean;
	readonly limit?: number;
	readonly offset?: number;
}

/**
 * The persistence surface the main thread sees. `DbClient` implements it over
 * the DB worker; unit tests fake it in-memory.
 */
export interface WorkstationStore {
	open(): Promise<number>;
	createCustomer(payload: CreateCustomerPayload): Promise<CustomerRow>;
	/** Optional atomic bulk insert used by the customer spreadsheet importer. */
	createCustomers?(
		payloads: ReadonlyArray<CreateCustomerPayload>,
	): Promise<ReadonlyArray<CustomerRow>>;
	listCustomers(): Promise<ReadonlyArray<CustomerRow>>;
	getCustomer(customerId: string): Promise<CustomerRow | null>;
	updateCustomer(
		customerId: string,
		patch: CustomerPatch,
	): Promise<CustomerRow>;
	deleteCustomer(customerId: string): Promise<void>;
	recordMatches(
		customerId: string,
		matches: ReadonlyArray<TieredMatch>,
	): Promise<ReadonlyArray<ReviewRow>>;
	replaceMatches(
		customerId: string,
		matches: ReadonlyArray<TieredMatch>,
	): Promise<ReadonlyArray<ReviewRow>>;
	/** Record a completed screen against the lists stamped `listVersion`. */
	markScreened(customerId: string, listVersion: string): Promise<CustomerRow>;
	listReviewMatches(filters: ReviewFilters): Promise<ReadonlyArray<ReviewRow>>;
	resolveMatch(
		matchId: string,
		resolution: string,
		reviewerId?: string,
		notes?: string,
	): Promise<ReviewRow>;
	/**
	 * The append-only-during-lifecycle audit trail for a match, ordered oldest-first. History
	 * survives match_id rotation: events are found by the current match_id OR by
	 * the (customer_id, ofac_entity_id) pair, so a replaceMatches that re-issues
	 * the row does not orphan its prior events.
	 */
	getMatchEvents(matchId: string): Promise<ReadonlyArray<MatchEvent>>;
	getSetting(key: string): Promise<string | null>;
	setSetting(key: string, value: string): Promise<void>;
}
