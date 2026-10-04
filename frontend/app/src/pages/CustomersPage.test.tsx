import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	CustomerOnboardResponse,
	CustomerResponse,
	ReviewMatch,
} from "../lib/api";
import { apiClient } from "../lib/api";
import { CustomersPage } from "./CustomersPage";

// The page talks to the backend exclusively through the apiClient singleton.
// Mock that seam so the tests drive deterministic responses with no network.
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

// The sync / re-screen path goes through the workstation handle.
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

function makeMatch(overrides: Partial<ReviewMatch> = {}): ReviewMatch {
	return {
		match_id: "m-1",
		tier: "STRONG",
		match_score: 0.9,
		match_type: "WHITELIST_VS_BLACKLIST",
		resolution_status: "PENDING",
		reviewer_id: null,
		review_notes: null,
		detected_at: "2026-06-06T10:00:00Z",
		customer_id: "cust-1",
		customer_reference: "REF-001",
		customer_name: "Jon Q. Fakename",
		sanctioned_name: "Listed Person",
		source_list: "OFAC_SDN",
		review_state: "CURRENT",
		...overrides,
	};
}

async function renderedRow(reference: string): Promise<HTMLElement> {
	render(<CustomersPage />);
	const cell = await screen.findByText(reference);
	const row = cell.closest("tr");
	if (!row) throw new Error("row not found");
	return row;
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

	it("loads and renders existing customers in a table", async () => {
		mockClient.listCustomers.mockResolvedValue([
			makeCustomer({
				customer_reference: "REF-AAA",
				onboarding_status: "ACTIVE",
				kyc_risk_rating: "MEDIUM",
				onboarded_by: "bob",
			}),
		]);

		render(<CustomersPage />);

		await waitFor(() =>
			expect(screen.getByText("REF-AAA")).toBeInTheDocument(),
		);
		const row = screen.getByText("REF-AAA").closest("tr");
		if (!row) throw new Error("row not found");
		expect(
			within(row).getByText("Approved", { selector: "span.badge" }),
		).toBeInTheDocument();
		expect(
			within(row).getByText("Medium", { selector: "span.badge" }),
		).toBeInTheDocument();
		expect(within(row).getByText("bob")).toBeInTheDocument();
		expect(mockClient.listCustomers).toHaveBeenCalled();
	});

	it("submitting the form calls onboardCustomer with the entered fields", async () => {
		mockClient.onboardCustomer.mockResolvedValue(makeOnboardResponse());

		render(<CustomersPage />);
		await waitFor(() => expect(mockClient.listCustomers).toHaveBeenCalled());

		fireEvent.change(screen.getByLabelText(/customer reference/i), {
			target: { value: "REF-NEW" },
		});
		fireEvent.change(screen.getByLabelText(/^name/i), {
			target: { value: "Jon Q. Fakename" },
		});
		fireEvent.submit(screen.getByRole("form", { name: /onboard a customer/i }));

		await waitFor(() =>
			expect(mockClient.onboardCustomer).toHaveBeenCalledWith(
				expect.objectContaining({
					customer_reference: "REF-NEW",
					name: "Jon Q. Fakename",
				}),
			),
		);
	});

	it("previews a customer CSV and commits accepted rows atomically", async () => {
		mockClient.importCustomers.mockResolvedValue({
			customers: [makeCustomer({ customer_reference: "CSV-1" })],
			screening: { customersScanned: 1, newHits: 0, clearedHits: 0 },
		});
		render(<CustomersPage />);
		await waitFor(() => expect(mockClient.listCustomers).toHaveBeenCalled());

		const file = new File(
			["customer_reference,name,country\nCSV-1,Imported Person,US"],
			"customers.csv",
			{ type: "text/csv" },
		);
		fireEvent.change(screen.getByLabelText("Customer spreadsheet"), {
			target: { files: [file] },
		});

		expect(
			await screen.findByText(/review customer import/i),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /import 1 customer/i }));

		await waitFor(() =>
			expect(mockClient.importCustomers).toHaveBeenCalledWith([
				{
					customer_reference: "CSV-1",
					name: "Imported Person",
					onboarded_by: "local",
					country: "US",
					dob: undefined,
					id_documents: [],
				},
			]),
		);
	});

	it("renders an optional Date-of-birth input in the onboarding form", async () => {
		render(<CustomersPage />);
		await waitFor(() => expect(mockClient.listCustomers).toHaveBeenCalled());

		const dobInput = screen.getByLabelText(
			/date of birth/i,
		) as HTMLInputElement;
		expect(dobInput).toBeInTheDocument();
		expect(dobInput.type).toBe("date");
		expect(dobInput.value).toBe("");
	});

	it("includes the entered DOB in the onboardCustomer call", async () => {
		mockClient.onboardCustomer.mockResolvedValue(makeOnboardResponse());

		render(<CustomersPage />);
		await waitFor(() => expect(mockClient.listCustomers).toHaveBeenCalled());

		fireEvent.change(screen.getByLabelText(/customer reference/i), {
			target: { value: "REF-DOB" },
		});
		fireEvent.change(screen.getByLabelText(/^name/i), {
			target: { value: "Ivan Fakovich" },
		});
		fireEvent.change(screen.getByLabelText(/date of birth/i), {
			target: { value: "1971-03-14" },
		});
		fireEvent.submit(screen.getByRole("form", { name: /onboard a customer/i }));

		await waitFor(() =>
			expect(mockClient.onboardCustomer).toHaveBeenCalledWith(
				expect.objectContaining({
					customer_reference: "REF-DOB",
					name: "Ivan Fakovich",
					dob: "1971-03-14",
				}),
			),
		);
	});

	it("omits dob from onboardCustomer when the DOB input is left empty", async () => {
		mockClient.onboardCustomer.mockResolvedValue(makeOnboardResponse());

		render(<CustomersPage />);
		await waitFor(() => expect(mockClient.listCustomers).toHaveBeenCalled());

		fireEvent.change(screen.getByLabelText(/customer reference/i), {
			target: { value: "REF-NODOB" },
		});
		fireEvent.change(screen.getByLabelText(/^name/i), {
			target: { value: "Jon Q. Fakename" },
		});
		fireEvent.submit(screen.getByRole("form", { name: /onboard a customer/i }));

		await waitFor(() => expect(mockClient.onboardCustomer).toHaveBeenCalled());
		const arg = mockClient.onboardCustomer.mock.calls[0]?.[0];
		expect(arg?.dob).toBeUndefined();
	});

	it("surfaces a sanctions-match warning when match_entity_ids is non-empty", async () => {
		mockClient.onboardCustomer.mockResolvedValue(
			makeOnboardResponse({ match_entity_ids: ["sdn-123", "sdn-456"] }),
		);

		render(<CustomersPage />);
		await waitFor(() => expect(mockClient.listCustomers).toHaveBeenCalled());

		fireEvent.change(screen.getByLabelText(/customer reference/i), {
			target: { value: "REF-HIT" },
		});
		fireEvent.change(screen.getByLabelText(/^name/i), {
			target: { value: "Sanctioned Person" },
		});
		fireEvent.submit(screen.getByRole("form", { name: /onboard a customer/i }));

		await waitFor(() =>
			expect(
				screen.getByText(/potential sanctions match/i),
			).toBeInTheDocument(),
		);
	});

	it("does not show a sanctions warning on a clean onboarding", async () => {
		mockClient.onboardCustomer.mockResolvedValue(
			makeOnboardResponse({ match_entity_ids: [] }),
		);

		render(<CustomersPage />);
		await waitFor(() => expect(mockClient.listCustomers).toHaveBeenCalled());

		fireEvent.change(screen.getByLabelText(/customer reference/i), {
			target: { value: "REF-CLEAN" },
		});
		fireEvent.change(screen.getByLabelText(/^name/i), {
			target: { value: "Clean Person" },
		});
		fireEvent.submit(screen.getByRole("form", { name: /onboard a customer/i }));

		await waitFor(() => expect(mockClient.onboardCustomer).toHaveBeenCalled());
		expect(screen.queryByText(/potential sanctions match/i)).toBeNull();
	});

	it("renders an error alert when loading customers fails", async () => {
		mockClient.listCustomers.mockRejectedValue(new Error("boom"));

		render(<CustomersPage />);

		await waitFor(() => expect(screen.getByText(/boom/i)).toBeInTheDocument());
	});

	it("a row status change calls updateCustomer with the new status", async () => {
		mockClient.listCustomers.mockResolvedValue([
			makeCustomer({ customer_id: "cust-row", onboarding_status: "DRAFT" }),
		]);
		mockClient.updateCustomer.mockResolvedValue(
			makeCustomer({ customer_id: "cust-row", onboarding_status: "ACTIVE" }),
		);

		render(<CustomersPage />);
		await waitFor(() =>
			expect(screen.getByText("REF-001")).toBeInTheDocument(),
		);

		fireEvent.click(screen.getByRole("button", { name: "Edit REF-001" }));
		fireEvent.change(screen.getByLabelText(/status for REF-001/i), {
			target: { value: "ACTIVE" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(mockClient.updateCustomer).toHaveBeenCalledWith("cust-row", {
				onboarding_status: "ACTIVE",
			}),
		);
	});

	it("Check for updates detects a NEW publish, reloads, and renders the re-screen summary", async () => {
		// A newer list (wl-v2) was published after this tab booted at wl-v1.
		mockFetchPublishedVersion.mockResolvedValue("wl-v2");
		mockSyncWatchlist.mockResolvedValue({
			changed: true,
			version: "wl-v2",
			customersScanned: 2,
			newHits: 1,
			clearedHits: 0,
		});

		render(<CustomersPage />);
		await waitFor(() => expect(mockClient.listCustomers).toHaveBeenCalled());

		fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

		// The new publish was reloaded into the engine before re-screening it.
		await waitFor(() => expect(mockReloadWatchlist).toHaveBeenCalledTimes(1));
		await waitFor(() =>
			expect(mockSyncWatchlist).toHaveBeenCalledWith("wl-v2"),
		);
		await waitFor(() =>
			expect(
				screen.getByText(
					"Re-screened 2 customer(s) — 1 new hit(s), 0 cleared.",
				),
			).toBeInTheDocument(),
		);
		expect(screen.getByText(/Last synced: wl-v2/)).toBeInTheDocument();
	});

	it("Check for updates on an unchanged watchlist shows 'already current'", async () => {
		mockSyncWatchlist.mockResolvedValue({
			changed: false,
			version: "wl-v1",
			customersScanned: 0,
			newHits: 0,
			clearedHits: 0,
		});

		render(<CustomersPage />);
		await waitFor(() => expect(mockClient.listCustomers).toHaveBeenCalled());

		fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

		await waitFor(() =>
			expect(
				screen.getByText("Watchlist already current."),
			).toBeInTheDocument(),
		);
		// No new publish → no reload.
		expect(mockReloadWatchlist).not.toHaveBeenCalled();
	});

	it("editing a row saves name/country then re-screens the customer", async () => {
		mockClient.listCustomers.mockResolvedValue([
			makeCustomer({ customer_id: "cust-edit" }),
		]);
		mockClient.updateCustomer.mockResolvedValue(
			makeCustomer({ customer_id: "cust-edit" }),
		);
		mockScreenCustomer.mockResolvedValue([]);

		render(<CustomersPage />);
		await waitFor(() =>
			expect(screen.getByText("REF-001")).toBeInTheDocument(),
		);

		fireEvent.click(screen.getByRole("button", { name: "Edit REF-001" }));
		fireEvent.change(screen.getByLabelText(/edit name for/i), {
			target: { value: "Renamed Person" },
		});
		fireEvent.change(screen.getByLabelText(/edit country for/i), {
			target: { value: "DE" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(mockClient.updateCustomer).toHaveBeenCalledWith("cust-edit", {
				name: "Renamed Person",
				country: "DE",
			}),
		);
		await waitFor(() =>
			expect(mockScreenCustomer).toHaveBeenCalledWith("cust-edit"),
		);
	});

	it("deleting a row calls deleteCustomer after confirmation", async () => {
		mockClient.listCustomers.mockResolvedValue([
			makeCustomer({ customer_id: "cust-del" }),
		]);
		mockClient.deleteCustomer.mockResolvedValue(undefined);
		vi.spyOn(window, "confirm").mockReturnValue(true);

		render(<CustomersPage />);
		await waitFor(() =>
			expect(screen.getByText("REF-001")).toBeInTheDocument(),
		);

		const row = screen.getByText("REF-001").closest("tr");
		if (!row) throw new Error("row not found");
		fireEvent.click(within(row).getByRole("button", { name: /delete/i }));

		await waitFor(() =>
			expect(mockClient.deleteCustomer).toHaveBeenCalledWith("cust-del"),
		);
	});
});

describe("CustomersPage — the customer row reads as plain, truthful words", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockClient.listReviewMatches.mockResolvedValue([]);
	});

	it("a clean customer reads as No matches, never as pending review", async () => {
		mockClient.listCustomers.mockResolvedValue([
			makeCustomer({ onboarding_status: "PENDING_REVIEW" }),
		]);
		const row = await renderedRow("REF-001");
		expect(await within(row).findByText("No matches")).toBeInTheDocument();
		expect(row.textContent).not.toMatch(/pending.?review/i);
	});

	it("a customer with undecided matches says how many need review", async () => {
		mockClient.listCustomers.mockResolvedValue([makeCustomer()]);
		mockClient.listReviewMatches.mockResolvedValue([
			makeMatch({ match_id: "a" }),
			makeMatch({ match_id: "b" }),
		]);
		const row = await renderedRow("REF-001");
		expect(await within(row).findByText("2 to review")).toBeInTheDocument();
		expect(within(row).queryByText("No matches")).toBeNull();
	});

	it("never calls a customer clear when the matches could not be read", async () => {
		mockClient.listCustomers.mockResolvedValue([makeCustomer()]);
		mockClient.listReviewMatches.mockRejectedValue(new Error("db busy"));
		const row = await renderedRow("REF-001");
		expect(await within(row).findByText("Not checked")).toBeInTheDocument();
		expect(within(row).queryByText("No matches")).toBeNull();
	});

	it("shows no raw status or risk codes", async () => {
		mockClient.listCustomers.mockResolvedValue([
			makeCustomer({ onboarding_status: "ACTIVE", kyc_risk_rating: null }),
		]);
		const row = await renderedRow("REF-001");
		expect(within(row).getByText("Approved")).toBeInTheDocument();
		expect(within(row).getByText("Not rated")).toBeInTheDocument();
		expect(row.textContent).not.toMatch(
			/ACTIVE|PENDING_REVIEW|UNRATED|LOW|MEDIUM|HIGH/,
		);
	});

	it("shows a human label instead of the internal 'local' actor id", async () => {
		mockClient.listCustomers.mockResolvedValue([
			makeCustomer({ onboarded_by: "local" }),
		]);
		const row = await renderedRow("REF-001");
		expect(within(row).getByText("No name given")).toBeInTheDocument();
		expect(row.textContent).not.toMatch(/\blocal\b/);
	});

	it("keeps each row to one compact action group: Edit and Delete, no dropdowns", async () => {
		mockClient.listCustomers.mockResolvedValue([makeCustomer()]);
		const row = await renderedRow("REF-001");
		expect(within(row).queryAllByRole("combobox")).toHaveLength(0);
		const group = within(row).getByRole("group", {
			name: "Actions for REF-001",
		});
		expect(
			within(group)
				.getAllByRole("button")
				.map((button) => button.getAttribute("aria-label")),
		).toEqual(["Edit REF-001", "Delete REF-001"]);
	});

	it("Edit opens one labelled editor with status and risk, and Save sends only what changed", async () => {
		mockClient.listCustomers.mockResolvedValue([
			makeCustomer({ customer_id: "cust-ed", kyc_risk_rating: null }),
		]);
		mockClient.updateCustomer.mockResolvedValue(makeCustomer());
		await renderedRow("REF-001");

		fireEvent.click(screen.getByRole("button", { name: "Edit REF-001" }));
		const editor = screen.getByRole("group", { name: "Editing REF-001" });
		fireEvent.change(within(editor).getByLabelText(/risk for REF-001/i), {
			target: { value: "HIGH" },
		});
		// Options read as words too.
		expect(
			within(editor).getByRole("option", { name: "Awaiting approval" }),
		).toBeInTheDocument();
		fireEvent.click(within(editor).getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(mockClient.updateCustomer).toHaveBeenCalledWith("cust-ed", {
				kyc_risk_rating: "HIGH",
			}),
		);
		// Identity unchanged → no re-screen.
		expect(mockScreenCustomer).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(
				screen.queryByRole("group", { name: "Editing REF-001" }),
			).toBeNull(),
		);
	});
});
