/**
 * LocalApiClient — the local-first implementation of the ApiClient surface.
 * The slice methods (customers, review) are real and backed by
 * @amlfilter/workstation; the app ships exactly those two tiers. Pages compile
 * against the same singleton shape: the class
 * `implements Pick<ApiClient, keyof ApiClient>` (the public surface).
 */

import type {
	CreateCustomerPayload,
	CustomerRow,
	LocalMatchTracker,
	LocalOnboardingService,
	MatchEvent,
	RescanService,
	RescanSummary,
	ReviewRow,
	ScreeningConfig,
	WorkstationStore,
} from "@amlfilter/workstation";
import {
	loadScreeningConfig,
	saveScreeningConfig,
} from "@amlfilter/workstation";
import type {
	ApiClient,
	CustomerImportResponse,
	CustomerListParams,
	CustomerOnboardRequest,
	CustomerOnboardResponse,
	CustomerResponse,
	CustomerUpdateRequest,
	ReviewMatch,
	ReviewMatchListParams,
	ReviewResolutionStatus,
	ReviewResolveBody,
} from "./api";

/** The booted local tier the client runs on (built by lib/workstation.ts). */
export interface WorkstationServices {
	readonly store: WorkstationStore;
	readonly onboarding: LocalOnboardingService;
	readonly tracker: LocalMatchTracker;
	readonly rescan: RescanService;
}

/** Lazy provider — construction stays side-effect free (no Worker spawn). */
export type WorkstationProvider = () => Promise<WorkstationServices>;

const LOCAL_TENANT = "local";

