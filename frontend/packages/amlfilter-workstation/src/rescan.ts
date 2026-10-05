// RescanService — the bidirectional auto-rescan tier. When the signed watchlist
// bundle advances to a new version, every existing customer is re-screened
// against it: brand-new hits surface as PENDING, hits that no longer match are
// cleared, and a still-matching hit keeps whatever disposition a reviewer
// already gave it (replaceMatches carries the audit trail forward). The screen
// + tiering path is the SAME one onboarding uses (tierMatch), so a re-screen and
// an onboard tier identically.

import { NotFoundError } from "./errors";
import { markScreenedWith, type NameScreener } from "./onboarding";
import { loadScreeningConfig, resolveThreshold } from "./screening_config";
import { canonicalProfile, tierMatch } from "./tier_match";
import type { CustomerRow, ReviewRow, WorkstationStore } from "./types";

/** The settings key under which the last fully-synced watchlist version lives. */
export const LAST_SYNCED_VERSION_KEY = "last_synced_watchlist_version";

export interface RescanSummary {
	readonly customersScanned: number;
	readonly newHits: number;
	readonly clearedHits: number;
}

export interface SyncResult extends RescanSummary {
	/** false => the watchlist was unchanged; only stale customers (if any) were re-screened. */
	readonly changed: boolean;
	/** The version now recorded as last-synced. */
	readonly version: string;
}

export class RescanService {
	readonly #store: WorkstationStore;
	readonly #screener: NameScreener;
	/** Dedupes concurrent syncWatchlist so one rescan runs, not N. */
	#syncInFlight: Promise<SyncResult> | null = null;
	/** Per-customer in-flight screen+replace, so overlaps share one write. */
	readonly #screenInFlight = new Map<
		string,
		Promise<ReadonlyArray<ReviewRow>>
	>();

	public constructor(store: WorkstationStore, screener: NameScreener) {
		this.#store = store;
		this.#screener = screener;
	}

	/** Re-screen one customer and replace their complete match set. */
	public async screenCustomer(
		customerId: string,
	): Promise<ReadonlyArray<ReviewRow>> {
		const customer = await this.#store.getCustomer(customerId);
		if (customer === null) {
			throw new NotFoundError(`customer ${customerId} not found`);
		}
		return this.#guardedReplaceFor(customer);
	}

	/** Re-screen every customer; summarize new and cleared hits across all. */
	public async rescanAll(): Promise<RescanSummary> {
		return this.#rescanEach(await this.#store.listCustomers());
	}

	/** Re-screen the given customers; summarize new and cleared hits. */
	async #rescanEach(
		customers: ReadonlyArray<CustomerRow>,
	): Promise<RescanSummary> {
		const priorByCustomer = await this.#priorEntityIds();
		let newHits = 0;
		let clearedHits = 0;
		for (const customer of customers) {
			const rows = await this.#guardedReplaceFor(customer);
			const prior = priorByCustomer.get(customer.customer_id) ?? new Set();
			const next = new Set(rows.map((r) => r.ofac_entity_id));
			newHits += countMissing(next, prior);
			clearedHits += countMissing(prior, next);
		}
		return { customersScanned: customers.length, newHits, clearedHits };
	}

	/**
	 * Idempotent on version: rescan + persist only when the version advanced.
	 * Concurrent calls share one in-flight run, so the version guard cannot be
	 * straddled by a second rescan (no double-run).
	 */
	public syncWatchlist(currentVersion: string): Promise<SyncResult> {
		if (this.#syncInFlight !== null) {
			return this.#syncInFlight;
		}
		const run = this.#syncWatchlist(currentVersion).finally(() => {
			this.#syncInFlight = null;
		});
		this.#syncInFlight = run;
		return run;
	}

	async #syncWatchlist(currentVersion: string): Promise<SyncResult> {
		const lastSynced = await this.#store.getSetting(LAST_SYNCED_VERSION_KEY);
		if (lastSynced === currentVersion) {
			const stale = await this.#screenStale(currentVersion);
			return { changed: false, version: currentVersion, ...stale };
		}
		const summary = await this.rescanAll();
		await this.#store.setSetting(LAST_SYNCED_VERSION_KEY, currentVersion);
		return { changed: true, version: currentVersion, ...summary };
	}

	/**
	 * Re-screen every customer without proof against `currentVersion`: never
	 * screened (null), screened under other lists, or edited since. A missing
	 * proof is STALE, never current — so a failed import screen is forced through
	 * again on the next sync instead of reading clear.
	 */
	async #screenStale(currentVersion: string): Promise<RescanSummary> {
		const customers = await this.#store.listCustomers();
		return this.#rescanEach(
			customers.filter(
				(customer) => customer.screened_list_version !== currentVersion,
			),
		);
	}

	/**
	 * Per-customer in-flight guard: an overlapping screen for the same customer
	 * shares one screen+replace, so a stale result can never clobber a fresh one.
	 */
	#guardedReplaceFor(customer: CustomerRow): Promise<ReadonlyArray<ReviewRow>> {
		const id = customer.customer_id;
		const pending = this.#screenInFlight.get(id);
		if (pending !== undefined) {
			return pending;
		}
		const run = this.#replaceFor(customer).finally(() => {
			this.#screenInFlight.delete(id);
		});
		this.#screenInFlight.set(id, run);
		return run;
	}

	async #replaceFor(customer: CustomerRow): Promise<ReadonlyArray<ReviewRow>> {
		// Same resolved-sensitivity contract as onboarding: one threshold drives
		// both the screen floor and the tier floor; default = balanced (0.65).
		const config = await loadScreeningConfig(this.#store);
		const threshold = resolveThreshold(config.sensitivity, config.overrides);
		const response = await this.#screener.screen({
			name: customer.name,
			country: customer.country,
			dob: customer.dob,
			threshold,
		});
		const listVersion = this.#screener.listVersion();
		const profile = canonicalProfile(customer.name, customer.country);
		const tiered = response.matches.map((match) =>
			tierMatch(match, profile, threshold),
		);
		const rows = await this.#store.replaceMatches(customer.customer_id, tiered);
		await markScreenedWith(this.#store, customer.customer_id, listVersion);
		return rows;
	}

	/** Snapshot every customer's prior match entity-id set in one board read. */
	async #priorEntityIds(): Promise<Map<string, Set<string>>> {
		const rows = await this.#store.listReviewMatches({
			limit: Number.MAX_SAFE_INTEGER,
		});
		const byCustomer = new Map<string, Set<string>>();
		for (const row of rows) {
			const set = byCustomer.get(row.customer_id) ?? new Set<string>();
			set.add(row.ofac_entity_id);
			byCustomer.set(row.customer_id, set);
		}
		return byCustomer;
	}
}

/** Count members of `a` that are absent from `b` (set difference size). */
function countMissing(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	let count = 0;
	for (const value of a) {
		if (!b.has(value)) {
			count += 1;
		}
	}
	return count;
}
