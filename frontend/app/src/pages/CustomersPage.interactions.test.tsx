// Interaction / edge-path behavior for CustomersPage: identity-document rows,
// badge variants, per-action error surfaces, the engine-boot path of "Check for
// updates", and edit cancel/dismiss flows. Complements CustomersPage.test.tsx
// (the happy-path suite) with the same two mocked seams: the apiClient
// singleton and the workstation handle.

import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomerOnboardResponse, CustomerResponse } from "../lib/api";
import { apiClient } from "../lib/api";
import { CustomersPage } from "./CustomersPage";

vi.mock("../lib/api", () => ({
	apiClient: {
		listCustomers: vi.fn(),
		onboardCustomer: vi.fn(),
		importCustomers: vi.fn(),
		updateCustomer: vi.fn(),
		deleteCustomer: vi.fn(),
		listReviewMatches: vi.fn(),
	},
}));

const mockSyncWatchlist = vi.fn();
const mockScreenCustomer = vi.fn();
const mockWatchlistVersion = vi.fn<() => string | null>(() => "wl-v1");
const mockEngineBoot = vi.fn().mockResolvedValue(undefined);
const mockFetchPublishedVersion = vi
	.fn<() => Promise<string>>()
	.mockResolvedValue("wl-v1");
const mockReloadWatchlist = vi.fn().mockResolvedValue(undefined);
vi.mock("../lib/workstation", () => ({
	workstation: vi.fn(async () => ({
		watchlistVersion: mockWatchlistVersion,
		engineBoot: mockEngineBoot,
		fetchPublishedVersion: mockFetchPublishedVersion,
		reloadWatchlist: mockReloadWatchlist,
		rescan: {
			syncWatchlist: mockSyncWatchlist,
			screenCustomer: mockScreenCustomer,
		},
	})),
}));

const mockClient = vi.mocked(apiClient);

function makeCustomer(
	overrides: Partial<CustomerResponse> = {},
): CustomerResponse {
	return {
		customer_id: "cust-1",
		tenant_id: "tenant-1",
		customer_reference: "REF-001",
		name: "Jon Q. Fakename",
		country: "US",
		dob: null,
		onboarding_status: "PENDING_REVIEW",
		kyc_risk_rating: "LOW",
		id_documents: [],
		onboarded_by: "alice",
		screening_entity_id: "ent-1",
		created_at: "2026-06-06T10:00:00Z",
		updated_at: "2026-06-06T10:00:00Z",
		...overrides,
	};
}

function makeOnboardResponse(
	overrides: Partial<CustomerOnboardResponse> = {},
): CustomerOnboardResponse {
	return {
		...makeCustomer(),
		match_entity_ids: [],
		...overrides,
	};
}

/** Render with an empty book and wait for the initial load to settle. */
async function renderEmpty(): Promise<void> {
	render(<CustomersPage />);
	await waitFor(() => expect(mockClient.listCustomers).toHaveBeenCalled());
}

/** Render with the given customers and wait for the first row to appear. */
async function renderWithCustomers(
	customers: CustomerResponse[],
): Promise<void> {
	mockClient.listCustomers.mockResolvedValue(customers);
	render(<CustomersPage />);
	await waitFor(() =>
		expect(
			screen.getByText(customers[0]?.customer_reference ?? ""),
		).toBeInTheDocument(),
	);
}

