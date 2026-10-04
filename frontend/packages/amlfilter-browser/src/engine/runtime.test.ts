import {
	DEFAULT_REQUEST_TIMEOUT_MS,
	FETCH_STALL_TIMEOUT_MS,
} from "@gainratio/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BundleSource } from "./bundleSource";
import type { Embedder, EmbedProgress } from "./embedder";
import { FRESH_RESOLVED } from "./freshnessFixtures";
import {
	BOOT_TIMEOUT_MS,
	type BootStage,
	bootTimeoutMs,
	compositeVersion,
	configFromEnv,
	defaultRuntimeDeps,
	EngineRuntime,
	MODEL_LOAD_IDLE_TIMEOUT_MS,
	modelLoadIdleTimeoutMs,
	type RuntimeConfig,
	type RuntimeDeps,
	SLOWEST_HEALTHY_COLD_SYNC_MS,
	throttleModelProgress,
	withTimeout,
} from "./runtime";
import { VectorIndex } from "./vectorIndex";
import type {
	LoadedWatchlist,
	LoadedWatchlistMetadata,
	WatchlistCatalog,
	WatchlistCatalogEntry,
} from "./watchlist";

const PUBKEY = new Uint8Array(32);

/** Build a list's loaded watchlist for a given catalog entry. */
type LoadedFor = (entry: WatchlistCatalogEntry) => LoadedWatchlist;

/** A fake {@link BundleSource} whose loaders resolve to the same fakes the old
 * JSON `loadCatalog`/`loadList` deps returned — the bundle path is now the ONLY
 * path, so the runtime is driven through `openBundleSource`. `onCatalog` (when
 * given) lets a test track/intercept each catalog read; `clear` is a no-op. */
function fakeBundleSource(
	catalog: WatchlistCatalog,
	loadedFor: LoadedFor,
	dispose: () => void = () => {},
): BundleSource {
	return {
		loadCatalog: () => catalog,
		loadList: (entry) => Promise.resolve(loadedFor(entry)),
		version: () => "fake",
		clear: () => Promise.resolve(),
		dispose,
	};
}

/** An `openBundleSource` dep that opens a source over the catalog drawn from a
 * queue (boot then each reload/poll, since the runtime re-opens after nulling
 * its memo), building lists via `loadedFor`. Advances the queue per open. */
function bundleSourceFromCatalogs(
	catalogs: ReadonlyArray<WatchlistCatalog>,
	loadedFor: LoadedFor,
	onOpen?: () => void,
): RuntimeDeps["openBundleSource"] {
	let opens = 0;
	return () => {
		onOpen?.();
		const catalog = catalogs[Math.min(opens, catalogs.length - 1)];
		opens += 1;
		return Promise.resolve(
			fakeBundleSource(catalog as WatchlistCatalog, loadedFor),
		);
	};
}

/** A catalog entry for `listId`, dir prefix derived from a lowercased id. */
function entryFor(listId: string, version: string): WatchlistCatalogEntry {
	return {
		id: listId,
		title: listId,
		version,
		entitiesCount: 1,
		path: `${listId.toLowerCase()}/`,
		...FRESH_RESOLVED,
	};
}

/** A catalog over the given (listId, version) pairs. */
function catalogOf(
	pairs: ReadonlyArray<readonly [string, string]>,
): WatchlistCatalog {
	return {
		schema: 1,
		generatedAt: "2026-06-19T00:00:00Z",
		lists: pairs.map(([id, v]) => entryFor(id, v)),
	};
}

