/**
 * Single sanctions match row, inline analyst disposition controls, and
 * expandable scoring evidence + append-only audit trail drawer.
 */

import { useTranslation } from "react-i18next";
import type {
	MatchEvent,
	MatchTier,
	ReviewDisposition,
	ReviewMatch,
	ReviewResolutionStatus,
	SarRecord,
} from "../lib/api";
import {
	listName,
	matchEventLabel,
	reasonLabel,
	resolutionLabel,
	tierLabel,
} from "../lib/plainLabels";
import { plainExplanation } from "./plainExplanation";

const REVIEW_NAMESPACES = ["review", "common"] as const;

const DISPOSITIONS: ReviewDisposition[] = [
	"TRUE_POSITIVE",
	"FALSE_POSITIVE",
	"RESOLVED",
];

export const TABLE_COLUMN_COUNT = 9;

export interface ResolveDraft {
	disposition: ReviewDisposition;
	reviewer_id: string;
	review_notes: string;
}

export interface HistoryEntry {
	loading: boolean;
	error: string | null;
	events: MatchEvent[];
}

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

function needsAction(match: ReviewMatch): boolean {
	return (
		match.resolution_status === "PENDING" || match.review_state === "CHANGED"
	);
}

function canFileSar(match: ReviewMatch): boolean {
	return match.tier === "STRONG" || match.resolution_status === "TRUE_POSITIVE";
}

function formatEventAt(at: string): string {
	const parsed = new Date(at);
	return Number.isNaN(parsed.getTime()) ? at : parsed.toLocaleString();
}

export interface MatchRowProps {
	match: ReviewMatch;
	draft: ResolveDraft;
	filedSar?: SarRecord | undefined;
	onChange: (field: keyof ResolveDraft, value: string) => void;
	onResolve: () => void;
	onOpenSarModal: (match: ReviewMatch) => void;
	historyOpen: boolean;
	history: HistoryEntry | undefined;
	onToggleHistory: () => void;
}

export function MatchRow({
	match,
	draft,
	filedSar,
	onChange,
	onResolve,
	onOpenSarModal,
	historyOpen,
	history,
	onToggleHistory,
}: MatchRowProps) {
	const { t } = useTranslation(REVIEW_NAMESPACES);
	const ref = match.customer_reference ?? match.match_id;
	const scorePct = (match.match_score * 100).toFixed(1);

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
				<td>
					<div className="review-entity-name">{match.sanctioned_name}</div>
				</td>
				<td>
					<span className="badge badge-muted">
						{listName(match.source_list, t)}
					</span>
				</td>
				<td>
					<div className="review-score-cell">
						<span className="review-score-value">
							{t("card.score", { score: scorePct })}
						</span>
						<div className="review-score-bar" aria-hidden="true">
							<div
								className={`review-score-fill review-score-fill--${match.tier.toLowerCase()}`}
								style={{
									width: `${Math.min(100, Math.round(match.match_score * 100))}%`,
								}}
							/>
						</div>
					</div>
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
					{filedSar && (
						<div className="mt-sm">
							<span className="badge badge-danger">
								{t(
									filedSar.status === "DRAFT"
										? "card.sarDraftBadge"
										: "card.sarFiledBadge",
									{ ref: filedSar.filing_reference },
								)}
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
					<div className="review-row-actions">
						<button
							type="button"
							className="btn btn-secondary btn-sm"
							aria-expanded={historyOpen}
							aria-label={t("card.history.aria", { ref })}
							onClick={onToggleHistory}
						>
							{t("card.history.toggle")}
						</button>
						{canFileSar(match) && (
							<button
								type="button"
								className="btn btn-danger btn-sm"
								aria-label={t("card.fileSarAria", { ref })}
								onClick={() => onOpenSarModal(match)}
							>
								{t("card.fileSar")}
							</button>
						)}
					</div>
				</td>
			</tr>
			{historyOpen && (
				<tr className="review-evidence-row">
					<td colSpan={TABLE_COLUMN_COUNT}>
						<HistoryDrawer match={match} history={history} />
					</td>
				</tr>
			)}
		</>
	);
}

function HistoryDrawer({
	match,
	history,
}: {
	match: ReviewMatch;
	history: HistoryEntry | undefined;
}) {
	const { t } = useTranslation(REVIEW_NAMESPACES);
	const reasons = match.reasons ?? [];
	const hasEvidence = reasons.length > 0 || Boolean(match.explanation);

	return (
		<div className="review-drawer-grid">
			{hasEvidence && (
				<div className="review-evidence-panel">
					<h4 className="review-drawer-title">
						{t("evidence.signalsHeading")}
					</h4>
					{match.explanation && (
						<p className="text-sm mb-sm">
							{plainExplanation(match.explanation, t)}
						</p>
					)}
					{reasons.length > 0 && (
						<div className="review-signal-chips">
							{reasons.map((r) => (
								<span key={r.signal} className="badge badge-muted">
									{reasonLabel(r.signal, t)}
									{r.contribution !== null &&
										` · ${t("evidence.weight", {
											pct: Math.round(r.contribution * 100),
										})}`}
								</span>
							))}
						</div>
					)}
				</div>
			)}
			<div className="review-history-panel">
				<h4 className="review-drawer-title">{t("history.heading")}</h4>
				{!history || history.loading ? (
					<p>{t("history.loading")}</p>
				) : history.error ? (
					<div className="alert alert-error">
						{t("history.error", { error: history.error })}
					</div>
				) : history.events.length === 0 ? (
					<p className="text-muted">{t("history.empty")}</p>
				) : (
					<ul className="text-sm review-history-list">
						{history.events.map((event) => (
							<HistoryItem key={event.event_id} event={event} />
						))}
					</ul>
				)}
			</div>
		</div>
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

function ResolveControls({
	match,
	draft,
	onChange,
	onResolve,
}: {
	match: ReviewMatch;
	draft: ResolveDraft;
	onChange: (field: keyof ResolveDraft, value: string) => void;
	onResolve: () => void;
}) {
	const { t } = useTranslation(REVIEW_NAMESPACES);
	const ref = match.customer_reference ?? match.match_id;
	return (
		<div className="resolve-controls">
			<div className="resolve-controls__top">
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
				<button
					type="button"
					onClick={onResolve}
					className="btn btn-primary btn-sm"
				>
					{t("resolve.submit")}
				</button>
			</div>
			<div className="resolve-controls__inputs">
				<input
					type="text"
					aria-label={t("resolve.reviewer", { ref })}
					placeholder={t("resolve.reviewerPlaceholder")}
					value={draft.reviewer_id}
					onChange={(e) => onChange("reviewer_id", e.target.value)}
					className="form-input resolve-controls__input"
				/>
				<input
					type="text"
					aria-label={t("resolve.notes", { ref })}
					placeholder={t("resolve.notesPlaceholder")}
					value={draft.review_notes}
					onChange={(e) => onChange("review_notes", e.target.value)}
					className="form-input resolve-controls__input"
				/>
			</div>
		</div>
	);
}
