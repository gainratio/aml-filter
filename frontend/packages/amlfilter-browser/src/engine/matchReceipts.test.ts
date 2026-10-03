// The sealer's own contract: what it stamps, what it hashes, and the two cases
// where it deliberately produces nothing.

import { publicKeyHex } from "@gainratio/avow";
import { describe, expect, it, vi } from "vitest";
import { calculateAssayScore } from "./assayScoring";
import type { Match, ScreenQuery } from "./domain";
import { INSTALL_SEED_KEY, type KeyStorage } from "./installKey";
import {
	createMatchReceiptSealer,
	inputsHash,
	type SealContext,
} from "./matchReceipts";
import { ScoreOutOfRange, verifyMatchReceipt } from "./scoreReceipt";
import { PRESETS } from "./scoring";
import { ENGINE_VERSION } from "./version";

const SEED = "cd".repeat(32);
const DEFAULT_EVIDENCE = calculateAssayScore(
	{
		name_vector: 0.8,
		name_sequence: 0.6,
		alias_match: 1,
		dob_match: 0,
		country_match: 0,
	},
	PRESETS.balanced.weights,
);
const SEVENTY_EVIDENCE = calculateAssayScore(
	{
		name_vector: 7 / 11,
		name_sequence: 0,
		alias_match: 1,
		dob_match: 0,
		country_match: 0,
	},
	PRESETS.balanced.weights,
);

function storageWithSeed(seed: string = SEED): KeyStorage {
	const map = new Map<string, string>([[INSTALL_SEED_KEY, seed]]);
	return {
		getItem: (k) => map.get(k) ?? null,
		setItem: (k, v) => {
			map.set(k, v);
		},
	};
}

function match(overrides: Partial<Match> = {}): Match {
	return {
		entity_id: "OFAC:1",
		score: DEFAULT_EVIDENCE.score,
		score_evidence: DEFAULT_EVIDENCE,
		entity_type: "PERSON",
		risk_category: "SANCTION",
		source_list: "ofac",
		list_version: "2026.06.09",
		primary_name: "Ivan Fako",
		aliases: [],
		countries: ["RU"],
		nationalities: [],
		dob: [],
		addresses: [],
		identifiers: { passport: [], national_id: [], other: {} },
		reasons: [],
		explanation: "exact canonical name match",
		...overrides,
	};
}

const QUERY: ScreenQuery = { name: "ivan fako", country: "RU" };

function context(overrides: Partial<SealContext> = {}): SealContext {
	return {
		query: QUERY,
		listVersions: { ofac: "2026.06.09" },
		possibleThresholdFor: () => 0.65,
		...overrides,
	};
}

