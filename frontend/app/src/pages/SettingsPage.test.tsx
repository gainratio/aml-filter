import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../lib/api";
import { SettingsPage } from "./SettingsPage";

// The page talks to the persisted screening config through the apiClient
// singleton, and to the analyst-name settings row through the workstation
// handle's store. Mock both seams so the tests are deterministic and offline.
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

const mockClient = vi.mocked(apiClient);

describe("SettingsPage", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockClient.getScreeningConfig.mockResolvedValue({
			sensitivity: "balanced",
			overrides: {},
		});
		mockClient.setScreeningConfig.mockResolvedValue({
			customersScanned: 0,
			newHits: 0,
			clearedHits: 0,
		});
		mockGetSetting.mockResolvedValue(null);
		mockCatalogLists.mockResolvedValue(FOUR_LISTS);
		mockGetEnabledLists.mockResolvedValue(FOUR_LISTS.map((l) => l.id));
		mockSetEnabledLists.mockResolvedValue({
			customersScanned: 0,
			newHits: 0,
			clearedHits: 0,
		});
	});

	it("loads the screening config on mount and reflects the sensitivity in the control", async () => {
		mockClient.getScreeningConfig.mockResolvedValue({
			sensitivity: "strict",
			overrides: {},
		});

		render(<SettingsPage />);

		await waitFor(() =>
			expect(screen.getByRole("radio", { name: "Strict" })).toHaveAttribute(
				"aria-checked",
				"true",
			),
		);
	});

	it("offers the receipt signing key section (export, import, reset)", async () => {
		render(<SettingsPage />);

		expect(
			await screen.findByRole("heading", { name: "Receipt signing key" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Reset signing key…" }),
		).toBeInTheDocument();
	});

	it("selecting a different sensitivity then Apply calls setScreeningConfig with that sensitivity", async () => {
		render(<SettingsPage />);
		await waitFor(() =>
			expect(mockClient.getScreeningConfig).toHaveBeenCalled(),
		);

		fireEvent.click(screen.getByRole("radio", { name: "Strict" }));
		fireEvent.click(screen.getByRole("button", { name: /apply/i }));

		await waitFor(() =>
			expect(mockClient.setScreeningConfig).toHaveBeenCalledWith(
				expect.objectContaining({ sensitivity: "strict" }),
			),
		);
	});

	it("after Apply resolves with a rescan summary, the confirmation banner shows the count", async () => {
		mockClient.setScreeningConfig.mockResolvedValue({
			customersScanned: 3,
			newHits: 1,
			clearedHits: 0,
		});

		render(<SettingsPage />);
		await waitFor(() =>
			expect(mockClient.getScreeningConfig).toHaveBeenCalled(),
		);

		fireEvent.click(screen.getByRole("button", { name: /apply/i }));

		await waitFor(() =>
			expect(screen.getByText(/Re-screened 3 customers/)).toBeInTheDocument(),
		);
	});

	it("choosing a per-list override is included in the setScreeningConfig overrides", async () => {
		render(<SettingsPage />);
		await waitFor(() =>
			expect(mockClient.getScreeningConfig).toHaveBeenCalled(),
		);

		fireEvent.change(screen.getByLabelText(/override for OFAC SDN/i), {
			target: { value: "strict" },
		});
		fireEvent.click(screen.getByRole("button", { name: /apply/i }));

		await waitFor(() =>
			expect(mockClient.setScreeningConfig).toHaveBeenCalledWith(
				expect.objectContaining({ overrides: { OFAC_SDN: "strict" } }),
			),
		);
	});

	it("renders a checkbox per catalog list, all checked by default", async () => {
		render(<SettingsPage />);
		await waitFor(() => expect(mockCatalogLists).toHaveBeenCalled());
		for (const list of FOUR_LISTS) {
			const checkbox = await screen.findByRole("checkbox", {
				name: new RegExp(list.title),
			});
			expect(checkbox).toBeChecked();
		}
	});

	it("renders one override row per ENABLED list (not just OFAC)", async () => {
		mockGetEnabledLists.mockResolvedValue(["OFAC_SDN", "UN_CONSOLIDATED"]);
		render(<SettingsPage />);
		await waitFor(() => expect(mockGetEnabledLists).toHaveBeenCalled());
		expect(
			await screen.findByLabelText(/override for OFAC SDN/i),
		).toBeInTheDocument();
		expect(
			await screen.findByLabelText(/override for UN Consolidated/i),
		).toBeInTheDocument();
		// EU is NOT enabled → no override row for it.
		expect(screen.queryByLabelText(/override for EU Consolidated/i)).toBeNull();
	});

	it("unchecking a list then Apply calls setEnabledLists without that id", async () => {
		render(<SettingsPage />);
		await waitFor(() => expect(mockCatalogLists).toHaveBeenCalled());
		const euCheckbox = await screen.findByRole("checkbox", {
			name: /EU Consolidated/,
		});
		fireEvent.click(euCheckbox); // disable EU
		fireEvent.click(screen.getByRole("button", { name: /apply/i }));
		await waitFor(() =>
			expect(mockSetEnabledLists).toHaveBeenCalledWith([
				"OFAC_SDN",
				"UN_CONSOLIDATED",
				"UK_OFSI",
			]),
		);
	});

	it("a selection-only change still shows the rescan summary banner", async () => {
		mockSetEnabledLists.mockResolvedValue({
			customersScanned: 5,
			newHits: 0,
			clearedHits: 2,
		});
		render(<SettingsPage />);
		await waitFor(() => expect(mockCatalogLists).toHaveBeenCalled());
		const euCheckbox = await screen.findByRole("checkbox", {
			name: /EU Consolidated/,
		});
		fireEvent.click(euCheckbox);
		fireEvent.click(screen.getByRole("button", { name: /apply/i }));
		await waitFor(() =>
			expect(screen.getByText(/Re-screened 5 customers/)).toBeInTheDocument(),
		);
	});

	it("Clear cached lists calls clearListCache and confirms the next load re-fetches", async () => {
		render(<SettingsPage />);
		await waitFor(() => expect(mockCatalogLists).toHaveBeenCalled());

		fireEvent.click(
			screen.getByRole("button", { name: /clear cached lists/i }),
		);

		await waitFor(() => expect(mockClearListCache).toHaveBeenCalledTimes(1));
		expect(await screen.findByRole("status")).toHaveTextContent(
			/cached lists cleared/i,
		);
	});
});
