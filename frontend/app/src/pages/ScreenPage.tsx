import {
	type BootStage,
	type CatalogListInfo,
	configFromEnv,
	EngineRuntime,
	type Entity,
	engineSupport,
	type Match,
} from "@amlfilter/browser";
import type { TFunction } from "i18next";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { CacheRecovery } from "../components/CacheRecovery";
import { Footer } from "../components/Footer";
import { formatBytes } from "../lib/formatBytes";
import { listAge } from "../lib/listAge";
import { listName } from "../lib/plainLabels";
import {
	type BundleCacheRecovery,
	bootErrorMessage,
	bundleCacheRecovery,
	deviceUnsupportedMessage,
	type UserFacingBootError,
	userFacingBootError,
} from "./bootErrorMessage";
import { DossierCard, dossierFromMatch } from "./DossierCard";
import { EntityDirectory } from "./EntityDirectory";
import {
	initialScreenScope,
	type ScreenScope,
	screenSelection,
	US_LIST_ID,
} from "./screenScope";
import {
	LEVEL,
	partitionForPresentation,
	passesStrictness,
	STRICTNESS_LEVELS,
	type Strictness,
	type StrictnessLevel,
} from "./strictness";

// The backend-free screening page. On mount it syncs the signed watchlist
// bundle (ed25519-verified, fail-closed) and warms the MiniLM embedder in a
// Web Worker; then it SEARCHES the verified lists entirely in-tab as you type.
// Which lists depends on the device — see ./screenScope.
// No FastAPI on this path. With an empty box it browses the whole list so a
// visitor immediately sees who is on it; typing surfaces ranked matches with a
// full dossier + the explainable score. The admin pages keep their own
// DB-backed flow — this is the public, in-browser tier.

type Phase =
	| { readonly kind: "booting"; readonly stage: BootStage }
	| { readonly kind: "ready" }
	| {
			readonly kind: "error";
			readonly message: string;
			/**
			 * Classified WHERE THE ERROR STILL IS AN ERROR.
			 *
			 * This used to hold only `message`, and the banner re-derived the copy by
			 * calling `userFacingBootError(phase.message)` on that STRING. Every
			 * `.name`-based branch in the registry is unreachable from a string, so
			 * every boot failure rendered the `internal.unknown` fallback — "Local
			 * screening engine unavailable — Close another AML-Filter tab" — no
			 * matter what actually went wrong. It is the same defect as the Worker
			 * boundary dropping the prototype, one layer further in: React state is
			 * another place a typed error gets flattened.
			 */
			readonly detail: UserFacingBootError;
			/** The in-app recovery this failure gets, also classified from the live
			 * error (a rollback/integrity refusal offers a confirmed cache clear). */
			readonly recovery: BundleCacheRecovery | null;
	  }
	// A device/browser that can't run the local engine at all (older iOS Safari /
	// locked-down WebView missing durable storage, module Workers, or safe locking). A
	// graceful dead-end detected BEFORE bootstrap — no Retry, since retrying can't
	// add a missing browser capability. Maps to future `bundle.device_unsupported`.
	| { readonly kind: "unsupported"; readonly message: string };

// Maps each boot stage to its `screen`-namespace translation key. The
// with-progress and without-progress banners share the same base key per stage,
// so the wording stays consistent (the model line's accurate ~23 MB size — the
// real quantized ONNX export is 22,972,370 bytes — lives in `boot.loadingModel`).
const STAGE_KEY: Readonly<Record<BootStage["kind"], string>> = {
	downloading: "boot.downloading",
	verified: "boot.verified",
	"loading-model": "boot.loadingModel",
	ready: "boot.ready",
};

/**
 * How many matches one search asks the engine for. Exported because the recall
 * harness measures with this exact value — see
 * frontend/packages/amlfilter-publisher/src/recall/screenParams.ts, and the pin
 * in ./recallParity.test.ts that fails when the two drift apart.
 */
export const SEARCH_K = 25;
const DEBOUNCE_MS = 180;

