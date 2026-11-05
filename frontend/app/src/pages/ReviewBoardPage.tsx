/**
 * Review / case board — institutional sanctions screening triage, scoring
 * evidence inspection, and local-first FinCEN SAR regulatory reporting.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	apiClient,
	type CreateSarPayload,
	type MatchTier,
	type ReviewMatch,
	type ReviewMatchListParams,
	type ReviewResolutionStatus,
	type SarRecord,
} from "../lib/api";
import { resolutionLabel, tierLabel } from "../lib/plainLabels";
import {
	type HistoryEntry,
	MatchRow,
	type ResolveDraft,
} from "./ReviewMatchRow";
import { SarFilingModal } from "./SarFilingModal";
import { SarRegistryPanel } from "./SarRegistryPanel";

const REVIEW_NAMESPACES = ["review", "common"] as const;

const TIER_FILTERS: MatchTier[] = ["STRONG", "POSSIBLE", "WEAK"];

const STATUS_FILTERS: ReviewResolutionStatus[] = [
	"PENDING",
	"TRUE_POSITIVE",
	"FALSE_POSITIVE",
	"RESOLVED",
];

type ViewFilter = "ALL" | "NEEDS_REVIEW" | "CHANGED";

type QueueTabId =
	| "ALL"
	| "NEEDS_REVIEW"
	| "STRONG"
	| "CHANGED"
	| "CONFIRMED"
	| "CLEARED"
	| "SARS";

const VIEW_OPTIONS: { value: ViewFilter; labelKey: string }[] = [
	{ value: "ALL", labelKey: "filters.view.options.all" },
	{ value: "NEEDS_REVIEW", labelKey: "filters.view.options.needsReview" },
	{ value: "CHANGED", labelKey: "filters.view.options.changed" },
];

const EMPTY_DRAFT: ResolveDraft = {
	disposition: "FALSE_POSITIVE",
	reviewer_id: "",
	review_notes: "",
};

function errorMessage(err: unknown, fallback: string): string {
	return err instanceof Error ? err.message : fallback;
}

function viewParams(view: ViewFilter): ReviewMatchListParams {
	if (view === "NEEDS_REVIEW") return { needsReview: true };
	if (view === "CHANGED") return { reviewState: "CHANGED" };
	return {};
}

function deriveQueueTab(
	panel: "CASES" | "SARS",
	tier: MatchTier | "",
	status: ReviewResolutionStatus | "",
	view: ViewFilter,
): QueueTabId | null {
	if (panel === "SARS") return "SARS";
	if (!tier && !status && view === "ALL") return "ALL";
	if (!tier && !status && view === "NEEDS_REVIEW") return "NEEDS_REVIEW";
	if (tier === "STRONG" && !status && view === "ALL") return "STRONG";
	if (!tier && !status && view === "CHANGED") return "CHANGED";
	if (!tier && status === "TRUE_POSITIVE" && view === "ALL") return "CONFIRMED";
	if (!tier && status === "FALSE_POSITIVE" && view === "ALL") return "CLEARED";
	return null;
}

export function ReviewBoardPage() {
	const { t } = useTranslation(REVIEW_NAMESPACES);
	const [matches, setMatches] = useState<ReviewMatch[]>([]);
	const [sars, setSars] = useState<SarRecord[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [tier, setTier] = useState<MatchTier | "">("");
	const [status, setStatus] = useState<ReviewResolutionStatus | "">("");
	const [view, setView] = useState<ViewFilter>("ALL");
	const [panel, setPanel] = useState<"CASES" | "SARS">("CASES");
	const [drafts, setDrafts] = useState<Record<string, ResolveDraft>>({});
	const [openHistoryId, setOpenHistoryId] = useState<string | null>(null);
	const [history, setHistory] = useState<Record<string, HistoryEntry>>({});
	const [sarModalMatch, setSarModalMatch] = useState<ReviewMatch | null>(null);

	const loadSars = useCallback(async () => {
		if (typeof apiClient.listSars !== "function") return;
		try {
			setSars(await apiClient.listSars());
		} catch {
			// Non-fatal in mock environments without SAR store
		}
	}, []);

	const loadMatches = useCallback(async () => {
		try {
			setLoading(true);
			setError(null);
			const params: ReviewMatchListParams = { ...viewParams(view) };
			if (tier) params.tier = tier;
			if (status) params.resolution_status = status;
			const data = await apiClient.listReviewMatches(params);
			setMatches(data);
		} catch (err) {
			setError(errorMessage(err, t("status.loadFailed")));
		} finally {
			setLoading(false);
		}
	}, [tier, status, view, t]);

	useEffect(() => {
		loadMatches();
	}, [loadMatches]);

	useEffect(() => {
		loadSars();
	}, [loadSars]);

	const selectQueueTab = (tab: QueueTabId) => {
		if (tab === "SARS") {
			setPanel("SARS");
			return;
		}
		setPanel("CASES");
		if (tab === "ALL") {
			setTier("");
			setStatus("");
			setView("ALL");
		} else if (tab === "NEEDS_REVIEW") {
			setTier("");
			setStatus("");
			setView("NEEDS_REVIEW");
		} else if (tab === "STRONG") {
			setTier("STRONG");
			setStatus("");
			setView("ALL");
		} else if (tab === "CHANGED") {
			setTier("");
			setStatus("");
			setView("CHANGED");
		} else if (tab === "CONFIRMED") {
			setTier("");
			setStatus("TRUE_POSITIVE");
			setView("ALL");
		} else if (tab === "CLEARED") {
			setTier("");
			setStatus("FALSE_POSITIVE");
			setView("ALL");
		}
	};

	const draftFor = (matchId: string): ResolveDraft =>
		drafts[matchId] ?? EMPTY_DRAFT;

	const updateDraft = (
		matchId: string,
		field: keyof ResolveDraft,
		value: string,
	) =>
		setDrafts((prev) => ({
			...prev,
			[matchId]: { ...draftFor(matchId), [field]: value },
		}));

	const handleResolve = async (match: ReviewMatch) => {
		const draft = draftFor(match.match_id);
		try {
			setError(null);
			const updated = await apiClient.resolveReviewMatch(
				match.match_id,
				draft.disposition,
				{
					...(draft.reviewer_id ? { reviewer_id: draft.reviewer_id } : {}),
					...(draft.review_notes ? { review_notes: draft.review_notes } : {}),
				},
			);
			setMatches((prev) =>
				prev.map((m) => (m.match_id === updated.match_id ? updated : m)),
			);
		} catch (err) {
			setError(errorMessage(err, t("status.resolveFailed")));
		}
	};

	const loadHistory = useCallback(
		async (matchId: string) => {
			setHistory((prev) => ({
				...prev,
				[matchId]: { loading: true, error: null, events: [] },
			}));
			try {
				const events = await apiClient.getMatchEvents(matchId);
				setHistory((prev) => ({
					...prev,
					[matchId]: { loading: false, error: null, events },
				}));
			} catch (err) {
				setHistory((prev) => ({
					...prev,
					[matchId]: {
						loading: false,
						error: errorMessage(err, t("status.historyFailed")),
						events: [],
					},
				}));
			}
		},
		[t],
	);

	const toggleHistory = (matchId: string) => {
		if (openHistoryId === matchId) {
			setOpenHistoryId(null);
			return;
		}
		setOpenHistoryId(matchId);
		if (!history[matchId]) loadHistory(matchId);
	};

	const handleCreateSar = async (payload: CreateSarPayload) => {
		try {
			setError(null);
			const created = await apiClient.createSar(payload);
			setSars((prev) => [
				created,
				...prev.filter((s) => s.sar_id !== created.sar_id),
			]);
		} catch (err) {
			setError(errorMessage(err, t("status.sarFailed")));
		}
	};

	const handleFinalizeSar = async (sarId: string) => {
		try {
			const updated = await apiClient.updateSar(sarId, { status: "FILED" });
			setSars((prev) => prev.map((s) => (s.sar_id === sarId ? updated : s)));
		} catch (err) {
			setError(errorMessage(err, t("status.sarFailed")));
		}
	};

	const handleExportSar = async (sar: SarRecord) => {
		if (typeof apiClient.updateSar !== "function") return;
		try {
			const updated = await apiClient.updateSar(sar.sar_id, {
				status: "EXPORTED",
			});
			setSars((prev) =>
				prev.map((s) => (s.sar_id === sar.sar_id ? updated : s)),
			);
		} catch {
			// Keep export non-blocking
		}
	};

	const sarByMatchId = useMemo(() => {
		const map = new Map<string, SarRecord>();
		for (const sar of sars) {
			if (!map.has(sar.match_id)) map.set(sar.match_id, sar);
		}
		return map;
	}, [sars]);

	const pendingCount = matches.filter(
		(m) => m.resolution_status === "PENDING",
	).length;
	const actionRequiredCount = matches.filter(
		(m) => m.resolution_status === "PENDING" || m.review_state === "CHANGED",
	).length;
	const strongHitCount = matches.filter((m) => m.tier === "STRONG").length;
	const confirmedCount = matches.filter(
		(m) => m.resolution_status === "TRUE_POSITIVE",
	).length;
	const activeTab = deriveQueueTab(panel, tier, status, view);

	const queueTabs: { id: QueueTabId; label: string; count?: number }[] = [
		{ id: "ALL", label: t("queues.all"), count: matches.length },
		{
			id: "NEEDS_REVIEW",
			label: t("queues.needsReview"),
			count: actionRequiredCount,
		},
		{ id: "STRONG", label: t("queues.strongHits"), count: strongHitCount },
		{ id: "CHANGED", label: t("queues.changed") },
		{ id: "CONFIRMED", label: t("queues.confirmed"), count: confirmedCount },
		{ id: "CLEARED", label: t("queues.cleared") },
		{ id: "SARS", label: t("queues.sarFilings"), count: sars.length },
	];

	return (
		<div>
			<header className="review-header">
				<div>
					<h1>{t("header.title")}</h1>
					<p className="text-muted">{t("header.subtitle")}</p>
				</div>
			</header>

			<section className="review-kpi-strip" aria-label={t("kpis.ariaLabel")}>
				<div className="review-kpi-card">
					<span className="review-kpi-label">{t("kpis.actionRequired")}</span>
					<strong className="review-kpi-value">{actionRequiredCount}</strong>
				</div>
				<div className="review-kpi-card review-kpi-card--danger">
					<span className="review-kpi-label">{t("kpis.strongHits")}</span>
					<strong className="review-kpi-value">{strongHitCount}</strong>
				</div>
				<div className="review-kpi-card">
					<span className="review-kpi-label">{t("kpis.confirmedMatches")}</span>
					<strong className="review-kpi-value">{confirmedCount}</strong>
				</div>
				<div className="review-kpi-card">
					<span className="review-kpi-label">{t("kpis.sarsFiled")}</span>
					<strong className="review-kpi-value">{sars.length}</strong>
				</div>
			</section>

			<div
				className="review-queue-tabs"
				role="tablist"
				aria-label={t("queues.ariaLabel")}
			>
				{queueTabs.map((tab) => {
					const selected = activeTab === tab.id;
					return (
						<button
							key={tab.id}
							type="button"
							role="tab"
							aria-selected={selected}
							className={`review-queue-tab${selected ? " review-queue-tab--active" : ""}`}
							onClick={() => selectQueueTab(tab.id)}
						>
							<span>{tab.label}</span>
							{tab.count !== undefined && (
								<span className="review-queue-tab__count">{tab.count}</span>
							)}
						</button>
					);
				})}
			</div>

			{error && (
				<div className="alert alert-error">{t("status.error", { error })}</div>
			)}

			<div className="form-group form-grid mb-md">
				<div>
					<label htmlFor="tier-filter" className="form-label">
						{t("filters.tier.label")}
					</label>
					<select
						id="tier-filter"
						value={tier}
						onChange={(e) => {
							setPanel("CASES");
							setTier(e.target.value as MatchTier | "");
						}}
						className="form-select"
					>
						<option value="">{t("filters.tier.all")}</option>
						{TIER_FILTERS.map((tierValue) => (
							<option key={tierValue} value={tierValue}>
								{tierLabel(tierValue, t)}
							</option>
						))}
					</select>
				</div>
				<div>
					<label htmlFor="status-filter" className="form-label">
						{t("filters.status.label")}
					</label>
					<select
						id="status-filter"
						value={status}
						onChange={(e) => {
							setPanel("CASES");
							setStatus(e.target.value as ReviewResolutionStatus | "");
						}}
						className="form-select"
					>
						<option value="">{t("filters.status.all")}</option>
						{STATUS_FILTERS.map((s) => (
							<option key={s} value={s}>
								{resolutionLabel(s, t)}
							</option>
						))}
					</select>
				</div>
				<div>
					<label htmlFor="view-filter" className="form-label">
						{t("filters.view.label")}
					</label>
					<select
						id="view-filter"
						value={view}
						onChange={(e) => {
							setPanel("CASES");
							setView(e.target.value as ViewFilter);
						}}
						className="form-select"
					>
						{VIEW_OPTIONS.map((opt) => (
							<option key={opt.value} value={opt.value}>
								{t(opt.labelKey)}
							</option>
						))}
					</select>
				</div>
			</div>

			{panel === "SARS" ? (
				<SarRegistryPanel
					sars={sars}
					onFinalizeDraft={handleFinalizeSar}
					onExportSar={handleExportSar}
				/>
			) : (
				<>
					<h2>
						{t("board.heading", {
							total: matches.length,
							pending: pendingCount,
						})}
					</h2>

					{loading ? (
						<p>{t("board.loading")}</p>
					) : matches.length === 0 ? (
						<p>{t("board.empty")}</p>
					) : (
						<section
							className="table-scroll"
							aria-label={t("board.heading", {
								total: matches.length,
								pending: pendingCount,
							})}
						>
							<table className="table">
								<thead>
									<tr>
										<th scope="col">{t("board.columns.tier")}</th>
										<th scope="col">{t("board.columns.customer")}</th>
										<th scope="col">{t("board.columns.matchedEntity")}</th>
										<th scope="col">{t("board.columns.source")}</th>
										<th scope="col">{t("board.columns.score")}</th>
										<th scope="col">{t("board.columns.status")}</th>
										<th scope="col">{t("board.columns.reviewerNotes")}</th>
										<th scope="col" className="table-cell-right">
											{t("board.columns.resolve")}
										</th>
										<th scope="col" className="table-cell-right">
											{t("board.columns.history")}
										</th>
									</tr>
								</thead>
								<tbody>
									{matches.map((match) => (
										<MatchRow
											key={match.match_id}
											match={match}
											draft={draftFor(match.match_id)}
											filedSar={sarByMatchId.get(match.match_id)}
											onChange={(field, value) =>
												updateDraft(match.match_id, field, value)
											}
											onResolve={() => handleResolve(match)}
											onOpenSarModal={(m) => setSarModalMatch(m)}
											historyOpen={openHistoryId === match.match_id}
											history={history[match.match_id]}
											onToggleHistory={() => toggleHistory(match.match_id)}
										/>
									))}
								</tbody>
							</table>
						</section>
					)}
				</>
			)}

			<SarFilingModal
				match={sarModalMatch}
				defaultOfficer={
					sarModalMatch
						? draftFor(sarModalMatch.match_id).reviewer_id ||
							sarModalMatch.reviewer_id ||
							""
						: ""
				}
				onClose={() => setSarModalMatch(null)}
				onSubmit={handleCreateSar}
			/>
		</div>
	);
}
