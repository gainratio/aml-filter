/**
 * Settings — the local-first workstation's configuration page. Four sections:
 *   1. Screening sensitivity (a global Strict/Balanced/Lenient segmented control)
 *   2. Watchlists (a checkbox per signed-catalog list — which lists are screened)
 *   3. Per-list overrides (a sensitivity override per ENABLED source list)
 *   4. Analyst name (the audit-trail signer, a SQLite settings row)
 * plus the cached-lists control and the receipt signing key (export, import,
 * reset — SigningKeySection).
 *
 * Apply persists the analyst name, re-bootstraps the engine over the chosen
 * watchlist set (a disabled list's matches drop out → SUPPRESSED on re-screen),
 * and hands the screening config to `apiClient.setScreeningConfig`, which persists
 * it and re-screens — surfacing the combined rescan summary in a banner.
 */

import type { CatalogListInfo } from "@amlfilter/browser";
import type { RescanSummary, ScreeningConfig } from "@amlfilter/workstation";
import { ANALYST_NAME_KEY } from "@amlfilter/workstation";
import type { TFunction } from "i18next";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { SigningKeySection } from "../components/SigningKeySection";
import { apiClient } from "../lib/api";
import { listAge } from "../lib/listAge";
import { workstation } from "../lib/workstation";
import "../styles/common.css";

type Sensitivity = "strict" | "balanced" | "lenient";
type Overrides = Record<string, Sensitivity>;

interface SensitivityLevel {
	readonly level: Sensitivity;
}

// Order lenient→strict so left/right arrow roving reads naturally, mirroring
// ScreenPage's STRICTNESS_LEVELS.
const SENSITIVITY_LEVELS: ReadonlyArray<SensitivityLevel> = [
	{ level: "lenient" },
	{ level: "balanced" },
	{ level: "strict" },
];

const EMPTY_SUMMARY: RescanSummary = {
	customersScanned: 0,
	newHits: 0,
	clearedHits: 0,
};

function errorMessage(err: unknown, fallback: string): string {
	return err instanceof Error ? err.message : fallback;
}

// The level reached by an arrow key from the current one (Left/Up ←, Right/Down
// →), clamped at the ends. Returns null for any other key (no change).
function arrowTarget(current: Sensitivity, key: string): Sensitivity | null {
	const i = SENSITIVITY_LEVELS.findIndex((l) => l.level === current);
	if (key === "ArrowRight" || key === "ArrowDown") {
		return (
			SENSITIVITY_LEVELS[Math.min(i + 1, SENSITIVITY_LEVELS.length - 1)]
				?.level ?? null
		);
	}
	if (key === "ArrowLeft" || key === "ArrowUp") {
		return SENSITIVITY_LEVELS[Math.max(i - 1, 0)]?.level ?? null;
	}
	return null;
}

// An accessible segmented control reading as a 3-stop sensitivity slider —
// radiogroup + role="radio" stops with single-tabstop arrow-key roving.
function SensitivityControl({
	value,
	onChange,
	t,
}: {
	readonly value: Sensitivity;
	readonly onChange: (next: Sensitivity) => void;
	readonly t: TFunction;
}) {
	const onKeyDown = (event: ReactKeyboardEvent) => {
		const next = arrowTarget(value, event.key);
		if (next !== null) {
			event.preventDefault();
			onChange(next);
		}
	};
	return (
		<div className="screen-strictness">
			<div
				className="screen-strictness__track"
				role="radiogroup"
				aria-label={t("sensitivity.ariaLabel")}
			>
				{SENSITIVITY_LEVELS.map((level) => (
					// biome-ignore lint/a11y/useSemanticElements: the same ARIA radiogroup/radio segmented control as /screen's strictness slider, sharing its `screen-strictness__stop[aria-checked]` CSS and keyboard roving; moving to native <input type="radio"> must change both pages and that CSS together, so it is not done here alone
					<button
						key={level.level}
						type="button"
						role="radio"
						aria-checked={value === level.level}
						tabIndex={value === level.level ? 0 : -1}
						className="screen-strictness__stop"
						onClick={() => onChange(level.level)}
						onKeyDown={onKeyDown}
					>
						{t(`sensitivity.levels.${level.level}`)}
					</button>
				))}
			</div>
		</div>
	);
}

/** The age sentence for one list: how old it is, and — when the publisher could
 * not refresh it — why. Returns the copy plus whether it is a warning.
 *
 * A list whose `fetchedAt` cannot be parsed reads "Age unknown", NEVER as fresh:
 * silently defaulting an unknown age to "just updated" is the exact lie the
 * engine's fail-closed bundle guard exists to prevent, and the UI must not
 * reintroduce it one layer up.
 *
 * A list from a pre-per-list-freshness bundle (`agedFrom === "generatedAt"`) has
 * a REAL age — the bundle's build time — but no per-list refresh time, so it is
 * worded as the bundle's age rather than as "updated". Claiming a refresh
 * instant we do not have would be the same lie in a quieter voice. */
