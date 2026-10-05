// Interaction / edge-path behavior for SettingsPage: keyboard roving on the
// sensitivity control, load/apply/clear-cache failure surfaces, analyst-name
// persistence, override reset, and watchlist re-enable. Complements
// SettingsPage.test.tsx (the happy-path suite) with the same two mocked seams:
// the apiClient singleton and the workstation handle.

import { ANALYST_NAME_KEY } from "@amlfilter/workstation";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

// Every catalog list now carries its own freshness (see `CatalogListInfo`), so
// these mocks carry it too — a mock that lags the real contract stops testing it.
const FOUR_LISTS = [
	{ id: "OFAC_SDN", title: "OFAC SDN" },
	{ id: "EU_CONSOLIDATED", title: "EU Consolidated" },
	{ id: "UN_CONSOLIDATED", title: "UN Consolidated" },
	{ id: "UK_OFSI", title: "UK OFSI" },
].map((list) => ({
	version: "2026-08-01",
	entitiesCount: 100,
	fetchedAt: "2026-08-01T08:00:00Z",
	agedFrom: "fetchedAt",
	sourceUpdatedAt: "2026-08-01T06:00:00Z",
	stale: false,
	staleReason: null,
	...list,
}));

const NO_RESCAN = { customersScanned: 0, newHits: 0, clearedHits: 0 };

const mockClient = vi.mocked(apiClient);

async function renderLoaded(): Promise<void> {
	render(<SettingsPage />);
	await waitFor(() => expect(mockCatalogLists).toHaveBeenCalled());
	await screen.findByRole("radio", { name: "Balanced" });
}

function expectChecked(name: string): void {
	expect(screen.getByRole("radio", { name })).toHaveAttribute(
		"aria-checked",
		"true",
	);
}

