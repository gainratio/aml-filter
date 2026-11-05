/**
 * Institutional SAR Filings Registry panel on the Review Board.
 *
 * Displays all locally persisted FinCEN Suspicious Activity Reports with
 * plain-word status badges, narrative inspection, draft finalization, and
 * structured JSON dossier export.
 */

import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SarRecord, SarStatus } from "../lib/api";
import { listName, sarActivityLabel, sarStatusLabel } from "../lib/plainLabels";
import { buildSarDossierJson } from "../lib/sarRegistry";

const REVIEW_NAMESPACES = ["review", "common"] as const;

function sarBadgeClass(status: SarStatus): string {
	if (status === "EXPORTED") return "badge badge-success";
	if (status === "FILED") return "badge badge-danger";
	return "badge badge-warning";
}

function formatSarTime(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function triggerJsonDownload(filename: string, content: string): void {
	if (typeof URL.createObjectURL !== "function") return;
	const blob = new Blob([content], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}

interface SarRegistryPanelProps {
	sars: ReadonlyArray<SarRecord>;
	onFinalizeDraft: (sarId: string) => Promise<void>;
	onExportSar: (sar: SarRecord) => Promise<void>;
}

export function SarRegistryPanel({
	sars,
	onFinalizeDraft,
	onExportSar,
}: SarRegistryPanelProps) {
	const { t } = useTranslation(REVIEW_NAMESPACES);
	const [openId, setOpenId] = useState<string | null>(null);

	const handleExport = async (sar: SarRecord) => {
		const json = buildSarDossierJson({ ...sar, status: "EXPORTED" });
		triggerJsonDownload(`${sar.filing_reference}.fincen-sar.json`, json);
		await onExportSar(sar);
	};

	return (
		<section
			className="sar-registry-panel"
			aria-label={t("sarRegistry.heading", { count: sars.length })}
		>
			<div className="sar-registry-header">
				<h2>{t("sarRegistry.heading", { count: sars.length })}</h2>
				<p className="text-muted text-sm">{t("sarRegistry.subtitle")}</p>
			</div>

			{sars.length === 0 ? (
				<p className="sar-empty-box">{t("sarRegistry.empty")}</p>
			) : (
				<div className="table-scroll">
					<table className="table">
						<thead>
							<tr>
								<th scope="col">{t("sarRegistry.columns.reference")}</th>
								<th scope="col">{t("sarRegistry.columns.subject")}</th>
								<th scope="col">{t("sarRegistry.columns.matchedEntity")}</th>
								<th scope="col">{t("sarRegistry.columns.category")}</th>
								<th scope="col">{t("sarRegistry.columns.officer")}</th>
								<th scope="col">{t("sarRegistry.columns.status")}</th>
								<th scope="col">{t("sarRegistry.columns.filedAt")}</th>
								<th scope="col" className="table-cell-right">
									{t("sarRegistry.columns.actions")}
								</th>
							</tr>
						</thead>
						<tbody>
							{sars.map((sar) => {
								const expanded = openId === sar.sar_id;
								return (
									<Fragment key={sar.sar_id}>
										<tr>
											<td>
												<strong className="text-mono">
													{sar.filing_reference}
												</strong>
											</td>
											<td>
												<div>
													<strong>{sar.customer_reference}</strong>
												</div>
												<div className="text-sm text-muted">
													{sar.subject_name}
												</div>
											</td>
											<td>
												<div>{sar.sanctioned_name}</div>
												<span className="badge badge-muted">
													{listName(sar.source_list, t)}
												</span>
											</td>
											<td>{sarActivityLabel(sar.activity_category, t)}</td>
											<td className="text-sm">
												<div>{sar.filing_officer}</div>
												<div className="text-muted">{sar.institution_name}</div>
											</td>
											<td>
												<span className={sarBadgeClass(sar.status)}>
													{sarStatusLabel(sar.status, t)}
												</span>
											</td>
											<td className="text-sm">
												{formatSarTime(sar.filed_at ?? sar.updated_at)}
											</td>
											<td className="table-cell-right">
												<div className="sar-row-actions">
													<button
														type="button"
														className="btn btn-secondary btn-sm"
														aria-expanded={expanded}
														aria-label={t("sarRegistry.toggleNarrativeAria", {
															ref: sar.filing_reference,
														})}
														onClick={() =>
															setOpenId(expanded ? null : sar.sar_id)
														}
													>
														{t("sarRegistry.toggleNarrative")}
													</button>
													{sar.status === "DRAFT" && (
														<button
															type="button"
															className="btn btn-danger btn-sm"
															aria-label={t("sarRegistry.finalizeAria", {
																ref: sar.filing_reference,
															})}
															onClick={() => onFinalizeDraft(sar.sar_id)}
														>
															{t("sarRegistry.finalize")}
														</button>
													)}
													<button
														type="button"
														className="btn btn-primary btn-sm"
														aria-label={t("sarRegistry.exportJsonAria", {
															ref: sar.filing_reference,
														})}
														onClick={() => handleExport(sar)}
													>
														{t("sarRegistry.exportJson")}
													</button>
												</div>
											</td>
										</tr>
										{expanded && (
											<tr>
												<td colSpan={8}>
													<div className="sar-narrative-drawer">
														<pre className="sar-narrative-pre">
															{sar.narrative}
														</pre>
													</div>
												</td>
											</tr>
										)}
									</Fragment>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}
