import type {
	EngineStorageOptions,
	EngineSyncOptions,
	SyncResult,
} from "@gainratio/browser";
import { describe, expect, it, vi } from "vitest";
import { type BundleEngineClient, openBundleSource } from "./bundleSource";
import { FRESH } from "./freshnessFixtures";

const CATALOG = new TextEncoder().encode(
	JSON.stringify({
		schemaVersion: 1,
		generatedAt: "2026-08-01T00:00:00Z",
		lists: [
			{
				id: "OFAC_SDN",
				title: "OFAC SDN",
				slug: "ofac",
				version: "2026-08-01",
				entitiesCount: 1,
				...FRESH,
			},
		],
	}),
);

const RESULT: SyncResult = {
	version: "2026-08-01",
	manifestHash: "0".repeat(64),
	chunksFetched: 0,
	chunksReused: 0,
	bytesFetched: 0,
};

describe("openBundleSource shared-engine contract", () => {
	it("uses scoped options, AML cache namespace, and filters chunk progress", async () => {
		const sync = vi.fn(
			(_baseUrl: string, _pubkeyUrl: string, options: EngineSyncOptions) => {
				options.onProgress?.({ phase: "pointer", version: "2026-08-01" });
				options.onProgress?.({
					phase: "chunks",
					fetchedChunks: 2,
					totalChunks: 5,
					bytesFetched: 128,
					bytesTotal: 640,
					bytesDone: 256,
				});
				return Promise.resolve(RESULT);
			},
		);
		const clear = vi.fn((_options?: EngineStorageOptions) => Promise.resolve());
		const client: BundleEngineClient = {
			sync,
			readFile: () => Promise.resolve(CATALOG),
			clear,
		};
		const progress = vi.fn();

		const source = await openBundleSource(
			"/bundle/origin",
			"/public.key",
			{ createClient: () => client },
			progress,
			["OFAC_SDN"],
		);

		expect(sync).toHaveBeenNthCalledWith(
			1,
			"/bundle/origin",
			"/public.key",
			expect.objectContaining({
				expectedBundleId: null,
				expectedChannel: null,
				wantedPaths: ["catalog.json"],
				cacheNamespace: "amlfilter-watchlists-v1",
				indexedDbLayout: {
					database: "aml-filter-signed-bundles-v1",
					store: "entries",
					separator: "/",
				},
			}),
		);
		expect(sync).toHaveBeenNthCalledWith(
			2,
			"/bundle/origin",
			"/public.key",
			expect.objectContaining({
				expectedBundleId: null,
				expectedChannel: null,
				wantedPaths: ["catalog.json", "ofac/"],
				cacheNamespace: "amlfilter-watchlists-v1",
				indexedDbLayout: {
					database: "aml-filter-signed-bundles-v1",
					store: "entries",
					separator: "/",
				},
			}),
		);
		expect(progress).toHaveBeenCalledTimes(1);
		expect(progress).toHaveBeenCalledWith({
			fetched: 2,
			total: 5,
			bytes: 128,
		});

		await source.clear();
		expect(clear).toHaveBeenCalledWith({
			cacheNamespace: "amlfilter-watchlists-v1",
			indexedDbLayout: {
				database: "aml-filter-signed-bundles-v1",
				store: "entries",
				separator: "/",
			},
		});
	});
});
