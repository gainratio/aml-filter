// INTEGRATION: does the real screening path actually seal its scores?
//
// scoreReceipt.ts can be unit-tested green while no production code ever calls
// it — a receipt module nobody invokes attests nothing. So these tests refuse to
// hand-construct a signer. They drive the REAL production construction paths —
// createMultiListScreeningEngine, createStreamingMultiListScreeningEngine, and
// EngineRuntime.bootstrap() itself — with nothing but a pre-seeded install key,
// then assert a verifiable receipt fell out the other side.
//
// The seed starts where the previous release kept it (localStorage), so every
// boot here also runs the real migration into the SQLite install_key row. jsdom
// has no Worker, so the SQL seam is backed by real in-memory SQLite.
//
// If the wiring is ever removed, these fail on a missing receipt.

import { publicKeyHex } from "@gainratio/avow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BundleSource } from "./bundleSource";
import type { Embedder } from "./embedder";
import { FRESH_RESOLVED } from "./freshnessFixtures";
import { INSTALL_SEED_KEY } from "./installKey";
import {
	createMultiListScreeningEngine,
	createStreamingMultiListScreeningEngine,
	type ListThresholds,
} from "./multiEngine";
import { EngineRuntime, type RuntimeConfig, type RuntimeDeps } from "./runtime";
import { verifyMatchReceipt } from "./scoreReceipt";
import { classifyTier, STRONG_TIER_FLOOR } from "./tiering";
import {
	buildLoadedWatchlist,
	type Watchlist,
	type WatchlistCatalog,
} from "./watchlist";

vi.mock("@gainratio/browser/sql", async () => {
	const { memoryInstallKeySql } = await import(
		"../testing/memoryInstallKeySql"
	);
	const sql = await memoryInstallKeySql();
	return { openSqlDatabase: sql.open };
});

const DIM = 384;
// A fixed install seed so the pinned verify key is deterministic. The engine
// migrates it out of localStorage exactly as it does for a returning visitor.
const SEED = "ab".repeat(32);

/** A single-entity list whose sole entity sits on axis 0 (an exact vector hit). */
function oneEntityList(listId: string, version: string): Watchlist {
	const matrix = new Float32Array(DIM);
	matrix[0] = 1;
	return {
		listId,
		version,
		generatedAt: "2026-06-19T00:00:00Z",
		model: "Xenova/all-MiniLM-L6-v2",
		dim: DIM,
		entities: [
			{
				entity_id: `${listId}:1`,
				name_canonical: "ivan fako",
				aliases: [],
				dob: null,
				countries: ["RU"],
				risk_category: "SANCTION",
				source_list: listId,
				list_version: version,
			},
		],
		vectors: Buffer.from(matrix.buffer).toString("base64"),
	};
}

/** A stub embedder returning the axis-0 direction — an exact hit, no model download. */
function axisZeroEmbedder(): Embedder {
	return {
		embed(): Promise<Float32Array> {
			const v = new Float32Array(DIM);
			v[0] = 1;
			return Promise.resolve(v);
		},
	};
}

const THRESHOLDS: ListThresholds = { default: 0.65 };
const QUERY = { name: "ivan fako", country: "RU", threshold: 0.65 };

beforeEach(() => {
	localStorage.clear();
	localStorage.setItem(INSTALL_SEED_KEY, SEED);
});

