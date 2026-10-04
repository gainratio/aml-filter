/**
 * Shared client-surface types for AML-Filter.
 *
 * This module is types-only at the wire level: there is NO server and NO
 * axios. It declares the `ApiClient` method surface (the contract every page
 * compiles against), the data interfaces that flow across that surface, and
 * the single LOCAL-FIRST runtime singleton (`apiClient` = `LocalApiClient`,
 * all I/O in-tab via SQLite-WASM/OPFS + the signed-bundle screening engine).
 *
 * The surface is the live customers + review slice only — the local-first
 * tier ships exactly those two tiers, so dead server-era methods (search,
 * api-keys, lists, whitelist, SAR, attestations) and their wire types have
 * been pruned.
 */

import type {
	CreateCustomerPayload,
	RescanSummary,
	ScreeningConfig,
} from "@amlfilter/workstation";
import { LocalApiClient } from "./localApi";
import { workstationProvider } from "./workstation";

/**
 * The shared client surface. `LocalApiClient` implements
 * `Pick<ApiClient, keyof ApiClient>`, so every method here must keep its name
 * for that constraint to hold. Method bodies live in `LocalApiClient`; this is
 * the type contract only (no axios, no transport).
 */
export interface ApiClient {
	// Auth machinery: inert in the local-first app (kept so the surface stays
	// stable; nothing calls these once /login is unrouted).
	setApiKey(apiKey: string): void;
	clearApiKey(): void;

	// KYC customer onboarding (the customers tier)
	onboardCustomer(
		payload: CustomerOnboardRequest,
	): Promise<CustomerOnboardResponse>;
	listCustomers(params?: CustomerListParams): Promise<CustomerResponse[]>;
	importCustomers(
		payloads: ReadonlyArray<CreateCustomerPayload>,
	): Promise<CustomerImportResponse>;
	getCustomer(customerId: string): Promise<CustomerResponse>;
	updateCustomer(
		customerId: string,
		payload: CustomerUpdateRequest,
	): Promise<CustomerResponse>;
	deleteCustomer(customerId: string): Promise<void>;

	// Review / case board (the review tier)
	listReviewMatches(params?: ReviewMatchListParams): Promise<ReviewMatch[]>;
	resolveReviewMatch(
		matchId: string,
		resolution_status: ReviewResolutionStatus,
		body?: ReviewResolveBody,
	): Promise<ReviewMatch>;
	/** The append-only audit trail for a match, oldest-first. */
	getMatchEvents(matchId: string): Promise<MatchEvent[]>;

	// Screening-config tier: getScreeningConfig reads the persisted sensitivity;
	// setScreeningConfig persists it THEN re-screens every customer (returns the
	// rescan summary). It is a no-op — no persist, no rescan — when unchanged.
	getScreeningConfig(): Promise<ScreeningConfig>;
	setScreeningConfig(config: ScreeningConfig): Promise<RescanSummary>;
}

// ---------------------------------------------------------------------------
// KYC customer onboarding (the customers tier)
// ---------------------------------------------------------------------------

export type OnboardingStatus =
	| "DRAFT"
	| "PENDING_REVIEW"
	| "ACTIVE"
	| "REJECTED";

export type KycRiskRating = "LOW" | "MEDIUM" | "HIGH";

/** A single identity document supplied during onboarding. */
export interface IdDocument {
	doc_type: string;
	number: string;
	issuing_country: string; // ISO2
	expiry?: string | null; // YYYY-MM-DD
}

export interface CustomerOnboardRequest {
	customer_reference: string;
	name: string;
	onboarded_by?: string;
	country?: string; // ISO2
	dob?: string; // ISO date YYYY-MM-DD; omitted when not supplied
	id_documents?: IdDocument[];
}

export interface CustomerUpdateRequest {
	onboarding_status?: OnboardingStatus;
	kyc_risk_rating?: KycRiskRating;
	customer_reference?: string;
	name?: string;
	country?: string;
}

