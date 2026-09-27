// Does the list selection actually reach the sync?
//
// It did not. `RuntimeSelection.enabledLists` existed and was honoured — but only
// in `#loadEnabledLists` / `#loadStreamingSources`, which run AFTER
// `openBundleSource` has already delta-synced the entire bundle. /screen has
// passed `enabledLists: ["OFAC_SDN"]` since it shipped and still downloaded EU,
// UK and UN on every cold boot: 527 of 1,296 chunks, 18.4 MB of 46.7 MB,
// measured against the live 2026-08-01 bundle.
//
// These tests assert the wiring at the seam where it was missing — what the
// runtime ASKS the bundle source for — rather than what the engine ends up
// holding, which was already correct and is exactly why nothing caught this.

import { describe, expect, it } from "vitest";
import type { BundleSource } from "./bundleSource";
import { FRESH_RESOLVED } from "./freshnessFixtures";
import { EngineRuntime, type RuntimeDeps } from "./runtime";
import type { LoadedWatchlist, WatchlistCatalog } from "./watchlist";

const CATALOG: WatchlistCatalog = {
	schema: 1,
	generatedAt: "2026-08-01T00:00:00Z",
	lists: [
		{
			id: "OFAC_SDN",
			title: "OFAC SDN",
			version: "2026-08-01",
			entitiesCount: 19_181,
			path: "ofac/",
			...FRESH_RESOLVED,
		},
		{
			id: "EU_CONSOLIDATED",
			title: "EU Consolidated",
			version: "2026-08-01",
			entitiesCount: 5_000,
			path: "eu/",
			...FRESH_RESOLVED,
		},
		{
			id: "UK_OFSI",
			title: "UK OFSI",
			version: "2026-08-01",
			entitiesCount: 4_000,
			path: "uk/",
			...FRESH_RESOLVED,
		},
		{
			id: "UN_CONSOLIDATED",
			title: "UN Consolidated",
			version: "2026-08-01",
			entitiesCount: 1_000,
			path: "un/",
			...FRESH_RESOLVED,
		},
	],
};

function emptyList(id: string): LoadedWatchlist {
	return {
		listId: id,
		version: "2026-08-01",
		entities: [],
		vectors: new Float32Array(0),
		dim: 8,
	} as unknown as LoadedWatchlist;
}

/** Records the `enabledLists` argument every `openBundleSource` call receives. */
function depsRecording(
	seen: Array<ReadonlyArray<string> | undefined>,
): RuntimeDeps {
	const source: BundleSource = {
		loadCatalog: () => CATALOG,
		loadList: (entry) => Promise.resolve(emptyList(entry.id)),
		loadListMetadata: (entry) =>
			Promise.resolve({
				listId: entry.id,
				version: entry.version,
				entities: [],
			} as never),
		version: () => "2026-08-01",
		clear: () => Promise.resolve(),
		dispose: () => undefined,
	};
	return {
		makeEmbedder: () =>
			({
				embed: () => Promise.resolve(new Float32Array(8)),
				dispose: () => undefined,
			}) as never,
		clearCache: () => Promise.resolve(),
		openBundleSource: (
			_baseUrl,
			_pubkeyUrl,
			_deps,
			_onProgress,
			enabledLists,
		) => {
			seen.push(enabledLists);
			return Promise.resolve(source);
		},
	};
}

const CONFIG = {
	bundleBaseUrl: "/bundle/origin",
	pubkeyUrl: "/public.key",
} as const;

describe("EngineRuntime hands the list selection to the sync", () => {
	it("asks for ONLY the selected list at boot", async () => {
		const seen: Array<ReadonlyArray<string> | undefined> = [];
		const runtime = new EngineRuntime(depsRecording(seen));

		await runtime.bootstrap(CONFIG, undefined, {
			enabledLists: ["OFAC_SDN"],
			residency: "streaming",
		});

		expect(seen).toEqual([["OFAC_SDN"]]);
	});

	it("widens the request when a list is enabled later", async () => {
		const seen: Array<ReadonlyArray<string> | undefined> = [];
		const runtime = new EngineRuntime(depsRecording(seen));

		await runtime.bootstrap(CONFIG, undefined, {
			enabledLists: ["OFAC_SDN"],
			residency: "streaming",
		});
		await runtime.reload({
			enabledLists: ["OFAC_SDN", "EU_CONSOLIDATED"],
			residency: "streaming",
		});

		// The second open carries the wider set. Nothing re-downloads what is
		// already local — the store is content-addressed, so the widened sync is a
		// top-up (proven by bundleSource.scoped.test.ts).
		expect(seen).toEqual([["OFAC_SDN"], ["OFAC_SDN", "EU_CONSOLIDATED"]]);
	});

	it("keeps 'no selection expressed' meaning every list", async () => {
		// Absent enabledLists must still sync the whole bundle — other callers and
		// the workstation path depend on it, and quietly narrowing it would be a
		// silent data loss, not an optimisation.
		const seen: Array<ReadonlyArray<string> | undefined> = [];
		const runtime = new EngineRuntime(depsRecording(seen));

		await runtime.bootstrap(CONFIG, undefined, { residency: "streaming" });

		expect(seen).toEqual([undefined]);
	});

	it("polls the published version without pulling any list payload", async () => {
		const seen: Array<ReadonlyArray<string> | undefined> = [];
		const runtime = new EngineRuntime(depsRecording(seen));
		await runtime.bootstrap(CONFIG, undefined, {
			enabledLists: ["OFAC_SDN"],
			residency: "streaming",
		});
		seen.length = 0;

		await runtime.fetchPublishedVersion();

		// An EMPTY selection, not `undefined`: the poll reads catalog.json only.
		// `undefined` here would re-sync all four lists on every poll.
		expect(seen).toEqual([[]]);
	});
});

// The landing page states the live list counts. Reading them must not download
// every list: an EMPTY selection syncs the signed catalog alone (pointer +
// manifest + catalog chunk, ~123 KB on production instead of ~58 MB).
describe("EngineRuntime.catalogOnlyLists", () => {
	it("syncs the catalog alone and returns every list's metadata", async () => {
		const seen: Array<ReadonlyArray<string> | undefined> = [];
		const runtime = new EngineRuntime(depsRecording(seen));

		const lists = await runtime.catalogOnlyLists(CONFIG);

		expect(seen).toEqual([[]]);
		expect(lists.map((list) => [list.id, list.entitiesCount])).toEqual([
			["OFAC_SDN", 19_181],
			["EU_CONSOLIDATED", 5_000],
			["UK_OFSI", 4_000],
			["UN_CONSOLIDATED", 1_000],
		]);
	});

	it("does not leave a catalog-only source behind for a later boot", async () => {
		const seen: Array<ReadonlyArray<string> | undefined> = [];
		const runtime = new EngineRuntime(depsRecording(seen));

		await runtime.catalogOnlyLists(CONFIG);
		await runtime.bootstrap(CONFIG, undefined, {
			enabledLists: ["OFAC_SDN"],
			residency: "streaming",
		});

		expect(seen).toEqual([[], ["OFAC_SDN"]]);
	});
});
