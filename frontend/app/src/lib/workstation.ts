/**
 * The workstation boot path: spawn + open the DB Worker (SQLite-WASM/OPFS),
 * and expose a LAZY engine bootstrap — the review board needs no model, and
 * the ~23 MB MiniLM load must not gate page render. Memoized like
 * EngineRuntime.bootstrap: the first call wins; a failure clears the memo so
 * the UI can retry. Construction of the apiClient stays side-effect free —
 * nothing here runs until the first workstation page asks for it.
 */

import {
	type CatalogListInfo,
	configFromEnv,
	EngineRuntime,
	type OnStage,
	type RuntimeConfig,
	type RuntimeSelection,
	type ScreenOptions,
	type ScreenQuery,
	type ScreenResponse,
} from "@amlfilter/browser";
import {
	DbClient,
	LocalMatchTracker,
	LocalOnboardingService,
	loadScreeningConfig,
	type NameScreener,
	RescanService,
	type RescanSummary,
	saveEnabledLists,
	toListThresholds,
	type WorkstationStore,
} from "@amlfilter/workstation";
import type { WorkstationServices } from "./localApi";
import { type EngineResidency, residencyForBrowser } from "./memoryPolicy";

/** The engine surface the boot path needs (ScreeningEngine satisfies it). */
interface EngineHandle {
	screen(query: ScreenQuery, options?: ScreenOptions): Promise<ScreenResponse>;
}

/** The runtime surface the boot path needs (EngineRuntime satisfies it). */
interface RuntimePort {
	bootstrap(
		config: RuntimeConfig,
		onStage?: OnStage,
		selection?: RuntimeSelection,
	): Promise<EngineHandle>;
	/** The loaded watchlist version; null before the first successful boot. */
	version(): string | null;
	/** Cheap signed-manifest poll: the currently PUBLISHED watchlist version. */
	fetchPublishedVersion(): Promise<string>;
	/** Re-fetch + re-verify the watchlist, swap it in over the warm embedder. An
	 * optional selection re-bootstraps for a new enabled set / thresholds. */
	reload(selection?: RuntimeSelection): Promise<EngineHandle>;
	/** Every list in the signed catalog — the selectable set, each entry carrying
	 * its own version, entity count and per-list freshness. */
	catalogLists(config?: RuntimeConfig): Promise<ReadonlyArray<CatalogListInfo>>;
	/** Just the ids of every catalog list. */
	catalogListIds(config?: RuntimeConfig): Promise<ReadonlyArray<string>>;
	/** Drop every durably-cached list blob; the next load re-fetches + re-verifies. */
	clearListCache(): Promise<void>;
	/** Release the model/index owned by the workstation routes. */
	dispose?(): Promise<void>;
}

/** Seams for tests; defaulted to the real DB Worker + EngineRuntime. */
export interface WorkstationDeps {
	readonly spawnStore: () => WorkstationStore;
	readonly runtime: RuntimePort;
	/** Override the device policy in tests or an explicitly managed shell. */
	readonly memoryPolicy?: () => EngineResidency;
}

export interface WorkstationHandle extends WorkstationServices {
	/** Kick (or await) the engine bootstrap, streaming boot stages to the UI. */
	readonly engineBoot: (onStage?: OnStage) => Promise<void>;
	/** The bidirectional auto-rescan service (Wave 2), over this DB + screener. */
	readonly rescan: RescanService;
	/** The loaded watchlist version; null until the engine has bootstrapped. */
	readonly watchlistVersion: () => string | null;
	/** Cheap signed-manifest poll for the currently PUBLISHED watchlist version
	 * — what "Check for updates" compares against the loaded version. */
	readonly fetchPublishedVersion: () => Promise<string>;
	/** Re-fetch + re-verify the signed watchlist and swap it into the running
	 * engine (reuses the warm embedder — no second model download). */
	readonly reloadWatchlist: () => Promise<void>;
	/** Every list in the signed catalog — the selectable set the Watchlists
	 * settings section renders a toggle for. Each entry carries its own version,
	 * entity count and freshness, so the toggle can state how old the list is. */
	readonly catalogLists: () => Promise<ReadonlyArray<CatalogListInfo>>;
	/** The currently enabled watchlist ids (stored selection ∩ live catalog;
	 * constrained/mobile browsers default to OFAC only; desktop keeps all lists). */
	readonly getEnabledLists: () => Promise<ReadonlyArray<string>>;
	/** Persist a new enabled-watchlist set, re-bootstrap the engine over it (reuses
	 * the warm embedder), and re-screen every customer when the set actually changed
	 * (a disabled list's matches drop out → logged SUPPRESSED by the rescan). Returns
	 * the rescan summary; an unchanged set is a clean no-op (all-zero summary). */
	readonly setEnabledLists: (
		ids: ReadonlyArray<string>,
	) => Promise<RescanSummary>;
	/** Drop every durably-cached list blob (the "Clear cached lists" affordance).
	 * The lifecycle boundary disposes the running engine/model first; the next
	 * operation re-fetches and re-verifies the lists from the network. */
	readonly clearListCache: () => Promise<void>;
	/** Release the shared model/index when no workstation route is mounted. */
	readonly disposeEngine: () => Promise<void>;
}