/**
 * The age line for one list being screened against: which list, how old its
 * data is, and — when the publisher could not refresh it — why.
 *
 * WHY THIS IS ON THE PUBLIC PAGE. The boot banner ends on "List verified."
 * Readers take that as a statement about the DATA; it is only a statement about
 * the signature. A perfectly-signed three-day-old list is still three days old,
 * so each list the search covers states its own age here.
 *
 * An age that cannot be read says so. It never falls back to silence, because
 * silence next to "List verified." reads as "current".
 *
 * A list from a pre-per-list-freshness bundle (`agedFrom === "generatedAt"`) has
 * a REAL age — the bundle's build time — but no per-list refresh time, so it is
 * worded as the bundle's age rather than as "updated".
 */
function screenedListAge(
	list: CatalogListInfo | null,
	label: string,
	t: TFunction,
): { readonly text: string; readonly stale: boolean } {
	const age = list === null ? null : listAge(list.fetchedAt);
	if (list === null || age === null) {
		return { text: t("list.ageUnknown", { list: label }), stale: true };
	}
	if (!list.stale) {
		const key =
			list.agedFrom === "generatedAt" ? "list.freshFromBundle" : "list.fresh";
		return {
			text: t(key, { list: label, age: age.phrase }),
			stale: false,
		};
	}
	const text =
		list.staleReason === null
			? t("list.stale", { list: label, age: age.duration })
			: t("list.staleWithReason", {
					age: age.duration,
					list: label,
					reason: list.staleReason,
				});
	return { text, stale: true };
}

/** The signed catalog's lists, or `null` when it cannot be read — which the page
 * states as "age unknown", the honest answer. Never throws: a page that can
 * screen must still screen. */
async function readCatalog(
	runtime: EngineRuntime,
): Promise<ReadonlyArray<CatalogListInfo> | null> {
	try {
		return await runtime.catalogLists();
	} catch {
		return null;
	}
}

/** The catalog lists a scope actually loads (the runtime loads catalog ∩ enabled). */
function scopedLists(
	catalog: ReadonlyArray<CatalogListInfo>,
	scope: ScreenScope,
): ReadonlyArray<CatalogListInfo> {
	return scope === "us-only"
		? catalog.filter((list) => list.id === US_LIST_ID)
		: catalog;
}

/** Renders {@link screenedListAge}. The stale form takes `role="alert"` because
 * it appears AFTER load and changes what the result on screen means; the fresh
 * form is ordinary text, so it never competes with the boot/search live regions.
 * The ⚠ is decorative — the warning is carried by the words. */
function ScreenedListAge({
	list,
	label,
	t,
}: {
	readonly list: CatalogListInfo | null;
	readonly label: string;
	readonly t: TFunction;
}) {
	const age = screenedListAge(list, label, t);
	return (
		<p
			className={
				age.stale ? "screen-list-age screen-list-age--stale" : "screen-list-age"
			}
			{...(age.stale ? { role: "alert" as const } : {})}
		>
			{age.stale && (
				<span aria-hidden="true" className="screen-list-age__icon">
					⚠
				</span>
			)}
			{age.text}
		</p>
	);
}

/** One age line per list the search covers; one "age unknown" line when the
 * catalog could not be read, or when the pinned US list is missing from it. */
function ListAges({
	catalog,
	scope,
	t,
}: {
	readonly catalog: ReadonlyArray<CatalogListInfo> | null;
	readonly scope: ScreenScope;
	readonly t: TFunction;
}) {
	const lists = catalog === null ? [] : scopedLists(catalog, scope);
	if (lists.length === 0) {
		const label =
			scope === "us-only" ? listName(US_LIST_ID, t) : t("scope.listsLabel");
		return <ScreenedListAge list={null} label={label} t={t} />;
	}
	return (
		<>
			{lists.map((list) => (
				<ScreenedListAge
					key={list.id}
					list={list}
					label={listName(list.id, t, list.title)}
					t={t}
				/>
			))}
		</>
	);
}

/** Says which lists the search covers. On a phone that starts US-only, it offers
 * the one-tap switch to every list and says what that costs. */
