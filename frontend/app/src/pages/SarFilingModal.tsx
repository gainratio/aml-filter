/**
 * Native `<dialog>` modal for preparing and filing a FinCEN-aligned
 * Suspicious Activity Report (SAR) from a sanctions match.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	CreateSarPayload,
	ReviewMatch,
	SarActivityCategory,
} from "../lib/api";
import { listName, reasonLabel, sarActivityLabel } from "../lib/plainLabels";

const REVIEW_NAMESPACES = ["review", "common"] as const;

const ACTIVITY_CATEGORIES: SarActivityCategory[] = [
	"SANCTIONS_HIT",
	"TERRORIST_FINANCING",
	"EVASION_ATTEMPT",
	"STRUCTURING",
	"OTHER",
];

export function buildDefaultNarrative(
	match: ReviewMatch,
	sourceText: string,
	signalList: string,
): string {
	const custRef = match.customer_reference ?? match.match_id;
	const custName = match.customer_name ?? "Unknown subject";
	const scorePct = (match.match_score * 100).toFixed(1);
	const entityId = match.ofac_entity_id ?? match.sanctioned_name;
	return [
		`1. WHO (Subject): Customer ${custName} (Ref: ${custRef}).`,
		`2. WHAT (Instrument / Match): Deterministic screening hit against ${match.sanctioned_name} (${entityId}) on ${sourceText} at ${scorePct}% similarity.`,
		`3. WHEN (Detection): Detected ${match.detected_at}.`,
		`4. WHERE (Jurisdiction / Channel): Local KYC Compliance Workstation onboarding / continuous rescan.`,
		`5. WHY (Suspicious Indicators): Corroborating match signals (${signalList || "name similarity"}) exceed institutional escalation thresholds and require regulatory reporting.`,
	].join("\n");
}

interface SarFilingModalProps {
	match: ReviewMatch | null;
	defaultOfficer?: string;
	onClose: () => void;
	onSubmit: (payload: CreateSarPayload) => Promise<void>;
}

interface FormErrors {
	institution?: string;
	officer?: string;
	email?: string;
	narrative?: string;
}

export function SarFilingModal({
	match,
	defaultOfficer = "",
	onClose,
	onSubmit,
}: SarFilingModalProps) {
	const { t } = useTranslation(REVIEW_NAMESPACES);
	const dialogRef = useRef<HTMLDialogElement | null>(null);
	const [institution, setInstitution] = useState("GainRatio Compliance Ops");
	const [officer, setOfficer] = useState(defaultOfficer);
	const [email, setEmail] = useState("compliance@institution.example");
	const [category, setCategory] =
		useState<SarActivityCategory>("SANCTIONS_HIT");
	const [amount, setAmount] = useState("");
	const [startDate, setStartDate] = useState(
		new Date().toISOString().slice(0, 10),
	);
	const [narrative, setNarrative] = useState("");
	const [errors, setErrors] = useState<FormErrors>({});
	const [submitting, setSubmitting] = useState(false);

	useEffect(() => {
		if (!match) return;
		const signals = (match.reasons ?? [])
			.map((r) => reasonLabel(r.signal, t))
			.join(", ");
		setNarrative(
			buildDefaultNarrative(match, listName(match.source_list, t), signals),
		);
		if (defaultOfficer) setOfficer(defaultOfficer);
		setErrors({});
		const el = dialogRef.current;
		if (!el) return;
		if (typeof el.showModal === "function" && !el.open) {
			el.showModal();
		} else {
			el.setAttribute("open", "");
		}
	}, [match, defaultOfficer, t]);

	if (!match) return null;

	const validate = (): FormErrors => {
		const next: FormErrors = {};
		if (!institution.trim())
			next.institution = t("sarModal.errors.institution");
		if (!officer.trim()) next.officer = t("sarModal.errors.officer");
		if (!email.includes("@")) next.email = t("sarModal.errors.email");
		if (narrative.trim().length < 30)
			next.narrative = t("sarModal.errors.narrative");
		setErrors(next);
		return next;
	};

	const handleSave = async (status: "DRAFT" | "FILED") => {
		if (Object.keys(validate()).length > 0) return;
		setSubmitting(true);
		try {
			await onSubmit({
				match_id: match.match_id,
				customer_id: match.customer_id,
				customer_reference: match.customer_reference ?? match.match_id,
				subject_name:
					match.customer_name ?? match.customer_reference ?? match.match_id,
				sanctioned_name: match.sanctioned_name,
				ofac_entity_id: match.ofac_entity_id ?? match.sanctioned_name,
				source_list: match.source_list,
				match_score: match.match_score,
				activity_category: category,
				suspicious_amount_usd: amount.trim() || null,
				activity_start_date: startDate.trim() || null,
				institution_name: institution,
				filing_officer: officer,
				contact_email: email,
				narrative,
				status,
			});
			onClose();
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<dialog
			ref={dialogRef}
			className="sar-dialog"
			aria-labelledby="sar-dialog-title"
			onCancel={onClose}
		>
			<div className="sar-dialog__header">
				<div>
					<h2 id="sar-dialog-title" className="sar-dialog__title">
						{t("sarModal.title")}
					</h2>
					<p className="text-muted text-sm mb-0">{t("sarModal.subtitle")}</p>
				</div>
				<button
					type="button"
					className="btn btn-secondary btn-sm"
					onClick={onClose}
				>
					{t("sarModal.cancel")}
				</button>
			</div>

			<fieldset className="sar-fieldset">
				<legend>{t("sarModal.subjectLegend")}</legend>
				<div className="sar-subject-summary">
					<div>
						<span className="form-label">{t("sarModal.subjectCustomer")}</span>
						<strong>{match.customer_reference}</strong> — {match.customer_name}
					</div>
					<div>
						<span className="form-label">{t("sarModal.matchedEntity")}</span>
						<strong>{match.sanctioned_name}</strong> (
						{listName(match.source_list, t)})
					</div>
					<div>
						<span className="form-label">{t("sarModal.matchStrength")}</span>
						<strong>{(match.match_score * 100).toFixed(1)}%</strong>
					</div>
				</div>
			</fieldset>

			<fieldset className="sar-fieldset">
				<legend>{t("sarModal.institutionLegend")}</legend>
				<div className="form-grid">
					<div>
						<label htmlFor="sar-institution" className="form-label">
							{t("sarModal.institutionLabel")}
						</label>
						<input
							id="sar-institution"
							type="text"
							className="form-input"
							value={institution}
							aria-invalid={Boolean(errors.institution)}
							onChange={(e) => setInstitution(e.target.value)}
						/>
						{errors.institution && (
							<p className="form-error">{errors.institution}</p>
						)}
					</div>
					<div>
						<label htmlFor="sar-officer" className="form-label">
							{t("sarModal.officerLabel")}
						</label>
						<input
							id="sar-officer"
							type="text"
							className="form-input"
							value={officer}
							aria-invalid={Boolean(errors.officer)}
							onChange={(e) => setOfficer(e.target.value)}
						/>
						{errors.officer && <p className="form-error">{errors.officer}</p>}
					</div>
					<div>
						<label htmlFor="sar-email" className="form-label">
							{t("sarModal.emailLabel")}
						</label>
						<input
							id="sar-email"
							type="email"
							className="form-input"
							value={email}
							aria-invalid={Boolean(errors.email)}
							onChange={(e) => setEmail(e.target.value)}
						/>
						{errors.email && <p className="form-error">{errors.email}</p>}
					</div>
					<div>
						<label htmlFor="sar-category" className="form-label">
							{t("sarModal.categoryLabel")}
						</label>
						<select
							id="sar-category"
							className="form-select"
							value={category}
							onChange={(e) =>
								setCategory(e.target.value as SarActivityCategory)
							}
						>
							{ACTIVITY_CATEGORIES.map((cat) => (
								<option key={cat} value={cat}>
									{sarActivityLabel(cat, t)}
								</option>
							))}
						</select>
					</div>
					<div>
						<label htmlFor="sar-amount" className="form-label">
							{t("sarModal.amountLabel")}
						</label>
						<input
							id="sar-amount"
							type="text"
							inputMode="decimal"
							className="form-input"
							placeholder={t("sarModal.amountPlaceholder")}
							value={amount}
							onChange={(e) => setAmount(e.target.value)}
						/>
					</div>
					<div>
						<label htmlFor="sar-date" className="form-label">
							{t("sarModal.startDateLabel")}
						</label>
						<input
							id="sar-date"
							type="date"
							className="form-input"
							value={startDate}
							onChange={(e) => setStartDate(e.target.value)}
						/>
					</div>
				</div>
			</fieldset>

			<fieldset className="sar-fieldset">
				<legend>{t("sarModal.narrativeLegend")}</legend>
				<label htmlFor="sar-narrative" className="form-label">
					{t("sarModal.narrativeLabel")}
				</label>
				<p className="text-xs text-muted mt-0 mb-sm">
					{t("sarModal.narrativeHint")}
				</p>
				<textarea
					id="sar-narrative"
					rows={5}
					className="form-input sar-textarea"
					value={narrative}
					aria-invalid={Boolean(errors.narrative)}
					onChange={(e) => setNarrative(e.target.value)}
				/>
				{errors.narrative && <p className="form-error">{errors.narrative}</p>}
			</fieldset>

			<div className="sar-dialog__actions">
				<button
					type="button"
					className="btn btn-secondary"
					disabled={submitting}
					onClick={() => handleSave("DRAFT")}
				>
					{t("sarModal.saveDraft")}
				</button>
				<button
					type="button"
					className="btn btn-danger"
					disabled={submitting}
					onClick={() => handleSave("FILED")}
				>
					{t("sarModal.submitReport")}
				</button>
			</div>
		</dialog>
	);
}