export interface CustomerResponse {
	customer_id: string;
	tenant_id: string;
	customer_reference: string;
	name: string;
	country: string | null;
	dob: string | null;
	onboarding_status: string;
	kyc_risk_rating: string | null;
	id_documents: IdDocument[];
	onboarded_by: string;
	screening_entity_id: string | null;
	/** When the customer was last screened; null = never, or its identity changed. */
	screened_at: string | null;
	/** Stamp of the lists that screen ran against; must equal the loaded lists
	 * before the customer may read "No matches". */
	screened_list_version: string | null;
	created_at: string;
	updated_at: string;
}

export interface CustomerImportResponse {
	customers: CustomerResponse[];
	screening: RescanSummary | null;
}

/** Onboarding response: the customer plus any sanctions matches found. */
export interface CustomerOnboardResponse extends CustomerResponse {
	match_entity_ids: string[];
}

export interface CustomerListParams {
	limit?: number;
	offset?: number;
}

// ---------------------------------------------------------------------------
// Review / case board (the review tier)
// ---------------------------------------------------------------------------

/** Match-strength tier — STRONG is the highest-confidence sanctions hit. */
export type MatchTier = "STRONG" | "POSSIBLE" | "WEAK";

/** Disposition lifecycle for a review-board match. */
export type ReviewResolutionStatus =
	| "PENDING"
	| "TRUE_POSITIVE"
	| "FALSE_POSITIVE"
	| "RESOLVED";

/** A disposition a reviewer can apply (every status except PENDING). */
export type ReviewDisposition = Exclude<ReviewResolutionStatus, "PENDING">;

/**
 * Whether a match still reflects the facts a reviewer last saw. CURRENT = the
 * disposition (if any) is still valid; CHANGED = the watchlist entity moved
 * materially since it was last dispositioned and needs a fresh look.
 */
type ReviewState = "CURRENT" | "CHANGED";

/** The lifecycle event types recorded on a match's append-only audit trail. */
type MatchEventType =
	| "DETECTED"
	| "DISPOSITIONED"
	| "REOPENED"
	| "CHANGED"
	| "SUPPRESSED";

/**
 * One append-only audit entry on a match's lifecycle (a match_events row). The
 * history survives match_id rotation, so the full story of a screened pair is
 * preserved even when its underlying match row is replaced by a rescan.
 */
export interface MatchEvent {
	event_id: string;
	match_id: string | null; // null for SUPPRESSED
	customer_id: string;
	ofac_entity_id: string;
	event_type: MatchEventType;
	from_status: string | null;
	to_status: string | null;
	reviewer_id: string | null;
	notes: string | null;
	at: string; // ISO-8601
}

/** An enriched sanctions match awaiting / under analyst review. */
export interface ReviewMatch {
	match_id: string;
	tier: MatchTier;
	match_score: number;
	match_type: string;
	resolution_status: ReviewResolutionStatus;
	reviewer_id: string | null;
	review_notes: string | null;
	detected_at: string;
	customer_id: string | null;
	customer_reference: string | null;
	customer_name: string | null;
	sanctioned_name: string;
	source_list: string;
	review_state: ReviewState;
}

export interface ReviewMatchListParams {
	tier?: MatchTier;
	resolution_status?: ReviewResolutionStatus;
	reviewState?: ReviewState;
	needsReview?: boolean; // PENDING OR CHANGED
	limit?: number;
	offset?: number;
}

export interface ReviewResolveBody {
	reviewer_id?: string;
	review_notes?: string;
}

// The app is LOCAL-FIRST: the singleton every page calls is the
// LocalApiClient — all KYC I/O stays in the tab (SQLite-WASM/OPFS + the
// signed-bundle screening engine). `ApiClient` above is the shared TYPE
// surface it satisfies; there is no server-tier transport in this app.
export const apiClient = new LocalApiClient(workstationProvider);