/** Open the row editor, change one control, and Save. */
function editField(label: RegExp, value: string): void {
	fireEvent.click(screen.getByRole("button", { name: "Edit REF-001" }));
	fireEvent.change(screen.getByLabelText(label), { target: { value } });
	fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

function submitMinimalOnboardForm(reference: string): void {
	fireEvent.change(screen.getByLabelText(/customer reference/i), {
		target: { value: reference },
	});
	fireEvent.change(screen.getByLabelText(/^name/i), {
		target: { value: "Jon Q. Fakename" },
	});
	fireEvent.submit(screen.getByRole("form", { name: /onboard a customer/i }));
}

describe("CustomersPage", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockClient.listCustomers.mockResolvedValue([]);
		mockClient.listReviewMatches.mockResolvedValue([]);
		mockWatchlistVersion.mockReturnValue("wl-v1");
		mockFetchPublishedVersion.mockResolvedValue("wl-v1");
		mockReloadWatchlist.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("row badges", () => {
		it("renders danger badges for REJECTED status and HIGH risk", async () => {
			await renderWithCustomers([
				makeCustomer({
					customer_reference: "REF-REJ",
					onboarding_status: "REJECTED",
					kyc_risk_rating: "HIGH",
				}),
			]);

			const row = screen.getByText("REF-REJ").closest("tr");
			if (!row) throw new Error("row not found");
			expect(
				within(row).getByText("Rejected", { selector: "span.badge" }),
			).toHaveClass("badge-danger");
			expect(
				within(row).getByText("High", { selector: "span.badge" }),
			).toHaveClass("badge-danger");
		});

		it("renders muted badges for DRAFT status and an unrated customer", async () => {
			await renderWithCustomers([
				makeCustomer({
					customer_reference: "REF-DRAFT",
					onboarding_status: "DRAFT",
					kyc_risk_rating: null,
				}),
			]);

			const row = screen.getByText("REF-DRAFT").closest("tr");
			if (!row) throw new Error("row not found");
			expect(
				within(row).getByText("Draft", { selector: "span.badge" }),
			).toHaveClass("badge-muted");
			expect(within(row).getByText("Not rated")).toHaveClass("badge-muted");
		});
	});

	describe("identity documents", () => {
		it("sends normalized id_documents and drops rows without a type + number", async () => {
			mockClient.onboardCustomer.mockResolvedValue(makeOnboardResponse());
			await renderEmpty();

			// Two rows: one real (messy input), one left blank (must be filtered).
			fireEvent.click(screen.getByRole("button", { name: /add document/i }));
			fireEvent.click(screen.getByRole("button", { name: /add document/i }));
			expect(screen.getAllByTestId("id-doc-row")).toHaveLength(2);

			fireEvent.change(screen.getByLabelText("Document type 1"), {
				target: { value: "  PASSPORT  " },
			});
			fireEvent.change(screen.getByLabelText("Document number 1"), {
				target: { value: " P-123 " },
			});
			fireEvent.change(screen.getByLabelText("Issuing country 1"), {
				target: { value: "de" },
			});
			submitMinimalOnboardForm("REF-DOCS");

			await waitFor(() =>
				expect(mockClient.onboardCustomer).toHaveBeenCalledWith(
					expect.objectContaining({
						id_documents: [
							{
								doc_type: "PASSPORT",
								number: "P-123",
								issuing_country: "DE",
								expiry: null,
							},
						],
					}),
				),
			);
			// A successful onboard resets the document rows.
			await waitFor(() =>
				expect(screen.queryAllByTestId("id-doc-row")).toHaveLength(0),
			);
		});

		it("keeps a filled expiry date on the submitted document", async () => {
			mockClient.onboardCustomer.mockResolvedValue(makeOnboardResponse());
			await renderEmpty();

			fireEvent.click(screen.getByRole("button", { name: /add document/i }));
			fireEvent.change(screen.getByLabelText("Document type 1"), {
				target: { value: "ID_CARD" },
			});
			fireEvent.change(screen.getByLabelText("Document number 1"), {
				target: { value: "ID-9" },
			});
			fireEvent.change(screen.getByLabelText("Expiry 1"), {
				target: { value: "2030-01-01" },
			});
			submitMinimalOnboardForm("REF-EXP");

			await waitFor(() =>
				expect(mockClient.onboardCustomer).toHaveBeenCalledWith(
					expect.objectContaining({
						id_documents: [
							expect.objectContaining({
								doc_type: "ID_CARD",
								number: "ID-9",
								expiry: "2030-01-01",
							}),
						],
					}),
				),
			);
		});

		it("Remove deletes exactly that row", async () => {
			await renderEmpty();

			fireEvent.click(screen.getByRole("button", { name: /add document/i }));
			fireEvent.click(screen.getByRole("button", { name: /add document/i }));
			fireEvent.change(screen.getByLabelText("Document type 2"), {
				target: { value: "KEEP-ME" },
			});

			const [firstRemove] = screen.getAllByRole("button", { name: "Remove" });
			if (!firstRemove) throw new Error("remove button not found");
			fireEvent.click(firstRemove);

			const rows = screen.getAllByTestId("id-doc-row");
			expect(rows).toHaveLength(1);
			expect(screen.getByLabelText("Document type 1")).toHaveValue("KEEP-ME");
		});
	});

	describe("action error surfaces", () => {
		it("surfaces an onboarding failure message", async () => {
			mockClient.onboardCustomer.mockRejectedValue(
				new Error("onboard exploded"),
			);
			await renderEmpty();

			submitMinimalOnboardForm("REF-ERR");

			expect(await screen.findByText(/onboard exploded/i)).toBeInTheDocument();
		});

		it("falls back to a generic message when the failure is not an Error", async () => {
			mockClient.onboardCustomer.mockRejectedValue("nope");
			await renderEmpty();

			submitMinimalOnboardForm("REF-ERR2");

			expect(
				await screen.findByText(/failed to onboard customer/i),
			).toBeInTheDocument();
		});

		it("surfaces a status-change failure", async () => {
			mockClient.updateCustomer.mockRejectedValue(new Error("status boom"));
			await renderWithCustomers([makeCustomer()]);

			editField(/status for REF-001/i, "ACTIVE");

			expect(await screen.findByText(/status boom/i)).toBeInTheDocument();
		});

		it("a risk change calls updateCustomer with the new rating", async () => {
			mockClient.updateCustomer.mockResolvedValue(
				makeCustomer({ kyc_risk_rating: "HIGH" }),
			);
			await renderWithCustomers([makeCustomer()]);

			editField(/risk for REF-001/i, "HIGH");

			await waitFor(() =>
				expect(mockClient.updateCustomer).toHaveBeenCalledWith("cust-1", {
					kyc_risk_rating: "HIGH",
				}),
			);
		});

		it("surfaces a risk-change failure", async () => {
			mockClient.updateCustomer.mockRejectedValue(new Error("risk boom"));
			await renderWithCustomers([makeCustomer()]);

			editField(/risk for REF-001/i, "MEDIUM");

			expect(await screen.findByText(/risk boom/i)).toBeInTheDocument();
		});

		it("declining the confirmation skips the delete", async () => {
			vi.spyOn(window, "confirm").mockReturnValue(false);
			await renderWithCustomers([makeCustomer()]);

			fireEvent.click(screen.getByRole("button", { name: /delete/i }));

			expect(mockClient.deleteCustomer).not.toHaveBeenCalled();
			expect(screen.getByText("REF-001")).toBeInTheDocument();
		});

		it("surfaces a delete failure", async () => {
			vi.spyOn(window, "confirm").mockReturnValue(true);
			mockClient.deleteCustomer.mockRejectedValue(new Error("delete boom"));
			await renderWithCustomers([makeCustomer()]);

			fireEvent.click(screen.getByRole("button", { name: /delete/i }));

			expect(await screen.findByText(/delete boom/i)).toBeInTheDocument();
		});

		it("surfaces an edit-save failure and does not re-screen", async () => {
			mockClient.updateCustomer.mockRejectedValue(new Error("save boom"));
			await renderWithCustomers([makeCustomer()]);

			fireEvent.click(screen.getByLabelText(/edit REF-001/i));
			fireEvent.change(screen.getByLabelText(/edit name for REF-001/i), {
				target: { value: "Renamed" },
			});
			fireEvent.click(screen.getByRole("button", { name: "Save" }));

			expect(await screen.findByText(/save boom/i)).toBeInTheDocument();
			expect(mockScreenCustomer).not.toHaveBeenCalled();
		});
	});

	describe("edit cancel", () => {
		it("Cancel leaves edit mode without saving", async () => {
			await renderWithCustomers([makeCustomer()]);

			fireEvent.click(screen.getByLabelText(/edit REF-001/i));
			expect(
				screen.getByLabelText(/edit name for REF-001/i),
			).toBeInTheDocument();

			fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

			expect(screen.queryByLabelText(/edit name for REF-001/i)).toBeNull();
			expect(screen.getByLabelText(/edit REF-001/i)).toBeInTheDocument();
			expect(mockClient.updateCustomer).not.toHaveBeenCalled();
		});
	});

	describe("check for updates (engine boot path)", () => {
		it("boots the engine first, then reports still-starting when no version appears", async () => {
			mockWatchlistVersion.mockReturnValue(null);
			await renderEmpty();

			fireEvent.click(
				screen.getByRole("button", { name: "Check for updates" }),
			);

			await waitFor(() => expect(mockEngineBoot).toHaveBeenCalledTimes(1));
			expect(
				await screen.findByText(/screening engine is still starting/i),
			).toBeInTheDocument();
			expect(mockSyncWatchlist).not.toHaveBeenCalled();
		});

		it("boots the engine then syncs once boot yields a version", async () => {
			mockWatchlistVersion.mockReturnValueOnce(null);
			mockSyncWatchlist.mockResolvedValue({
				changed: false,
				version: "wl-v1",
				customersScanned: 0,
				newHits: 0,
				clearedHits: 0,
			});
			await renderEmpty();

			fireEvent.click(
				screen.getByRole("button", { name: "Check for updates" }),
			);

			await waitFor(() => expect(mockEngineBoot).toHaveBeenCalledTimes(1));
			await waitFor(() =>
				expect(mockSyncWatchlist).toHaveBeenCalledWith("wl-v1"),
			);
			expect(
				await screen.findByText("Watchlist already current."),
			).toBeInTheDocument();
		});

		it("surfaces a failure while checking and re-enables the button", async () => {
			mockFetchPublishedVersion.mockRejectedValue(new Error("manifest down"));
			await renderEmpty();

			fireEvent.click(
				screen.getByRole("button", { name: "Check for updates" }),
			);

			expect(await screen.findByText(/manifest down/i)).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "Check for updates" }),
			).toBeEnabled();
		});
	});

	describe("onboarding optional fields + result dismissal", () => {
		it("includes onboarded_by and country when filled", async () => {
			mockClient.onboardCustomer.mockResolvedValue(makeOnboardResponse());
			await renderEmpty();

			fireEvent.change(screen.getByLabelText(/onboarded by/i), {
				target: { value: "carol" },
			});
			fireEvent.change(screen.getByLabelText(/country code/i), {
				target: { value: "de" },
			});
			submitMinimalOnboardForm("REF-FULL");

			await waitFor(() =>
				expect(mockClient.onboardCustomer).toHaveBeenCalledWith(
					expect.objectContaining({
						customer_reference: "REF-FULL",
						onboarded_by: "carol",
						country: "de",
					}),
				),
			);
		});

		it("Dismiss clears the onboarding result banner", async () => {
			mockClient.onboardCustomer.mockResolvedValue(makeOnboardResponse());
			await renderEmpty();

			submitMinimalOnboardForm("REF-DISMISS");
			expect(
				await screen.findByText(/no sanctions matches/i),
			).toBeInTheDocument();

			fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

			expect(screen.queryByText(/no sanctions matches/i)).toBeNull();
		});
	});
});
