import { describe, expect, it, vi } from "vitest";
import type { ReviewMatch } from "./api";
import {
	listAllReviewMatches,
	REVIEW_PAGE_SIZE,
	screeningStateFor,
	screeningSummaries,
	screeningSummaryFor,
} from "./customerScreening";

function match(overrides: Partial<ReviewMatch> = {}): ReviewMatch {
	return {
		match_id: "m-1",
		tier: "STRONG",
		match_score: 0.9,
		match_type: "WHITELIST_VS_BLACKLIST",
		resolution_status: "PENDING",
		reviewer_id: null,
		review_notes: null,
		detected_at: "2026-10-01T00:00:00Z",
		customer_id: "c-1",
		customer_reference: "REF-1",
		customer_name: "Someone",
		sanctioned_name: "Listed Person",
		source_list: "OFAC_SDN",
		review_state: "CURRENT",
		...overrides,
	};
}

describe("screeningSummaryFor — what the customer row says about screening", () => {
	it("a customer with no matches is clear", () => {
		const summaries = screeningSummaries([match({ customer_id: "other" })]);
		expect(screeningSummaryFor(summaries, "c-1")).toEqual({
			state: "clear",
			open: 0,
		});
	});

	it("counts every match still waiting for a decision", () => {
		const summaries = screeningSummaries([
			match({ match_id: "a" }),
			match({ match_id: "b" }),
			match({ match_id: "c", resolution_status: "FALSE_POSITIVE" }),
		]);
		expect(screeningSummaryFor(summaries, "c-1")).toEqual({
			state: "toReview",
			open: 2,
		});
	});

	it("a decided match that CHANGED needs review again", () => {
		const summaries = screeningSummaries([
			match({ resolution_status: "FALSE_POSITIVE", review_state: "CHANGED" }),
		]);
		expect(screeningSummaryFor(summaries, "c-1").state).toBe("toReview");
	});

	it("a confirmed match outranks dismissed ones", () => {
		const summaries = screeningSummaries([
			match({ match_id: "a", resolution_status: "FALSE_POSITIVE" }),
			match({ match_id: "b", resolution_status: "TRUE_POSITIVE" }),
		]);
		expect(screeningSummaryFor(summaries, "c-1")).toEqual({
			state: "confirmed",
			open: 0,
		});
	});

	it("matches all ruled out read as cleared after review", () => {
		const summaries = screeningSummaries([
			match({ match_id: "a", resolution_status: "FALSE_POSITIVE" }),
			match({ match_id: "b", resolution_status: "RESOLVED" }),
		]);
		expect(screeningSummaryFor(summaries, "c-1").state).toBe("cleared");
	});
});

describe("listAllReviewMatches — every match, not just the first page", () => {
	it("pins the page size", () => {
		expect(REVIEW_PAGE_SIZE).toBe(500);
	});

	it("keeps reading pages until a short page, so no customer looks clear by truncation", async () => {
		const full = Array.from({ length: REVIEW_PAGE_SIZE }, (_, i) =>
			match({ match_id: `p1-${i}`, customer_id: "busy" }),
		);
		const last = [match({ match_id: "p2-0", customer_id: "c-late" })];
		const list = vi
			.fn<
				(params: { limit: number; offset: number }) => Promise<ReviewMatch[]>
			>()
			.mockResolvedValueOnce(full)
			.mockResolvedValueOnce(last);

		const all = await listAllReviewMatches(list);

		expect(all).toHaveLength(REVIEW_PAGE_SIZE + 1);
		expect(list).toHaveBeenNthCalledWith(1, {
			limit: REVIEW_PAGE_SIZE,
			offset: 0,
		});
		expect(list).toHaveBeenNthCalledWith(2, {
			limit: REVIEW_PAGE_SIZE,
			offset: REVIEW_PAGE_SIZE,
		});
		expect(screeningSummaryFor(screeningSummaries(all), "c-late").state).toBe(
			"toReview",
		);
	});
});

describe("screeningStateFor — clear needs proof against the current lists", () => {
	const clean = screeningSummaries([]);
	const proven = { customer_id: "c-1", screened_list_version: "L@1" };

	it("proven against the loaded lists and no matches: clear", () => {
		expect(screeningStateFor(clean, proven, "L@1").state).toBe("clear");
	});

	it("never screened: not screened yet", () => {
		expect(
			screeningStateFor(
				clean,
				{ ...proven, screened_list_version: null },
				"L@1",
			).state,
		).toBe("notScreened");
	});

	it("screened against other lists: not screened yet", () => {
		expect(screeningStateFor(clean, proven, "L@2").state).toBe("notScreened");
	});

	it("lists not loaded yet: loading, never clear", () => {
		expect(screeningStateFor(clean, proven, null).state).toBe("listsLoading");
	});

	it("matches could not be read: unknown", () => {
		expect(screeningStateFor(null, proven, "L@1").state).toBe("unknown");
	});

	it("dismissed matches need proof too before reading cleared", () => {
		const dismissed = screeningSummaries([
			match({ resolution_status: "FALSE_POSITIVE" }),
		]);
		expect(screeningStateFor(dismissed, proven, "L@1").state).toBe("cleared");
		expect(screeningStateFor(dismissed, proven, "L@2").state).toBe(
			"notScreened",
		);
	});

	it("open or confirmed matches show regardless of proof", () => {
		const open = screeningSummaries([match()]);
		expect(screeningStateFor(open, proven, null).state).toBe("toReview");
	});
});