function ageSentence(
	list: CatalogListInfo,
	t: TFunction,
): { readonly text: string; readonly stale: boolean } {
	const age = listAge(list.fetchedAt);
	if (age === null) {
		return { text: t("watchlists.ageUnknown"), stale: true };
	}
	if (!list.stale) {
		const key =
			list.agedFrom === "generatedAt"
				? "watchlists.freshFromBundle"
				: "watchlists.fresh";
		return { text: t(key, { age: age.phrase }), stale: false };
	}
	const text =
		list.staleReason === null
			? t("watchlists.stale", { age: age.duration })
			: t("watchlists.staleWithReason", {
					age: age.duration,
					reason: list.staleReason,
				});
	return { text, stale: true };
}

function WatchlistToggle({
	list,
	enabled,
	onToggle,
	t,
}: {
	readonly list: CatalogListInfo;
	readonly enabled: boolean;
	readonly onToggle: (id: string, next: boolean) => void;
	readonly t: TFunction;
}) {
	const age = ageSentence(list, t);
	return (
		<label className="form-label" htmlFor={`watchlist-${list.id}`}>
			<input
				id={`watchlist-${list.id}`}
				type="checkbox"
				checked={enabled}
				onChange={(e) => onToggle(list.id, e.target.checked)}
			/>{" "}
			{list.title}{" "}
			{/* The age rides INSIDE the label, so it is part of the checkbox's
			    accessible name — a screen reader announces "EU Consolidated, Not
			    updated for 3 days …" when the user lands on the control. The ⚠ is
			    decorative; the warning is carried by the text, never by colour. */}
			<span
				className={
					age.stale ? "watchlist-age watchlist-age--stale" : "watchlist-age"
				}
			>
				{age.stale && (
					<span aria-hidden="true" className="watchlist-age__icon">
						⚠
					</span>
				)}
				{age.text}
			</span>{" "}
			<span className="watchlist-age watchlist-age--count">
				{t("watchlists.entities", { count: list.entitiesCount })}
			</span>
		</label>
	);
}

function OverrideSelect({
	id,
	label,
	value,
	onChange,
	t,
}: {
	readonly id: string;
	readonly label: string;
	readonly value: Sensitivity | "";
	readonly onChange: (next: string) => void;
	readonly t: TFunction;
}) {
	return (
		<div>
			<label className="form-label" htmlFor={`override-${id}`}>
				{t("overrides.label", { label })}
			</label>
			<select
				id={`override-${id}`}
				className="form-select"
				value={value}
				onChange={(e) => onChange(e.target.value)}
			>
				<option value="">{t("overrides.options.default")}</option>
				<option value="strict">{t("overrides.options.strict")}</option>
				<option value="balanced">{t("overrides.options.balanced")}</option>
				<option value="lenient">{t("overrides.options.lenient")}</option>
			</select>
		</div>
	);
}

function ResultBanner({
	summary,
	error,
	appliedChange,
	onRetry,
	t,
}: {
	readonly summary: RescanSummary | null;
	readonly error: string | null;
	/** Whether the apply that produced `summary` actually changed anything. A
	 * zero-customer book rescans 0 customers even for a REAL change, so the
	 * summary alone cannot distinguish "applied" from "nothing to apply". */
	readonly appliedChange: boolean;
	readonly onRetry?: (() => void) | undefined;
	readonly t: TFunction;
}) {
	if (error !== null) {
		return (
			<div className="alert alert-error" role="alert">
				<div>{t("banner.error", { error })}</div>
				{onRetry !== undefined && (
					<button type="button" className="btn btn-secondary" onClick={onRetry}>
						{t("buttons.retry")}
					</button>
				)}
			</div>
		);
	}
	if (summary === null) return null;
	if (summary.customersScanned === 0) {
		return (
			<div className="alert alert-success" role="status">
				{appliedChange ? t("banner.applied") : t("banner.unchanged")}
			</div>
		);
	}
	return (
		<div className="alert alert-success" role="status">
			{t("banner.rescanned", {
				customers: summary.customersScanned,
				newHits: summary.newHits,
				clearedHits: summary.clearedHits,
			})}
		</div>
	);
}

function setOverride(prev: Overrides, id: string, value: string): Overrides {
	if (value === "") {
		const next = { ...prev };
		delete next[id];
		return next;
	}
	return { ...prev, [id]: value as Sensitivity };
}

