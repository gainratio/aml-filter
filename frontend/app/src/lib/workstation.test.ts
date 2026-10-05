import type { ScreenResponse } from "@amlfilter/browser";
import { RescanService, type WorkstationStore } from "@amlfilter/workstation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	resetWorkstationForTests,
	type WorkstationDeps,
	workstation,
} from "./workstation";

/** The first recorded call of a mock; every caller has already exercised it. */
/** A complete CatalogListInfo — the runtime projects the signed catalog entry's
 * version, count and per-list freshness, so the mocks carry them all. */
function catalogList(id: string, title: string) {
	return {
		id,
		title,
		version: "demo-1",
		entitiesCount: 2,
		fetchedAt: "2026-08-01T08:00:00Z",
		agedFrom: "fetchedAt" as const,
		sourceUpdatedAt: "2026-08-01T06:00:00Z",
		stale: false,
		staleReason: null,
	};
}

function firstCall<Args extends readonly unknown[]>(
	calls: ReadonlyArray<Args>,
): Args {
	const call = calls[0];
	if (call === undefined) {
		throw new Error("unreachable: mock has no recorded calls");
	}
	return call;
}

function makeStore(): WorkstationStore {
	return {
		open: vi.fn().mockResolvedValue(1),
		createCustomer: vi.fn(),
		getCustomer: vi.fn(),
		updateCustomer: vi.fn(),
		deleteCustomer: vi.fn(),
		recordMatches: vi.fn(),
		markScreened: vi.fn().mockResolvedValue(undefined),
		listReviewMatches: vi.fn().mockResolvedValue([]),
		resolveMatch: vi.fn(),
		listCustomers: vi.fn().mockResolvedValue([]),
		getSetting: vi.fn().mockResolvedValue(null),
		setSetting: vi.fn().mockResolvedValue(undefined),
	} as unknown as WorkstationStore;
}

function makeDeps(store: WorkstationStore): WorkstationDeps {
	const response: ScreenResponse = {
		request_id: "r",
		matches: [],
		list_versions_used: {},
		execution_time_ms: 1,
	};
	return {
		spawnStore: vi.fn(() => store),
		runtime: {
			bootstrap: vi.fn().mockResolvedValue({
				screen: vi.fn().mockResolvedValue(response),
			}),
			version: vi.fn(() => "watchlist-v-test"),
			fetchPublishedVersion: vi.fn().mockResolvedValue("watchlist-v-next"),
			reload: vi.fn().mockResolvedValue({
				screen: vi.fn().mockResolvedValue(response),
			}),
			catalogLists: vi
				.fn()
				.mockResolvedValue([
					catalogList("OFAC_SDN", "OFAC SDN"),
					catalogList("EU_CONSOLIDATED", "EU Consolidated"),
				]),
			catalogListIds: vi
				.fn()
				.mockResolvedValue(["OFAC_SDN", "EU_CONSOLIDATED"]),
			clearListCache: vi.fn().mockResolvedValue(undefined),
		},
	};
}

beforeEach(() => {
	resetWorkstationForTests();
});