describe("production screening path carries a verifiable score receipt", () => {
	it("seals EVERY returned match into a receipt that verifies under the install key", async () => {
		const engine = createMultiListScreeningEngine(
			[buildLoadedWatchlist(oneEntityList("A", "v1"))],
			axisZeroEmbedder(),
			THRESHOLDS,
		);
		const pinned = await publicKeyHex(SEED);

		const response = await engine.screen(QUERY);

		expect(response.matches.length).toBeGreaterThan(0);
		for (const match of response.matches) {
			const receipt = match.score_receipt;
			// The wiring assertion: the engine must have produced this, not a test.
			expect(receipt).toBeDefined();
			if (receipt === undefined) {
				throw new Error("unreachable");
			}
			expect(receipt.payload.kind).toBe("aml.match_score");
			expect(receipt.payload.score).toBe(match.score);
			expect(receipt.payload.inputs_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
			// Verify against the PINNED install key: rejects an altered payload or
			// a swapped signer. Tamper-EVIDENCE, not proof the host was clean.
			await expect(
				verifyMatchReceipt(receipt, pinned),
			).resolves.toBeUndefined();
		}
	});

	it("stamps the tier and the screened list version into the signed subject", async () => {
		const engine = createMultiListScreeningEngine(
			[buildLoadedWatchlist(oneEntityList("A", "v7"))],
			axisZeroEmbedder(),
			THRESHOLDS,
		);

		const [match] = (await engine.screen(QUERY)).matches;
		const receipt = match?.score_receipt;
		expect(receipt).toBeDefined();
		if (match === undefined || receipt === undefined) {
			throw new Error("unreachable");
		}

		expect(receipt.payload.watchlist_version).toBe("A@v7");
		expect(receipt.payload.tier).toBe(
			classifyTier(match.score, 0.65, STRONG_TIER_FLOOR),
		);
	});

	it("binds the receipt to its inputs — a different name yields a different hash", async () => {
		const engine = createMultiListScreeningEngine(
			[buildLoadedWatchlist(oneEntityList("A", "v1"))],
			axisZeroEmbedder(),
			THRESHOLDS,
		);

		const first = (await engine.screen(QUERY)).matches[0]?.score_receipt;
		const second = (await engine.screen({ ...QUERY, name: "ivan fakoo" }))
			.matches[0]?.score_receipt;

		expect(first?.payload.inputs_hash).toBeDefined();
		expect(second?.payload.inputs_hash).toBeDefined();
		expect(second?.payload.inputs_hash).not.toBe(first?.payload.inputs_hash);
	});

	it("seals receipts on the STREAMING (bounded-residency) path too", async () => {
		const loaded = buildLoadedWatchlist(oneEntityList("S", "v2"));
		const engine = createStreamingMultiListScreeningEngine(
			[
				{
					listId: "S",
					version: "v2",
					entities: new Map(),
					load: () =>
						Promise.resolve(buildLoadedWatchlist(oneEntityList("S", "v2"))),
				},
			],
			axisZeroEmbedder(),
			THRESHOLDS,
		);
		const pinned = await publicKeyHex(SEED);
		expect(loaded.listId).toBe("S");

		const response = await engine.screen(QUERY);

		expect(response.matches.length).toBeGreaterThan(0);
		const receipt = response.matches[0]?.score_receipt;
		expect(receipt).toBeDefined();
		if (receipt === undefined) {
			throw new Error("unreachable");
		}
		await expect(verifyMatchReceipt(receipt, pinned)).resolves.toBeUndefined();
	});
});

// The strongest form of the wiring claim: not "the factory seals", but "the
// documented primary entry point seals". EngineRuntime.bootstrap() is what the
// SPA actually calls, so this drives it end to end over a faked (but real-shaped)
// signed bundle source and checks a receipt survives all the way out.
describe("EngineRuntime.bootstrap() — the documented entry point", () => {
	const CONFIG: RuntimeConfig = {
		pubkeyUrl: "https://app.example/public.key",
		bundleBaseUrl: "/bundle/origin",
	};

	const CATALOG: WatchlistCatalog = {
		schema: 1,
		generatedAt: "2026-06-19T00:00:00Z",
		lists: [
			{
				id: "OFAC_SDN",
				title: "OFAC_SDN",
				version: "demo-1",
				entitiesCount: 1,
				path: "ofac_sdn/",
				...FRESH_RESOLVED,
			},
		],
	};

	function bundleSource(): BundleSource {
		return {
			loadCatalog: () => CATALOG,
			loadList: () =>
				Promise.resolve(
					buildLoadedWatchlist(oneEntityList("OFAC_SDN", "demo-1")),
				),
			version: () => "fake",
			clear: () => Promise.resolve(),
			dispose: () => {},
		};
	}

	function deps(): RuntimeDeps {
		return {
			makeEmbedder: () => axisZeroEmbedder(),
			clearCache: () => Promise.resolve(),
			openBundleSource: () => Promise.resolve(bundleSource()),
		};
	}

	it("returns an engine whose screens carry verifiable receipts", async () => {
		// The bundle source is faked, so nothing reaches the network; stub fetch
		// defensively so a stray same-origin read cannot hit it either.
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(new Response("", { status: 200 }))),
		);
		const runtime = new EngineRuntime(deps());
		const pinned = await publicKeyHex(SEED);

		const engine = await runtime.bootstrap(CONFIG);
		const response = await engine.screen(QUERY);

		expect(response.matches.length).toBeGreaterThan(0);
		const receipt = response.matches[0]?.score_receipt;
		expect(receipt).toBeDefined();
		if (receipt === undefined) {
			throw new Error("unreachable");
		}
		expect(receipt.payload.kind).toBe("aml.match_score");
		expect(receipt.payload.watchlist_version).toBe("OFAC_SDN@demo-1");
		await expect(verifyMatchReceipt(receipt, pinned)).resolves.toBeUndefined();

		vi.unstubAllGlobals();
	});
});
