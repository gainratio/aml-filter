/**
 * The live smoke's failed-request watch: which same-origin requests failed, and
 * which of those the smoke may excuse (see failedRequests.ts). Kept apart from
 * liveSmoke.ts and typed against a small slice of a Playwright Page, so a Vitest
 * guard can drive it with exact event orders a real page cannot be forced into
 * (src/__tests__/liveSmokeOverlap.guard.test.ts).
 */

import type { Page, Request } from "@playwright/test";
import {
	excuseEvidence,
	type FailedRequestFacts,
	isExcusedFailedRequest,
	parseContentLength,
	RequestLedger,
} from "./failedRequests";

/** The part of a Playwright Page the watch listens to. */
export type WatchedPage = Pick<Page, "on" | "url" | "mainFrame">;

/** Where classified failures go. */
export interface RequestOutcomes {
	readonly problems: string[];
	/** Failed requests the smoke excused, each with the proof it relied on. */
	readonly excused: string[];
}

/** The encoded body size Playwright received, or `null` when it cannot say. */
async function receivedBodyBytes(request: Request): Promise<number | null> {
	const sizes = await request.sizes().catch(() => null);
	return sizes?.responseBodySize ?? null;
}

/** Read what Playwright knows about a failed request. `manifestFollowed` is
 * read at settle time, once the app has had its chance to request the manifest. */
async function failedRequestFacts(
	request: Request,
	finished: ReadonlySet<Request>,
	abandonedByNavigation: boolean,
	ledger: RequestLedger<Request>,
): Promise<FailedRequestFacts> {
	const response = await request.response().catch(() => null);
	return {
		url: request.url(),
		errorText: request.failure()?.errorText ?? "unknown",
		status: response?.status() ?? null,
		finished: finished.has(request),
		receivedBodyBytes:
			response === null ? null : await receivedBodyBytes(request),
		contentLength: parseContentLength(response?.headers()["content-length"]),
		contentEncoding: response?.headers()["content-encoding"] ?? null,
		abandonedByNavigation,
		manifestFollowed: ledger.manifestFollowed(request),
	};
}

/** A failed same-origin request, held until the watch settles. */
interface FailedRequest {
	readonly request: Request;
	/** Captured when it failed, so a later navigation can never excuse it. */
	readonly abandonedByNavigation: boolean;
}

/** Add each failed request to `problems` unless it is the excused pointer
 * request (see failedRequests.ts), which goes to `excused` with its proof. */
async function recordFailedRequests(
	failed: ReadonlyArray<FailedRequest>,
	finished: ReadonlySet<Request>,
	ledger: RequestLedger<Request>,
	out: RequestOutcomes,
): Promise<void> {
	for (const { request, abandonedByNavigation } of failed) {
		const facts = await failedRequestFacts(
			request,
			finished,
			abandonedByNavigation,
			ledger,
		);
		const line = `${request.url()} (${facts.errorText})`;
		if (isExcusedFailedRequest(facts)) {
			out.excused.push(`${line}: ${excuseEvidence(facts)}`);
		} else {
			out.problems.push(`requestfailed: ${line}`);
		}
	}
}

function isMainFrameNavigation(page: WatchedPage, request: Request): boolean {
	return request.isNavigationRequest() && request.frame() === page.mainFrame();
}

/** Every request the page starts, in order (see RequestLedger). */
function trackRequests(page: WatchedPage): RequestLedger<Request> {
	const ledger = new RequestLedger<Request>();
	page.on("request", (request) => {
		ledger.note(request, request.url(), isMainFrameNavigation(page, request));
	});
	return ledger;
}

/** Watch the page's same-origin failed requests for its lifetime. Returns the
 * settle function: it classifies every failure seen so far into `out`. */
export function watchFailedRequests(
	page: WatchedPage,
	out: RequestOutcomes,
): () => Promise<void> {
	const ledger = trackRequests(page);
	const failed: FailedRequest[] = [];
	const finished = new Set<Request>();
	page.on("requestfinished", (request) => finished.add(request));
	page.on("requestfailed", (request) => {
		const origin = new URL(page.url() || request.url()).origin;
		if (request.url().startsWith(origin)) {
			failed.push({
				request,
				abandonedByNavigation: ledger.abandoned(request),
			});
		}
	});
	return async () => {
		const settling = failed.splice(0);
		await recordFailedRequests(settling, finished, ledger, out);
	};
}