describe("SettingsPage interactions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockClient.getScreeningConfig.mockResolvedValue({
			sensitivity: "balanced",
			overrides: {},
		});
		mockClient.setScreeningConfig.mockResolvedValue(NO_RESCAN);
		mockGetSetting.mockResolvedValue(null);
		mockCatalogLists.mockResolvedValue(FOUR_LISTS);
		mockGetEnabledLists.mockResolvedValue(FOUR_LISTS.map((l) => l.id));
		mockSetEnabledLists.mockResolvedValue(NO_RESCAN);
		mockClearListCache.mockResolvedValue(undefined);
		mockSetSetting.mockResolvedValue(undefined);
	});

	describe("load failures", () => {
		it("shows the failure message when loading settings rejects", async () => {
			mockClient.getScreeningConfig.mockRejectedValue(
				new Error("config store dead"),
			);

			render(<SettingsPage />);

			expect(await screen.findByText(/config store dead/i)).toBeInTheDocument();
			// The form never finished loading, so Apply must stay disabled.
			expect(screen.getByRole("button", { name: /apply/i })).toBeDisabled();
		});

		it("falls back to a generic message when the failure is not an Error", async () => {
			mockClient.getScreeningConfig.mockRejectedValue("nope");

			render(<SettingsPage />);

			expect(
				await screen.findByText(/failed to load settings/i),
			).toBeInTheDocument();
		});

		it("offers a retry after a WASM memory failure", async () => {
			mockCatalogLists
				.mockRejectedValueOnce(new Error("[wasm] RangeError: Out of memory"))
				.mockResolvedValueOnce(FOUR_LISTS);

			render(<SettingsPage />);

			expect(await screen.findByText(/out of memory/i)).toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: /retry/i }));
			await waitFor(() => expect(mockCatalogLists).toHaveBeenCalledTimes(2));
			expect(
				await screen.findByRole("radio", { name: "Balanced" }),
			).toBeInTheDocument();
		});
	});

	describe("sensitivity keyboard roving", () => {
		it("ArrowRight moves balanced → strict", async () => {
			await renderLoaded();

			fireEvent.keyDown(screen.getByRole("radio", { name: "Balanced" }), {
				key: "ArrowRight",
			});

			expectChecked("Strict");
		});

		it("ArrowDown clamps at strict (no wrap past the end)", async () => {
			mockClient.getScreeningConfig.mockResolvedValue({
				sensitivity: "strict",
				overrides: {},
			});
			await renderLoaded();

			fireEvent.keyDown(screen.getByRole("radio", { name: "Strict" }), {
				key: "ArrowDown",
			});

			expectChecked("Strict");
		});

		it("ArrowLeft moves balanced → lenient and ArrowUp clamps at lenient", async () => {
			await renderLoaded();

			fireEvent.keyDown(screen.getByRole("radio", { name: "Balanced" }), {
				key: "ArrowLeft",
			});
			expectChecked("Lenient");

			fireEvent.keyDown(screen.getByRole("radio", { name: "Lenient" }), {
				key: "ArrowUp",
			});
			expectChecked("Lenient");
		});

		it("any other key leaves the selection unchanged", async () => {
			await renderLoaded();

			fireEvent.keyDown(screen.getByRole("radio", { name: "Balanced" }), {
				key: "Enter",
			});

			expectChecked("Balanced");
		});
	});

	describe("apply / clear-cache failures", () => {
		it("an apply failure surfaces the error banner and re-enables Apply", async () => {
			mockSetEnabledLists.mockRejectedValue(new Error("apply blew up"));
			await renderLoaded();

			fireEvent.click(screen.getByRole("button", { name: /apply/i }));

			expect(await screen.findByText(/apply blew up/i)).toBeInTheDocument();
			expect(screen.getByRole("button", { name: /apply/i })).toBeEnabled();
		});

		it("a clear-cache failure surfaces the error and shows no confirmation", async () => {
			mockClearListCache.mockRejectedValue(new Error("opfs denied"));
			await renderLoaded();

			fireEvent.click(
				screen.getByRole("button", { name: /clear cached lists/i }),
			);

			expect(await screen.findByText(/opfs denied/i)).toBeInTheDocument();
			expect(screen.queryByText(/cached lists cleared/i)).toBeNull();
		});
	});

	describe("analyst name", () => {
		it("Apply persists the trimmed analyst name", async () => {
			await renderLoaded();

			fireEvent.change(screen.getByLabelText(/analyst name/i), {
				target: { value: "  Avery Analyst  " },
			});
			fireEvent.click(screen.getByRole("button", { name: /apply/i }));

			await waitFor(() =>
				expect(mockSetSetting).toHaveBeenCalledWith(
					ANALYST_NAME_KEY,
					"Avery Analyst",
				),
			);
		});

		it("a blank analyst name is not persisted", async () => {
			await renderLoaded();

			fireEvent.change(screen.getByLabelText(/analyst name/i), {
				target: { value: "   " },
			});
			fireEvent.click(screen.getByRole("button", { name: /apply/i }));

			await waitFor(() => expect(mockSetEnabledLists).toHaveBeenCalled());
			expect(mockSetSetting).not.toHaveBeenCalled();
		});
	});

	describe("override reset", () => {
		it("resetting an override back to 'Use default' removes it from the config", async () => {
			await renderLoaded();

			const select = screen.getByLabelText(/override for OFAC SDN/i);
			fireEvent.change(select, { target: { value: "strict" } });
			fireEvent.change(select, { target: { value: "" } });
			fireEvent.click(screen.getByRole("button", { name: /apply/i }));

			await waitFor(() =>
				expect(mockClient.setScreeningConfig).toHaveBeenCalledWith(
					expect.objectContaining({ overrides: {} }),
				),
			);
		});
	});

	describe("watchlist re-enable", () => {
		it("re-checking a disabled list restores it in the applied selection", async () => {
			await renderLoaded();

			const euCheckbox = await screen.findByRole("checkbox", {
				name: /EU Consolidated/,
			});
			fireEvent.click(euCheckbox); // disable
			fireEvent.click(euCheckbox); // re-enable
			fireEvent.click(screen.getByRole("button", { name: /apply/i }));

			await waitFor(() =>
				expect(mockSetEnabledLists).toHaveBeenCalledWith(
					FOUR_LISTS.map((l) => l.id),
				),
			);
		});
	});

	// A rescan over a zero-customer book returns customersScanned: 0 even when
	// the config WAS saved — the banner must confirm the apply, and say
	// "unchanged" only when the form truly matches what is already applied.
	// (Live bug: every Apply on a fresh device reported "Settings unchanged".)
	describe("apply confirmation", () => {
		it("a changed sensitivity confirms 'applied' even when zero customers re-screened", async () => {
			await renderLoaded();

			fireEvent.click(screen.getByRole("radio", { name: "Strict" }));
			fireEvent.click(screen.getByRole("button", { name: /apply/i }));

			expect(await screen.findByText(/settings applied/i)).toBeInTheDocument();
			expect(screen.queryByText(/settings unchanged/i)).toBeNull();
			// The change really was persisted, not skipped.
			await waitFor(() =>
				expect(mockClient.setScreeningConfig).toHaveBeenCalledWith({
					sensitivity: "strict",
					overrides: {},
				}),
			);
		});

		it("an analyst-name-only change confirms 'applied', not 'unchanged'", async () => {
			await renderLoaded();

			fireEvent.change(screen.getByLabelText(/analyst name/i), {
				target: { value: "Avery Analyst" },
			});
			fireEvent.click(screen.getByRole("button", { name: /apply/i }));

			expect(await screen.findByText(/settings applied/i)).toBeInTheDocument();
			expect(screen.queryByText(/settings unchanged/i)).toBeNull();
		});

		it("a per-list override change confirms 'applied', not 'unchanged'", async () => {
			await renderLoaded();

			fireEvent.change(screen.getByLabelText(/override for OFAC SDN/i), {
				target: { value: "strict" },
			});
			fireEvent.click(screen.getByRole("button", { name: /apply/i }));

			expect(await screen.findByText(/settings applied/i)).toBeInTheDocument();
			expect(screen.queryByText(/settings unchanged/i)).toBeNull();
		});

		it("Apply with no edits reports 'unchanged'", async () => {
			await renderLoaded();

			fireEvent.click(screen.getByRole("button", { name: /apply/i }));

			expect(
				await screen.findByText(/settings unchanged/i),
			).toBeInTheDocument();
			expect(screen.queryByText(/settings applied/i)).toBeNull();
		});

		it("a second Apply without further edits reports 'unchanged'", async () => {
			await renderLoaded();

			fireEvent.click(screen.getByRole("radio", { name: "Strict" }));
			fireEvent.click(screen.getByRole("button", { name: /apply/i }));
			await screen.findByText(/settings applied/i);

			fireEvent.click(screen.getByRole("button", { name: /apply/i }));

			expect(
				await screen.findByText(/settings unchanged/i),
			).toBeInTheDocument();
		});
	});
});