describe("workstation boot", () => {
	it("opens the DB once and memoizes the handle", async () => {
		const store = makeStore();
		const deps = makeDeps(store);
		const first = await workstation(deps);
		const second = await workstation(deps);
		expect(first).toBe(second);
		expect(store.open).toHaveBeenCalledTimes(1);
		expect(deps.spawnStore).toHaveBeenCalledTimes(1);
	});

	it("does NOT bootstrap the engine during boot (lazy — review board needs no model)", async () => {
		const deps = makeDeps(makeStore());
		await workstation(deps);
		expect(deps.runtime.bootstrap).not.toHaveBeenCalled();
	});

	it("engineBoot and the screener share the memoized runtime bootstrap", async () => {
		const deps = makeDeps(makeStore());
		const handle = await workstation(deps);
		await handle.engineBoot();
		expect(deps.runtime.bootstrap).toHaveBeenCalledTimes(1);
	});

	it("exposes a RescanService over the same DB + screener", async () => {
		const handle = await workstation(makeDeps(makeStore()));
		expect(handle.rescan).toBeInstanceOf(RescanService);
	});

	it("watchlistVersion reflects the runtime's loaded version", async () => {
		const deps = makeDeps(makeStore());
		const handle = await workstation(deps);
		expect(handle.watchlistVersion()).toBe("watchlist-v-test");
		expect(deps.runtime.version).toHaveBeenCalled();
	});

	it("an onboarded customer is marked screened against the runtime's loaded lists", async () => {
		const store = makeStore();
		vi.mocked(store.createCustomer).mockResolvedValue({
			customer_id: "c-9",
		} as Awaited<ReturnType<WorkstationStore["createCustomer"]>>);
		const handle = await workstation(makeDeps(store));
		await handle.onboarding.onboard({ customer_reference: "R-9", name: "Ann" });
		expect(store.markScreened).toHaveBeenCalledWith("c-9", "watchlist-v-test");
	});

	it("fetchPublishedVersion + reloadWatchlist delegate to the runtime", async () => {
		const deps = makeDeps(makeStore());
		const handle = await workstation(deps);
		await expect(handle.fetchPublishedVersion()).resolves.toBe(
			"watchlist-v-next",
		);
		expect(deps.runtime.fetchPublishedVersion).toHaveBeenCalledTimes(1);
		await handle.reloadWatchlist();
		expect(deps.runtime.reload).toHaveBeenCalledTimes(1);
	});

	it("bootstrap reads the stored enabled set + screening config and passes them through", async () => {
		const store = makeStore();
		vi.mocked(store.getSetting).mockImplementation((key: string) => {
			if (key === "enabled_watchlists") {
				return Promise.resolve(JSON.stringify(["OFAC_SDN"]));
			}
			if (key === "screening_sensitivity") return Promise.resolve("strict");
			if (key === "screening_threshold_overrides") {
				return Promise.resolve(JSON.stringify({ OFAC_SDN: "lenient" }));
			}
			return Promise.resolve(null);
		});
		const deps = makeDeps(store);
		const handle = await workstation(deps);
		await handle.engineBoot();
		const [, , selection] = firstCall(
			vi.mocked(deps.runtime.bootstrap).mock.calls,
		);
		expect(selection?.enabledLists).toEqual(["OFAC_SDN"]);
		// strict default = 0.75; OFAC override lenient = 0.55.
		expect(selection?.thresholds).toEqual({
			default: 0.75,
			perList: { OFAC_SDN: 0.55 },
		});
	});

	it("bounds a fresh streaming workstation boot to OFAC when no list selection is stored", async () => {
		const deps = {
			...makeDeps(makeStore()),
			memoryPolicy: () => "streaming" as const,
		} as WorkstationDeps & { memoryPolicy: () => "eager" | "streaming" };
		const handle = await workstation(deps);
		await handle.engineBoot();
		const [, , selection] = firstCall(
			vi.mocked(deps.runtime.bootstrap).mock.calls,
		);
		expect(selection?.enabledLists).toEqual(["OFAC_SDN"]);
	});

	it("keeps the all-list default for an eager desktop workstation", async () => {
		const deps = {
			...makeDeps(makeStore()),
			memoryPolicy: () => "eager" as const,
		} as WorkstationDeps & { memoryPolicy: () => "eager" | "streaming" };
		const handle = await workstation(deps);
		await handle.engineBoot();
		const [, , selection] = firstCall(
			vi.mocked(deps.runtime.bootstrap).mock.calls,
		);
		expect(selection?.enabledLists).toBeUndefined();
	});

	it("uses bounded streaming residency on a constrained browser without changing the selected lists", async () => {
		const store = makeStore();
		vi.mocked(store.getSetting).mockImplementation((key: string) =>
			Promise.resolve(
				key === "enabled_watchlists" ? JSON.stringify(["OFAC_SDN"]) : null,
			),
		);
		const deps = {
			...makeDeps(store),
			memoryPolicy: () => "streaming" as const,
		} as WorkstationDeps & { memoryPolicy: () => "eager" | "streaming" };
		const handle = await workstation(deps);
		await handle.engineBoot();
		const [, , selection] = firstCall(
			vi.mocked(deps.runtime.bootstrap).mock.calls,
		);
		expect(selection?.enabledLists).toEqual(["OFAC_SDN"]);
		expect(selection?.residency).toBe("streaming");
	});

	it("keeps eager residency on a desktop policy for throughput", async () => {
		const deps = {
			...makeDeps(makeStore()),
			memoryPolicy: () => "eager" as const,
		} as WorkstationDeps & { memoryPolicy: () => "eager" | "streaming" };
		const handle = await workstation(deps);
		await handle.engineBoot();
		const [, , selection] = firstCall(
			vi.mocked(deps.runtime.bootstrap).mock.calls,
		);
		expect(selection?.residency).toBe("eager");
	});

	it("getEnabledLists returns the stored selection intersected with the catalog", async () => {
		const store = makeStore();
		vi.mocked(store.getSetting).mockImplementation((key: string) =>
			Promise.resolve(
				key === "enabled_watchlists"
					? JSON.stringify(["OFAC_SDN", "GONE"])
					: null,
			),
		);
		const handle = await workstation(makeDeps(store));
		await handle.engineBoot(); // catalog ids become known after a boot
		expect(await handle.getEnabledLists()).toEqual(["OFAC_SDN"]);
	});

	it("reads settings catalog and enabled lists without bootstrapping the model", async () => {
		const deps = {
			...makeDeps(makeStore()),
			memoryPolicy: () => "streaming" as const,
		} as WorkstationDeps & { memoryPolicy: () => "eager" | "streaming" };
		const handle = await workstation(deps);
		await expect(handle.catalogLists()).resolves.toHaveLength(2);
		await expect(handle.getEnabledLists()).resolves.toEqual(["OFAC_SDN"]);
		expect(deps.runtime.bootstrap).not.toHaveBeenCalled();
	});

	it("catalogLists delegates to the runtime, freshness intact", async () => {
		const deps = makeDeps(makeStore());
		const handle = await workstation(deps);
		await handle.engineBoot();
		expect(await handle.catalogLists()).toEqual([
			catalogList("OFAC_SDN", "OFAC SDN"),
			catalogList("EU_CONSOLIDATED", "EU Consolidated"),
		]);
	});

	it("clearListCache delegates to the runtime", async () => {
		const deps = makeDeps(makeStore());
		const handle = await workstation(deps);
		await handle.clearListCache();
		expect(deps.runtime.clearListCache).toHaveBeenCalledTimes(1);
	});

	it("serializes reload and clear-cache operations", async () => {
		const events: string[] = [];
		let releaseReload: (() => void) | undefined;
		const deps = makeDeps(makeStore());
		vi.mocked(deps.runtime.reload).mockImplementation(
			() =>
				new Promise((resolve) => {
					events.push("reload");
					releaseReload = () => resolve({ screen: vi.fn() });
				}),
		);
		vi.mocked(deps.runtime.clearListCache).mockImplementation(async () => {
			events.push("clear");
		});
		const handle = await workstation(deps);

		const reload = handle.reloadWatchlist();
		const clear = handle.clearListCache();
		await vi.waitFor(() => expect(events).toEqual(["reload"]));
		releaseReload?.();
		await Promise.all([reload, clear]);
		expect(events).toEqual(["reload", "clear"]);
	});

	it("serializes a settings apply before clear-cache", async () => {
		const events: string[] = [];
		let releaseApply: (() => void) | undefined;
		const deps = {
			...makeDeps(makeStore()),
			memoryPolicy: () => "eager" as const,
		} as WorkstationDeps & { memoryPolicy: () => "eager" | "streaming" };
		vi.mocked(deps.runtime.reload).mockImplementation(
			() =>
				new Promise((resolve) => {
					events.push("apply");
					releaseApply = () => resolve({ screen: vi.fn() });
				}),
		);
		vi.mocked(deps.runtime.clearListCache).mockImplementation(async () => {
			events.push("clear");
		});
		const handle = await workstation(deps);
		await handle.engineBoot();

		const apply = handle.setEnabledLists(["OFAC_SDN"]);
		const clear = handle.clearListCache();
		await vi.waitFor(() => expect(events).toEqual(["apply"]));
		releaseApply?.();
		await Promise.all([apply, clear]);
		expect(events).toEqual(["apply", "clear"]);
	});

	it("serializes a settings catalog read before clear-cache", async () => {
		const events: string[] = [];
		let releaseCatalog: (() => void) | undefined;
		const deps = makeDeps(makeStore());
		vi.mocked(deps.runtime.catalogLists).mockImplementation(
			() =>
				new Promise((resolve) => {
					events.push("catalog");
					releaseCatalog = () => resolve([catalogList("OFAC_SDN", "OFAC SDN")]);
				}),
		);
		vi.mocked(deps.runtime.clearListCache).mockImplementation(async () => {
			events.push("clear");
		});
		const handle = await workstation(deps);

		const read = handle.catalogLists();
		const clear = handle.clearListCache();
		await vi.waitFor(() => expect(events).toEqual(["catalog"]));
		releaseCatalog?.();
		await Promise.all([read, clear]);
		expect(events).toEqual(["catalog", "clear"]);
	});

	it("setEnabledLists persists the selection, re-bootstraps, and rescans on a real change", async () => {
		const store = makeStore();
		const deps = {
			...makeDeps(store),
			memoryPolicy: () => "eager" as const,
		} as WorkstationDeps & { memoryPolicy: () => "eager" | "streaming" };
		const handle = await workstation(deps);
		await handle.engineBoot();
		// Eager desktop default (unset) = all catalog ids; disabling EU_CONSOLIDATED is a change.
		const summary = await handle.setEnabledLists(["OFAC_SDN"]);
		expect(store.setSetting).toHaveBeenCalledWith(
			"enabled_watchlists",
			JSON.stringify(["OFAC_SDN"]),
		);
		// Re-bootstrap goes through the runtime reload (reuses the warm embedder).
		expect(deps.runtime.reload).toHaveBeenCalledTimes(1);
		const [selection] = firstCall(vi.mocked(deps.runtime.reload).mock.calls);
		expect(selection?.enabledLists).toEqual(["OFAC_SDN"]);
		// A real selection change triggers a re-screen (no customers → all zeros).
		expect(summary).toEqual({
			customersScanned: 0,
			newHits: 0,
			clearedHits: 0,
		});
	});

	it("setEnabledLists is a clean no-op when the set is unchanged", async () => {
		const store = makeStore();
		const deps = {
			...makeDeps(store),
			memoryPolicy: () => "eager" as const,
		} as WorkstationDeps & { memoryPolicy: () => "eager" | "streaming" };
		const handle = await workstation(deps);
		await handle.engineBoot();
		// Re-selecting all catalog ids matches the eager desktop default → no reload, no rescan.
		await handle.setEnabledLists(["EU_CONSOLIDATED", "OFAC_SDN"]);
		expect(deps.runtime.reload).not.toHaveBeenCalled();
		expect(store.setSetting).not.toHaveBeenCalled();
	});

	it("a failed DB open clears the memo so the next call retries", async () => {
		const store = makeStore();
		vi.mocked(store.open)
			.mockRejectedValueOnce(new Error("locked by another tab"))
			.mockResolvedValueOnce(1);
		const deps = makeDeps(store);
		await expect(workstation(deps)).rejects.toThrow(/locked/);
		await expect(workstation(deps)).resolves.toBeDefined();
		expect(store.open).toHaveBeenCalledTimes(2);
	});
});
