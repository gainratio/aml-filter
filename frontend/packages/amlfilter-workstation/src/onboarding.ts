// LocalOnboardingService — the browser port of backend customers/service.py
// OnboardingService, re-shaped for the two-store architecture (D4): the
// customer row goes to SQLite via the store; the screen runs on the existing
// signed-bundle engine; tiered matches are persisted back to SQLite.

import type { ScreenQuery, ScreenResponse } from "@amlfilter/browser";
import { loadScreeningConfig, resolveThreshold } from "./screening_config";
import { canonicalProfile, tierMatch } from "./tier_match";
import type {
	CustomerRow,
	IdDocument,
	ReviewRow,
	WorkstationStore,
} from "./types";

/** Score floor for onboarding screens (customers/service.py:31). */
// The literal fallback default — used only when no screening config is set.
// Deliberately below the POSSIBLE tier boundary: onboarding records WEAK-tier matches too.
export const ONBOARDING_THRESHOLD = 0.65;

/** The screen surface the service needs — ScreeningEngine satisfies it. */
export interface NameScreener {
	screen(query: ScreenQuery): Promise<ScreenResponse>;
	/**
	 * The composite stamp of the lists the engine has loaded, read right after a
	 * screen. It is what a customer's screening proof records; absent or null
	 * means the screen proves nothing about which lists it ran against.
	 */
	listVersion?(): string | null;
}

/**
 * Record positive proof of a completed screen. Call only AFTER the screen's
 * matches are stored, so any failure on the way leaves the customer unproven.
 */
export async function markScreenedWith(
	store: WorkstationStore,
	customerId: string,
	listVersion: string | null,
): Promise<void> {
	if (listVersion !== null) {
		await store.markScreened(customerId, listVersion);
	}
}

export interface OnboardRequest {
	readonly customer_reference: string;
	readonly name: string;
	readonly onboarded_by?: string;
	readonly country?: string | null;
	/** ISO date string (YYYY-MM-DD), or null/absent when not supplied. */
	readonly dob?: string | null;
	readonly id_documents?: ReadonlyArray<IdDocument>;
}

export interface OnboardResult {
	readonly customer: CustomerRow;
	readonly matches: ReadonlyArray<ReviewRow>;
}

export class LocalOnboardingService {
	readonly #store: WorkstationStore;
	readonly #screener: NameScreener;

	public constructor(store: WorkstationStore, screener: NameScreener) {
		this.#store = store;
		this.#screener = screener;
	}

	/** Create the customer (dup-rejected), screen the name, tier + persist. */
	public async onboard(request: OnboardRequest): Promise<OnboardResult> {
		// Duplicate check happens BEFORE any screening work — the same
		// fail-closed ordering as customers/service.py:59.
		const customer = await this.#store.createCustomer({
			customer_reference: request.customer_reference,
			name: request.name,
			country: request.country ?? null,
			dob: request.dob ?? null,
			onboarded_by: request.onboarded_by ?? "local",
			id_documents: request.id_documents ?? [],
		});
		const country = request.country ?? null;
		const dob = request.dob ?? null;
		// The configured sensitivity drives BOTH the screen floor and the tier
		// floor so screening and tiering stay consistent; default = balanced
		// (0.65), preserving the legacy ONBOARDING_THRESHOLD exactly.
		const config = await loadScreeningConfig(this.#store);
		const threshold = resolveThreshold(config.sensitivity, config.overrides);
		const response = await this.#screener.screen({
			name: request.name,
			country,
			dob,
			threshold,
		});
		const listVersion = this.#screener.listVersion?.() ?? null;
		const profile = canonicalProfile(request.name, country);
		const tiered = response.matches.map((match) =>
			tierMatch(match, profile, threshold),
		);
		const matches =
			tiered.length === 0
				? []
				: await this.#store.recordMatches(customer.customer_id, tiered);
		await markScreenedWith(this.#store, customer.customer_id, listVersion);
		return { customer, matches };
	}
}