function ScopeLine({
	catalog,
	scope,
	onIncludeAll,
	t,
}: {
	readonly catalog: ReadonlyArray<CatalogListInfo> | null;
	readonly scope: ScreenScope;
	readonly onIncludeAll: () => void;
	readonly t: TFunction;
}) {
	if (scope === "us-only") {
		return (
			<p className="screen-scope">
				{t("scope.usOnly")}{" "}
				<button
					type="button"
					className="screen-scope__include-all"
					onClick={onIncludeAll}
				>
					{catalog === null
						? t("scope.includeAllUnknown")
						: t("scope.includeAll", { count: catalog.length })}
				</button>
			</p>
		);
	}
	const names = (catalog ?? []).map((l) => listName(l.id, t, l.title));
	return (
		<p className="screen-scope">
			{names.length === 0
				? t("scope.allUnknown")
				: t("scope.all", { count: names.length, names: names.join(", ") })}
			{scope === "all-lists-streaming" && (
				<span className="screen-scope__note"> {t("scope.streamingNote")}</span>
			)}
		</p>
	);
}

const EXAMPLE_QUERIES = ["Ivan Fakovich", "fakovic", "Olga", "bank"] as const;

// The strictness levels (named floors/gates/display lines with their declared
// ranges and rationale) and the gate/partition helpers live in ./strictness —
// a pure, unit-tested module. This is a SEARCH-LAYER control only: it never
// touches the parity-locked scoring contract. Balanced withholds unqualified
// sub-line nearest neighbours; Lenient remains the explicit show-everything
// option.

// The outcome of one screen call. A rejection is a FIRST-CLASS state, not a
// dropped promise: an unscreened name must never fall through to the no-match
// (clear) render. `matches` carries a completed screen; `error` a failed one.
type SearchOutcome =
	| {
			readonly kind: "matches";
			readonly matches: ReadonlyArray<Match>;
			readonly ms: number;
			/**
			 * The engine returned a FULL quota of `SEARCH_K` candidates, so the
			 * ranked list was cut off and more may sit below the last card. Read
			 * from the engine's raw return, BEFORE the strictness gate — the cut-off
			 * happens in the engine, so filtering afterwards cannot reveal or hide it.
			 */
			readonly capped: boolean;
	  }
	| { readonly kind: "error"; readonly message: string };

