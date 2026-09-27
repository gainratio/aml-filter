/** Review / case board — analyst triage of sanctions matches (the /v1/review tier). */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	apiClient,
	type MatchEvent,
	type MatchTier,
	type ReviewDisposition,
	type ReviewMatch,
	type ReviewMatchListParams,
	type ReviewResolutionStatus,
} from "../lib/api";
import {
	listName,
	matchEventLabel,
	resolutionLabel,
	tierLabel,
} from "../lib/plainLabels";

/**
 * Codes (`STRONG`, `FALSE_POSITIVE`, `UK_OFSI`, …) stay the data: option
 * values, API params, exports. Every visible word goes through plainLabels, so
 * the board shows plain words and never a raw code.
 */
const REVIEW_NAMESPACES = ["review", "common"] as const;

const TIER_FILTERS: MatchTier[] = ["STRONG", "POSSIBLE", "WEAK"];

const STATUS_FILTERS: ReviewResolutionStatus[] = [
	"PENDING",
	"TRUE_POSITIVE",
	"FALSE_POSITIVE",
	"RESOLVED",
];

const DISPOSITIONS: ReviewDisposition[] = [
	"TRUE_POSITIVE",
	"FALSE_POSITIVE",
	"RESOLVED",
];

/** The View filter shapes which params the list query carries. */
type ViewFilter = "ALL" | "NEEDS_REVIEW" | "CHANGED";

const VIEW_OPTIONS: { value: ViewFilter; labelKey: string }[] = [
	{ value: "ALL", labelKey: "filters.view.options.all" },
	{ value: "NEEDS_REVIEW", labelKey: "filters.view.options.needsReview" },
	{ value: "CHANGED", labelKey: "filters.view.options.changed" },
];

function tierBadgeClass(tier: MatchTier): string {
	if (tier === "STRONG") return "badge badge-danger";
	if (tier === "POSSIBLE") return "badge badge-warning";
	return "badge badge-muted";
}

function statusBadgeClass(status: ReviewResolutionStatus): string {
	if (status === "PENDING") return "badge badge-warning";
	if (status === "TRUE_POSITIVE") return "badge badge-danger";
	if (status === "FALSE_POSITIVE") return "badge badge-success";
	return "badge badge-muted";
}

function errorMessage(err: unknown, fallback: string): string {
	return err instanceof Error ? err.message : fallback;
}

/** A row needs the Resolve controls when it is pending OR flagged for re-review. */
function needsAction(match: ReviewMatch): boolean {
	return (
		match.resolution_status === "PENDING" || match.review_state === "CHANGED"
	);
}

function formatEventAt(at: string): string {
	const parsed = new Date(at);
	return Number.isNaN(parsed.getTime()) ? at : parsed.toLocaleString();
}

/** Translate the View filter into the extra list-query params it implies. */
function viewParams(view: ViewFilter): ReviewMatchListParams {
	if (view === "NEEDS_REVIEW") return { needsReview: true };
	if (view === "CHANGED") return { reviewState: "CHANGED" };
	return {};
}

interface ResolveDraft {
	disposition: ReviewDisposition;
	reviewer_id: string;
	review_notes: string;
}

const EMPTY_DRAFT: ResolveDraft = {
	disposition: "FALSE_POSITIVE",
	reviewer_id: "",
	review_notes: "",
};

/** Lazily-loaded audit trail per match_id (loading / error / events). */
interface HistoryEntry {
	loading: boolean;
	error: string | null;
	events: MatchEvent[];
}

type HistoryState = Record<string, HistoryEntry>;

export default function ReviewBoardPage() {
	const { t } = useTranslation(REVIEW_NAMESPACES);
	const [matches, setMatches] = useState<ReviewMatch[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [tier, setTier] = useState<MatchTier | "">("");
	const [status, setStatus] = useState<ReviewResolutionStatus | "">("");
	const [view, setView] = useState<ViewFilter>("ALL");
	const [drafts, setDrafts] = useState<Record<string, ResolveDraft>>({});
	const [openHistoryId, setOpenHistoryId] = useState<string | null>(null);
	const [history, setHistory] = useState<HistoryState>({});

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

	const pendingCount = matches.filter(
		(m) => m.resolution_status === "PENDING",
	).length;

	return (
		<div>
			<h1>{t("header.title")}</h1>
			<p className="text-muted">{t("header.subtitle")}</p>

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
						onChange={(e) => setTier(e.target.value as MatchTier | "")}
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
						onChange={(e) =>
							setStatus(e.target.value as ReviewResolutionStatus | "")
						}
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
						onChange={(e) => setView(e.target.value as ViewFilter)}
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

			<h2>
				{t("board.heading", { total: matches.length, pending: pendingCount })}
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
									onChange={(field, value) =>
										updateDraft(match.match_id, field, value)
									}
									onResolve={() => handleResolve(match)}
									historyOpen={openHistoryId === match.match_id}
									history={history[match.match_id]}
									onToggleHistory={() => toggleHistory(match.match_id)}
								/>
							))}
						</tbody>
					</table>
				</section>
			)}
		</div>
	);
}

const TABLE_COLUMN_COUNT = 9;

interface MatchRowProps {
	match: ReviewMatch;
	draft: ResolveDraft;
	onChange: (field: keyof ResolveDraft, value: string) => void;
	onResolve: () => void;
	historyOpen: boolean;
	history: HistoryEntry | undefined;
	onToggleHistory: () => void;
}