beforeEach(() => {
	// The bundle path verifies the pinned pubkey inside the (faked) bundle source,
	// so the main thread never fetches here; stub fetch defensively so any stray
	// same-origin read resolves with deterministic bytes rather than hitting the
	// network in the test environment.
	vi.stubGlobal(
		"fetch",
		vi.fn(() => Promise.resolve(new Response(PUBKEY, { status: 200 }))),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const CONFIG: RuntimeConfig = {
	pubkeyUrl: "https://app.example/public.key",
	bundleBaseUrl: "/bundle/origin",
};

/** A trivial loaded watchlist whose index/entities are never reached when
 * warmup hangs or rejects. */
function fakeLoaded(): LoadedWatchlist {
	return {
		index: new VectorIndex(new Float32Array(1), ["x"], 1),
		entities: new Map(),
		version: "test",
		listId: "OFAC_SDN",
	};
}

/** An embedder whose embed() never settles — the boot-hang condition. */
function neverEmbedder(): Embedder {
	return { embed: () => new Promise<Float32Array>(() => {}) };
}

/** A single-catalog `openBundleSource` over the given (listId, version) pairs,
 * each list loaded as a trivial {@link fakeLoaded}. The bundle path is the ONLY
 * path, so bootstrap is always driven through this. */
function bundleSourceOf(
	pairs: ReadonlyArray<readonly [string, string]>,
): RuntimeDeps["openBundleSource"] {
	return bundleSourceFromCatalogs([catalogOf(pairs)], () => fakeLoaded());
}

describe("modelLoadIdleTimeoutMs (model-load idle override, fail-closed)", () => {
	it("returns the production default when the override is absent", () => {
		expect(modelLoadIdleTimeoutMs({})).toBe(MODEL_LOAD_IDLE_TIMEOUT_MS);
	});

	it("uses a valid positive numeric override", () => {
		expect(
			modelLoadIdleTimeoutMs({ VITE_MODEL_LOAD_IDLE_TIMEOUT_MS: "2500" }),
		).toBe(2500);
	});

	it.each(["", "abc", "0", "-1", "NaN", "Infinity"])(
		"falls back to the default for the invalid override %p",
		(raw) => {
			expect(
				modelLoadIdleTimeoutMs({ VITE_MODEL_LOAD_IDLE_TIMEOUT_MS: raw }),
			).toBe(MODEL_LOAD_IDLE_TIMEOUT_MS);
		},
	);

	it("reads VITE_MODEL_LOAD_IDLE_TIMEOUT_MS from the env record", () => {
		expect(
			modelLoadIdleTimeoutMs({ VITE_MODEL_LOAD_IDLE_TIMEOUT_MS: "1234" }),
		).toBe(1234);
	});

	it("falls back to the default when the env var is unset", () => {
		expect(modelLoadIdleTimeoutMs({})).toBe(MODEL_LOAD_IDLE_TIMEOUT_MS);
	});
});

describe("bootTimeoutMs (overall boot deadline override, fail-closed)", () => {
	it("defaults to BOOT_TIMEOUT_MS when the env var is unset", () => {
		expect(bootTimeoutMs({})).toBe(BOOT_TIMEOUT_MS);
	});

	it("uses a valid positive override and falls back for an invalid one", () => {
		expect(bootTimeoutMs({ VITE_BOOT_TIMEOUT_MS: "5000" })).toBe(5000);
		expect(bootTimeoutMs({ VITE_BOOT_TIMEOUT_MS: "-1" })).toBe(BOOT_TIMEOUT_MS);
	});

	it("is longer than the model-load ceiling so the model timeout stays the tighter bound", () => {
		expect(BOOT_TIMEOUT_MS).toBeGreaterThan(MODEL_LOAD_IDLE_TIMEOUT_MS);
	});

	/**
	 * THE guard for the 2026-08-01 finding. The boot ceiling DOES fire — verified
	 * in a real browser against the production build — but it was set BELOW the
	 * time a healthy slow link needs, so the first visitor it would ever hit is
	 * someone whose download is working perfectly, just slowly. A wall-clock cap
	 * on a download whose duration scales with the visitor's bandwidth is a
	 * false-failure generator, and this is the arithmetic that says so out loud.
	 *
	 * Proven able to fail: at the previous 180 s value this rejects, because
	 * 180_000 is not greater than 535_000. That was the bug.
	 */
	it("cannot fire before a healthy slow-link cold download has finished", () => {
		expect(BOOT_TIMEOUT_MS).toBeGreaterThan(SLOWEST_HEALTHY_COLD_SYNC_MS);
	});

	/**
	 * The layering that makes a wide ceiling safe. A boot that is genuinely WEDGED
	 * is caught in seconds by the tighter, better-shaped bounds — the per-fetch
	 * transport ceiling and the Worker client's no-progress watchdog — neither of
	 * which punishes mere slowness. BOOT_TIMEOUT_MS is only the backstop for the
	 * residual case they cannot see: a boot that keeps making progress and still
	 * never finishes. The moment it became the TIGHTEST bound it would go back to
	 * terminating healthy downloads.
	 */
	it("is the loosest bound: the stall detectors stay tighter", () => {
		expect(FETCH_STALL_TIMEOUT_MS).toBeLessThan(BOOT_TIMEOUT_MS);
		expect(DEFAULT_REQUEST_TIMEOUT_MS).toBeLessThan(BOOT_TIMEOUT_MS);
		expect(MODEL_LOAD_IDLE_TIMEOUT_MS).toBeLessThan(BOOT_TIMEOUT_MS);
	});
});

describe("EngineRuntime overall boot timeout", () => {
	it("rejects the whole boot when the download phase stalls past the deadline", async () => {
		const deps: RuntimeDeps = {
			makeEmbedder: () => neverEmbedder(),
			clearCache: () => Promise.resolve(),
			// A bundle open that never settles — the download/verify phase hangs
			// forever, the exact "sits on Downloading… forever" shape on iOS.
			openBundleSource: () => new Promise<BundleSource>(() => {}),
		};
		const runtime = new EngineRuntime(deps);
		vi.useFakeTimers();
		const pending = runtime.bootstrap(CONFIG);
		const assertion = expect(pending).rejects.toThrow(/timed out/i);
		await vi.advanceTimersByTimeAsync(BOOT_TIMEOUT_MS);
		await assertion;
		// The boot-timeout rejection flows through the SAME memo-clearing catch a
		// build rejection does (covered by "a failed bundle open clears the memo"),
		// so a later Retry re-attempts the boot.
	});
});

describe("withTimeout", () => {
	it("passes through the value of a promise that settles before the deadline", async () => {
		await expect(withTimeout(Promise.resolve(42), 1000, "nope")).resolves.toBe(
			42,
		);
	});

	it("rejects with the message when the inner promise never settles", async () => {
		vi.useFakeTimers();
		const pending = withTimeout(
			new Promise<number>(() => {}),
			5000,
			"warmup stalled",
		);
		const assertion = expect(pending).rejects.toThrow("warmup stalled");
		await vi.advanceTimersByTimeAsync(5000);
		await assertion;
	});

	it("does not reject after the inner promise already resolved", async () => {
		vi.useFakeTimers();
		const resolved = withTimeout(
			Promise.resolve("ok"),
			5000,
			"should not fire",
		);
		await expect(resolved).resolves.toBe("ok");
		// Advancing past the deadline must not produce an unhandled rejection.
		await vi.advanceTimersByTimeAsync(5000);
	});
});

describe("EngineRuntime bootstrap timeout", () => {
	function deps(embedder: Embedder): RuntimeDeps {
		return {
			makeEmbedder: () => embedder,
			clearCache: () => Promise.resolve(),
			openBundleSource: bundleSourceOf([["OFAC_SDN", "test"]]),
		};
	}

	it("rejects with the model-load timeout message when warmup never settles", async () => {
		vi.useFakeTimers();
		const runtime = new EngineRuntime(deps(neverEmbedder()));
		const pending = runtime.bootstrap(CONFIG);
		const assertion = expect(pending).rejects.toThrow(/model/i);
		await vi.advanceTimersByTimeAsync(MODEL_LOAD_IDLE_TIMEOUT_MS);
		await assertion;
	});

	it("clears the memo on timeout so a later boot re-attempts the warmup", async () => {
		vi.useFakeTimers();
		// Both warmups hang; we only assert that #build re-ran (embed called
		// again), which is impossible unless the rejected memo was cleared.
		const embed = vi
			.fn<Embedder["embed"]>()
			.mockImplementation(() => new Promise<Float32Array>(() => {}));
		const runtime = new EngineRuntime(deps({ embed }));

		const first = runtime.bootstrap(CONFIG);
		const firstAssert = expect(first).rejects.toThrow();
		await vi.advanceTimersByTimeAsync(MODEL_LOAD_IDLE_TIMEOUT_MS);
		await firstAssert;
		expect(embed).toHaveBeenCalledTimes(1);

		const second = runtime.bootstrap(CONFIG);
		const secondAssert = expect(second).rejects.toThrow();
		await vi.advanceTimersByTimeAsync(MODEL_LOAD_IDLE_TIMEOUT_MS);
		await secondAssert;
		// A fresh #build ran (warmup re-attempted) — the rejected memo was cleared.
		expect(embed).toHaveBeenCalledTimes(2);
	});

	it("does not install a late engine when a timed-out bundle load eventually resolves", async () => {
		vi.useFakeTimers();
		let releaseBundle: ((source: BundleSource) => void) | undefined;
		let opens = 0;
		const runtime = new EngineRuntime({
			makeEmbedder: () => ({
				embed: () => Promise.resolve(new Float32Array(384)),
			}),
			clearCache: () => Promise.resolve(),
			openBundleSource: () => {
				opens += 1;
				if (opens > 1) {
					return Promise.resolve(
						fakeBundleSource(catalogOf([["OFAC_SDN", "new"]]), () => ({
							...fakeLoaded(),
							version: "new",
						})),
					);
				}
				return new Promise<BundleSource>((resolve) => {
					releaseBundle = resolve;
				});
			},
		});
		const boot = runtime.bootstrap(CONFIG);
		const failed = expect(boot).rejects.toThrow(/timed out/i);
		await vi.advanceTimersByTimeAsync(BOOT_TIMEOUT_MS);
		await failed;

		// The timed-out operation has already released its lifecycle slot. A retry
		// may therefore complete before the old bundle load settles.
		const fresh = await runtime.bootstrap(CONFIG);
		expect(fresh).toBeDefined();
		expect(releaseBundle).toBeDefined();
		releaseBundle?.(
			fakeBundleSource(catalogOf([["OFAC_SDN", "late"]]), () => ({
				...fakeLoaded(),
				version: "late",
			})),
		);
		await vi.advanceTimersByTimeAsync(1);
		for (let i = 0; i < 8; i += 1) {
			await Promise.resolve();
		}

		expect(runtime.version()).toContain("OFAC_SDN@new");
	});
});

describe("EngineRuntime.reload", () => {
	/** A loaded watchlist tagged with a listId + version + a single entity id. */
	function loadedAt(
		version: string,
		entityId: string,
		listId = "OFAC_SDN",
	): LoadedWatchlist {
		return {
			index: new VectorIndex(new Float32Array(1), [entityId], 1),
			entities: new Map([
				[
					entityId,
					{
						entity_id: entityId,
						entity_type: "PERSON",
						primary_name: entityId,
						name_canonical: entityId,
						aliases: [],
						dob: [],
						countries: [],
						risk_category: "SANCTION",
						source_list: listId,
						list_version: version,
					},
				],
			]),
			version,
			listId,
		};
	}

	/** An embedder that resolves instantly so bootstrap completes (no fake timers). */
	function instantEmbedder(): Embedder {
		return { embed: () => Promise.resolve(new Float32Array(1)) };
	}

	/** Deps whose bundle source loads a `<listId>:E@<version>` loaded watchlist per
	 * catalog entry, with the catalog drawn from a queue (boot then each reopen —
	 * reload/poll null the runtime's memo and re-open the source). */
	function depsForCatalogs(catalogs: ReadonlyArray<WatchlistCatalog>): {
		deps: RuntimeDeps;
		makeEmbedder: ReturnType<typeof vi.fn>;
	} {
		const makeEmbedder = vi.fn(() => instantEmbedder());
		const deps: RuntimeDeps = {
			makeEmbedder,
			clearCache: () => Promise.resolve(),
			openBundleSource: bundleSourceFromCatalogs(catalogs, (entry) =>
				loadedAt(entry.version, `${entry.id}:E`, entry.id),
			),
		};
		return { deps, makeEmbedder };
	}

	it("loads EVERY catalog list and stamps the composite version", async () => {
		const { deps } = depsForCatalogs([
			catalogOf([
				["EU_CONSOLIDATED", "demo-1"],
				["OFAC_SDN", "demo-1"],
			]),
		]);
		const runtime = new EngineRuntime(deps);
		const engine = await runtime.bootstrap(CONFIG);
		// Both lists' entities are present (browse view spans lists).
		expect(
			engine
				.allEntities()
				.map((e) => e.entity_id)
				.sort(),
		).toEqual(["EU_CONSOLIDATED:E", "OFAC_SDN:E"]);
		// Composite stamp: sorted id@version join.
		expect(runtime.version()).toBe("EU_CONSOLIDATED@demo-1|OFAC_SDN@demo-1");
	});

	it("rejects the WHOLE bootstrap if ANY single list fails to load (fail-closed)", async () => {
		const makeEmbedder = vi.fn(() => instantEmbedder());
		const catalog = catalogOf([
			["EU_CONSOLIDATED", "demo-1"],
			["OFAC_SDN", "demo-1"],
		]);
		const runtime = new EngineRuntime({
			makeEmbedder,
			clearCache: () => Promise.resolve(),
			openBundleSource: () =>
				Promise.resolve({
					loadCatalog: () => catalog,
					loadList: (entry) =>
						entry.id === "OFAC_SDN"
							? Promise.reject(new Error("signature verification failed"))
							: Promise.resolve(loadedAt(entry.version, `${entry.id}:E`)),
					version: () => "fake",
					clear: () => Promise.resolve(),
				}),
		});
		await expect(runtime.bootstrap(CONFIG)).rejects.toThrow(/verification/);
		// No partial engine was published.
		expect(runtime.engine()).toBeNull();
		// CONTRACT REVERSED (iOS memory fix): the model is now warmed BEFORE the lists
		// load, so a bad list no longer saves the ~23 MB download. Fail-closed is
		// unchanged: the boot still rejects and no engine is published.
		expect(makeEmbedder).toHaveBeenCalledTimes(1);
	});

	it("reload re-loads every list, reuses the warm embedder, and advances the composite", async () => {
		const { deps, makeEmbedder } = depsForCatalogs([
			catalogOf([["OFAC_SDN", "demo-1"]]),
			catalogOf([["OFAC_SDN", "demo-2"]]),
		]);
		const runtime = new EngineRuntime(deps);

		const first = await runtime.bootstrap(CONFIG);
		expect(runtime.version()).toBe("OFAC_SDN@demo-1");

		const reloaded = await runtime.reload();
		expect(runtime.version()).toBe("OFAC_SDN@demo-2");
		expect(reloaded.listVersions()).toEqual({ OFAC_SDN: "demo-2" });
		expect(runtime.engine()).toBe(reloaded);
		expect(runtime.engine()).not.toBe(first);
		// The embedder was built ONCE (at bootstrap) — reload did NOT re-download.
		expect(makeEmbedder).toHaveBeenCalledTimes(1);
	});

	it("disposes the prior eager index before loading a replacement", async () => {
		const events: string[] = [];
		let opens = 0;
		const runtime = new EngineRuntime({
			makeEmbedder: () => instantEmbedder(),
			clearCache: () => Promise.resolve(),
			openBundleSource: () => {
				opens += 1;
				const open = opens;
				return Promise.resolve(
					fakeBundleSource(
						catalogOf([["OFAC_SDN", `demo-${open}`]]),
						(entry) => {
							const loaded = loadedAt(entry.version, `OFAC_SDN:${open}`);
							const dispose = loaded.index.dispose.bind(loaded.index);
							loaded.index.dispose = () => {
								events.push(`dispose-${open}`);
								dispose();
							};
							events.push(`load-${open}`);
							return loaded;
						},
						() => events.push(`source-${open}`),
					),
				);
			},
		});

		await runtime.bootstrap(CONFIG);
		events.length = 0;
		await runtime.reload();

		expect(events.indexOf("dispose-1")).toBeLessThan(events.indexOf("load-2"));
	});

	it("waits for an in-flight screen before reload opens a replacement source", async () => {
		let embedCalls = 0;
		let releaseQuery: (() => void) | undefined;
		const vector = new Float32Array([0]);
		const embedder: Embedder = {
			embed: () => {
				embedCalls += 1;
				if (embedCalls === 1) return Promise.resolve(vector);
				return new Promise<Float32Array>((resolve) => {
					releaseQuery = () => resolve(vector);
				});
			},
		};
		let opens = 0;
		const runtime = new EngineRuntime({
			makeEmbedder: () => embedder,
			clearCache: () => Promise.resolve(),
			openBundleSource: () => {
				opens += 1;
				return Promise.resolve(
					fakeBundleSource(
						catalogOf([["OFAC_SDN", `demo-${opens}`]]),
						(entry) => loadedAt(entry.version, `OFAC_SDN:${opens}`),
					),
				);
			},
		});

		const first = await runtime.bootstrap(CONFIG);
		const screen = first.screen({ name: "OFAC_SDN:1" });
		const reload = runtime.reload();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(opens).toBe(1);

		releaseQuery?.();
		await screen;
		await reload;
		expect(opens).toBe(2);
	});

	it("disposes the replaced bundle source after reload and on runtime dispose", async () => {
		let opens = 0;
		const firstDispose = vi.fn();
		const secondDispose = vi.fn();
		const runtime = new EngineRuntime({
			makeEmbedder: () => instantEmbedder(),
			clearCache: () => Promise.resolve(),
			openBundleSource: () => {
				opens += 1;
				const dispose = opens === 1 ? firstDispose : secondDispose;
				return Promise.resolve(
					fakeBundleSource(
						catalogOf([["OFAC_SDN", `demo-${opens}`]]),
						() => loadedAt(`demo-${opens}`, `OFAC_SDN:${opens}`),
						dispose,
					),
				);
			},
		});

		await runtime.bootstrap(CONFIG);
		await runtime.reload();
		expect(firstDispose).toHaveBeenCalledTimes(1);
		expect(secondDispose).not.toHaveBeenCalled();

		await runtime.dispose();
		expect(secondDispose).toHaveBeenCalledTimes(1);
	});

	it("fetchPublishedVersion returns a DIFFERENT composite when a list version bumps", async () => {
		// Boot opens the source over demo-1; fetchPublishedVersion nulls the memo
		// and re-opens, drawing the bumped demo-2 catalog from the queue.
		const { deps } = depsForCatalogs([
			catalogOf([["OFAC_SDN", "demo-1"]]),
			catalogOf([["OFAC_SDN", "demo-2"]]),
		]);
		const runtime = new EngineRuntime(deps);
		await runtime.bootstrap(CONFIG);
		const published = await runtime.fetchPublishedVersion();
		expect(runtime.version()).toBe("OFAC_SDN@demo-1");
		expect(published).toBe("OFAC_SDN@demo-2");
		expect(published).not.toBe(runtime.version());
	});

	it("disposes only the temporary source used by a published-version poll", async () => {
		let opens = 0;
		const firstDispose = vi.fn();
		const pollDispose = vi.fn();
		const runtime = new EngineRuntime({
			makeEmbedder: () => instantEmbedder(),
			clearCache: () => Promise.resolve(),
			openBundleSource: () => {
				opens += 1;
				return Promise.resolve(
					fakeBundleSource(
						catalogOf([["OFAC_SDN", `demo-${opens}`]]),
						() => loadedAt(`demo-${opens}`, `OFAC_SDN:${opens}`),
						opens === 1 ? firstDispose : pollDispose,
					),
				);
			},
		});

		await runtime.bootstrap(CONFIG);
		await runtime.fetchPublishedVersion();
		expect(firstDispose).not.toHaveBeenCalled();
		expect(pollDispose).toHaveBeenCalledTimes(1);
		expect(runtime.engine()).not.toBeNull();
	});

	it("throws if reload is called before a successful bootstrap", async () => {
		const { deps } = depsForCatalogs([catalogOf([["OFAC_SDN", "demo-1"]])]);
		const runtime = new EngineRuntime(deps);
		await expect(runtime.reload()).rejects.toThrow();
	});

	it("reads the signed catalog before model bootstrap when settings supplies config", async () => {
		const makeEmbedder = vi.fn(() => instantEmbedder());
		const runtime = new EngineRuntime({
			makeEmbedder,
			clearCache: () => Promise.resolve(),
			openBundleSource: bundleSourceFromCatalogs(
				[catalogOf([["OFAC_SDN", "demo-1"]])],
				() => fakeLoaded(),
			),
		});

		// The signed catalog entry's version, count and FRESHNESS travel with the
		// list: this hop used to project `{id, title}` and drop the rest, which is
		// why no UI could tell a user how old the list they were selecting was.
		expect(await runtime.catalogLists(CONFIG)).toEqual([
			{
				id: "OFAC_SDN",
				title: "OFAC_SDN",
				version: "demo-1",
				entitiesCount: 1,
				...FRESH_RESOLVED,
			},
		]);
		expect(await runtime.catalogListIds()).toEqual(["OFAC_SDN"]);
		expect(runtime.engine()).toBeNull();
		expect(makeEmbedder).not.toHaveBeenCalled();
	});

	it("does not silently switch trust origins after the engine is booted", async () => {
		const runtime = new EngineRuntime({
			makeEmbedder: () => instantEmbedder(),
			clearCache: () => Promise.resolve(),
			openBundleSource: bundleSourceOf([["OFAC_SDN", "demo-1"]]),
		});
		await runtime.bootstrap(CONFIG);
		await expect(
			runtime.catalogLists({
				...CONFIG,
				bundleBaseUrl: "/another-origin",
			}),
		).rejects.toThrow(/cannot change after bootstrap/);
	});

	it("throws if fetchPublishedVersion is called before a successful bootstrap", async () => {
		const { deps } = depsForCatalogs([catalogOf([["OFAC_SDN", "demo-1"]])]);
		const runtime = new EngineRuntime(deps);
		await expect(runtime.fetchPublishedVersion()).rejects.toThrow();
	});
});

describe("EngineRuntime enabledLists selection + thresholds", () => {
	function loadedAt(
		version: string,
		entityId: string,
		listId: string,
	): LoadedWatchlist {
		return {
			index: new VectorIndex(new Float32Array(1), [entityId], 1),
			entities: new Map([
				[
					entityId,
					{
						entity_id: entityId,
						entity_type: "PERSON",
						primary_name: entityId,
						name_canonical: entityId,
						aliases: [],
						dob: [],
						countries: [],
						risk_category: "SANCTION",
						source_list: listId,
						list_version: version,
					},
				],
			]),
			version,
			listId,
		};
	}

	function instantEmbedder(): Embedder {
		return { embed: () => Promise.resolve(new Float32Array(1)) };
	}

	/** Deps over a static multi-list catalog; the bundle source's loadList tracks
	 * which ids loaded (the runtime filters to the enabled set before loading). */
	function depsFor(catalog: WatchlistCatalog): {
		deps: RuntimeDeps;
		loadedIds: string[];
		makeEmbedder: ReturnType<typeof vi.fn>;
	} {
		const loadedIds: string[] = [];
		const makeEmbedder = vi.fn(() => instantEmbedder());
		const deps: RuntimeDeps = {
			makeEmbedder,
			clearCache: () => Promise.resolve(),
			openBundleSource: bundleSourceFromCatalogs([catalog], (entry) => {
				loadedIds.push(entry.id);
				return loadedAt(entry.version, `${entry.id}:E`, entry.id);
			}),
		};
		return { deps, loadedIds, makeEmbedder };
	}

	const MULTI = catalogOf([
		["EU_CONSOLIDATED", "demo-1"],
		["OFAC_SDN", "demo-1"],
		["UN_CONSOLIDATED", "demo-1"],
	]);

	it("loads only the enabled subset of catalog lists", async () => {
		const { deps, loadedIds } = depsFor(MULTI);
		const runtime = new EngineRuntime(deps);
		const engine = await runtime.bootstrap(CONFIG, () => {}, {
			enabledLists: ["OFAC_SDN", "UN_CONSOLIDATED"],
		});
		expect(loadedIds.sort()).toEqual(["OFAC_SDN", "UN_CONSOLIDATED"]);
		expect(
			engine
				.allEntities()
				.map((e) => e.entity_id)
				.sort(),
		).toEqual(["OFAC_SDN:E", "UN_CONSOLIDATED:E"]);
		expect(runtime.version()).toBe("OFAC_SDN@demo-1|UN_CONSOLIDATED@demo-1");
	});

	it("supports bounded streaming residency without loading vectors at boot", async () => {
		const catalog = catalogOf([
			["EU_CONSOLIDATED", "demo-1"],
			["OFAC_SDN", "demo-1"],
		]);
		const loadedIds: string[] = [];
		const metadataIds: string[] = [];
		const source: BundleSource = {
			loadCatalog: () => catalog,
			loadListMetadata: async (entry): Promise<LoadedWatchlistMetadata> => {
				metadataIds.push(entry.id);
				const loaded = loadedAt(entry.version, `${entry.id}:E`, entry.id);
				return {
					entities: loaded.entities,
					listId: loaded.listId,
					version: loaded.version,
				};
			},
			loadList: async (entry) => {
				loadedIds.push(entry.id);
				return loadedAt(entry.version, `${entry.id}:E`, entry.id);
			},
			version: () => "fake",
			clear: () => Promise.resolve(),
		};
		const runtime = new EngineRuntime({
			makeEmbedder: () => instantEmbedder(),
			clearCache: () => Promise.resolve(),
			openBundleSource: () => Promise.resolve(source),
		});
		const engine = await runtime.bootstrap(CONFIG, () => {}, {
			residency: "streaming",
		});
		expect(metadataIds).toEqual(["EU_CONSOLIDATED", "OFAC_SDN"]);
		expect(loadedIds).toEqual([]);
		expect(engine.allEntities()).toHaveLength(2);
		await engine.screen({ name: "EU_CONSOLIDATED:E" });
		expect(loadedIds).toEqual(["EU_CONSOLIDATED", "OFAC_SDN"]);
		loadedIds.length = 0;
		metadataIds.length = 0;
		await runtime.reload();
		expect(loadedIds).toEqual([]);
		expect(metadataIds).toEqual(["EU_CONSOLIDATED", "OFAC_SDN"]);
	});

	it("loads every list when enabledLists is absent (today's behavior)", async () => {
		const { deps, loadedIds } = depsFor(MULTI);
		const runtime = new EngineRuntime(deps);
		await runtime.bootstrap(CONFIG);
		expect(loadedIds.sort()).toEqual([
			"EU_CONSOLIDATED",
			"OFAC_SDN",
			"UN_CONSOLIDATED",
		]);
	});

	it("silently skips an enabled id that is absent from the catalog", async () => {
		const { deps, loadedIds } = depsFor(MULTI);
		const runtime = new EngineRuntime(deps);
		await runtime.bootstrap(CONFIG, () => {}, {
			enabledLists: ["OFAC_SDN", "NOT_IN_CATALOG"],
		});
		expect(loadedIds).toEqual(["OFAC_SDN"]);
	});

	it("loads nothing and screens to no matches for an empty enabled set", async () => {
		const { deps, loadedIds, makeEmbedder } = depsFor(MULTI);
		const runtime = new EngineRuntime(deps);
		const engine = await runtime.bootstrap(CONFIG, () => {}, {
			enabledLists: [],
		});
		expect(loadedIds).toEqual([]);
		expect(engine.allEntities()).toEqual([]);
		// The embedder still warms (model load is selection-independent).
		expect(makeEmbedder).toHaveBeenCalledTimes(1);
		const res = await engine.screen({ name: "anyone" });
		expect(res.matches).toEqual([]);
	});

	it("exposes the catalog list ids (the real selectable set)", async () => {
		const { deps } = depsFor(MULTI);
		const runtime = new EngineRuntime(deps);
		await runtime.bootstrap(CONFIG);
		expect([...(await runtime.catalogListIds())].sort()).toEqual([
			"EU_CONSOLIDATED",
			"OFAC_SDN",
			"UN_CONSOLIDATED",
		]);
	});

	it("re-bootstrap reloads a new enabled set, reusing the warm embedder", async () => {
		const { deps, loadedIds, makeEmbedder } = depsFor(MULTI);
		const runtime = new EngineRuntime(deps);
		await runtime.bootstrap(CONFIG, () => {}, {
			enabledLists: ["OFAC_SDN"],
		});
		expect(loadedIds).toEqual(["OFAC_SDN"]);

		const re = await runtime.reload({
			enabledLists: ["EU_CONSOLIDATED", "OFAC_SDN"],
		});
		expect(re.listVersions()).toEqual({
			EU_CONSOLIDATED: "demo-1",
			OFAC_SDN: "demo-1",
		});
		expect(runtime.engine()).toBe(re);
		// The embedder was built ONCE — re-bootstrap did NOT re-download the model.
		expect(makeEmbedder).toHaveBeenCalledTimes(1);
	});

	it("passes thresholds through to the engine (a strict per-list bar suppresses)", async () => {
		const { deps } = depsFor(MULTI);
		const runtime = new EngineRuntime(deps);
		// Every list's entity vector is identical to the (axis) embed; only the
		// per-list bar differs. OFAC's impossibly-high bar suppresses its hit.
		const engine = await runtime.bootstrap(CONFIG, () => {}, {
			thresholds: { default: 0, perList: { OFAC_SDN: 1.0001 } },
		});
		const ids = (
			await engine.screen({ name: "EU_CONSOLIDATED:E" })
		).matches.map((m) => m.entity_id);
		expect(ids).not.toContain("OFAC_SDN:E");
	});
});

describe("compositeVersion", () => {
	it("sorts by id and joins id@version with a pipe", () => {
		expect(
			compositeVersion({ OFAC_SDN: "demo-1", EU_CONSOLIDATED: "demo-1" }),
		).toBe("EU_CONSOLIDATED@demo-1|OFAC_SDN@demo-1");
	});

	it("is empty for no lists", () => {
		expect(compositeVersion({})).toBe("");
	});
});

describe("throttleModelProgress", () => {
	function progress(pct: number): EmbedProgress {
		return { loaded: pct, total: 100, pct };
	}

	it("emits once for repeated ticks at the same rounded percent", () => {
		const emit = vi.fn();
		const throttled = throttleModelProgress(emit);
		// Four sub-percent ticks that all round to 42 → exactly one emit.
		throttled(progress(42.0));
		throttled(progress(42.1));
		throttled(progress(42.4));
		throttled(progress(41.7)); // still rounds to 42
		expect(emit).toHaveBeenCalledTimes(1);
	});

	it("emits again when the rounded percent changes, forwarding precise pct", () => {
		const emit = vi.fn();
		const throttled = throttleModelProgress(emit);
		throttled(progress(42.2));
		throttled(progress(43.1)); // rounds to 43 → a new emit
		expect(emit).toHaveBeenCalledTimes(2);
		// The precise pct is forwarded unchanged (the banner rounds for display).
		expect(emit).toHaveBeenNthCalledWith(2, progress(43.1));
	});

	it("caps emissions at ~101 over a full 0→100 sub-percent stream", () => {
		const emit = vi.fn();
		const throttled = throttleModelProgress(emit);
		// 1000 ticks evenly from 0 to 100 → at most 101 distinct rounded values.
		for (let i = 0; i <= 1000; i += 1) {
			throttled(progress((i / 1000) * 100));
		}
		expect(emit.mock.calls.length).toBeLessThanOrEqual(101);
	});

	it("throttles by whole MiB when the server withheld a total", () => {
		// No content-length ⇒ no honest percent, so the banner shows megabytes and
		// the gate must step on those instead. Rounding an undefined pct yields
		// NaN, which never equals itself — every chunk would re-render the banner.
		const emit = vi.fn();
		const throttled = throttleModelProgress(emit);
		const mib = 1024 * 1024;
		for (let chunk = 1; chunk <= 64; chunk += 1) {
			throttled({ loaded: chunk * (mib / 16) });
		}
		// 64 chunks of 64 KiB reach exactly 4 MiB, crossing the 0/1/2/3/4 MiB
		// marks → 5 emits, not one per chunk.
		expect(emit).toHaveBeenCalledTimes(5);
	});
});

describe("EngineRuntime boot stages", () => {
	it("warms the embedder BEFORE any watchlist bytes are loaded (iOS peak-memory order)", async () => {
		// The ONNX/WASM runtime needs its largest single WebAssembly allocation at
		// model start. Loading the signed list + SQLite index first put that
		// allocation on top of ~600 MB of resident list state, which is what ran
		// iPhone Safari out of memory ("[wasm] RangeError: Out of memory"). The model
		// must therefore be built while the tab is still empty.
		const order: string[] = [];
		const inner = bundleSourceOf([["OFAC_SDN", "test"]]);
		const deps: RuntimeDeps = {
			makeEmbedder: () => ({
				embed: () => {
					order.push("embed");
					return Promise.resolve(new Float32Array(384));
				},
			}),
			clearCache: () => Promise.resolve(),
			openBundleSource: (...args) => {
				order.push("open-bundle");
				return inner(...args);
			},
		};
		await new EngineRuntime(deps).bootstrap(CONFIG, () => undefined);
		expect(order.indexOf("embed")).toBeGreaterThanOrEqual(0);
		expect(order.indexOf("embed")).toBeLessThan(order.indexOf("open-bundle"));
	});

	const instantModel = (): Embedder => ({
		embed: () => Promise.resolve(new Float32Array(384)),
	});

	it("emits loading-model first, then downloading and verified(version)", async () => {
		const deps: RuntimeDeps = {
			makeEmbedder: instantModel,
			clearCache: () => Promise.resolve(),
			openBundleSource: bundleSourceOf([["OFAC_SDN", "test"]]),
		};
		const stages: BootStage[] = [];
		await new EngineRuntime(deps).bootstrap(CONFIG, (s) => stages.push(s));
		expect(stages[0]).toEqual({ kind: "loading-model" });
		// The verified stage carries the COMPOSITE stamp, not a bare version.
		expect(stages).toContainEqual({
			kind: "verified",
			version: "OFAC_SDN@test",
		});
		expect(stages.at(-1)).toEqual({ kind: "ready" });
	});

	it("threads cold-sync download progress into a downloading stage", async () => {
		// The bundle-open dep receives an onSyncProgress sink (4th arg); this fake
		// fires one tick during the sync, proving the progress reached onStage.
		const deps: RuntimeDeps = {
			makeEmbedder: instantModel,
			clearCache: () => Promise.resolve(),
			openBundleSource: (_baseUrl, _pubkeyUrl, _bundleDeps, onProgress) => {
				onProgress?.({ fetched: 3, total: 10, bytes: 300 });
				return Promise.resolve(
					fakeBundleSource(catalogOf([["OFAC_SDN", "test"]]), () =>
						fakeLoaded(),
					),
				);
			},
		};
		const stages: BootStage[] = [];
		await new EngineRuntime(deps).bootstrap(CONFIG, (s) => stages.push(s));
		// The plain downloading stage fires (no progress yet), after the model...
		expect(stages).toContainEqual({ kind: "downloading" });
		// ...then the per-chunk progress rides a later downloading stage.
		expect(stages).toContainEqual({
			kind: "downloading",
			progress: { fetched: 3, total: 10, bytes: 300 },
		});
	});

	it("threads an embedder progress event into a loading-model stage", async () => {
		// The embedder factory receives an onProgress sink; this fake fires one
		// progress event during warmup, which the runtime must surface as a
		// loading-model BootStage carrying that progress.
		const deps: RuntimeDeps = {
			makeEmbedder: (onProgress) => ({
				// Fire one progress tick, then reject — that halts #build before the
				// (out-of-scope) screening-engine assembly while still proving the
				// progress sink reached onStage. The rejection is asserted below.
				embed: () => {
					onProgress({ loaded: 12, total: 24, pct: 50 });
					return Promise.reject(new Error("warmup halted after progress"));
				},
			}),
			clearCache: () => Promise.resolve(),
			openBundleSource: bundleSourceOf([["OFAC_SDN", "test"]]),
		};
		const runtime = new EngineRuntime(deps);
		const stages: BootStage[] = [];
		await expect(
			runtime.bootstrap(CONFIG, (s) => stages.push(s)),
		).rejects.toThrow("warmup halted after progress");

		expect(stages).toContainEqual({
			kind: "loading-model",
			progress: { loaded: 12, total: 24, pct: 50 },
		});
		// The plain (progress-less) loading-model stage still fires first.
		expect(stages).toContainEqual({ kind: "loading-model" });
	});
});

describe("EngineRuntime.clearListCache + cache-aware deps", () => {
	function instantEmbedder(): Embedder {
		return { embed: () => Promise.resolve(new Float32Array(1)) };
	}

	it("clearListCache delegates to the injected cache-clear seam", async () => {
		const clearCache = vi.fn(() => Promise.resolve());
		const runtime = new EngineRuntime({
			makeEmbedder: () => instantEmbedder(),
			clearCache,
			openBundleSource: bundleSourceOf([["OFAC_SDN", "v"]]),
		});
		await runtime.clearListCache();
		expect(clearCache).toHaveBeenCalledTimes(1);
	});

	it("never opens the bundle source when the model fails first (nothing to evict)", async () => {
		// CONTRACT REVERSED (iOS memory fix): this used to assert the source opened
		// before the model was evicted. The model is now built first, so a model
		// failure must leave no bundle source open at all.
		const sourceDispose = vi.fn();
		const open = vi.fn();
		const runtime = new EngineRuntime({
			makeEmbedder: () => ({
				embed: () => Promise.reject(new Error("warmup failed")),
			}),
			clearCache: () => Promise.resolve(),
			openBundleSource: () => {
				open();
				return Promise.resolve(
					fakeBundleSource(
						catalogOf([["OFAC_SDN", "v1"]]),
						() => fakeLoaded(),
						sourceDispose,
					),
				);
			},
		});

		await expect(runtime.bootstrap(CONFIG)).rejects.toThrow(/warmup failed/);
		expect(open).not.toHaveBeenCalled();
		expect(sourceDispose).not.toHaveBeenCalled();
	});

	it("disposes the active engine and resets the boot memo after clearing", async () => {
		let opens = 0;
		const dispose = vi.fn();
		const makeEmbedder = vi.fn(() => ({
			...instantEmbedder(),
			dispose,
		}));
		const runtime = new EngineRuntime({
			makeEmbedder,
			clearCache: () => Promise.resolve(),
			openBundleSource: (baseUrl, pubkeyUrl) => {
				opens += 1;
				return bundleSourceOf([["OFAC_SDN", `v${opens}`]])(baseUrl, pubkeyUrl);
			},
		});
		const first = await runtime.bootstrap(CONFIG);
		await runtime.clearListCache();
		expect(runtime.engine()).toBeNull();
		expect(first.allEntities()).toEqual([]);
		expect(dispose).toHaveBeenCalledTimes(1);

		const second = await runtime.bootstrap(CONFIG);
		expect(second).not.toBe(first);
		expect(opens).toBe(2);
		expect(makeEmbedder).toHaveBeenCalledTimes(2);
	});

	it("disposes the active bundle source while clearing the cache", async () => {
		const sourceDispose = vi.fn();
		const runtime = new EngineRuntime({
			makeEmbedder: () => instantEmbedder(),
			clearCache: () => Promise.resolve(),
			openBundleSource: () =>
				Promise.resolve(
					fakeBundleSource(
						catalogOf([["OFAC_SDN", "v1"]]),
						() => fakeLoaded(),
						sourceDispose,
					),
				),
		});

		await runtime.bootstrap(CONFIG);
		await runtime.clearListCache();
		expect(sourceDispose).toHaveBeenCalledTimes(1);
	});

	it("releases the ready engine and embedder before opening the clear source", async () => {
		const events: string[] = [];
		const loaded = fakeLoaded();
		vi.spyOn(loaded.index, "dispose").mockImplementation(() => {
			events.push("engine");
		});
		const runtime = new EngineRuntime({
			makeEmbedder: () => ({
				...instantEmbedder(),
				dispose: () => events.push("embedder"),
			}),
			clearCache: async () => {
				events.push("clear");
			},
			openBundleSource: () =>
				Promise.resolve(
					fakeBundleSource(
						catalogOf([["OFAC_SDN", "v1"]]),
						() => loaded,
						() => events.push("source"),
					),
				),
		});

		await runtime.bootstrap(CONFIG);
		await runtime.clearListCache();

		expect(events).toEqual(["source", "engine", "embedder", "clear"]);
	});

	it("serializes a clear-cache request behind an in-flight reload", async () => {
		const events: string[] = [];
		let opens = 0;
		let releaseReload: (() => void) | undefined;
		const runtime = new EngineRuntime({
			makeEmbedder: () => instantEmbedder(),
			clearCache: async () => {
				events.push("clear");
			},
			openBundleSource: (baseUrl, pubkeyUrl) => {
				opens += 1;
				if (opens === 1) {
					events.push("boot-open");
					return bundleSourceOf([["OFAC_SDN", "v1"]])(baseUrl, pubkeyUrl);
				}
				events.push("reload-open");
				return new Promise<BundleSource>((resolve) => {
					releaseReload = () =>
						resolve(
							fakeBundleSource(catalogOf([["OFAC_SDN", "v2"]]), () =>
								fakeLoaded(),
							),
						);
				});
			},
		});
		await runtime.bootstrap(CONFIG);

		const reload = runtime.reload();
		const clear = runtime.clearListCache();
		await vi.waitFor(() =>
			expect(events).toEqual(["boot-open", "reload-open"]),
		);
		releaseReload?.();
		await reload;
		await clear;
		expect(events).toEqual(["boot-open", "reload-open", "clear"]);
		expect(runtime.engine()).toBeNull();
	});

	it("serializes a published-version poll before cache clear", async () => {
		const events: string[] = [];
		let opens = 0;
		let releasePoll: (() => void) | undefined;
		const runtime = new EngineRuntime({
			makeEmbedder: () => instantEmbedder(),
			clearCache: async () => {
				events.push("clear");
			},
			openBundleSource: (baseUrl, pubkeyUrl) => {
				opens += 1;
				if (opens === 1) {
					events.push("boot-open");
					return bundleSourceOf([["OFAC_SDN", "v1"]])(baseUrl, pubkeyUrl);
				}
				events.push("poll-open");
				return new Promise<BundleSource>((resolve) => {
					releasePoll = () =>
						resolve(
							fakeBundleSource(catalogOf([["OFAC_SDN", "v2"]]), () =>
								fakeLoaded(),
							),
						);
				});
			},
		});
		await runtime.bootstrap(CONFIG);

		const poll = runtime.fetchPublishedVersion();
		const clear = runtime.clearListCache();
		await vi.waitFor(() => expect(events).toEqual(["boot-open", "poll-open"]));
		releasePoll?.();
		await expect(poll).resolves.toBe("OFAC_SDN@v2");
		await clear;
		expect(events).toEqual(["boot-open", "poll-open", "clear"]);
		expect(runtime.engine()).toBeNull();
	});

	it("defaultRuntimeDeps exposes a clearCache seam (cache-aware by default)", () => {
		expect(typeof defaultRuntimeDeps().clearCache).toBe("function");
	});
});

describe("EngineRuntime.dispose (page-unmount release)", () => {
	function instantEmbedder(): Embedder {
		return { embed: () => Promise.resolve(new Float32Array(1)) };
	}

	it("releases the engine and model worker WITHOUT clearing the durable cache", async () => {
		let opens = 0;
		const clearCache = vi.fn(() => Promise.resolve());
		const dispose = vi.fn();
		const makeEmbedder = vi.fn(() => ({
			...instantEmbedder(),
			dispose,
		}));
		const runtime = new EngineRuntime({
			makeEmbedder,
			clearCache,
			openBundleSource: (baseUrl, pubkeyUrl) => {
				opens += 1;
				return bundleSourceOf([["OFAC_SDN", `v${opens}`]])(baseUrl, pubkeyUrl);
			},
		});
		const first = await runtime.bootstrap(CONFIG);
		await runtime.dispose();

		// Engine vectors + model worker released…
		expect(runtime.engine()).toBeNull();
		expect(runtime.version()).toBeNull();
		expect(first.allEntities()).toEqual([]);
		expect(dispose).toHaveBeenCalledTimes(1);
		// …but the durable OPFS bundle store is untouched — unlike clearListCache,
		// a page unmount must not force the next visit into a full re-download.
		expect(clearCache).not.toHaveBeenCalled();

		// The instance stays usable: a later bootstrap re-boots from scratch.
		const second = await runtime.bootstrap(CONFIG);
		expect(second).not.toBe(first);
		expect(opens).toBe(2);
		expect(makeEmbedder).toHaveBeenCalledTimes(2);
	});

	it("a dispose issued during an in-flight boot aborts it before the boot timeout", async () => {
		let releaseBoot: ((source: BundleSource) => void) | undefined;
		const runtime = new EngineRuntime({
			makeEmbedder: () => instantEmbedder(),
			clearCache: () => Promise.resolve(),
			openBundleSource: () =>
				new Promise<BundleSource>((resolve) => {
					releaseBoot = resolve;
				}),
		});
		const boot = runtime.bootstrap(CONFIG);
		await vi.waitFor(() => expect(releaseBoot).toBeDefined());
		const disposed = runtime.dispose();

		await expect(boot).rejects.toThrow(/superseded/);
		await disposed;
		expect(runtime.engine()).toBeNull();

		releaseBoot?.(
			fakeBundleSource(catalogOf([["OFAC_SDN", "v1"]]), () => fakeLoaded()),
		);
	});

	it("cancels an in-flight model boot promptly when disposed", async () => {
		vi.useFakeTimers();
		const dispose = vi.fn();
		const embed = vi.fn(() => new Promise<Float32Array>(() => {}));
		const runtime = new EngineRuntime({
			makeEmbedder: () => ({ embed, dispose }),
			clearCache: () => Promise.resolve(),
			openBundleSource: bundleSourceOf([["OFAC_SDN", "v1"]]),
		});

		const boot = runtime.bootstrap(CONFIG);
		await vi.waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
		const disposed = runtime.dispose();
		const settled = Promise.race([
			boot.then(
				() => true,
				() => true,
			),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1)),
		]);
		await vi.advanceTimersByTimeAsync(1);

		expect(await settled).toBe(true);
		await expect(boot).rejects.toThrow(/superseded|disposed/);
		await disposed;
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("dispose before any bootstrap is a safe no-op", async () => {
		const runtime = new EngineRuntime({
			makeEmbedder: () => instantEmbedder(),
			clearCache: () => Promise.resolve(),
			openBundleSource: bundleSourceOf([["OFAC_SDN", "v"]]),
		});
		await expect(runtime.dispose()).resolves.toBeUndefined();
		expect(runtime.engine()).toBeNull();
	});
});

describe("configFromEnv", () => {
	it("defaults the bundle base URL and pins the pubkey same-origin", () => {
		const config = configFromEnv({});
		expect(config.bundleBaseUrl).toBe("/bundle/origin");
		expect(config.pubkeyUrl).toBe(
			new URL("public.key", document.baseURI).toString(),
		);
	});

	it("VITE_BUNDLE_BASE_URL overrides the default bundle origin", () => {
		const config = configFromEnv({
			VITE_BUNDLE_BASE_URL: "https://cdn.example/bundle",
		});
		expect(config.bundleBaseUrl).toBe("https://cdn.example/bundle");
	});

	it("a whitespace-only override falls back to the default (fail-closed)", () => {
		expect(configFromEnv({ VITE_BUNDLE_BASE_URL: "   " }).bundleBaseUrl).toBe(
			"/bundle/origin",
		);
	});
});

describe("EngineRuntime bootstrap memo + bundle-source retry", () => {
	function instantEmbedder(): Embedder {
		return { embed: () => Promise.resolve(new Float32Array(384)) };
	}

	it("bootstrap is idempotent: a second call reuses the first engine", async () => {
		let opens = 0;
		const deps: RuntimeDeps = {
			makeEmbedder: () => instantEmbedder(),
			clearCache: () => Promise.resolve(),
			openBundleSource: bundleSourceFromCatalogs(
				[catalogOf([["OFAC_SDN", "1"]])],
				() => fakeLoaded(),
				() => {
					opens += 1;
				},
			),
		};
		const runtime = new EngineRuntime(deps);
		const first = await runtime.bootstrap(CONFIG);
		const second = await runtime.bootstrap(CONFIG);
		expect(second).toBe(first);
		// ONE delta-sync served both calls — the memo held.
		expect(opens).toBe(1);
	});

	it("a failed bundle open clears the memo so a later bootstrap retries", async () => {
		let calls = 0;
		const good = bundleSourceOf([["OFAC_SDN", "1"]]);
		const deps: RuntimeDeps = {
			makeEmbedder: () => instantEmbedder(),
			clearCache: () => Promise.resolve(),
			openBundleSource: (baseUrl, pubkeyUrl) => {
				calls += 1;
				if (calls === 1) {
					return Promise.reject(new Error("bundle origin unreachable"));
				}
				return good(baseUrl, pubkeyUrl);
			},
		};
		const runtime = new EngineRuntime(deps);
		await expect(runtime.bootstrap(CONFIG)).rejects.toThrow(
			/bundle origin unreachable/,
		);
		// Both memos (engine promise + bundle source) were cleared: the retry
		// re-opens the bundle instead of replaying the failed promise.
		await expect(runtime.bootstrap(CONFIG)).resolves.toBeDefined();
		expect(calls).toBe(2);
	});

	it("catalogLists before a successful bootstrap throws", async () => {
		const runtime = new EngineRuntime({
			makeEmbedder: () => instantEmbedder(),
			clearCache: () => Promise.resolve(),
			openBundleSource: bundleSourceOf([["OFAC_SDN", "1"]]),
		});
		await expect(runtime.catalogLists()).rejects.toThrow(
			/requires a runtime config before bootstrap/,
		);
	});
});

// --- defaultRuntimeDeps: the production seams over a scripted Worker -----------

/** Requests the scripted engine Worker received, by kind, in order. */
const scriptedRequests: string[] = [];

/** A scripted stand-in for the sync engine Worker (worker.ts): replies to
 * sync/readFile/clear like the real one over an empty-but-valid bundle, so the
 * default clearCache seam (spawn → sync → catalog → clear) runs end-to-end on
 * the main thread with no OPFS and no real module Worker. */
class ScriptedEngineWorker {
	#listener: ((event: MessageEvent<unknown>) => void) | undefined;

	public addEventListener(
		type: "message" | "error" | "messageerror",
		listener:
			| ((event: MessageEvent<unknown>) => void)
			| ((event: { message?: string }) => void)
			| (() => void),
	): void {
		if (type === "message") {
			this.#listener = listener as (event: MessageEvent<unknown>) => void;
		}
	}

	public postMessage(request: {
		kind: "sync" | "readFile" | "clear";
		id: number;
	}): void {
		scriptedRequests.push(request.kind);
		const respond = (data: unknown): void => {
			queueMicrotask(() => this.#listener?.({ data } as MessageEvent<unknown>));
		};
		if (request.kind === "sync") {
			respond({
				ok: true,
				id: request.id,
				kind: "sync",
				result: {
					version: "demo-1",
					manifestHash: "h".repeat(64),
					chunksFetched: 0,
					chunksReused: 0,
					bytesFetched: 0,
				},
			});
			return;
		}
		if (request.kind === "readFile") {
			respond({
				ok: true,
				id: request.id,
				kind: "readFile",
				bytes: new TextEncoder().encode(
					JSON.stringify({
						schemaVersion: 1,
						generatedAt: "2026-06-19T00:00:00Z",
						lists: [],
					}),
				),
			});
			return;
		}
		respond({ ok: true, id: request.id, kind: "clear" });
	}

	public terminate(): void {}
}

describe("defaultRuntimeDeps (production seams over a scripted Worker)", () => {
	it("clearCache drops the durable store through a spawned Worker client", async () => {
		scriptedRequests.length = 0;
		vi.stubGlobal("Worker", ScriptedEngineWorker);

		await defaultRuntimeDeps().clearCache();

		// The clear goes STRAIGHT to the Worker: no sync first. It used to open a
		// transient bundle source (sync, readFile, sync) before clearing, so a store
		// whose rollback floor refuses the served pointer — the one store a user
		// most needs to clear — could never be cleared at all.
		expect(scriptedRequests).toEqual(["clear"]);
	});

	it("makeEmbedder builds a Worker-backed embedder", () => {
		vi.stubGlobal("Worker", ScriptedEngineWorker);
		const embedder = defaultRuntimeDeps().makeEmbedder(() => {});
		expect(typeof embedder.embed).toBe("function");
	});
});
