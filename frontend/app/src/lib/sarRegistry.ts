/**
 * Local-first Suspicious Activity Report (SAR) compliance registry.
 *
 * Persists SAR filings in the workstation SQLite settings table under
 * `SAR_REGISTRY_KEY` so regulatory dossiers survive browser restarts with zero
 * server round-trips.
 */

import type { SettingsStore } from "@amlfilter/workstation";
import type { CreateSarPayload, SarRecord, UpdateSarPayload } from "./api";

export const SAR_REGISTRY_KEY = "compliance.sar_registry.v1";

function parseRegistry(raw: string | null): SarRecord[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? (parsed as SarRecord[]) : [];
	} catch {
		return [];
	}
}

function buildFilingReference(nowIso: string, index: number): string {
	const dateStamp = nowIso.slice(0, 10).replaceAll("-", "");
	const seq = String(index).padStart(4, "0");
	return `SAR-${dateStamp}-${seq}`;
}

export async function loadSarRegistry(
	store: SettingsStore,
): Promise<SarRecord[]> {
	const raw = await store.getSetting(SAR_REGISTRY_KEY);
	return parseRegistry(raw);
}

async function saveSarRegistry(
	store: SettingsStore,
	records: ReadonlyArray<SarRecord>,
): Promise<void> {
	await store.setSetting(SAR_REGISTRY_KEY, JSON.stringify(records));
}

export async function createSarRecord(
	store: SettingsStore,
	payload: CreateSarPayload,
): Promise<SarRecord> {
	const existing = await loadSarRegistry(store);
	const now = new Date().toISOString();
	const status = payload.status ?? "FILED";
	const record: SarRecord = {
		sar_id: `sar-${Date.now()}-${existing.length + 1}`,
		filing_reference: buildFilingReference(now, existing.length + 1),
		status,
		match_id: payload.match_id,
		customer_id: payload.customer_id ?? null,
		customer_reference: payload.customer_reference,
		subject_name: payload.subject_name,
		sanctioned_name: payload.sanctioned_name,
		ofac_entity_id: payload.ofac_entity_id ?? payload.sanctioned_name,
		source_list: payload.source_list,
		match_score: payload.match_score,
		activity_category: payload.activity_category,
		suspicious_amount_usd: payload.suspicious_amount_usd ?? null,
		activity_start_date: payload.activity_start_date ?? null,
		institution_name: payload.institution_name.trim(),
		filing_officer: payload.filing_officer.trim(),
		contact_email: payload.contact_email.trim(),
		narrative: payload.narrative.trim(),
		created_at: now,
		updated_at: now,
		filed_at: status === "FILED" ? now : null,
		exported_at: null,
	};
	await saveSarRegistry(store, [record, ...existing]);
	return record;
}

export async function updateSarRecord(
	store: SettingsStore,
	sarId: string,
	patch: UpdateSarPayload,
): Promise<SarRecord> {
	const existing = await loadSarRegistry(store);
	const idx = existing.findIndex((r) => r.sar_id === sarId);
	if (idx === -1) throw new Error(`SAR ${sarId} not found`);
	const current = existing[idx] as SarRecord;
	const now = new Date().toISOString();
	const nextStatus = patch.status ?? current.status;
	const updated: SarRecord = {
		...current,
		...patch,
		status: nextStatus,
		updated_at: now,
		filed_at:
			nextStatus === "FILED" && !current.filed_at ? now : current.filed_at,
		exported_at: nextStatus === "EXPORTED" ? now : current.exported_at,
	};
	const next = [...existing];
	next[idx] = updated;
	await saveSarRegistry(store, next);
	return updated;
}

export function buildSarDossierJson(sar: SarRecord): string {
	return JSON.stringify(
		{
			schema: "amlfilter.fincen.sar.v1",
			filing_reference: sar.filing_reference,
			sar_id: sar.sar_id,
			status: sar.status,
			timestamps: {
				created_at: sar.created_at,
				updated_at: sar.updated_at,
				filed_at: sar.filed_at,
				exported_at: sar.exported_at,
			},
			filing_institution: {
				institution_name: sar.institution_name,
				filing_officer: sar.filing_officer,
				contact_email: sar.contact_email,
			},
			subject_information: {
				customer_id: sar.customer_id,
				customer_reference: sar.customer_reference,
				subject_name: sar.subject_name,
			},
			suspicious_activity: {
				activity_category: sar.activity_category,
				suspicious_amount_usd: sar.suspicious_amount_usd,
				activity_start_date: sar.activity_start_date,
				sanctions_match: {
					match_id: sar.match_id,
					sanctioned_name: sar.sanctioned_name,
					ofac_entity_id: sar.ofac_entity_id,
					source_list: sar.source_list,
					match_score: sar.match_score,
				},
			},
			narrative: sar.narrative,
		},
		null,
		2,
	);
}