function MatchRow({
	match,
	draft,
	onChange,
	onResolve,
	historyOpen,
	history,
	onToggleHistory,
}: MatchRowProps) {
	const { t } = useTranslation(REVIEW_NAMESPACES);
	const ref = match.customer_reference ?? match.match_id;
	return (
		<>
			<tr>
				<td>
					<span className={tierBadgeClass(match.tier)}>
						{tierLabel(match.tier, t)}
					</span>
				</td>
				<td>
					<div>
						<strong>{match.customer_reference}</strong>
					</div>
					<div className="text-sm text-muted">{match.customer_name}</div>
				</td>
				<td>{match.sanctioned_name}</td>
				<td>
					<span className="badge badge-muted">
						{listName(match.source_list, t)}
					</span>
				</td>
				<td>
					{t("card.score", { score: (match.match_score * 100).toFixed(1) })}
				</td>
				<td>
					<span className={statusBadgeClass(match.resolution_status)}>
						{resolutionLabel(match.resolution_status, t)}
					</span>
					{match.review_state === "CHANGED" && (
						<div className="mt-sm">
							<span className="badge badge-warning">
								{t("card.changedBadge")}
							</span>
						</div>
					)}
				</td>
				<td className="text-sm">
					<div>{match.reviewer_id ?? t("card.emptyReviewer")}</div>
					{match.review_notes && (
						<div className="text-muted">{match.review_notes}</div>
					)}
				</td>
				<td className="table-cell-right">
					{needsAction(match) ? (
						<ResolveControls
							match={match}
							draft={draft}
							onChange={onChange}
							onResolve={onResolve}
						/>
					) : (
						<span className="text-muted text-sm">{t("card.resolved")}</span>
					)}
				</td>
				<td className="table-cell-right">
					<button
						type="button"
						className="btn btn-secondary btn-sm"
						aria-expanded={historyOpen}
						aria-label={t("card.history.aria", { ref })}
						onClick={onToggleHistory}
					>
						{t("card.history.toggle")}
					</button>
				</td>
			</tr>
			{historyOpen && (
				<tr>
					<td colSpan={TABLE_COLUMN_COUNT}>
						<HistoryDrawer history={history} />
					</td>
				</tr>
			)}
		</>
	);
}

interface HistoryDrawerProps {
	history: HistoryEntry | undefined;
}

function HistoryDrawer({ history }: HistoryDrawerProps) {
	const { t } = useTranslation("review");
	if (!history || history.loading) return <p>{t("history.loading")}</p>;
	if (history.error)
		return (
			<div className="alert alert-error">
				{t("history.error", { error: history.error })}
			</div>
		);
	if (history.events.length === 0)
		return <p className="text-muted">{t("history.empty")}</p>;
	return (
		<ul className="text-sm">
			{history.events.map((event) => (
				<HistoryItem key={event.event_id} event={event} />
			))}
		</ul>
	);
}

function HistoryItem({ event }: { event: MatchEvent }) {
	const { t } = useTranslation(REVIEW_NAMESPACES);
	const statusText = (code: string | null): string =>
		code ? resolutionLabel(code, t) : t("history.unknownStatus");
	const transition =
		event.from_status || event.to_status
			? t("history.transition", {
					from: statusText(event.from_status),
					to: statusText(event.to_status),
				})
			: "";
	return (
		<li>
			<strong>{matchEventLabel(event.event_type, t)}</strong>
			{transition}
			{t("history.separator")}
			{formatEventAt(event.at)}
			{event.reviewer_id && (
				<span>
					{t("history.meta")}
					{event.reviewer_id}
				</span>
			)}
			{event.notes && (
				<span className="text-muted">
					{t("history.meta")}
					{event.notes}
				</span>
			)}
		</li>
	);
}

interface ResolveControlsProps {
	match: ReviewMatch;
	draft: ResolveDraft;
	onChange: (field: keyof ResolveDraft, value: string) => void;
	onResolve: () => void;
}

function ResolveControls({
	match,
	draft,
	onChange,
	onResolve,
}: ResolveControlsProps) {
	const { t } = useTranslation(REVIEW_NAMESPACES);
	const ref = match.customer_reference ?? match.match_id;
	return (
		<div className="flex-gap-sm">
			<select
				aria-label={t("resolve.disposition", { ref })}
				value={draft.disposition}
				onChange={(e) =>
					onChange("disposition", e.target.value as ReviewDisposition)
				}
				className="form-select review-resolve-select"
			>
				{DISPOSITIONS.map((d) => (
					<option key={d} value={d}>
						{resolutionLabel(d, t)}
					</option>
				))}
			</select>
			<input
				type="text"
				aria-label={t("resolve.reviewer", { ref })}
				placeholder={t("resolve.reviewerPlaceholder")}
				value={draft.reviewer_id}
				onChange={(e) => onChange("reviewer_id", e.target.value)}
				className="form-input"
			/>
			<input
				type="text"
				aria-label={t("resolve.notes", { ref })}
				placeholder={t("resolve.notesPlaceholder")}
				value={draft.review_notes}
				onChange={(e) => onChange("review_notes", e.target.value)}
				className="form-input"
			/>
			<button
				type="button"
				onClick={onResolve}
				className="btn btn-primary btn-sm"
			>
				{t("resolve.submit")}
			</button>
		</div>
	);
}
