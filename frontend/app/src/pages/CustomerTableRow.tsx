/**
 * One customer in the /customers table, plus its inline editor.
 *
 * The row is read-only words (screening result, onboarding status, risk) and
 * one compact action group: Edit and Delete. Changing status, risk, name or
 * country happens in a single editor row that Edit opens beneath it, so a row
 * never stacks two dropdowns and four buttons, and it still fits a phone.
 */
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type {
	CustomerResponse,
	KycRiskRating,
	OnboardingStatus,
} from "../lib/api";
import type { ScreeningSummary } from "../lib/customerScreening";
import { actorLabel, kycRiskLabel, onboardingLabel } from "../lib/plainLabels";

export const ONBOARDING_STATUSES: ReadonlyArray<OnboardingStatus> = [
	"DRAFT",
	"PENDING_REVIEW",
	"ACTIVE",
	"REJECTED",
];

export const RISK_RATINGS: ReadonlyArray<KycRiskRating> = [
	"LOW",
	"MEDIUM",
	"HIGH",
];

/** The editor's buffer: identity plus the status and risk it can change. */
export interface CustomerDraft {
	readonly customerId: string;
	readonly name: string;
	readonly country: string;
	readonly status: string;
	readonly risk: string;
}

export function draftOf(customer: CustomerResponse): CustomerDraft {
	return {
		customerId: customer.customer_id,
		name: customer.name,
		country: customer.country ?? "",
		status: customer.onboarding_status,
		risk: customer.kyc_risk_rating ?? "",
	};
}

/** Columns in the customers table (the editor row spans all of them). */
export const CUSTOMER_COLUMNS = 7;

function statusBadgeClass(status: string): string {
	if (status === "ACTIVE") return "badge badge-success";
	if (status === "REJECTED") return "badge badge-danger";
	if (status === "PENDING_REVIEW") return "badge badge-warning";
	return "badge badge-muted";
}

function riskBadgeClass(rating: string | null): string {
	if (rating === "HIGH") return "badge badge-danger";
	if (rating === "MEDIUM") return "badge badge-warning";
	if (rating === "LOW") return "badge badge-success";
	return "badge badge-muted";
}

const SCREENING_BADGE: Readonly<Record<ScreeningSummary["state"], string>> = {
	clear: "badge badge-success",
	cleared: "badge badge-success",
	toReview: "badge badge-warning",
	confirmed: "badge badge-danger",
};

function ScreeningBadge({
	summary,
}: {
	readonly summary: ScreeningSummary | null;
}) {
	const { t } = useTranslation("customers");
	if (summary === null) {
		// The matches could not be read: never claim a clean result we did not see.
		return (
			<span className="badge badge-muted">{t("list.screening.unknown")}</span>
		);
	}
	return (
		<span className={SCREENING_BADGE[summary.state]}>
			{t(`list.screening.${summary.state}`, { count: summary.open })}
		</span>
	);
}

interface CustomerTableRowProps {
	readonly customer: CustomerResponse;
	readonly screening: ScreeningSummary | null;
	readonly editing: boolean;
	readonly onEdit: () => void;
	readonly onDelete: () => void;
}

export function CustomerTableRow({
	customer,
	screening,
	editing,
	onEdit,
	onDelete,
}: CustomerTableRowProps) {
	const { t } = useTranslation("customers");
	const reference = customer.customer_reference;
	return (
		<tr>
			<td data-label={t("list.columns.reference")}>{reference}</td>
			<td data-label={t("list.columns.screening")}>
				<ScreeningBadge summary={screening} />
			</td>
			<td data-label={t("list.columns.status")}>
				<span className={statusBadgeClass(customer.onboarding_status)}>
					{onboardingLabel(customer.onboarding_status, t)}
				</span>
			</td>
			<td data-label={t("list.columns.risk")}>
				<span className={riskBadgeClass(customer.kyc_risk_rating)}>
					{kycRiskLabel(customer.kyc_risk_rating, t)}
				</span>
			</td>
			<td data-label={t("list.columns.onboardedBy")}>
				{actorLabel(customer.onboarded_by, t)}
			</td>
			<td data-label={t("list.columns.created")}>
				{new Date(customer.created_at).toLocaleDateString()}
			</td>
			<td className="table-cell-right customer-row-actions-cell">
				<fieldset
					className="customer-row-actions"
					aria-label={t("list.controls.actionsAria", { reference })}
				>
					{/* While the editor is open it owns the row (and focus); Edit
					    comes back when it closes, which is how a save reads as done. */}
					{editing ? null : (
						<button
							type="button"
							aria-label={t("list.controls.editAria", { reference })}
							onClick={onEdit}
							className="btn btn-secondary btn-sm"
						>
							{t("actions.edit")}
						</button>
					)}
					<button
						type="button"
						aria-label={t("list.controls.deleteAria", { reference })}
						onClick={onDelete}
						className="btn btn-danger btn-sm"
					>
						{t("actions.delete")}
					</button>
				</fieldset>
			</td>
		</tr>
	);
}