function toCustomerResponse(row: CustomerRow): CustomerResponse {
	return {
		customer_id: row.customer_id,
		tenant_id: LOCAL_TENANT,
		customer_reference: row.customer_reference,
		name: row.name,
		country: row.country,
		dob: row.dob,
		onboarding_status: row.onboarding_status,
		kyc_risk_rating: row.kyc_risk_rating,
		id_documents: [...row.id_documents],
		onboarded_by: row.onboarded_by,
		// No WHITELIST Entity rows exist locally (the only entity store is the
		// read-only signed bundle), so there is no screening_entity_id.
		screening_entity_id: null,
		screened_at: row.screened_at,
		screened_list_version: row.screened_list_version,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

function toReviewMatch(row: ReviewRow): ReviewMatch {
	return {
		match_id: row.match_id,
		tier: row.tier,
		match_score: row.match_score,
		// Constant locally — mirrors the match_type onboarding records.
		match_type: "WHITELIST_VS_BLACKLIST",
		// ResolutionStatus (workstation) and ReviewResolutionStatus (app types)
		// are structurally identical unions that must stay in lockstep.
		resolution_status: row.resolution_status,
		reviewer_id: row.reviewer_id,
		review_notes: row.review_notes,
		detected_at: row.detected_at,
		customer_id: row.customer_id,
		customer_reference: row.customer_reference,
		customer_name: row.customer_name,
		sanctioned_name: row.sanctioned_name,
		source_list: row.source_list,
		review_state: row.review_state,
	};
}

/** Deep-equal two screening configs: same sensitivity and same overrides. */
function configsEqual(a: ScreeningConfig, b: ScreeningConfig): boolean {
	if (a.sensitivity !== b.sensitivity) {
		return false;
	}
	const aKeys = Object.keys(a.overrides);
	const bKeys = Object.keys(b.overrides);
	if (aKeys.length !== bKeys.length) {
		return false;
	}
	return aKeys.every((key) => a.overrides[key] === b.overrides[key]);
}

export class LocalApiClient implements Pick<ApiClient, keyof ApiClient> {
	readonly #services: WorkstationProvider;

	public constructor(services: WorkstationProvider) {
		this.#services = services;
	}

	// --- auth machinery: removed in the local-first app; kept inert so the
	// surface stays identical (nothing calls these once /login is unrouted) ---
	public setApiKey(_apiKey: string): void {}

	public clearApiKey(): void {}

	// --- slice: KYC customers ------------------------------------------------
	public async onboardCustomer(
		payload: CustomerOnboardRequest,
	): Promise<CustomerOnboardResponse> {
		const { onboarding } = await this.#services();
		const result = await onboarding.onboard({
			customer_reference: payload.customer_reference,
			name: payload.name,
			...(payload.onboarded_by !== undefined
				? { onboarded_by: payload.onboarded_by }
				: {}),
			country: payload.country ?? null,
			dob: payload.dob ?? null,
			id_documents: payload.id_documents ?? [],
		});
		return {
			...toCustomerResponse(result.customer),
			match_entity_ids: result.matches.map((m) => m.ofac_entity_id),
		};
	}

	public async listCustomers(
		_params?: CustomerListParams,
	): Promise<CustomerResponse[]> {
		const { store } = await this.#services();
		return (await store.listCustomers()).map(toCustomerResponse);
	}

	public async importCustomers(
		payloads: ReadonlyArray<CreateCustomerPayload>,
	): Promise<CustomerImportResponse> {
		const { store, rescan } = await this.#services();
		if (store.createCustomers === undefined) {
			throw new Error("Atomic customer import is unavailable");
		}
		const rows = await store.createCustomers(payloads);
		let screening: RescanSummary | null = null;
		try {
			screening = await rescan.rescanAll();
		} catch {
			// The customer transaction is still durable; the UI reports that
			// screening remains pending rather than pretending a rollback occurred.
		}
		return { customers: rows.map(toCustomerResponse), screening };
	}

	public async getCustomer(customerId: string): Promise<CustomerResponse> {
		const { store } = await this.#services();
		const row = await store.getCustomer(customerId);
		if (row === null) {
			throw new Error(`Customer ${customerId} not found`);
		}
		return toCustomerResponse(row);
	}

	public async updateCustomer(
		customerId: string,
		payload: CustomerUpdateRequest,
	): Promise<CustomerResponse> {
		const { store } = await this.#services();
		return toCustomerResponse(await store.updateCustomer(customerId, payload));
	}

	public async deleteCustomer(customerId: string): Promise<void> {
		const { store } = await this.#services();
		await store.deleteCustomer(customerId);
	}

	// --- slice: review board ---------------------------------------------------
	public async listReviewMatches(
		params?: ReviewMatchListParams,
	): Promise<ReviewMatch[]> {
		const { store } = await this.#services();
		const rows = await store.listReviewMatches({
			...(params?.tier !== undefined ? { tier: params.tier } : {}),
			...(params?.resolution_status !== undefined
				? { resolutionStatus: params.resolution_status }
				: {}),
			...(params?.reviewState !== undefined
				? { reviewState: params.reviewState }
				: {}),
			...(params?.needsReview !== undefined
				? { needsReview: params.needsReview }
				: {}),
			...(params?.limit !== undefined ? { limit: params.limit } : {}),
			...(params?.offset !== undefined ? { offset: params.offset } : {}),
		});
		return rows.map(toReviewMatch);
	}

	public async resolveReviewMatch(
		matchId: string,
		resolution_status: ReviewResolutionStatus,
		body?: ReviewResolveBody,
	): Promise<ReviewMatch> {
		const { tracker } = await this.#services();
		const row = await tracker.resolve(matchId, resolution_status, {
			...(body?.reviewer_id !== undefined
				? { reviewerId: body.reviewer_id }
				: {}),
			...(body?.review_notes !== undefined ? { notes: body.review_notes } : {}),
		});
		return toReviewMatch(row);
	}

	public async getMatchEvents(matchId: string): Promise<MatchEvent[]> {
		const { store } = await this.#services();
		return [...(await store.getMatchEvents(matchId))];
	}

	// --- slice: screening config ---------------------------------------------
	public async getScreeningConfig(): Promise<ScreeningConfig> {
		const { store } = await this.#services();
		return loadScreeningConfig(store);
	}

	public async setScreeningConfig(
		config: ScreeningConfig,
	): Promise<RescanSummary> {
		const { store, rescan } = await this.#services();
		// Only re-screen if the config actually changed: persist + rescan are
		// expensive, so an idempotent save is a clean no-op.
		if (configsEqual(await loadScreeningConfig(store), config)) {
			return { customersScanned: 0, newHits: 0, clearedHits: 0 };
		}
		await saveScreeningConfig(store, config);
		return rescan.rescanAll();
	}
}
