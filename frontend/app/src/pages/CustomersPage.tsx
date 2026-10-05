/** KYC customer onboarding page (the /v1/customers tier). */

import type { TFunction } from "i18next";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
	apiClient,
	type CustomerOnboardResponse,
	type CustomerResponse,
	type CustomerUpdateRequest,
	type IdDocument,
	type KycRiskRating,
	type OnboardingStatus,
} from "../lib/api";
import {
	listAllReviewMatches,
	type ScreeningSummary,
	type ScreeningView,
	screeningStateFor,
	screeningSummaries,
} from "../lib/customerScreening";
import {
	buildCustomerImportPreview,
	type CustomerImportDuplicate,
	type CustomerImportError,
	type CustomerImportRow,
	createCustomerExportFile,
	readCustomerImportFile,
} from "../lib/customerTransfer";
import { checkForWatchlistUpdates, reportUserSync } from "../lib/sync";
import { useLoadedListVersion } from "../lib/useLoadedListVersion";
import { workstation } from "../lib/workstation";
import {
	type CustomerDraft,
	CustomerEditorRow,
	CustomerTableRow,
	draftOf,
	UnscreenedNotice,
} from "./CustomerTableRow";

interface IdDocumentRow {
	/** Stable React key for this form row (never submitted). */
	key: string;
	doc_type: string;
	number: string;
	issuing_country: string;
	expiry: string;
}

interface NewCustomerForm {
	customer_reference: string;
	name: string;
	onboarded_by: string;
	country: string;
	dob: string;
}

interface ImportPreviewState {
	fileName: string;
	accepted: ReadonlyArray<CustomerImportRow>;
	duplicates: ReadonlyArray<CustomerImportDuplicate>;
	errors: ReadonlyArray<CustomerImportError>;
}

const EMPTY_FORM: NewCustomerForm = {
	customer_reference: "",
	name: "",
	onboarded_by: "",
	country: "",
	dob: "",
};

/** Only the fields the editor actually changed, so an unchanged field is never rewritten. */
function changedFields(
	before: CustomerResponse,
	draft: CustomerDraft,
): CustomerUpdateRequest {
	return {
		...(draft.name !== before.name ? { name: draft.name } : {}),
		...(draft.country !== (before.country ?? "")
			? { country: draft.country }
			: {}),
		...(draft.status !== before.onboarding_status
			? { onboarding_status: draft.status as OnboardingStatus }
			: {}),
		...(draft.risk !== "" && draft.risk !== before.kyc_risk_rating
			? { kyc_risk_rating: draft.risk as KycRiskRating }
			: {}),
	};
}

/** Screening summaries per customer, or null when the matches could not be read. */
async function loadScreening(): Promise<ReadonlyMap<
	string,
	ScreeningSummary
> | null> {
	try {
		return screeningSummaries(
			await listAllReviewMatches((page) => apiClient.listReviewMatches(page)),
		);
	} catch {
		return null;
	}
}

function toIdDocuments(rows: IdDocumentRow[]): IdDocument[] {
	return rows
		.filter((row) => row.doc_type.trim() && row.number.trim())
		.map((row) => ({
			doc_type: row.doc_type.trim(),
			number: row.number.trim(),
			issuing_country: row.issuing_country.trim().toUpperCase(),
			expiry: row.expiry || null,
		}));
}

function errorMessage(err: unknown, fallback: string): string {
	return err instanceof Error ? err.message : fallback;
}