/** The catalog ids that are currently enabled, in catalog order. */
function enabledIds(
	catalog: ReadonlyArray<CatalogListInfo>,
	enabled: ReadonlySet<string>,
): string[] {
	return catalog.filter((l) => enabled.has(l.id)).map((l) => l.id);
}

/** Combine the selection + config rescan summaries: both re-screen the whole
 * book, so prefer whichever actually ran (config runs last over the final engine
 * state); if neither scanned, it's a clean no-op. */
function combineSummaries(
	selection: RescanSummary,
	config: RescanSummary,
): RescanSummary {
	if (config.customersScanned > 0) return config;
	if (selection.customersScanned > 0) return selection;
	return EMPTY_SUMMARY;
}

/** What the form holds vs what the device is actually running. `analystName`
 * is kept TRIMMED (that is what Apply persists). */
interface SettingsSnapshot {
	readonly sensitivity: Sensitivity;
	readonly overrides: Overrides;
	readonly analystName: string;
	readonly enabled: ReadonlySet<string>;
}

function overridesEqual(a: Overrides, b: Overrides): boolean {
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
	);
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	return a.size === b.size && [...a].every((id) => b.has(id));
}

/** Whether applying `draft` changes anything vs the applied snapshot. A blank
 * analyst name is never persisted, so it never counts as a change. */
function snapshotsDiffer(
	draft: SettingsSnapshot,
	applied: SettingsSnapshot,
): boolean {
	return (
		draft.sensitivity !== applied.sensitivity ||
		!overridesEqual(draft.overrides, applied.overrides) ||
		(draft.analystName !== "" && draft.analystName !== applied.analystName) ||
		!sameSet(draft.enabled, applied.enabled)
	);
}

