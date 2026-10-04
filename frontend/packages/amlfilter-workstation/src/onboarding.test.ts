import type { Match, ScreenQuery, ScreenResponse } from "@amlfilter/browser";
import { EMPTY_IDENTIFIERS } from "@amlfilter/browser";
import { describe, expect, it, vi } from "vitest";
import { DuplicateReferenceError } from "./errors";
import {
	LocalOnboardingService,
	type NameScreener,
	ONBOARDING_THRESHOLD,
} from "./onboarding";
import type { CustomerRow, ReviewRow, WorkstationStore } from "./types";

function makeCustomerRow(): CustomerRow {
	return {
		customer_id: "c-1",
		customer_reference: "R-1",
		name: "Ivan Fakovich",
		country: "RU",
		dob: null,
		onboarding_status: "PENDING_REVIEW",
		kyc_risk_rating: null,
		id_documents: [],
		onboarded_by: "local",
		screened_at: null,
		screened_list_version: null,
		created_at: "2026-06-09T00:00:00.000Z",
		updated_at: "2026-06-09T00:00:00.000Z",
	};
}

function makeMatch(overrides: Partial<Match> = {}): Match {
	return {
		entity_id: "DEMO_SDN:0001",
		score: 0.95,
		entity_type: "PERSON",
		risk_category: "SANCTION",
		source_list: "DEMO_SDN",
		list_version: "2026-05-01",
		primary_name: "Ivan Fakovich",
		aliases: [],
		countries: ["RU"],
		nationalities: [],
		dob: [],
		addresses: [],
		identifiers: EMPTY_IDENTIFIERS,
		reasons: [
			{
				signal: "name_vector",
				value: 0.95,
				weight: 0.55,
				contribution: 0.52,
				description: "Vector similarity",
			},
		],
		explanation: "Match due to: strong vector similarity",
		...overrides,
	};
}

function makeStore(): WorkstationStore {
	return {
		open: vi.fn().mockResolvedValue(1),
		createCustomer: vi.fn().mockResolvedValue(makeCustomerRow()),
		listCustomers: vi.fn().mockResolvedValue([]),
		getCustomer: vi.fn().mockResolvedValue(null),
		updateCustomer: vi.fn().mockResolvedValue(makeCustomerRow()),
		deleteCustomer: vi.fn().mockResolvedValue(undefined),
		recordMatches: vi.fn().mockResolvedValue([] as ReviewRow[]),
		markScreened: vi.fn().mockResolvedValue(makeCustomerRow()),
		listReviewMatches: vi.fn().mockResolvedValue([] as ReviewRow[]),
		resolveMatch: vi.fn(),
		getSetting: vi.fn().mockResolvedValue(null),
		setSetting: vi.fn().mockResolvedValue(undefined),
	} as unknown as WorkstationStore;
}

function makeScreener(matches: ReadonlyArray<Match>): NameScreener {
	return {
		screen: vi.fn(
			async (_query: ScreenQuery): Promise<ScreenResponse> => ({
				request_id: "req-1",
				matches,
				list_versions_used: { DEMO_SDN: "2026-05-01" },
				execution_time_ms: 1,
			}),
		),
	};
}

