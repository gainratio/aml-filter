/**
 * Boot + identity gate for the local-first workstation routes. Order:
 *   1. open the DB Worker (SQLite-WASM/OPFS) — blocking, fast;
 *   2. one-time analyst-name prompt (a SQLite settings row, spec §9.5);
 *   3. render children, with the OFAC engine bootstrapping in the BACKGROUND
 *      (a status strip mirrors /screen's staged boot UX; onboarding awaits
 *      the engine internally, the review board never needs it).
 */

import type { BootStage } from "@amlfilter/browser";
import { ANALYST_NAME_KEY, type SyncResult } from "@amlfilter/workstation";
import type { TFunction } from "i18next";
import {
	type FormEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { formatBytes } from "../lib/formatBytes";
import { checkForWatchlistUpdates, syncToAnnounce } from "../lib/sync";
import {
	retainWorkstationRuntime,
	type WorkstationHandle,
	workstation,
} from "../lib/workstation";
import {
	bundleCacheRecovery,
	userFacingBootError,
	userFacingStorageError,
} from "../pages/bootErrorMessage";
import { CacheRecovery } from "./CacheRecovery";

/**
 * How often an open tab re-checks for a newly-published watchlist version. A
 * nightly list refresh is then picked up without a manual reload. Exported (and
 * a named constant, not an inline magic number) so it is tunable + testable.
 */
export const WATCHLIST_POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

type GatePhase =
	| { kind: "booting" }
	| { kind: "name-needed" }
	| { kind: "ready" }
	| { kind: "error"; message: string };

interface WorkstationGateProps {
	children: ReactNode;
	/** Settings only needs signed catalog metadata; defer model boot until Apply. */
	readonly bootEngine?: boolean;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function WorkstationGate({
	children,
	bootEngine = true,
}: WorkstationGateProps) {
	const { t } = useTranslation(["common", "errors"]);
	const [phase, setPhase] = useState<GatePhase>({ kind: "booting" });
	const [nonce, setNonce] = useState(0);
	const [name, setName] = useState("");
	const releaseLease = useRef<(() => void) | null>(null);

	// nonce is not read in the body — it is the intentional re-fire trigger:
	// Retry bumps it so this effect re-runs the DB boot (workstation() cleared
	// its memo when the prior attempt rejected).
	// biome-ignore lint/correctness/useExhaustiveDependencies: nonce is an intentional re-fire trigger, not read in the body
	useEffect(() => {
		let cancelled = false;
		releaseLease.current?.();
		releaseLease.current = retainWorkstationRuntime();
		setPhase({ kind: "booting" });
		// Ask the browser to protect OPFS from eviction (spec risk: quota /
		// eviction). Best-effort: jsdom/tests and older browsers lack it.
		void navigator.storage?.persist?.().catch(() => undefined);
		workstation()
			.then(async (handle) => {
				const stored = await handle.store.getSetting(ANALYST_NAME_KEY);
				if (!cancelled) {
					setPhase(stored ? { kind: "ready" } : { kind: "name-needed" });
				}
			})
			.catch((error: unknown) => {
				if (!cancelled) {
					setPhase({ kind: "error", message: messageOf(error) });
				}
			});
		return () => {
			cancelled = true;
			releaseLease.current?.();
			releaseLease.current = null;
		};
	}, [nonce]);

	const handleNameSubmit = async (event: FormEvent) => {
		event.preventDefault();
		const trimmed = name.trim();
		if (!trimmed) return;
		try {
			const handle = await workstation();
			await handle.store.setSetting(ANALYST_NAME_KEY, trimmed);
			setPhase({ kind: "ready" });
		} catch (error) {
			setPhase({ kind: "error", message: messageOf(error) });
		}
	};

	if (phase.kind === "booting") {
		return (
			<div className="card card-muted" role="status" aria-live="polite">
				{t("common:workstation.booting")}
			</div>
		);
	}

	if (phase.kind === "error") {
		const safeError = userFacingStorageError(phase.message);
		return (
			<div
				className="alert alert-error error-surface"
				role="alert"
				aria-live="assertive"
			>
				<div className="error-surface__copy">
					<strong>{safeError.title}</strong>
					<p>{safeError.recovery}</p>
					<details className="error-surface__details">
						<summary>Technical details</summary>
						<code>{safeError.technicalDetail}</code>
					</details>
				</div>
				<button
					type="button"
					className="btn btn-primary"
					onClick={() => setNonce((n) => n + 1)}
				>
					{t("common:actions.retry")}
				</button>
			</div>
		);
	}

	if (phase.kind === "name-needed") {
		return (
			<form
				onSubmit={handleNameSubmit}
				aria-label={t("common:workstation.nameFormAria")}
				className="card card-muted"
			>
				<h2>{t("common:workstation.welcomeHeading")}</h2>
				<p className="text-muted">{t("common:workstation.nameExplain")}</p>
				<label htmlFor="analyst-name" className="form-label">
					{t("common:workstation.nameLabel")}
				</label>
				<input
					id="analyst-name"
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					required
					className="form-input"
				/>
				<button type="submit" className="btn btn-primary">
					{t("common:workstation.startReviewing")}
				</button>
			</form>
		);
	}

	return (
		<>
			{bootEngine && <EngineStatusStrip />}
			{children}
		</>
	);
}

function engineStageLabel(stage: BootStage, t: TFunction): string | null {
	if (stage.kind === "downloading") {
		return t("common:workstation.engine.downloading");
	}
	if (stage.kind === "verified") {
		return t("common:workstation.engine.verified");
	}
	if (stage.kind === "loading-model") {
		return t("common:workstation.engine.loadingModel", {
			detail: modelDetail(stage.progress),
		});
	}
	return null; // ready
}

/** The suffix on the engine-strip model line: a percent when the download has a
 * real denominator, megabytes when the server withheld `content-length`, and
 * nothing before the first byte lands. Never a fabricated percentage. */
function modelDetail(
	progress: Extract<BootStage, { kind: "loading-model" }>["progress"],
): string {
	if (progress === undefined) {
		return "";
	}
	if (progress.pct === undefined) {
		return ` ${formatBytes(progress.loaded)}`;
	}
	return ` ${Math.round(progress.pct)}%`;
}

function EngineStatusStrip() {
	const { t } = useTranslation(["common", "errors"]);
	const [stage, setStage] = useState<BootStage | null>(null);
	// The LIVE boot error, not its message: the classifier reads the Worker's
	// `EngineOperationError.code` / `.name`, which a string has already lost.
	const [error, setError] = useState<unknown>(null);
	const [autoSync, setAutoSync] = useState<SyncResult | null>(null);
	const [nonce, setNonce] = useState(0);
	// Guards the once-per-boot auto-sync: the engine version is only known after
	// engineBoot resolves, and we must not re-fire on every render.
	const autoSyncFired = useRef(false);

	// nonce is not read in the body — it is the intentional re-fire trigger:
	// Retry bumps it so this effect re-kicks the background engine bootstrap.
	// biome-ignore lint/correctness/useExhaustiveDependencies: nonce is an intentional re-fire trigger, not read in the body
	useEffect(() => {
		let cancelled = false;
		setError(null);
		workstation()
			.then(async (handle) => {
				if (cancelled) return;
				await handle.engineBoot((s) => {
					if (!cancelled) setStage(s);
				});
				if (cancelled) return;
				// Engine ready → the watchlist version is now known. Auto-sync once:
				// re-screen every customer if the list advanced since last sync.
				if (autoSyncFired.current) return;
				autoSyncFired.current = true;
				// Only a genuine update (a version change since a recorded sync that
				// re-screened someone) gets a banner; the first-ever list load is a
				// baseline and stays silent beside the onboarding alert.
				const result = await syncToAnnounce(handle);
				if (!cancelled && result !== null) {
					setAutoSync(result);
				}
			})
			.catch((bootError: unknown) => {
				if (!cancelled) setError(bootError ?? new Error("engine boot failed"));
			});
		return () => {
			cancelled = true;
		};
	}, [nonce]);

	// Recurring poll: while the tab stays open, re-check for a newly-published
	// watchlist version on an interval (a nightly refresh is picked up without a
	// manual reload). Independent of the once-per-boot auto-sync above. Errors are
	// swallowed/logged so a transient fetch failure never stops future polls, and
	// an in-flight check is never allowed to stack (isChecking guard). The
	// interval is torn down on unmount / handle change (no leaked timers).
	useEffect(() => {
		let cancelled = false;
		let isChecking = false;
		let timer: ReturnType<typeof setInterval> | null = null;
		let handle: WorkstationHandle | null = null;

		const poll = () => {
			if (isChecking || handle === null) return; // skip: a poll is still running
			isChecking = true;
			void checkForWatchlistUpdates(handle)
				.catch((pollError: unknown) => {
					// Transient (e.g. offline fetch) — log, never crash or stop polling.
					console.warn("watchlist update poll failed:", messageOf(pollError));
				})
				.finally(() => {
					isChecking = false;
				});
		};

		workstation()
			.then((resolved) => {
				if (cancelled) return;
				handle = resolved;
				timer = setInterval(poll, WATCHLIST_POLL_INTERVAL_MS);
			})
			.catch(() => undefined); // boot failure is surfaced by the effect above

		return () => {
			cancelled = true;
			if (timer !== null) clearInterval(timer);
		};
	}, []);

	if (error !== null) {
		const safeError = userFacingBootError(error);
		const recovery = bundleCacheRecovery(error);
		return (
			<div
				className="alert alert-warning error-surface"
				role="alert"
				aria-live="assertive"
			>
				<div className="error-surface__copy">
					<strong>{safeError.title}</strong>
					<p>{safeError.recovery}</p>
					<details className="error-surface__details">
						<summary>Technical details</summary>
						<code>{safeError.technicalDetail}</code>
					</details>
					{recovery !== null && (
						<CacheRecovery
							kind={recovery}
							onClear={async () => {
								const handle = await workstation();
								await handle.clearListCache();
							}}
							onCleared={() => setNonce((n) => n + 1)}
						/>
					)}
				</div>
				<button
					type="button"
					className="btn btn-secondary btn-sm"
					onClick={() => setNonce((n) => n + 1)}
				>
					{t("common:actions.retry")}
				</button>
			</div>
		);
	}

	const label = stage === null ? null : engineStageLabel(stage, t);
	if (label !== null) {
		return (
			<div className="card card-muted text-sm" role="status" aria-live="polite">
				{t("common:workstation.engineStatus", { label })}
			</div>
		);
	}
	if (autoSync !== null) {
		return (
			<div
				className="alert card-muted text-sm"
				role="status"
				aria-live="polite"
			>
				{t("common:workstation.watchlistUpdated", {
					count: autoSync.customersScanned,
					newHits: autoSync.newHits,
					clearedHits: autoSync.clearedHits,
				})}{" "}
				<button
					type="button"
					className="btn btn-secondary btn-sm"
					onClick={() => setAutoSync(null)}
				>
					{t("common:actions.dismiss")}
				</button>
			</div>
		);
	}
	return null;
}