export function SettingsPage() {
	const { t } = useTranslation("settings");
	const [sensitivity, setSensitivity] = useState<Sensitivity>("balanced");
	const [overrides, setOverrides] = useState<Overrides>({});
	const [analystName, setAnalystName] = useState<string>("");
	const [catalog, setCatalog] = useState<ReadonlyArray<CatalogListInfo>>([]);
	const [enabled, setEnabled] = useState<ReadonlySet<string>>(new Set());
	// The catalog + enabled set load asynchronously (a signed-catalog fetch). Apply
	// must wait for that: applying a half-loaded form would persist an empty
	// selection and disable every list.
	const [loaded, setLoaded] = useState<boolean>(false);
	const [applying, setApplying] = useState<boolean>(false);
	const [summary, setSummary] = useState<RescanSummary | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [cacheCleared, setCacheCleared] = useState<boolean>(false);
	// Cancels the in-flight settings load.
	const cancelLoad = useRef<(() => void) | null>(null);
	const [loadFailed, setLoadFailed] = useState<boolean>(false);
	// The last loaded-or-applied snapshot. The rescan summary alone cannot say
	// whether Apply changed anything (a zero-customer book always rescans 0),
	// so the confirmation banner diffs the draft against this baseline.
	const [baseline, setBaseline] = useState<SettingsSnapshot | null>(null);
	const [appliedChange, setAppliedChange] = useState<boolean>(false);

	// One settings load. Mount (and a language change) starts one; Retry starts
	// another directly from its handler. Each load cancels the previous one.
	const startLoad = useCallback(() => {
		cancelLoad.current?.();
		let cancelled = false;
		cancelLoad.current = () => {
			cancelled = true;
		};
		setLoadFailed(false);
		async function load(): Promise<void> {
			const config = await apiClient.getScreeningConfig();
			const handle = await workstation();
			const [stored, lists, enabledList] = await Promise.all([
				handle.store.getSetting(ANALYST_NAME_KEY),
				handle.catalogLists(),
				handle.getEnabledLists(),
			]);
			if (cancelled) return;
			setSensitivity(config.sensitivity);
			setOverrides({ ...config.overrides });
			setAnalystName(stored ?? "");
			setCatalog(lists);
			setEnabled(new Set(enabledList));
			setBaseline({
				sensitivity: config.sensitivity,
				overrides: { ...config.overrides },
				analystName: stored ?? "",
				enabled: new Set(enabledList),
			});
			setLoaded(true);
		}
		load().catch((err: unknown) => {
			if (!cancelled) {
				setLoadFailed(true);
				setError(errorMessage(err, t("errors.load")));
			}
		});
	}, [t]);

	useEffect(() => {
		startLoad();
		return () => {
			cancelLoad.current?.();
			cancelLoad.current = null;
		};
	}, [startLoad]);

	function retryLoad(): void {
		setError(null);
		setLoaded(false);
		startLoad();
	}

	function toggleWatchlist(id: string, next: boolean): void {
		setEnabled((prev) => {
			const updated = new Set(prev);
			if (next) {
				updated.add(id);
			} else {
				updated.delete(id);
			}
			return updated;
		});
	}

	async function persist(): Promise<void> {
		const handle = await workstation();
		const trimmed = analystName.trim();
		const draft: SettingsSnapshot = {
			sensitivity,
			overrides,
			analystName: trimmed,
			enabled,
		};
		const changed = baseline === null || snapshotsDiffer(draft, baseline);
		if (trimmed) {
			await handle.store.setSetting(ANALYST_NAME_KEY, trimmed);
		}
		// Apply the watchlist selection first (re-bootstrap + re-screen), then the
		// screening config (re-screen over the now-correct engine). Both return a
		// rescan summary; either may be a no-op when nothing in its slice changed.
		const selectionSummary = await handle.setEnabledLists(
			enabledIds(catalog, enabled),
		);
		const config: ScreeningConfig = { sensitivity, overrides };
		const configSummary = await apiClient.setScreeningConfig(config);
		// Everything persisted: the draft is now what the device runs (a blank
		// name was not persisted, so the baseline keeps the previous one).
		setBaseline({
			sensitivity,
			overrides: { ...overrides },
			analystName: trimmed !== "" ? trimmed : (baseline?.analystName ?? ""),
			enabled: new Set(enabled),
		});
		setAppliedChange(changed);
		setSummary(combineSummaries(selectionSummary, configSummary));
	}

	async function handleApply(): Promise<void> {
		setApplying(true);
		setError(null);
		setSummary(null);
		try {
			await persist();
		} catch (err) {
			setError(errorMessage(err, t("errors.apply")));
		} finally {
			setApplying(false);
		}
	}

	async function handleClearCache(): Promise<void> {
		setError(null);
		setCacheCleared(false);
		try {
			const handle = await workstation();
			await handle.clearListCache();
			setCacheCleared(true);
		} catch (err) {
			setError(errorMessage(err, t("errors.clearCache")));
		}
	}

	const overrideRows = catalog.filter((list) => enabled.has(list.id));

	return (
		<div className="page-content">
			<h1>{t("header.title")}</h1>

			{!loaded ? (
				<section className="card">
					<p className="text-muted" role="status">
						{t("status.loading")}
					</p>
				</section>
			) : (
				<>
					<section className="card">
						<h2>{t("sensitivity.title")}</h2>
						<p className="text-muted">{t("sensitivity.description")}</p>
						<SensitivityControl
							value={sensitivity}
							onChange={setSensitivity}
							t={t}
						/>
					</section>

					<section className="card">
						<h2>{t("watchlists.title")}</h2>
						<p className="text-muted">{t("watchlists.description")}</p>
						{catalog.map((list) => (
							<WatchlistToggle
								key={list.id}
								list={list}
								enabled={enabled.has(list.id)}
								onToggle={toggleWatchlist}
								t={t}
							/>
						))}
					</section>

					<section className="card">
						<h2>{t("overrides.title")}</h2>
						{overrideRows.map((list) => (
							<OverrideSelect
								key={list.id}
								id={list.id}
								label={list.title}
								value={overrides[list.id] ?? ""}
								onChange={(value) =>
									setOverrides((prev) => setOverride(prev, list.id, value))
								}
								t={t}
							/>
						))}
					</section>

					<section className="card">
						<h2>{t("analyst.title")}</h2>
						<label className="form-label" htmlFor="analyst-name">
							{t("analyst.label")}
						</label>
						<input
							id="analyst-name"
							type="text"
							className="form-input"
							value={analystName}
							onChange={(e) => setAnalystName(e.target.value)}
						/>
					</section>
				</>
			)}

			<section className="card">
				<h2>{t("cache.title")}</h2>
				<p className="text-muted">{t("cache.description")}</p>
				<button
					type="button"
					className="btn btn-secondary"
					onClick={() => {
						void handleClearCache();
					}}
				>
					{t("cache.button")}
				</button>
				{cacheCleared && (
					<div className="alert alert-success" role="status">
						{t("cache.cleared")}
					</div>
				)}
			</section>

			<button
				type="button"
				className="btn btn-primary"
				disabled={applying || !loaded}
				onClick={() => {
					void handleApply();
				}}
			>
				{t("buttons.apply")}
			</button>

			<ResultBanner
				summary={summary}
				error={error}
				appliedChange={appliedChange}
				onRetry={loadFailed ? retryLoad : undefined}
				t={t}
			/>

			<SigningKeySection />
		</div>
	);
}