export function CustomersPage() {
	const { t } = useTranslation("customers");
	const [customers, setCustomers] = useState<CustomerResponse[]>([]);
	const [screening, setScreening] = useState<ReadonlyMap<
		string,
		ScreeningSummary
	> | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [form, setForm] = useState<NewCustomerForm>(EMPTY_FORM);
	const [idDocs, setIdDocs] = useState<IdDocumentRow[]>([]);
	const [lastResult, setLastResult] = useState<CustomerOnboardResponse | null>(
		null,
	);
	const [syncing, setSyncing] = useState(false);
	const [syncMessage, setSyncMessage] = useState<string | null>(null);
	const [lastSynced, setLastSynced] = useState<{
		version: string;
		at: string;
	} | null>(null);
	const [editing, setEditing] = useState<CustomerDraft | null>(null);
	const [importPreview, setImportPreview] = useState<ImportPreviewState | null>(
		null,
	);
	const [importing, setImporting] = useState(false);
	const [transferMessage, setTransferMessage] = useState<string | null>(null);
	const importInputRef = useRef<HTMLInputElement>(null);
	const lists = useLoadedListVersion();
	const refreshListVersion = lists.refresh;
	const [screeningNow, setScreeningNow] = useState(false);

	const loadCustomers = useCallback(async () => {
		try {
			setLoading(true);
			setError(null);
			const data = await apiClient.listCustomers();
			setCustomers(data);
			setScreening(await loadScreening());
			await refreshListVersion();
		} catch (err) {
			setError(errorMessage(err, t("errors.load")));
		} finally {
			setLoading(false);
		}
	}, [t, refreshListVersion]);

	const viewFor = (customer: CustomerResponse): ScreeningView => {
		const view = screeningStateFor(screening, customer, lists.version);
		// A failed engine boot can never prove a screen: say "Not checked".
		return lists.failed && view.state === "listsLoading"
			? { state: "unknown", open: 0 }
			: view;
	};
	const unscreened = customers.filter(
		(customer) => viewFor(customer).state === "notScreened",
	);

	const handleScreenUnscreened = async () => {
		try {
			setScreeningNow(true);
			setError(null);
			const handle = await workstation();
			for (const customer of unscreened) {
				await handle.rescan.screenCustomer(customer.customer_id);
			}
			await loadCustomers();
		} catch (err) {
			setError(errorMessage(err, t("errors.screen")));
		} finally {
			setScreeningNow(false);
		}
	};

	useEffect(() => {
		loadCustomers();
	}, [loadCustomers]);

	const handleOnboard = async (e: React.FormEvent) => {
		e.preventDefault();
		try {
			setError(null);
			const result = await apiClient.onboardCustomer({
				customer_reference: form.customer_reference,
				name: form.name,
				...(form.onboarded_by ? { onboarded_by: form.onboarded_by } : {}),
				...(form.country ? { country: form.country } : {}),
				...(form.dob ? { dob: form.dob } : {}),
				id_documents: toIdDocuments(idDocs),
			});
			setLastResult(result);
			setForm(EMPTY_FORM);
			setIdDocs([]);
			await loadCustomers();
		} catch (err) {
			setError(errorMessage(err, t("errors.onboard")));
		}
	};

	const handleDelete = async (customerId: string) => {
		if (!confirm(t("actions.deleteConfirm"))) return;
		try {
			setError(null);
			await apiClient.deleteCustomer(customerId);
			await loadCustomers();
		} catch (err) {
			setError(errorMessage(err, t("errors.delete")));
		}
	};

	const handleCheckForUpdates = async () => {
		try {
			setSyncing(true);
			setError(null);
			const handle = await workstation();
			// A fresh manual click may precede the background engine boot — the
			// watchlist version is only known after bootstrap, so ensure it first.
			if (handle.watchlistVersion() === null) {
				await handle.engineBoot();
			}
			// Live new-publish detection: poll the signed manifest, and if a newer
			// list was published after this tab booted, reload it into the engine
			// before re-screening every customer against it.
			const result = await checkForWatchlistUpdates(handle);
			if (result === null) {
				setSyncMessage(t("sync.enginePending"));
				return;
			}
			setSyncMessage(reportUserSync(result));
			setLastSynced({ version: result.version, at: new Date().toISOString() });
			await loadCustomers();
		} catch (err) {
			setError(errorMessage(err, t("errors.checkUpdates")));
		} finally {
			setSyncing(false);
		}
	};

	const handleEditSave = async () => {
		if (editing === null) return;
		const before = customers.find(
			(customer) => customer.customer_id === editing.customerId,
		);
		if (before === undefined) return;
		try {
			setError(null);
			const patch = changedFields(before, editing);
			if (Object.keys(patch).length > 0) {
				await apiClient.updateCustomer(editing.customerId, patch);
			}
			// A new name or country is a new identity: re-screen this customer so
			// the review board reflects it. Status and risk alone change nothing
			// the screen reads.
			if (patch.name !== undefined || patch.country !== undefined) {
				const handle = await workstation();
				await handle.rescan.screenCustomer(editing.customerId);
			}
			setEditing(null);
			await loadCustomers();
		} catch (err) {
			setError(errorMessage(err, t("errors.save")));
		}
	};

	const handleExport = async () => {
		try {
			setError(null);
			setTransferMessage(null);
			const file = await createCustomerExportFile(customers);
			const url = URL.createObjectURL(file);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = `aml-filter-customers-${new Date().toISOString().slice(0, 10)}.xlsx`;
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			window.setTimeout(() => URL.revokeObjectURL(url), 0);
			setTransferMessage(t("transfer.exported", { total: customers.length }));
		} catch (err) {
			setError(errorMessage(err, t("errors.export")));
		}
	};

	const handleImportFile = async (
		event: React.ChangeEvent<HTMLInputElement>,
	) => {
		const file = event.target.files?.[0];
		event.target.value = "";
		if (!file) return;
		try {
			setError(null);
			setTransferMessage(null);
			const parsed = await readCustomerImportFile(file);
			const preview = buildCustomerImportPreview(
				parsed.rows,
				customers.map((customer) => customer.customer_reference),
			);
			setImportPreview({
				fileName: file.name,
				accepted: preview.accepted,
				duplicates: preview.duplicates,
				errors: parsed.errors,
			});
		} catch (err) {
			setImportPreview(null);
			setError(errorMessage(err, t("errors.import")));
		}
	};

	const handleImportConfirm = async () => {
		if (!importPreview || importPreview.accepted.length === 0) return;
		setImporting(true);
		setError(null);
		try {
			const result = await apiClient.importCustomers(
				importPreview.accepted.map((row) => ({
					customer_reference: row.customer_reference,
					name: row.name,
					onboarded_by: row.onboarded_by,
					...(row.country ? { country: row.country } : {}),
					...(row.dob ? { dob: row.dob } : {}),
					id_documents: [...row.id_documents],
				})),
			);
			await loadCustomers();
			setImportPreview(null);
			setTransferMessage(
				t("transfer.imported", {
					imported: result.customers.length,
					duplicates: importPreview.duplicates.length,
					screening: result.screening
						? t("transfer.screened", {
								customers: result.screening.customersScanned,
							})
						: t("transfer.screeningPending"),
				}),
			);
		} catch (err) {
			setError(errorMessage(err, t("errors.import")));
		} finally {
			setImporting(false);
		}
	};

	const addIdDocRow = () =>
		setIdDocs((rows) => [
			...rows,
			{
				key: crypto.randomUUID(),
				doc_type: "",
				number: "",
				issuing_country: "",
				expiry: "",
			},
		]);

	const updateIdDocRow = (
		index: number,
		field: Exclude<keyof IdDocumentRow, "key">,
		value: string,
	) =>
		setIdDocs((rows) =>
			rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
		);

	const removeIdDocRow = (index: number) =>
		setIdDocs((rows) => rows.filter((_, i) => i !== index));

	return (
		<div>
			<div className="flex-between customers-header">
				<h1>{t("header.title")}</h1>
				<div className="flex-gap-sm customers-header-actions">
					<input
						ref={importInputRef}
						type="file"
						accept=".csv,.xls,.xlsx"
						onChange={handleImportFile}
						className="visually-hidden"
						aria-label={t("transfer.fileLabel")}
					/>
					<button
						type="button"
						onClick={() => importInputRef.current?.click()}
						className="btn btn-secondary btn-sm"
					>
						{t("transfer.import")}
					</button>
					<button
						type="button"
						onClick={handleExport}
						disabled={loading || importing}
						className="btn btn-secondary btn-sm"
					>
						{t("transfer.export")}
					</button>
					<button
						type="button"
						onClick={handleCheckForUpdates}
						disabled={syncing || importing}
						className="btn btn-secondary btn-sm"
					>
						{syncing ? t("header.checking") : t("header.checkUpdates")}
					</button>
				</div>
			</div>

			{syncMessage && (
				<div className="alert card-muted text-sm" role="status">
					{syncMessage}
				</div>
			)}
			{lastSynced && (
				<p className="text-muted text-sm">
					{t("sync.lastSynced", {
						version: lastSynced.version,
						time: new Date(lastSynced.at).toLocaleTimeString(),
					})}
				</p>
			)}

			{error && (
				<div className="alert alert-error">{t("alerts.error", { error })}</div>
			)}
			{transferMessage && (
				<div className="alert alert-success" role="status">
					{transferMessage}
				</div>
			)}

			{importPreview && (
				<section
					className="card card-muted transfer-preview"
					aria-live="polite"
				>
					<div className="flex-between">
						<div>
							<h2>{t("transfer.previewTitle")}</h2>
							<p className="text-muted text-sm">{importPreview.fileName}</p>
						</div>
						<button
							type="button"
							onClick={() => setImportPreview(null)}
							className="btn btn-secondary btn-sm"
							disabled={importing}
						>
							{t("transfer.cancel")}
						</button>
					</div>
					<p>
						{t("transfer.summary", {
							accepted: importPreview.accepted.length,
							duplicates: importPreview.duplicates.length,
							errors: importPreview.errors.length,
						})}
					</p>
					{importPreview.errors.length > 0 && (
						<ul className="transfer-issues text-sm">
							{importPreview.errors.slice(0, 20).map((issue) => (
								<li key={`${issue.rowNumber}-${issue.field}`}>
									{t("transfer.issue", { ...issue })}
								</li>
							))}
						</ul>
					)}
					<button
						type="button"
						onClick={handleImportConfirm}
						disabled={importing || importPreview.accepted.length === 0}
						className="btn btn-primary"
					>
						{importing
							? t("transfer.importing")
							: t("transfer.confirm", {
									count: importPreview.accepted.length,
								})}
					</button>
				</section>
			)}

			{lastResult && (
				<OnboardResultAlert
					result={lastResult}
					onDismiss={() => setLastResult(null)}
					t={t}
				/>
			)}

			<form
				onSubmit={handleOnboard}
				aria-label={t("onboard.formLabel")}
				className="card card-muted mb-lg"
			>
				<h3>{t("onboard.heading")}</h3>
				<div className="form-group form-grid">
					<div>
						<label htmlFor="customer-reference" className="form-label">
							{t("onboard.fields.reference")}
						</label>
						<input
							id="customer-reference"
							type="text"
							value={form.customer_reference}
							onChange={(e) =>
								setForm({ ...form, customer_reference: e.target.value })
							}
							required
							className="form-input"
						/>
					</div>
					<div>
						<label htmlFor="customer-name" className="form-label">
							{t("onboard.fields.name")}
						</label>
						<input
							id="customer-name"
							type="text"
							value={form.name}
							onChange={(e) => setForm({ ...form, name: e.target.value })}
							required
							className="form-input"
						/>
					</div>
				</div>
				<div className="form-group form-grid">
					<div>
						<label htmlFor="customer-onboarded-by" className="form-label">
							{t("onboard.fields.onboardedBy")}
						</label>
						<input
							id="customer-onboarded-by"
							type="text"
							value={form.onboarded_by}
							onChange={(e) =>
								setForm({ ...form, onboarded_by: e.target.value })
							}
							className="form-input"
						/>
					</div>
					<div>
						<label htmlFor="customer-country" className="form-label">
							{t("onboard.fields.country")}
						</label>
						<input
							id="customer-country"
							type="text"
							value={form.country}
							onChange={(e) => setForm({ ...form, country: e.target.value })}
							maxLength={2}
							className="form-input"
						/>
					</div>
					<div>
						<label htmlFor="customer-dob" className="form-label">
							{t("onboard.fields.dob")}
						</label>
						<input
							id="customer-dob"
							type="date"
							value={form.dob}
							onChange={(e) => setForm({ ...form, dob: e.target.value })}
							className="form-input"
						/>
					</div>
				</div>

				<div className="form-group">
					<div className="flex-between mb-sm">
						<span className="form-label-bold">
							{t("onboard.documents.heading")}
						</span>
						<button
							type="button"
							onClick={addIdDocRow}
							className="btn btn-secondary btn-sm"
						>
							{t("onboard.documents.add")}
						</button>
					</div>
					{idDocs.length === 0 ? (
						<p className="text-muted text-sm">{t("onboard.documents.empty")}</p>
					) : (
						idDocs.map((row, index) => (
							<div
								key={row.key}
								className="form-grid mb-sm"
								data-testid="id-doc-row"
							>
								<input
									type="text"
									aria-label={t("onboard.documents.typeAria", {
										index: index + 1,
									})}
									placeholder={t("onboard.documents.typePlaceholder")}
									value={row.doc_type}
									onChange={(e) =>
										updateIdDocRow(index, "doc_type", e.target.value)
									}
									className="form-input"
								/>
								<input
									type="text"
									aria-label={t("onboard.documents.numberAria", {
										index: index + 1,
									})}
									placeholder={t("onboard.documents.numberPlaceholder")}
									value={row.number}
									onChange={(e) =>
										updateIdDocRow(index, "number", e.target.value)
									}
									className="form-input"
								/>
								<input
									type="text"
									aria-label={t("onboard.documents.issuingCountryAria", {
										index: index + 1,
									})}
									placeholder={t("onboard.documents.issuingCountryPlaceholder")}
									maxLength={2}
									value={row.issuing_country}
									onChange={(e) =>
										updateIdDocRow(index, "issuing_country", e.target.value)
									}
									className="form-input"
								/>
								<input
									type="date"
									aria-label={t("onboard.documents.expiryAria", {
										index: index + 1,
									})}
									value={row.expiry}
									onChange={(e) =>
										updateIdDocRow(index, "expiry", e.target.value)
									}
									className="form-input"
								/>
								<button
									type="button"
									onClick={() => removeIdDocRow(index)}
									className="btn btn-danger btn-sm"
								>
									{t("onboard.documents.remove")}
								</button>
							</div>
						))
					)}
				</div>

				<button type="submit" className="btn btn-primary">
					{t("onboard.submit")}
				</button>
			</form>

			<h2>{t("list.title", { total: customers.length })}</h2>
			{!loading && unscreened.length > 0 ? (
				<UnscreenedNotice
					count={unscreened.length}
					busy={screeningNow}
					onScreen={handleScreenUnscreened}
				/>
			) : null}
			{loading ? (
				<p>{t("list.loading")}</p>
			) : customers.length === 0 ? (
				<p>{t("list.empty")}</p>
			) : (
				<section
					className="table-scroll"
					aria-label={t("list.title", { total: customers.length })}
				>
					<table className="table customers-table">
						<thead>
							<tr>
								<th scope="col">{t("list.columns.reference")}</th>
								<th scope="col">{t("list.columns.screening")}</th>
								<th scope="col">{t("list.columns.status")}</th>
								<th scope="col">{t("list.columns.risk")}</th>
								<th scope="col">{t("list.columns.onboardedBy")}</th>
								<th scope="col">{t("list.columns.created")}</th>
								<th scope="col" className="table-cell-right">
									{t("list.columns.actions")}
								</th>
							</tr>
						</thead>
						<tbody>
							{customers.map((customer) => {
								const isEditing = editing?.customerId === customer.customer_id;
								return (
									<Fragment key={customer.customer_id}>
										<CustomerTableRow
											customer={customer}
											screening={viewFor(customer)}
											editing={isEditing}
											onEdit={() => setEditing(draftOf(customer))}
											onDelete={() => handleDelete(customer.customer_id)}
										/>
										{isEditing && editing !== null ? (
											<CustomerEditorRow
												reference={customer.customer_reference}
												draft={editing}
												onChange={setEditing}
												onSave={handleEditSave}
												onCancel={() => setEditing(null)}
											/>
										) : null}
									</Fragment>
								);
							})}
						</tbody>
					</table>
				</section>
			)}
		</div>
	);
}

interface OnboardResultAlertProps {
	result: CustomerOnboardResponse;
	onDismiss: () => void;
	t: TFunction;
}

function OnboardResultAlert({ result, onDismiss, t }: OnboardResultAlertProps) {
	const hasMatch = result.match_entity_ids.length > 0;
	return (
		<div className={`alert ${hasMatch ? "alert-warning" : "alert-success"}`}>
			<div className="flex-between">
				<span>
					{hasMatch ? (
						<Trans
							i18nKey="onboard.result.match"
							ns="customers"
							values={{
								reference: result.customer_reference,
								matches: result.match_entity_ids.length,
							}}
							components={{ strong: <strong /> }}
						/>
					) : (
						<Trans
							i18nKey="onboard.result.clear"
							ns="customers"
							values={{ reference: result.customer_reference }}
							components={{ strong: <strong /> }}
						/>
					)}
				</span>
				<button
					type="button"
					onClick={onDismiss}
					className="btn btn-secondary btn-sm"
				>
					{t("onboard.result.dismiss")}
				</button>
			</div>
		</div>
	);
}