// A screen call that rejects mid-session must be shown as a hard error, never as
// a clear — an unscreened name is NOT a cleared name. This surfaces the cause
// (so a crashed worker / model fault is diagnosable) into the `results.searchError`
// copy, which frames it as uncleared and tells the user how to retry.
function errorDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function ScreenPage() {
	const { t } = useTranslation("screen");
	const runtime = useMemo(() => new EngineRuntime(), []);
	// Capability preflight (once): before spawning any Worker or touching durable storage,
	// check this browser can actually run the local engine. On an unsupported
	// device the boot below would otherwise throw deep in a Worker — or, on iOS,
	// silently hang with no catchable error — so we branch to an explicit screen.
	const support = useMemo(() => engineSupport(), []);
	const [phase, setPhase] = useState<Phase>(() =>
		support.supported
			? { kind: "booting", stage: { kind: "downloading" } }
			: {
					kind: "unsupported",
					message: deviceUnsupportedMessage(support.missing),
				},
	);
	const [query, setQuery] = useState("");
	// Optional date-of-birth filter. A native date input's value is already
	// `YYYY-MM-DD`, which flows straight into the engine's `dob` (normalized to
	// ISO before the parity-locked dob_match scorer). Empty = no dob supplied.
	const [dob, setDob] = useState("");
	const [strictness, setStrictness] = useState<Strictness>("balanced");
	const [entities, setEntities] = useState<ReadonlyArray<Entity>>([]);
	const [search, setSearch] = useState<SearchOutcome | null>(null);
	// Which lists the search covers (see ./screenScope). Held in a ref too, so
	// the once-only boot effect reads the current scope without re-firing.
	const [scope, setScope] = useState<ScreenScope>(() => initialScreenScope());
	const scopeRef = useRef(scope);
	scopeRef.current = scope;
	// The signed catalog's lists. `undefined` means "not read yet" and shows
	// nothing; `null` means "read and unavailable" and shows "age unknown". The
	// distinction matters — flashing a stale-age warning during boot would train
	// people to ignore the one that is real.
	const [catalog, setCatalog] = useState<
		ReadonlyArray<CatalogListInfo> | null | undefined
	>(undefined);
	// The screen in flight, so a new query waits for it and a superseded one is
	// skipped rather than queued (a streaming search takes seconds).
	const inflight = useRef<Promise<void>>(Promise.resolve());
	// Bumped by Retry: it resets the boot guard and re-fires the boot effect so a
	// boot that timed out (stalled CDN) can be re-attempted from the error banner.
	const [bootNonce, setBootNonce] = useState(0);
	const seq = useRef(0);
	const started = useRef(false);
	const alive = useRef(true);

	// Re-arm `alive` on mount and disarm on unmount. The mount re-arm matters
	// under React 18 StrictMode, whose dev mount→unmount→remount would otherwise
	// leave `alive.current` stuck `false` after the throwaway first pass — which
	// would silently swallow the boot's resolve/reject on the real (second) mount.
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	// The pending deferred-disposal timer for the page-owned runtime (see the
	// effect below); a ref so the StrictMode replay can cancel the teardown the
	// throwaway first pass scheduled.
	const disposeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Release the page-owned runtime (embedder Worker + ONNX WASM heap + resident
	// vectors) when the page REALLY leaves the DOM. Without this, SPA navigation
	// to /settings or any workstation route leaves TWO live runtimes — this one
	// plus the workstation's module-level one — keeping ~2× the ~23 MB model heap
	// for the rest of the session (an OOM trigger under iOS Safari's tab budget).
	// Disposal is deferred one macrotask and canceled on re-entry: StrictMode's
	// dev mount→unmount→remount replays this effect body before the zero-delay
	// timer fires, so the throwaway first pass never tears down the runtime the
	// surviving mount keeps using (the `started` boot guard would never re-boot
	// it). On a real unmount no replay follows, the timer fires, and dispose —
	// serialized on the runtime's lifecycle queue — waits out any in-flight boot
	// before terminating its workers; the durable list cache is untouched.
	useEffect(() => {
		if (disposeTimer.current !== null) {
			clearTimeout(disposeTimer.current);
			disposeTimer.current = null;
		}
		return () => {
			disposeTimer.current = setTimeout(() => void runtime.dispose(), 0);
		};
	}, [runtime]);

	// bootNonce is not read in the body — it is the intentional re-fire trigger:
	// Retry resets the `started` guard and bumps the nonce so this effect re-runs
	// the boot. Listed as a dep so that re-fire actually happens.
	// biome-ignore lint/correctness/useExhaustiveDependencies: bootNonce is an intentional re-fire trigger, not read in the body
	useEffect(() => {
		// An unsupported device never boots: the preflight already routed to the
		// unsupported screen, and spawning the engine Worker would only throw/hang.
		if (!support.supported) {
			return;
		}
		if (started.current) {
			return;
		}
		started.current = true;
		const config = configFromEnv(import.meta.env);
		runtime
			// Eagerly materialize the scope's lists so "Ready" means the SQLite
			// Worker, sqlite-vector runtime, and vectors are already local; typing a
			// name can never trigger a network request. A phone starts on the one
			// bounded US list — every list eagerly exceeds iOS Safari's tab/WASM
			// budget (PR #71) — until the visitor opts in to all of them.
			.bootstrap(
				config,
				(stage) => setPhase({ kind: "booting", stage }),
				screenSelection(scopeRef.current),
			)
			.then(async () => {
				if (!alive.current) {
					return;
				}
				setEntities(runtime.engine()?.allEntities() ?? []);
				setPhase({ kind: "ready" });
				// The signed catalog already carries each list's age; read it so the
				// page can state it. Failing to read it is NOT fatal to screening —
				// but it must show as "age unknown", never as silence next to
				// "List verified."
				const lists = await readCatalog(runtime);
				// Re-check: the await above is a second chance to unmount, and this
				// runs after the page is already interactive.
				if (alive.current) {
					setCatalog(lists);
				}
			})
			.catch((error: unknown) => {
				if (!alive.current) {
					return;
				}
				// A verify/format/model failure aborts the load fail-closed; surface
				// the cause so a bad signature or stalled model is diagnosable from
				// the banner alone.
				setPhase({
					kind: "error",
					message: bootErrorMessage(error),
					detail: userFacingBootError(error),
					recovery: bundleCacheRecovery(error),
				});
			});
	}, [runtime, bootNonce, support.supported]);

	const retryBoot = useCallback(() => {
		// Reset the once-only boot guard and re-arm the booting banner; bumping the
		// nonce re-runs the boot effect, which calls bootstrap again (the runtime
		// cleared its memo when the prior attempt rejected).
		started.current = false;
		setPhase({ kind: "booting", stage: { kind: "downloading" } });
		// Forget the previous attempt's age: re-reading it is part of re-booting.
		setCatalog(undefined);
		setBootNonce((n) => n + 1);
	}, []);

	// A phone's one-tap switch from US-only to every list. It rebuilds the engine
	// over the SAME warm model with bounded streaming residency (one list's
	// vectors resident at a time), so it never holds all four at once.
	const includeAllLists = useCallback(() => {
		setScope("all-lists-streaming");
		setPhase({
			kind: "booting",
			stage: { kind: "verified", version: runtime.version() ?? "" },
		});
		runtime
			.reload(screenSelection("all-lists-streaming"))
			.then(() => {
				if (alive.current) {
					setEntities(runtime.engine()?.allEntities() ?? []);
					setPhase({ kind: "ready" });
				}
			})
			.catch((error: unknown) => {
				if (alive.current) {
					setPhase({
						kind: "error",
						message: bootErrorMessage(error),
						detail: userFacingBootError(error),
						recovery: bundleCacheRecovery(error),
					});
				}
			});
	}, [runtime]);

	const runSearch = useCallback(
		async (text: string, dobIso: string) => {
			const engine = runtime.engine();
			if (engine === null) {
				return;
			}
			const level = LEVEL[strictness];
			const mine = ++seq.current;
			const previous = inflight.current;
			let done: () => void = () => {};
			inflight.current = new Promise<void>((resolve) => {
				done = resolve;
			});
			await previous;
			if (mine !== seq.current) {
				done();
				return;
			}
			try {
				const result = await engine.screen({
					name: text,
					// A native date input is already ISO `YYYY-MM-DD`; omit when empty so
					// the scorer never sees a blank dob (which it would treat as null).
					...(dobIso.length > 0 ? { dob: dobIso } : {}),
					threshold: level.floor,
					k: SEARCH_K,
				});
				if (mine === seq.current && alive.current) {
					const matches = result.matches.filter((m) =>
						passesStrictness(m, text, level),
					);
					setSearch({
						kind: "matches",
						matches,
						ms: result.execution_time_ms,
						capped: result.matches.length === SEARCH_K,
					});
				}
			} catch (error) {
				// Fail LOUD, never silent: a dropped screen rejection would let the
				// prior (stale/empty) result linger and read as a clear. Surface a
				// visible error for this exact query instead.
				if (mine === seq.current && alive.current) {
					setSearch({
						kind: "error",
						message: t("results.searchError", { detail: errorDetail(error) }),
					});
				}
			} finally {
				done();
			}
		},
		[runtime, strictness, t],
	);

	useEffect(() => {
		if (phase.kind !== "ready") {
			return;
		}
		const trimmed = query.trim();
		if (trimmed.length === 0) {
			seq.current += 1; // cancel any in-flight search
			setSearch(null);
			return;
		}
		const timer = setTimeout(() => void runSearch(trimmed, dob), DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [query, dob, phase.kind, runSearch]);

	return (
		<div className="screen-page">
			<h1>{t("header.title")}</h1>
			<p className="screen-page__lede">{t("header.lede")}</p>

			<BootBanner
				phase={phase}
				onRetry={scope === "all-lists-streaming" ? includeAllLists : retryBoot}
				onClearCache={() => runtime.clearListCache()}
			/>

			{phase.kind === "ready" && catalog !== undefined && (
				<>
					<ScopeLine
						catalog={catalog}
						scope={scope}
						onIncludeAll={includeAllLists}
						t={t}
					/>
					<ListAges catalog={catalog} scope={scope} t={t} />
				</>
			)}

			<input
				className="screen-search"
				type="search"
				placeholder={t("search.placeholder")}
				aria-label={t("search.ariaLabel")}
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				disabled={phase.kind !== "ready"}
			/>

			<div className="screen-dob">
				<label className="screen-dob__label" htmlFor="screen-dob-input">
					{t("dob.label")}
				</label>
				<input
					id="screen-dob-input"
					className="screen-dob__input"
					type="date"
					value={dob}
					onChange={(event) => setDob(event.target.value)}
					disabled={phase.kind !== "ready"}
				/>
			</div>

			<StrictnessControl
				value={strictness}
				onChange={setStrictness}
				disabled={phase.kind !== "ready"}
			/>

			<div className="screen-examples">
				<span className="screen-examples__label">{t("examples.label")}</span>
				{EXAMPLE_QUERIES.map((example) => (
					<button
						key={example}
						type="button"
						className="screen-chip"
						disabled={phase.kind !== "ready"}
						onClick={() => setQuery(example)}
					>
						{example}
					</button>
				))}
			</div>

			{phase.kind === "ready" && (
				<Results
					query={query.trim()}
					entities={entities}
					search={search}
					level={LEVEL[strictness]}
				/>
			)}
			<Footer />
		</div>
	);
}

// The level reached by an arrow key from the current one (Left/Up ←, Right/Down →),
// clamped at the ends. Returns null for any other key (no selection change).
function arrowTarget(current: Strictness, key: string): Strictness | null {
	const i = STRICTNESS_LEVELS.findIndex((l) => l.level === current);
	if (key === "ArrowRight" || key === "ArrowDown") {
		return (
			STRICTNESS_LEVELS[Math.min(i + 1, STRICTNESS_LEVELS.length - 1)]?.level ??
			null
		);
	}
	if (key === "ArrowLeft" || key === "ArrowUp") {
		return STRICTNESS_LEVELS[Math.max(i - 1, 0)]?.level ?? null;
	}
	return null;
}

// An accessible segmented control that reads like a 3-stop "match strictness"
// slider. radiogroup + role="radio" stops, arrow-key navigation, disabled while
// the bundle/model is still booting. Selecting a stop re-runs search live.
function StrictnessControl({
	value,
	onChange,
	disabled,
}: {
	readonly value: Strictness;
	readonly onChange: (next: Strictness) => void;
	readonly disabled: boolean;
}) {
	const { t } = useTranslation("screen");
	const onKeyDown = (event: ReactKeyboardEvent) => {
		const next = arrowTarget(value, event.key);
		if (next !== null) {
			event.preventDefault();
			onChange(next);
		}
	};
	return (
		<div className="screen-strictness">
			<span className="screen-strictness__caption">
				{t("strictness.caption")}
			</span>
			<div
				className="screen-strictness__track"
				role="radiogroup"
				aria-label={t("strictness.ariaLabel")}
			>
				{STRICTNESS_LEVELS.map((level) => (
					// biome-ignore lint/a11y/useSemanticElements: this is a custom segmented "slider" — a native radio can't carry the active-segment styling or the single-tabstop arrow-key roving used here; the ARIA radiogroup/radio pattern is the correct equivalent
					<button
						key={level.level}
						type="button"
						role="radio"
						aria-checked={value === level.level}
						tabIndex={value === level.level ? 0 : -1}
						className="screen-strictness__stop"
						disabled={disabled}
						onClick={() => onChange(level.level)}
						onKeyDown={onKeyDown}
					>
						{t(`strictness.levels.${level.level}`)}
					</button>
				))}
			</div>
			<span className="screen-strictness__hint">{t("strictness.hint")}</span>
		</div>
	);
}

function BootBanner({
	phase,
	onRetry,
	onClearCache,
}: {
	readonly phase: Phase;
	readonly onRetry: () => void;
	/** Drop the cached signed lists + their rollback floor (never customer data). */
	readonly onClearCache: () => Promise<void>;
}) {
	const { t } = useTranslation("screen");
	if (phase.kind === "ready") {
		return null;
	}
	if (phase.kind === "unsupported") {
		// A graceful dead-end: no Retry, because retrying can't add a missing
		// browser capability. role="alert" so assistive tech announces it.
		return (
			<div className="screen-banner screen-banner--unsupported" role="alert">
				<span>{phase.message}</span>
			</div>
		);
	}
	if (phase.kind === "error") {
		// The CLASSIFIED title + recovery (from the live error object), with the
		// app's ONE "Could not load the screening bundle: <cause>" wrapper kept as
		// the technical detail. Both are contracts: bootErrorMessage.ts states the
		// wrapper is the single user-facing framing for a load failure, and
		// screen-cold-blocked.spec.ts asserts that substring. Classifying early
		// fixed the title; it must not cost the wrapper.
		const safeError = { ...phase.detail, technicalDetail: phase.message };
		return (
			<div
				className="screen-banner screen-banner--error"
				role="alert"
				aria-live="assertive"
			>
				<div className="screen-banner__copy">
					<strong>{safeError.title}</strong>
					<p>{safeError.recovery}</p>
					<details className="screen-banner__details">
						<summary>Technical details</summary>
						<code>{safeError.technicalDetail}</code>
					</details>
					{phase.recovery !== null && (
						<CacheRecovery
							kind={phase.recovery}
							onClear={onClearCache}
							onCleared={onRetry}
						/>
					)}
				</div>
				<button
					type="button"
					className="screen-banner__retry"
					onClick={onRetry}
				>
					{t("boot.retry")}
				</button>
			</div>
		);
	}
	return (
		<div className="screen-banner screen-banner--booting" role="status">
			<span>{stageMessage(phase.stage, t)}</span>
			{isFirstRunDownload(phase.stage) ? (
				<span className="screen-banner__note">{t("boot.firstRunNote")}</span>
			) : null}
		</div>
	);
}

/**
 * True for the two stages that actually move bytes on a cold boot. A first-time
 * visitor waits ~11s on broadband and much longer on a phone, so those two
 * stages carry the payoff note ("downloaded once, then screening stays in the tab"). The
 * instant stages don't: promising a one-time download next to a verify step
 * that transfers nothing is noise, especially on a warm reload.
 */
function isFirstRunDownload(stage: BootStage): boolean {
	return (
		(stage.kind === "downloading" && stage.progress !== undefined) ||
		stage.kind === "loading-model"
	);
}

/** The model-load progress the engine reports, read off the stage contract so
 * this page does not widen the package's export surface. */
type ModelProgress = NonNullable<
	Extract<BootStage, { kind: "loading-model" }>["progress"]
>;

/**
 * The model line. A percentage whenever the download has an honest denominator;
 * otherwise bytes loaded — a server that withholds `content-length` gives no
 * total, and a fabricated one is worse than none. Either way the line MOVES:
 * this ~23 MB download used to be the only frozen phase of the cold boot.
 */
function modelMessage(progress: ModelProgress, t: TFunction): string {
	const label = t("boot.loadingModel");
	if (progress.pct === undefined) {
		return t("boot.loadingModelBytes", {
			label,
			size: formatBytes(progress.loaded),
		});
	}
	return t("boot.loadingModelProgress", {
		label,
		pct: Math.round(progress.pct),
	});
}

// The banner line for a stage.
function stageMessage(stage: BootStage, t: TFunction): string {
	if (stage.kind === "loading-model" && stage.progress !== undefined) {
		return modelMessage(stage.progress, t);
	}
	// The cold sync on /screen is ~769 chunks / ~28 MB (OFAC SDN only; the full
	// four-list bundle is 1,296 / ~46.7 MB). Report BOTH how far along it is
	// and how much has actually arrived: the percentage comes from exact chunk
	// counts, and the megabytes are bytes genuinely transferred — neither is an
	// extrapolated guess at a total we don't know yet.
	if (stage.kind === "downloading" && stage.progress !== undefined) {
		const { fetched, total, bytes } = stage.progress;
		return t("boot.downloadingProgress", {
			label: t("boot.downloading"),
			pct: total > 0 ? Math.round((fetched / total) * 100) : 0,
			size: formatBytes(bytes),
		});
	}
	return t(STAGE_KEY[stage.kind]);
}

function Results({
	query,
	entities,
	search,
	level,
}: {
	readonly query: string;
	readonly entities: ReadonlyArray<Entity>;
	readonly search: SearchOutcome | null;
	readonly level: StrictnessLevel;
}) {
	const { t } = useTranslation("screen");
	// Empty box → browse the whole list (a directory, no scores).
	if (query.length === 0) {
		return <EntityDirectory entities={entities} />;
	}
	if (search === null) {
		return (
			<div className="screen-banner" role="status">
				{t("results.searching")}
			</div>
		);
	}
	// A failed screen is a hard, visible error — never a silent clear. role="alert"
	// so assistive tech announces it, and the stale/empty result is replaced.
	if (search.kind === "error") {
		return (
			<div className="screen-results screen-results--error" role="alert">
				{search.message}
			</div>
		);
	}
	if (search.matches.length === 0) {
		return (
			<div className="screen-results screen-results--clear" aria-live="polite">
				{t("results.noMatch", { query, ms: search.ms })}
			</div>
		);
	}
	// Matches at/above the level's display line lead as primary cards. Balanced
	// discloses a weaker candidate only when an exact published-name token makes
	// it independently actionable; unqualified nearest-neighbour noise is not
	// advertised as a lead. At Lenient and Strict the line is 0, so every match
	// is primary — unchanged.
	const { primary, lowConfidence } = partitionForPresentation(
		search.matches,
		query,
		level,
	);
	const levelLabel = t(`strictness.levels.${level.level}`);
	return (
		<section className="screen-results" aria-live="polite">
			{primary.length > 0 ? (
				<>
					<p className="screen-results__count">
						{t("results.matchCount", {
							n: primary.length,
							suffix: primary.length === 1 ? "" : "es",
							ms: search.ms,
						})}
					</p>
					<ul className="screen-results__list">
						{primary.map((match) => (
							<DossierCard
								key={match.entity_id}
								dossier={dossierFromMatch(match)}
							/>
						))}
					</ul>
				</>
			) : (
				// Nothing clears the primary display line. Keep this neutral rather
				// than using the green clear treatment: qualified weak candidates may
				// still be grouped below, and unqualified neighbours may be withheld.
				<p className="screen-results__none">
					{t("results.noPrimaryMatch", {
						query,
						level: levelLabel,
						ms: search.ms,
					})}
				</p>
			)}
			{lowConfidence.length > 0 && (
				<details className="screen-results__low">
					<summary className="screen-results__low-summary">
						{t("results.lowConfidenceCount", {
							n: lowConfidence.length,
							suffix: lowConfidence.length === 1 ? "" : "s",
							level: levelLabel,
						})}
					</summary>
					<ul className="screen-results__list">
						{lowConfidence.map((match) => (
							<DossierCard
								key={match.entity_id}
								dossier={dossierFromMatch(match)}
							/>
						))}
					</ul>
				</details>
			)}
			{/*
			 * A capped list looks exactly like a complete one: 25 near-identical
			 * cards with nothing to say whether that is all of them. The engine
			 * reports no total, so this states the cut-off and nothing more — never
			 * "25 of N", which would be a number nobody measured.
			 */}
			{search.capped && (primary.length > 0 || lowConfidence.length > 0) && (
				<p className="screen-results__capped">
					{t("results.capped", { n: SEARCH_K })}
				</p>
			)}
		</section>
	);
}