describe("LocalOnboardingService", () => {
	it("creates the customer, screens with the resolved threshold, tiers, persists", async () => {
		const store = makeStore();
		const screener = makeScreener([
			makeMatch({ entity_id: "e-strong", score: 0.95 }),
			makeMatch({ entity_id: "e-possible", score: 0.72 }),
		]);
		// No screening config set => default balanced (0.65) drives both the
		// screen floor and the tier floor (resolved threshold, not a constant).
		const service = new LocalOnboardingService(store, screener);
		await service.onboard({
			customer_reference: "R-1",
			name: "Ivan Fakovich",
			country: "RU",
		});

		expect(screener.screen).toHaveBeenCalledWith({
			name: "Ivan Fakovich",
			country: "RU",
			dob: null,
			threshold: ONBOARDING_THRESHOLD,
		});
		expect(store.recordMatches).toHaveBeenCalledTimes(1);
		const call = vi.mocked(store.recordMatches).mock.calls[0];
		if (call === undefined) throw new Error("call missing");
		const [customerId, tiered] = call;
		expect(customerId).toBe("c-1");
		expect(tiered.map((t) => [t.ofac_entity_id, t.tier])).toEqual([
			["e-strong", "STRONG"],
			["e-possible", "POSSIBLE"],
		]);
		expect(tiered[0]?.sanctioned_name).toBe("Ivan Fakovich");
		expect(tiered[0]?.reasons[0]?.signal).toBe("name_vector");
		expect(tiered[0]?.material_fingerprint).toMatch(/^[0-9a-f]+$/);
	});

	it("persists a supplied dob and carries it into the ScreenQuery", async () => {
		const store = makeStore();
		const screener = makeScreener([]);
		const service = new LocalOnboardingService(store, screener);
		await service.onboard({
			customer_reference: "R-1",
			name: "Ivan Fakovich",
			country: "RU",
			dob: "1975-03-02",
		});
		// The customer row carries the dob through to the store.
		expect(store.createCustomer).toHaveBeenCalledWith({
			customer_reference: "R-1",
			name: "Ivan Fakovich",
			country: "RU",
			dob: "1975-03-02",
			onboarded_by: "local",
			id_documents: [],
		});
		// And the screen query is built with that dob so DOB-based scoring runs.
		expect(screener.screen).toHaveBeenCalledWith({
			name: "Ivan Fakovich",
			country: "RU",
			dob: "1975-03-02",
			threshold: ONBOARDING_THRESHOLD,
		});
	});

	it("honors a persisted 'strict' sensitivity for the screen floor", async () => {
		const store = makeStore();
		vi.mocked(store.getSetting).mockImplementation((key: string) =>
			Promise.resolve(key === "screening_sensitivity" ? "strict" : null),
		);
		const screener = makeScreener([]);
		const service = new LocalOnboardingService(store, screener);
		await service.onboard({
			customer_reference: "R-1",
			name: "Ann",
			country: "US",
		});
		expect(screener.screen).toHaveBeenCalledWith({
			name: "Ann",
			country: "US",
			dob: null,
			threshold: 0.75,
		});
	});

	it("defaults onboarded_by to 'local' and id_documents to []", async () => {
		const store = makeStore();
		const service = new LocalOnboardingService(store, makeScreener([]));
		await service.onboard({ customer_reference: "R-1", name: "Ann" });
		expect(store.createCustomer).toHaveBeenCalledWith({
			customer_reference: "R-1",
			name: "Ann",
			country: null,
			dob: null,
			onboarded_by: "local",
			id_documents: [],
		});
	});

	it("does not call recordMatches when screening returns no matches", async () => {
		const store = makeStore();
		const service = new LocalOnboardingService(store, makeScreener([]));
		const result = await service.onboard({
			customer_reference: "R-1",
			name: "Ann",
		});
		expect(store.recordMatches).not.toHaveBeenCalled();
		expect(result.matches).toEqual([]);
	});

	it("marks a clean customer screened against the screener's lists", async () => {
		const store = makeStore();
		const screener = { ...makeScreener([]), listVersion: () => "OFAC_SDN@v9" };
		await new LocalOnboardingService(store, screener).onboard({
			customer_reference: "R-1",
			name: "Ann",
		});
		expect(store.markScreened).toHaveBeenCalledWith("c-1", "OFAC_SDN@v9");
	});

	it("marks only after the matches are stored", async () => {
		const store = makeStore();
		vi.mocked(store.recordMatches).mockRejectedValue(new Error("disk full"));
		const screener = {
			...makeScreener([makeMatch()]),
			listVersion: () => "OFAC_SDN@v9",
		};
		await expect(
			new LocalOnboardingService(store, screener).onboard({
				customer_reference: "R-1",
				name: "Ann",
			}),
		).rejects.toThrow("disk full");
		expect(store.markScreened).not.toHaveBeenCalled();
	});

	it("a screen failure leaves the new customer unproven", async () => {
		const store = makeStore();
		const screener = {
			screen: vi.fn().mockRejectedValue(new Error("engine died")),
			listVersion: () => "OFAC_SDN@v9",
		};
		await expect(
			new LocalOnboardingService(store, screener).onboard({
				customer_reference: "R-1",
				name: "Ann",
			}),
		).rejects.toThrow("engine died");
		expect(store.markScreened).not.toHaveBeenCalled();
	});

	it("propagates DuplicateReferenceError without screening (fail-closed order, service.py:59)", async () => {
		const store = makeStore();
		vi.mocked(store.createCustomer).mockRejectedValue(
			new DuplicateReferenceError("customer_reference 'R-1' already exists"),
		);
		const screener = makeScreener([makeMatch()]);
		const service = new LocalOnboardingService(store, screener);
		await expect(
			service.onboard({ customer_reference: "R-1", name: "Ann" }),
		).rejects.toBeInstanceOf(DuplicateReferenceError);
		expect(screener.screen).not.toHaveBeenCalled();
	});
});
