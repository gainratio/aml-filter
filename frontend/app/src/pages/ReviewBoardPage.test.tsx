import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatchEvent, ReviewMatch } from "../lib/api";
import { apiClient } from "../lib/api";
import ReviewBoardPage from "./ReviewBoardPage";

// The page talks to the backend exclusively through the apiClient singleton.
// Mock that seam so the tests drive deterministic responses with no network.
vi.mock("../lib/api", () => ({
	apiClient: {
		listReviewMatches: vi.fn(),
		resolveReviewMatch: vi.fn(),
		getMatchEvents: vi.fn(),
	},
}));

const mockClient = vi.mocked(apiClient);

function renderBoard() {
	return render(
		<MemoryRouter initialEntries={["/review"]}>
			<Routes>
				<Route path="/review" element={<ReviewBoardPage />} />
			</Routes>
		</MemoryRouter>,
	);
}

function makeMatch(overrides: Partial<ReviewMatch> = {}): ReviewMatch {
	return {
		match_id: "match-1",
		tier: "STRONG",
		match_score: 0.95,
		match_type: "NAME",
		resolution_status: "PENDING",
		reviewer_id: null,
		review_notes: null,
		detected_at: "2026-06-06T10:00:00Z",
		customer_id: "cust-1",
		customer_reference: "REF-001",
		customer_name: "Jon Q. Fakename",
		sanctioned_name: "John Fakename",
		source_list: "OFAC_SDN",
		review_state: "CURRENT",
		...overrides,
	};
}

function makeEvent(overrides: Partial<MatchEvent> = {}): MatchEvent {
	return {
		event_id: "evt-1",
		match_id: "match-1",
		customer_id: "cust-1",
		ofac_entity_id: "ofac-1",
		event_type: "DETECTED",
		from_status: null,
		to_status: null,
		reviewer_id: null,
		notes: null,
		at: "2026-06-06T10:00:00Z",
		...overrides,
	};
}