describe("createMatchReceiptSealer", () => {
	it("stamps engine version, list version, and the derived tier", async () => {
		const sealer = createMatchReceiptSealer(storageWithSeed());

		const [sealed] = await sealer.seal([match()], context());

		expect(sealed?.score_receipt?.payload).toMatchObject({
			kind: "aml.match_score",
			engine: "amlfilter-sequenceMatcher",
			engine_version: ENGINE_VERSION,
			watchlist_version: "ofac@2026.06.09",
			score: 0.91,
			tier: "STRONG",
		});
	});

	it("tiers each match against ITS OWN list floor, not a global one", async () => {
		const sealer = createMatchReceiptSealer(storageWithSeed());
		const strict = match({
			entity_id: "A:1",
			source_list: "strict",
			score: SEVENTY_EVIDENCE.score,
			score_evidence: SEVENTY_EVIDENCE,
		});
		const loose = match({
			entity_id: "B:1",
			source_list: "loose",
			score: SEVENTY_EVIDENCE.score,
			score_evidence: SEVENTY_EVIDENCE,
		});

		const sealed = await sealer.seal(
			[strict, loose],
			context({
				possibleThresholdFor: (m) => (m.source_list === "strict" ? 0.75 : 0.6),
			}),
		);

		// Same score, different floors → WEAK under the strict list, POSSIBLE under
		// the loose one. A single global threshold could not produce this.
		expect(sealed[0]?.score_receipt?.payload.tier).toBe("WEAK");
		expect(sealed[1]?.score_receipt?.payload.tier).toBe("POSSIBLE");
	});

	it("signs under the persisted install key so receipts verify", async () => {
		const sealer = createMatchReceiptSealer(storageWithSeed());

		const [sealed] = await sealer.seal([match()], context());
		const receipt = sealed?.score_receipt;
		if (receipt === undefined) {
			throw new Error("expected a receipt");
		}

		await expect(
			verifyMatchReceipt(receipt, await publicKeyHex(SEED)),
		).resolves.toBeUndefined();
	});

	it("seals the effective screen threshold independently of the weight preset", async () => {
		const evidence = calculateAssayScore(
			{
				name_vector: 0.8,
				name_sequence: 0.6,
				alias_match: 1,
				dob_match: 0,
				country_match: 0,
			},
			PRESETS.balanced.weights,
		);
		const sealer = createMatchReceiptSealer(storageWithSeed());

		const [sealed] = await sealer.seal(
			[match({ score: evidence.score, score_evidence: evidence })],
			context({ possibleThresholdFor: () => 0.3 }),
		);

		expect(sealed?.score_receipt?.payload.possible_threshold).toBe(0.3);
	});

	it("resolves the install key ONCE across repeated screens", async () => {
		let reads = 0;
		const inner = storageWithSeed();
		const counting: KeyStorage = {
			getItem: (k) => {
				reads += 1;
				return inner.getItem(k);
			},
			setItem: (k, v) => inner.setItem(k, v),
		};
		const sealer = createMatchReceiptSealer(counting);

		await sealer.seal([match()], context());
		await sealer.seal([match()], context());

		expect(reads).toBe(1);
	});

	it("produces NO receipts when the tab has no usable storage", async () => {
		const sealer = createMatchReceiptSealer(null);

		const sealed = await sealer.seal([match()], context());

		// Documented: provenance is unavailable, but the screen still returns.
		expect(sealed[0]?.score_receipt).toBeUndefined();
		expect(sealed).toHaveLength(1);
	});

	it("returns matches without receipts when storage becomes unavailable", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const sealer = createMatchReceiptSealer({
			getItem: () => {
				throw new DOMException("storage blocked", "SecurityError");
			},
			setItem: () => undefined,
		});

		const sealed = await sealer.seal([match()], context());

		expect(sealed).toHaveLength(1);
		expect(sealed[0]?.score_receipt).toBeUndefined();
		expect(warn).toHaveBeenCalledWith(
			"amlfilter.match_receipts.unavailable",
			expect.objectContaining({ error: expect.any(String) }),
		);
		warn.mockRestore();
	});

	it("does not hide an impossible engine score behind the provenance fallback", async () => {
		const sealer = createMatchReceiptSealer(storageWithSeed());

		await expect(
			sealer.seal([match({ score: 1.5 })], context()),
		).rejects.toBeInstanceOf(ScoreOutOfRange);
	});

	it("short-circuits an empty match set without touching the key", async () => {
		const sealer = createMatchReceiptSealer({
			getItem: () => {
				throw new Error("must not read the key for zero matches");
			},
			setItem: () => undefined,
		});

		await expect(sealer.seal([], context())).resolves.toEqual([]);
	});
});

describe("retrieval provenance stays out of the signed receipt", () => {
	it("signs the identical payload whatever channels reached the match", async () => {
		const sealer = createMatchReceiptSealer(storageWithSeed());
		const [bare] = await sealer.seal([match()], context());
		const [phonetic] = await sealer.seal(
			[match({ retrieved_via: ["phonetic"] })],
			context(),
		);
		const [all] = await sealer.seal(
			[match({ retrieved_via: ["vector", "token", "phonetic"] })],
			context(),
		);

		expect(phonetic?.score_receipt?.payload).toEqual(
			bare?.score_receipt?.payload,
		);
		expect(all?.score_receipt?.payload).toEqual(bare?.score_receipt?.payload);
		expect(JSON.stringify(all?.score_receipt?.payload)).not.toContain(
			"retrieved_via",
		);
		// The sealer passes provenance through untouched for display.
		expect(phonetic?.retrieved_via).toEqual(["phonetic"]);
	});

	it("keeps the inputs hash independent of provenance", async () => {
		expect(
			await inputsHash(match({ retrieved_via: ["phonetic"] }), QUERY),
		).toBe(await inputsHash(match(), QUERY));
	});
});

describe("inputsHash", () => {
	it("is a sha256 over the screened identity pair", async () => {
		expect(await inputsHash(match(), QUERY)).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	it("is stable for the same pair and distinct for a different one", async () => {
		const base = await inputsHash(match(), QUERY);

		expect(await inputsHash(match(), QUERY)).toBe(base);
		expect(await inputsHash(match({ entity_id: "OFAC:2" }), QUERY)).not.toBe(
			base,
		);
		expect(await inputsHash(match(), { ...QUERY, dob: "1980-01-01" })).not.toBe(
			base,
		);
	});
});
