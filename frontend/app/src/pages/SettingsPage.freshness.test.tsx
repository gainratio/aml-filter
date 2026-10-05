// The per-list AGE, rendered where a user actually picks lists.
//
// The signed bundle has always known how old each list was; the settings screen
// never showed it, so a user could tick "EU Consolidated" and screen against a
// three-day-old copy with nothing on screen saying so. These tests pin the two
// cases that matter: a fresh list states its age, and a stale one states its
// REAL age plus why it is stale — visibly, in text, with no hover required.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../lib/api";
import { SettingsPage } from "./SettingsPage";

vi.mock("../lib/api", () => ({
	apiClient: {
		getScreeningConfig: vi.fn(),
		setScreeningConfig: vi.fn(),
	},
}));

const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn().mockResolvedValue(undefined);
const mockCatalogLists = vi.fn();
const mockGetEnabledLists = vi.fn();
const mockSetEnabledLists = vi.fn();
const mockClearListCache = vi.fn().mockResolvedValue(undefined);
vi.mock("../lib/workstation", () => ({
	workstation: vi.fn(async () => ({
		store: { getSetting: mockGetSetting, setSetting: mockSetSetting },
		catalogLists: mockCatalogLists,
		getEnabledLists: mockGetEnabledLists,
		setEnabledLists: mockSetEnabledLists,
		clearListCache: mockClearListCache,
	})),
}));

// Freeze the clock: the ages asserted below are exact, not approximate.
const NOW = new Date("2026-08-01T12:00:00Z");

/** OFAC refreshed four hours ago; EU carried forward from three days ago. */
const LISTS = [
	{
		id: "OFAC_SDN",
		title: "OFAC SDN",
		version: "2026-08-01",
		entitiesCount: 19_181,
		fetchedAt: "2026-08-01T08:00:00Z",
		agedFrom: "fetchedAt",
		sourceUpdatedAt: "2026-08-01T06:00:00Z",
		stale: false,
		staleReason: null,
	},
	{
		id: "EU_CONSOLIDATED",
		title: "EU Consolidated",
		version: "2026-07-29",
		entitiesCount: 5_000,
		fetchedAt: "2026-07-29T12:00:00Z",
		agedFrom: "fetchedAt",
		sourceUpdatedAt: null,
		stale: true,
		staleReason: "the EU feed was unreachable",
	},
];

const mockClient = vi.mocked(apiClient);

describe("SettingsPage — per-list freshness", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.setSystemTime(NOW);
		mockClient.getScreeningConfig.mockResolvedValue({
			sensitivity: "balanced",
			overrides: {},
		});
		mockGetSetting.mockResolvedValue(null);
		mockCatalogLists.mockResolvedValue(LISTS);
		mockGetEnabledLists.mockResolvedValue(LISTS.map((l) => l.id));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("shows a FRESH list's real age next to its name", async () => {
		render(<SettingsPage />);
		expect(await screen.findByText(/updated 4 hours ago/i)).toBeInTheDocument();
	});

	it("shows a STALE list's REAL age and the reason, visibly", async () => {
		render(<SettingsPage />);
		const warning = await screen.findByText(
			/Not updated for 3 days — the EU feed was unreachable/i,
		);
		expect(warning).toBeInTheDocument();
		// Visible in the document flow — not a title attribute, not hover-only.
		expect(warning).toBeVisible();
	});

	it("does not present the stale list as if it were fresh", async () => {
		render(<SettingsPage />);
		await screen.findByText(/Not updated for 3 days/i);
		expect(screen.queryByText(/updated 3 days ago/i)).not.toBeInTheDocument();
	});

	it("announces the stale warning to assistive tech, not by colour alone", async () => {
		render(<SettingsPage />);
		const warning = await screen.findByText(/Not updated for 3 days/i);
		// The warning carries its meaning as TEXT inside the toggle's own label,
		// so a screen reader reaches it; the ⚠ glyph is decorative only.
		const label = warning.closest("label");
		expect(label).not.toBeNull();
		expect(label?.textContent).toMatch(/Not updated for 3 days/);
		expect(label?.getAttribute("for")).toBe("watchlist-EU_CONSOLIDATED");
	});

	it("shows each list's entity count", async () => {
		render(<SettingsPage />);
		expect(await screen.findByText(/19,181 entities/)).toBeInTheDocument();
		expect(screen.getByText(/5,000 entities/)).toBeInTheDocument();
	});

	it("keeps the existing checkbox ids so interaction tests still bind", async () => {
		render(<SettingsPage />);
		await waitFor(() => {
			expect(document.getElementById("watchlist-OFAC_SDN")).toBeTruthy();
			expect(document.getElementById("watchlist-EU_CONSOLIDATED")).toBeTruthy();
		});
	});

	// A bundle published before per-list freshness has no per-list `fetchedAt`, so
	// the engine ages it from the bundle's own build stamp and says so. The age is
	// real — it must NOT read "Age unknown" — but it is the BUNDLE's age, and the
	// copy has to say that rather than claim a per-list refresh time we do not
	// have. (aml-filter.com was serving exactly such a bundle when this shipped.)
	it("states a legacy list's age as the BUNDLE's build time, not as a refresh", async () => {
		mockCatalogLists.mockResolvedValue([
			{
				...LISTS[0],
				fetchedAt: "2026-08-01T08:00:00Z",
				agedFrom: "generatedAt",
				sourceUpdatedAt: null,
			},
		]);
		render(<SettingsPage />);
		expect(
			await screen.findByText(/in a bundle built 4 hours ago/i),
		).toBeInTheDocument();
		expect(screen.queryByText(/age unknown/i)).not.toBeInTheDocument();
	});

	it("says the age is UNKNOWN rather than fresh when fetchedAt is unusable", async () => {
		mockCatalogLists.mockResolvedValue([
			{ ...LISTS[0], fetchedAt: "not-a-date" },
		]);
		render(<SettingsPage />);
		expect(await screen.findByText(/age unknown/i)).toBeInTheDocument();
		expect(screen.queryByText(/updated .* ago/i)).not.toBeInTheDocument();
	});
});
