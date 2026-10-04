/**
 * What each customer row says about sanctions screening.
 *
 * The onboarding status (`PENDING_REVIEW`, `ACTIVE`, …) is a KYC approval step,
 * not a screening result: a customer with no matches is still awaiting approval.
 * Showing that status alone made a clean customer read as "pending review". This
 * module derives the screening result from the customer's review matches, so
 * the row can say "No matches" for a clean customer and a count for one that
 * still has matches to decide.
 */
import type { ReviewMatch, ReviewMatchListParams } from "./api";

/** Rows per review-match page; the store paginates (default 100). */
export const REVIEW_PAGE_SIZE = 500;

/** What the matches alone say about a customer. */
export type MatchState = "clear" | "toReview" | "confirmed" | "cleared";

/**
 * What the row may claim. "clear" and "cleared" need positive proof: the
 * customer was screened against exactly the lists loaded now. Without it the
 * row says "notScreened" (or "listsLoading" before the lists are known, or
 * "unknown" when the matches could not be read) — never "No matches".
 */
export type ScreeningState =
	| MatchState
	| "notScreened"
	| "listsLoading"
	| "unknown";

export interface ScreeningSummary {
	readonly state: MatchState;
	/** Matches still waiting for a decision (PENDING or materially CHANGED). */
	readonly open: number;
}

type ListPage = (
	params: Required<Pick<ReviewMatchListParams, "limit" | "offset">>,
) => Promise<ReviewMatch[]>;

const CLEAR: ScreeningSummary = { state: "clear", open: 0 };

/**
 * Read EVERY review match, page by page. One page would cap at the store's
 * limit, and a customer whose matches sat past it would wrongly read as clear.
 */
export async function listAllReviewMatches(
	listPage: ListPage,
): Promise<ReviewMatch[]> {
	const all: ReviewMatch[] = [];
	for (let offset = 0; ; offset += REVIEW_PAGE_SIZE) {
		const page = await listPage({ limit: REVIEW_PAGE_SIZE, offset });
		all.push(...page);
		if (page.length < REVIEW_PAGE_SIZE) return all;
	}
}

function isOpen(match: ReviewMatch): boolean {
	return (
		match.resolution_status === "PENDING" || match.review_state === "CHANGED"
	);
}

function summarize(matches: ReadonlyArray<ReviewMatch>): ScreeningSummary {
	const open = matches.filter(isOpen).length;
	if (open > 0) return { state: "toReview", open };
	const confirmed = matches.some(
		(match) => match.resolution_status === "TRUE_POSITIVE",
	);
	return { state: confirmed ? "confirmed" : "cleared", open: 0 };
}

/** Group matches by customer and summarize each customer's screening result. */
export function screeningSummaries(
	matches: ReadonlyArray<ReviewMatch>,
): ReadonlyMap<string, ScreeningSummary> {
	const byCustomer = new Map<string, ReviewMatch[]>();
	for (const match of matches) {
		if (match.customer_id === null) continue;
		const group = byCustomer.get(match.customer_id) ?? [];
		group.push(match);
		byCustomer.set(match.customer_id, group);
	}
	return new Map(
		[...byCustomer].map(([customerId, group]) => [
			customerId,
			summarize(group),
		]),
	);
}

export interface ScreeningView {
	readonly state: ScreeningState;
	readonly open: number;
}

/** The screening proof fields a customer row carries. */
export interface ScreeningProof {
	readonly customer_id: string;
	readonly screened_list_version: string | null;
}

/**
 * The row's screening state. Open or confirmed matches are real whatever the
 * proof says, so they always show. A clean or all-dismissed result is only
 * claimed when the customer's screen ran against `currentListVersion`.
 */
export function screeningStateFor(
	summaries: ReadonlyMap<string, ScreeningSummary> | null,
	customer: ScreeningProof,
	currentListVersion: string | null,
): ScreeningView {
	if (summaries === null) return { state: "unknown", open: 0 };
	const summary = screeningSummaryFor(summaries, customer.customer_id);
	if (summary.state === "toReview" || summary.state === "confirmed") {
		return summary;
	}
	if (currentListVersion === null) return { state: "listsLoading", open: 0 };
	return customer.screened_list_version === currentListVersion
		? summary
		: { state: "notScreened", open: 0 };
}

/** A customer with no review matches at all is clear. */
export function screeningSummaryFor(
	summaries: ReadonlyMap<string, ScreeningSummary>,
	customerId: string,
): ScreeningSummary {
	return summaries.get(customerId) ?? CLEAR;
}