const defaultDeps: WorkstationDeps = {
	spawnStore: () => DbClient.spawn(),
	runtime: new EngineRuntime(),
};

let handlePromise: Promise<WorkstationHandle> | null = null;
let workstationLeaseCount = 0;
let workstationReleaseTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Retain the module-level workstation runtime for a mounted gate. The delayed
 * final release makes route changes and React StrictMode effect replay safe: a
 * new gate can acquire the lease before the old gate tears down the model.
 */
export function retainWorkstationRuntime(): () => void {
	workstationLeaseCount += 1;
	if (workstationReleaseTimer !== null) {
		clearTimeout(workstationReleaseTimer);
		workstationReleaseTimer = null;
	}
	let released = false;
	return () => {
		if (released) {
			return;
		}
		released = true;
		workstationLeaseCount = Math.max(0, workstationLeaseCount - 1);
		if (workstationLeaseCount !== 0) {
			return;
		}
		workstationReleaseTimer = setTimeout(() => {
			workstationReleaseTimer = null;
			if (workstationLeaseCount !== 0 || handlePromise === null) {
				return;
			}
			void handlePromise.then(
				(handle) => {
					if (workstationLeaseCount === 0) {
						return handle.disposeEngine();
					}
					return undefined;
				},
				() => undefined,
			);
		}, 0);
	};
}

/** Boot (or reuse) the local workstation. First call wins; failures retry. */
export function workstation(
	deps: WorkstationDeps = defaultDeps,
): Promise<WorkstationHandle> {
	if (handlePromise === null) {
		handlePromise = build(deps).catch((error: unknown) => {
			handlePromise = null;
			throw error;
		});
	}
	return handlePromise;
}

/** Test-only: drop the memoized handle between specs. */
export function resetWorkstationForTests(): void {
	handlePromise = null;
}