interface CustomerEditorRowProps {
	readonly reference: string;
	readonly draft: CustomerDraft;
	readonly onChange: (draft: CustomerDraft) => void;
	readonly onSave: () => void;
	readonly onCancel: () => void;
}

export function CustomerEditorRow({
	reference,
	draft,
	onChange,
	onSave,
	onCancel,
}: CustomerEditorRowProps) {
	const { t } = useTranslation("customers");
	const firstField = useRef<HTMLInputElement>(null);
	useEffect(() => {
		firstField.current?.focus();
	}, []);
	const id = `customer-edit-${draft.customerId}`;
	return (
		<tr className="customer-editor-row">
			<td colSpan={CUSTOMER_COLUMNS}>
				<fieldset
					className="customer-editor"
					aria-label={t("list.controls.editorAria", { reference })}
				>
					<label className="customer-editor__field" htmlFor={`${id}-name`}>
						<span className="form-label">{t("list.controls.name")}</span>
						<input
							ref={firstField}
							id={`${id}-name`}
							type="text"
							aria-label={t("list.controls.editNameAria", { reference })}
							value={draft.name}
							onChange={(e) => onChange({ ...draft, name: e.target.value })}
							className="form-input"
						/>
					</label>
					<label className="customer-editor__field" htmlFor={`${id}-country`}>
						<span className="form-label">{t("list.controls.country")}</span>
						<input
							id={`${id}-country`}
							type="text"
							aria-label={t("list.controls.editCountryAria", { reference })}
							value={draft.country}
							maxLength={2}
							onChange={(e) => onChange({ ...draft, country: e.target.value })}
							className="form-input"
						/>
					</label>
					<label className="customer-editor__field" htmlFor={`${id}-status`}>
						<span className="form-label">{t("list.columns.status")}</span>
						<select
							id={`${id}-status`}
							aria-label={t("list.controls.statusAria", { reference })}
							value={draft.status}
							onChange={(e) => onChange({ ...draft, status: e.target.value })}
							className="form-select"
						>
							{ONBOARDING_STATUSES.map((status) => (
								<option key={status} value={status}>
									{onboardingLabel(status, t)}
								</option>
							))}
						</select>
					</label>
					<label className="customer-editor__field" htmlFor={`${id}-risk`}>
						<span className="form-label">{t("list.columns.risk")}</span>
						<select
							id={`${id}-risk`}
							aria-label={t("list.controls.riskAria", { reference })}
							value={draft.risk}
							onChange={(e) => onChange({ ...draft, risk: e.target.value })}
							className="form-select"
						>
							<option value="" disabled>
								{kycRiskLabel(null, t)}
							</option>
							{RISK_RATINGS.map((rating) => (
								<option key={rating} value={rating}>
									{kycRiskLabel(rating, t)}
								</option>
							))}
						</select>
					</label>
					<div className="customer-editor__actions">
						<button
							type="button"
							onClick={onSave}
							className="btn btn-primary btn-sm"
						>
							{t("actions.save")}
						</button>
						<button
							type="button"
							onClick={onCancel}
							className="btn btn-secondary btn-sm"
						>
							{t("actions.cancel")}
						</button>
					</div>
				</fieldset>
			</td>
		</tr>
	);
}
