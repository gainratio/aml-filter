// The age of each list `/screen` actually screens against.
//
// The boot banner ends on "List verified." — which readers take as a statement
// about the DATA, not just the signature. A visitor screening a name against a
// three-day-old copy had no way to know. `/screen` has no list selector to hang
// a badge off, so each list's age goes next to the search box, by plain name
// ("US OFAC", not the catalog's "OFAC SDN").

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Frozen clock: the ages asserted here are exact.
const NOW = new Date("2026-08-01T12:00:00Z");

const OFAC_ENTITY = {
	entity_id: "DEMO:1",
	entity_type: "PERSON",
	primary_name: "Ivan Fakovich",
	name_canonical: "ivan fakovich",
	aliases: [],
	dob: ["1971-03-14"],
	countries: ["RU"],
	nationalities: ["RU"],
	addresses: [],
	identifiers: { passport: [], national_id: [], other: {} },
	risk_category: "SANCTION",
	source_list: "OFAC_SDN",
	list_version: "demo-1",
};

/** What the faked runtime's `catalogLists()` resolves to for the next render. */
let catalogListsResult: {
	resolve: () => Promise<ReadonlyArray<Record<string, unknown>>>;
};

/** A complete CatalogListInfo for OFAC, with freshness overridable per test. */
function ofacList(over: Record<string, unknown> = {}) {
	return {
		id: "OFAC_SDN",
		title: "OFAC SDN",
		version: "demo-1",
		entitiesCount: 3,
		fetchedAt: "2026-08-01T06:00:00Z",
		agedFrom: "fetchedAt",
		sourceUpdatedAt: "2026-08-01T04:00:00Z",
		stale: false,
		staleReason: null,
		...over,
	};
}

vi.mock("@amlfilter/browser", async (importActual) => {
	const actual = await importActual<typeof import("@amlfilter/browser")>();
	class EngineRuntime {
		bootstrap(): Promise<void> {
			return Promise.resolve();
		}
		catalogLists(): Promise<ReadonlyArray<Record<string, unknown>>> {
			return catalogListsResult.resolve();
		}
		engine() {
			return {
				allEntities: () => [OFAC_ENTITY],
				screen: () => Promise.resolve({ matches: [], execution_time_ms: 1 }),
			};
		}
		dispose() {}
	}
	return {
		...actual,
		EngineRuntime,
		configFromEnv: () => ({}),
		engineSupport: () => ({ supported: true, missing: [] }),
	};
});

import { ScreenPage } from "./ScreenPage";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	vi.setSystemTime(NOW);
	catalogListsResult = { resolve: () => Promise.resolve([ofacList()]) };
});

describe("ScreenPage — the age of the list being screened against", () => {
	it("names the list and states its age once booted", async () => {
		render(<ScreenPage />);
		expect(
			await screen.findByText(/US OFAC.*updated 6 hours ago/i),
		).toBeInTheDocument();
	});

	it("flags a stale list unmissably, with its REAL age and the reason", async () => {
		catalogListsResult = {
			resolve: () =>
				Promise.resolve([
					ofacList({
						fetchedAt: "2026-07-29T12:00:00Z",
						agedFrom: "fetchedAt",
						sourceUpdatedAt: null,
						stale: true,
						staleReason: "the OFAC feed was unreachable",
					}),
				]),
		};
		render(<ScreenPage />);
		const warning = await screen.findByText(
			/Not updated for 3 days — the OFAC feed was unreachable/i,
		);
		expect(warning).toBeVisible();
	});

	it("announces the stale warning to assistive tech, not by colour alone", async () => {
		catalogListsResult = {
			resolve: () =>
				Promise.resolve([
					ofacList({
						fetchedAt: "2026-07-29T12:00:00Z",
						agedFrom: "fetchedAt",
						stale: true,
						staleReason: "the OFAC feed was unreachable",
					}),
				]),
		};
		render(<ScreenPage />);
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toMatch(/Not updated for 3 days/);
	});

	it("does not present a stale list as freshly updated", async () => {
		catalogListsResult = {
			resolve: () =>
				Promise.resolve([
					ofacList({ fetchedAt: "2026-07-29T12:00:00Z", stale: true }),
				]),
		};
		render(<ScreenPage />);
		await screen.findByText(/Not updated for 3 days/i);
		expect(screen.queryByText(/updated 3 days ago/i)).not.toBeInTheDocument();
	});

	// A pre-per-list-freshness bundle (what aml-filter.com serves today) has no
	// per-list `fetchedAt`; the engine ages it from the bundle's own build stamp.
	// That age is REAL, so this line must state it — but as the bundle's age, not
	// as a per-list refresh time we cannot actually prove.
	it("states a legacy list's age as the BUNDLE's build time, not as a refresh", async () => {
		catalogListsResult = {
			resolve: () =>
				Promise.resolve([
					ofacList({ agedFrom: "generatedAt", sourceUpdatedAt: null }),
				]),
		};
		render(<ScreenPage />);
		expect(
			await screen.findByText(/US OFAC.*in a bundle built 6 hours ago/i),
		).toBeInTheDocument();
		expect(screen.queryByText(/age unknown/i)).not.toBeInTheDocument();
	});

	it("says the age is unknown rather than implying freshness when it cannot be read", async () => {
		catalogListsResult = {
			resolve: () => Promise.reject(new Error("catalog read failed")),
		};
		render(<ScreenPage />);
		expect(await screen.findByText(/age unknown/i)).toBeInTheDocument();
	});

	// On a phone the search pins US OFAC (see ./screenScope); a catalog without it
	// cannot state that list's age.
	it("says the age is unknown when the pinned list is absent from the catalog", async () => {
		vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
			"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) Mobile/15E148",
		);
		catalogListsResult = {
			resolve: () => Promise.resolve([ofacList({ id: "EU_CONSOLIDATED" })]),
		};
		render(<ScreenPage />);
		expect(await screen.findByText(/age unknown/i)).toBeInTheDocument();
	});

	it("still renders the search box and the list directory", async () => {
		render(<ScreenPage />);
		await waitFor(() =>
			expect(
				screen.getByRole("searchbox", { name: /search the sanctions list/i }),
			).toBeEnabled(),
		);
		// "Ivan Fakovich" is also the search placeholder, so assert on the rendered
		// directory entry rather than on any text anywhere on the page.
		expect(screen.getAllByText(/Ivan Fakovich/).length).toBeGreaterThanOrEqual(
			1,
		);
	});
});