async function build(deps: WorkstationDeps): Promise<WorkstationHandle> {
	const store = deps.spawnStore();
	await store.open();

	// The persisted selection (raw stored enabled ids) + thresholds the engine is
	// loaded with. `enabledLists` is the RAW stored set — the runtime intersects it
	// with the catalog (and silently skips ids the catalog doesn't have); an UNSET
	// selection keeps every list only for an explicitly high-memory desktop, but
	// is bounded to OFAC on streaming browsers. Thresholds map
	// the global sensitivity + per-list overrides onto the engine's score floors.
	const runtimeConfig = configFromEnv(import.meta.env);
	const currentSelection = async (
		enabledOverride?: ReadonlyArray<string>,
	): Promise<RuntimeSelection> => {
		const [rawEnabled, config] = await Promise.all([
			store.getSetting("enabled_watchlists"),
			loadScreeningConfig(store),
		]);
		// An explicit set (just-applied by setEnabledLists) wins over the persisted
		// value, so a re-bootstrap doesn't depend on a read-after-write round-trip.
		const residency = deps.memoryPolicy?.() ?? residencyForBrowser();
		const parsedEnabled = parseEnabledLists(rawEnabled);
		const enabledLists =
			enabledOverride ??
			(parsedEnabled === undefined && residency === "streaming"
				? ["OFAC_SDN"]
				: parsedEnabled);
		// The override map is small; scoping perList to the loaded ids is the
		// runtime's job (it only applies a floor to a list that loaded). Passing the
		// override keys is harmless, so the catalog ids aren't needed here.
		const thresholds = toListThresholds(config, Object.keys(config.overrides));
		return enabledLists === undefined
			? { thresholds, residency }
			: { enabledLists, thresholds, residency };
	};

	const bootEngine = async (onStage?: OnStage): Promise<EngineHandle> =>
		deps.runtime.bootstrap(runtimeConfig, onStage, await currentSelection());
	let operationTail: Promise<void> = Promise.resolve();
	const serial = <T>(operation: () => Promise<T>): Promise<T> => {
		const run = operationTail.then(operation);
		operationTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};
	const screener: NameScreener = {
		screen: async (query: ScreenQuery): Promise<ScreenResponse> =>
			(await bootEngine()).screen(query),
	};
	const rescan = new RescanService(store, screener);
	return {
		store,
		tracker: new LocalMatchTracker(store),
		onboarding: new LocalOnboardingService(store, screener),
		rescan,
		watchlistVersion: (): string | null => deps.runtime.version(),
		engineBoot: (onStage?: OnStage): Promise<void> =>
			serial(async () => {
				await bootEngine(onStage);
			}),
		fetchPublishedVersion: (): Promise<string> =>
			serial(() => deps.runtime.fetchPublishedVersion()),
		reloadWatchlist: (): Promise<void> =>
			serial(async () => {
				// Plain new-publish reload: keep the active selection + thresholds.
				await deps.runtime.reload(await currentSelection());
			}),
		catalogLists: (): Promise<ReadonlyArray<CatalogListInfo>> =>
			serial(() => deps.runtime.catalogLists(runtimeConfig)),
		getEnabledLists: (): Promise<ReadonlyArray<string>> =>
			serial(async () => {
				const catalogIds = await deps.runtime.catalogListIds(runtimeConfig);
				return effectiveEnabledIds(store, catalogIds, deps);
			}),
		setEnabledLists: (ids: ReadonlyArray<string>): Promise<RescanSummary> =>
			serial(async () => {
				const catalogIds = await deps.runtime.catalogListIds(runtimeConfig);
				const before = await effectiveEnabledIds(store, catalogIds, deps);
				// Intersect the requested set with the catalog so the change check and the
				// persisted value match what the runtime will actually load.
				const after = catalogIds.filter((id) => ids.includes(id));
				if (sameIdSet(before, after)) {
					return { customersScanned: 0, newHits: 0, clearedHits: 0 };
				}
				await saveEnabledLists(store, after);
				// A settings-only visit has no model yet: first boot over the new set.
				// Existing workstation routes already have a warm engine, so reload it
				// over the new set and reuse its embedder.
				if (deps.runtime.version() === null) {
					await bootEngine();
				} else {
					await deps.runtime.reload(await currentSelection(after));
				}
				return rescan.rescanAll();
			}),
		clearListCache: (): Promise<void> =>
			serial(() => deps.runtime.clearListCache()),
		disposeEngine: (): Promise<void> =>
			deps.runtime.dispose?.() ?? Promise.resolve(),
	};
}

/** Order-insensitive equality of two id sets. */
function sameIdSet(
	a: ReadonlyArray<string>,
	b: ReadonlyArray<string>,
): boolean {
	if (a.length !== b.length) {
		return false;
	}
	const set = new Set(a);
	return b.every((id) => set.has(id));
}

/** Resolve an unset selection without forcing the engine/model to boot. */
async function effectiveEnabledIds(
	store: WorkstationStore,
	catalogIds: ReadonlyArray<string>,
	deps: WorkstationDeps,
): Promise<ReadonlyArray<string>> {
	const parsed = parseEnabledLists(
		await store.getSetting("enabled_watchlists"),
	);
	const residency = deps.memoryPolicy?.() ?? residencyForBrowser();
	const selected =
		parsed ?? (residency === "streaming" ? ["OFAC_SDN"] : catalogIds);
	return catalogIds.filter((id) => selected.includes(id));
}

/** Parse the persisted `enabled_watchlists` value: a JSON string array, or
 * `undefined` for an unset/malformed value. A persisted empty array is honored
 * as "disable everything"; callers apply the device-specific safe default. */
function parseEnabledLists(
	raw: string | null,
): ReadonlyArray<string> | undefined {
	if (raw === null) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
			return parsed as ReadonlyArray<string>;
		}
	} catch {
		// Fall through to the all-lists default.
	}
	return undefined;
}

/** The provider the apiClient singleton is constructed with. */
export const workstationProvider = (): Promise<WorkstationServices> =>
	workstation();