describe("ReviewBoardPage", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockClient.listReviewMatches.mockResolvedValue([]);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders matches with the correct tier badge variant", async () => {
		mockClient.listReviewMatches.mockResolvedValue([
			makeMatch({
				match_id: "m-strong",
				tier: "STRONG",
				customer_reference: "R-STRONG",
			}),
			makeMatch({
				match_id: "m-possible",
				tier: "POSSIBLE",
				customer_reference: "R-POSSIBLE",
			}),
			makeMatch({
				match_id: "m-weak",
				tier: "WEAK",
				customer_reference: "R-WEAK",
			}),
		]);

		renderBoard();

		await waitFor(() =>
			expect(screen.getByText("R-STRONG")).toBeInTheDocument(),
		);

		const strongRow = screen.getByText("R-STRONG").closest("tr");
		const possibleRow = screen.getByText("R-POSSIBLE").closest("tr");
		const weakRow = screen.getByText("R-WEAK").closest("tr");
		if (!strongRow || !possibleRow || !weakRow)
			throw new Error("rows not found");

		expect(
			within(strongRow).getByText("Strong", { selector: "span.badge" }),
		).toHaveClass("badge-danger");
		expect(
			within(possibleRow).getByText("Possible", { selector: "span.badge" }),
		).toHaveClass("badge-warning");
		expect(
			within(weakRow).getByText("Weak", { selector: "span.badge" }),
		).toHaveClass("badge-muted");
	});

	it("renders the empty state when there are no matches", async () => {
		mockClient.listReviewMatches.mockResolvedValue([]);

		renderBoard();

		await waitFor(() =>
			expect(screen.getByText(/no matches/i)).toBeInTheDocument(),
		);
	});

	it("changing the tier filter calls the client with that tier", async () => {
		renderBoard();
		await waitFor(() =>
			expect(mockClient.listReviewMatches).toHaveBeenCalled(),
		);

		fireEvent.change(screen.getByLabelText(/filter by tier/i), {
			target: { value: "STRONG" },
		});

		await waitFor(() =>
			expect(mockClient.listReviewMatches).toHaveBeenCalledWith(
				expect.objectContaining({ tier: "STRONG" }),
			),
		);
	});

	it("changing the status filter calls the client with that status", async () => {
		renderBoard();
		await waitFor(() =>
			expect(mockClient.listReviewMatches).toHaveBeenCalled(),
		);

		fireEvent.change(screen.getByLabelText(/filter by status/i), {
			target: { value: "TRUE_POSITIVE" },
		});

		await waitFor(() =>
			expect(mockClient.listReviewMatches).toHaveBeenCalledWith(
				expect.objectContaining({ resolution_status: "TRUE_POSITIVE" }),
			),
		);
	});

	it("resolving a pending row PUTs disposition with reviewer and notes and updates the row", async () => {
		mockClient.listReviewMatches.mockResolvedValue([
			makeMatch({ match_id: "m-1", customer_reference: "REF-RES" }),
		]);
		mockClient.resolveReviewMatch.mockResolvedValue(
			makeMatch({
				match_id: "m-1",
				customer_reference: "REF-RES",
				resolution_status: "FALSE_POSITIVE",
				reviewer_id: "alice",
				review_notes: "known good",
			}),
		);

		renderBoard();
		await waitFor(() =>
			expect(screen.getByText("REF-RES")).toBeInTheDocument(),
		);

		const row = screen.getByText("REF-RES").closest("tr");
		if (!row) throw new Error("row not found");

		fireEvent.change(within(row).getByLabelText(/disposition/i), {
			target: { value: "FALSE_POSITIVE" },
		});
		fireEvent.change(within(row).getByLabelText(/reviewer/i), {
			target: { value: "alice" },
		});
		fireEvent.change(within(row).getByLabelText(/notes/i), {
			target: { value: "known good" },
		});
		fireEvent.click(within(row).getByRole("button", { name: /resolve/i }));

		await waitFor(() =>
			expect(mockClient.resolveReviewMatch).toHaveBeenCalledWith(
				"m-1",
				"FALSE_POSITIVE",
				{ reviewer_id: "alice", review_notes: "known good" },
			),
		);

		// The row updates in place: status badge now reflects the resolution,
		// in plain words (the code FALSE_POSITIVE stays the data, not the text).
		await waitFor(() => {
			const updated = screen.getByText("REF-RES").closest("tr");
			if (!updated) throw new Error("row not found");
			expect(
				within(updated).getByText("Not a match", { selector: "span.badge" }),
			).toBeInTheDocument();
		});
	});

	it("renders an error alert when loading fails", async () => {
		mockClient.listReviewMatches.mockRejectedValue(new Error("boom"));

		renderBoard();

		await waitFor(() => expect(screen.getByText(/boom/i)).toBeInTheDocument());
	});

	it("renders the View filter with three options and selecting 'Needs review' calls the client with needsReview", async () => {
		renderBoard();
		await waitFor(() =>
			expect(mockClient.listReviewMatches).toHaveBeenCalled(),
		);

		const viewFilter = await screen.findByLabelText(/view/i);
		expect(within(viewFilter).getAllByRole("option")).toHaveLength(3);

		fireEvent.change(viewFilter, { target: { value: "NEEDS_REVIEW" } });

		await waitFor(() =>
			expect(mockClient.listReviewMatches).toHaveBeenCalledWith(
				expect.objectContaining({ needsReview: true }),
			),
		);
	});

	it("selecting 'Changed only' in the View filter calls the client with reviewState CHANGED", async () => {
		renderBoard();
		await waitFor(() =>
			expect(mockClient.listReviewMatches).toHaveBeenCalled(),
		);

		fireEvent.change(await screen.findByLabelText(/view/i), {
			target: { value: "CHANGED" },
		});

		await waitFor(() =>
			expect(mockClient.listReviewMatches).toHaveBeenCalledWith(
				expect.objectContaining({ reviewState: "CHANGED" }),
			),
		);
	});

	it("renders the CHANGED re-review badge only for rows whose review_state is CHANGED", async () => {
		mockClient.listReviewMatches.mockResolvedValue([
			makeMatch({
				match_id: "m-changed",
				customer_reference: "R-CHANGED",
				review_state: "CHANGED",
			}),
			makeMatch({
				match_id: "m-current",
				customer_reference: "R-CURRENT",
				review_state: "CURRENT",
			}),
		]);

		renderBoard();
		await waitFor(() =>
			expect(screen.getByText("R-CHANGED")).toBeInTheDocument(),
		);

		const changedRow = screen.getByText("R-CHANGED").closest("tr");
		const currentRow = screen.getByText("R-CURRENT").closest("tr");
		if (!changedRow || !currentRow) throw new Error("rows not found");

		expect(
			within(changedRow).getByText(/CHANGED — needs re-review/i),
		).toBeInTheDocument();
		expect(
			within(currentRow).queryByText(/CHANGED — needs re-review/i),
		).toBeNull();
	});

	it("renders the Resolve controls for a CHANGED row that already has a disposition", async () => {
		mockClient.listReviewMatches.mockResolvedValue([
			makeMatch({
				match_id: "m-changed-resolved",
				customer_reference: "R-CHANGED-RES",
				resolution_status: "FALSE_POSITIVE",
				reviewer_id: "alice",
				review_notes: "previously cleared",
				review_state: "CHANGED",
			}),
		]);

		renderBoard();
		await waitFor(() =>
			expect(screen.getByText("R-CHANGED-RES")).toBeInTheDocument(),
		);

		const row = screen.getByText("R-CHANGED-RES").closest("tr");
		if (!row) throw new Error("row not found");

		expect(
			within(row).getByRole("button", { name: /resolve/i }),
		).toBeInTheDocument();
		expect(within(row).getByLabelText(/disposition/i)).toBeInTheDocument();
		expect(within(row).queryByText("Resolved")).toBeNull();
	});

	it("does not render the Resolve controls for a CURRENT row that already has a disposition", async () => {
		mockClient.listReviewMatches.mockResolvedValue([
			makeMatch({
				match_id: "m-current-resolved",
				customer_reference: "R-CURRENT-RES",
				resolution_status: "FALSE_POSITIVE",
				reviewer_id: "alice",
				review_notes: "cleared",
				review_state: "CURRENT",
			}),
		]);

		renderBoard();
		await waitFor(() =>
			expect(screen.getByText("R-CURRENT-RES")).toBeInTheDocument(),
		);

		const row = screen.getByText("R-CURRENT-RES").closest("tr");
		if (!row) throw new Error("row not found");

		expect(within(row).queryByRole("button", { name: /resolve/i })).toBeNull();
		expect(within(row).queryByLabelText(/disposition/i)).toBeNull();
		expect(within(row).getByText("Resolved")).toBeInTheDocument();
	});

	it("renders the source_list as a plain-named Source badge for a row", async () => {
		mockClient.listReviewMatches.mockResolvedValue([
			makeMatch({
				match_id: "m-src",
				customer_reference: "R-SRC",
				source_list: "OFAC_SDN",
			}),
		]);

		renderBoard();
		await waitFor(() => expect(screen.getByText("R-SRC")).toBeInTheDocument());

		const row = screen.getByText("R-SRC").closest("tr");
		if (!row) throw new Error("row not found");
		expect(
			within(row).getByText("US OFAC", { selector: "span.badge" }),
		).toBeInTheDocument();
	});

	it("clicking History loads and renders the event timeline, then collapses on a second click", async () => {
		mockClient.listReviewMatches.mockResolvedValue([
			makeMatch({ match_id: "m-hist", customer_reference: "R-HIST" }),
		]);
		mockClient.getMatchEvents.mockResolvedValue([
			makeEvent({
				event_id: "e1",
				match_id: "m-hist",
				event_type: "DETECTED",
			}),
			makeEvent({
				event_id: "e2",
				match_id: "m-hist",
				event_type: "DISPOSITIONED",
				from_status: "PENDING",
				to_status: "FALSE_POSITIVE",
				reviewer_id: "alice",
				notes: "cleared on review",
			}),
		]);

		renderBoard();
		await waitFor(() => expect(screen.getByText("R-HIST")).toBeInTheDocument());

		const row = screen.getByText("R-HIST").closest("tr");
		if (!row) throw new Error("row not found");

		const historyBtn = within(row).getByRole("button", { name: /history/i });
		expect(historyBtn).toHaveAttribute("aria-expanded", "false");

		fireEvent.click(historyBtn);

		await waitFor(() =>
			expect(mockClient.getMatchEvents).toHaveBeenCalledWith("m-hist"),
		);
		await waitFor(() =>
			expect(screen.getByText("Decision recorded")).toBeInTheDocument(),
		);
		expect(screen.getByText(/cleared on review/i)).toBeInTheDocument();
		expect(historyBtn).toHaveAttribute("aria-expanded", "true");

		fireEvent.click(historyBtn);
		await waitFor(() =>
			expect(screen.queryByText(/cleared on review/i)).toBeNull(),
		);
	});

	it("offers no File SAR control in the local-first slice (route is unrouted)", async () => {
		mockClient.listReviewMatches.mockResolvedValue([
			makeMatch({
				match_id: "m-strong",
				tier: "STRONG",
				customer_reference: "R-STRONG",
			}),
		]);
		renderBoard();
		await waitFor(() =>
			expect(screen.getByText("R-STRONG")).toBeInTheDocument(),
		);
		expect(screen.queryByRole("button", { name: /file sar/i })).toBeNull();
		expect(screen.queryByText("SAR")).toBeNull();
	});

	describe("plain words, never raw codes", () => {
		const RAW_CODE =
			/\b(UK_OFSI|OFAC_SDN|EU_CONSOLIDATED|UN_CONSOLIDATED|FALSE_POSITIVE|TRUE_POSITIVE|PENDING_REVIEW|PENDING|STRONG|POSSIBLE|WEAK|RESOLVED|DETECTED|DISPOSITIONED)\b/;

		function optionPairs(select: HTMLElement): [string, string][] {
			return within(select)
				.getAllByRole("option")
				.map((o) => [(o as HTMLOptionElement).value, o.textContent ?? ""]);
		}

		it("renders tier, status and source in plain words with no raw code in the text", async () => {
			mockClient.listReviewMatches.mockResolvedValue([
				makeMatch({
					match_id: "m-uk",
					customer_reference: "R-UK",
					tier: "STRONG",
					source_list: "UK_OFSI",
					resolution_status: "PENDING",
				}),
				makeMatch({
					match_id: "m-eu",
					customer_reference: "R-EU",
					tier: "POSSIBLE",
					source_list: "EU_CONSOLIDATED",
					resolution_status: "FALSE_POSITIVE",
					review_state: "CHANGED",
				}),
				makeMatch({
					match_id: "m-us",
					customer_reference: "R-US",
					tier: "WEAK",
					source_list: "OFAC_SDN",
					resolution_status: "TRUE_POSITIVE",
				}),
			]);

			const { container } = renderBoard();
			await waitFor(() => expect(screen.getByText("R-UK")).toBeInTheDocument());

			const ukRow = screen.getByText("R-UK").closest("tr");
			const euRow = screen.getByText("R-EU").closest("tr");
			const usRow = screen.getByText("R-US").closest("tr");
			if (!ukRow || !euRow || !usRow) throw new Error("rows not found");
			expect(
				within(ukRow).getByText("Strong", { selector: "span.badge" }),
			).toBeInTheDocument();
			expect(
				within(ukRow).getByText("UK Sanctions List", {
					selector: "span.badge",
				}),
			);
			expect(
				within(ukRow).getByText("Needs review", { selector: "span.badge" }),
			).toBeInTheDocument();
			expect(
				within(euRow).getByText("EU", { selector: "span.badge" }),
			).toBeInTheDocument();
			expect(
				within(euRow).getByText("Not a match", { selector: "span.badge" }),
			).toBeInTheDocument();
			expect(
				within(usRow).getByText("Confirmed match", { selector: "span.badge" }),
			);
			expect(container.textContent ?? "").not.toMatch(RAW_CODE);
		});

		it("keeps codes as option values while the filter options read in plain words", async () => {
			renderBoard();
			await waitFor(() =>
				expect(mockClient.listReviewMatches).toHaveBeenCalled(),
			);

			expect(optionPairs(screen.getByLabelText(/filter by tier/i))).toEqual([
				["", "All tiers"],
				["STRONG", "Strong"],
				["POSSIBLE", "Possible"],
				["WEAK", "Weak"],
			]);
			expect(optionPairs(screen.getByLabelText(/filter by status/i))).toEqual([
				["", "All statuses"],
				["PENDING", "Needs review"],
				["TRUE_POSITIVE", "Confirmed match"],
				["FALSE_POSITIVE", "Not a match"],
				["RESOLVED", "Closed"],
			]);
		});

		it("keeps codes as disposition values while the options read in plain words", async () => {
			mockClient.listReviewMatches.mockResolvedValue([
				makeMatch({ match_id: "m-d", customer_reference: "R-D" }),
			]);
			renderBoard();
			await waitFor(() => expect(screen.getByText("R-D")).toBeInTheDocument());

			const select = screen.getByLabelText("Disposition for R-D");
			expect(select).toHaveClass("review-resolve-select");
			expect(select).toHaveValue("FALSE_POSITIVE");
			expect(optionPairs(select)).toEqual([
				["TRUE_POSITIVE", "Confirmed match"],
				["FALSE_POSITIVE", "Not a match"],
				["RESOLVED", "Closed"],
			]);
		});

		it("renders the history event and its status change in plain words", async () => {
			mockClient.listReviewMatches.mockResolvedValue([
				makeMatch({ match_id: "m-h", customer_reference: "R-H" }),
			]);
			mockClient.getMatchEvents.mockResolvedValue([
				makeEvent({ event_id: "e1", match_id: "m-h", event_type: "DETECTED" }),
				makeEvent({
					event_id: "e2",
					match_id: "m-h",
					event_type: "DISPOSITIONED",
					from_status: "PENDING",
					to_status: "TRUE_POSITIVE",
				}),
			]);
			renderBoard();
			await waitFor(() => expect(screen.getByText("R-H")).toBeInTheDocument());

			fireEvent.click(screen.getByRole("button", { name: /history for R-H/i }));
			const item = await screen.findByText("Decision recorded");
			const li = item.closest("li");
			if (!li) throw new Error("history item not found");
			expect(li).toHaveTextContent("(Needs review → Confirmed match)");
			expect(screen.getByText("Match found")).toBeInTheDocument();
			const list = li.closest("ul");
			expect(list?.textContent ?? "").not.toMatch(RAW_CODE);
		});
	});
});
