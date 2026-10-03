/** @vitest-environment node */

import { additive } from "@gainratio/assay";
import { generateSeedHex, publicKeyHex, signPayload } from "@gainratio/avow";
import { describe, expect, it } from "vitest";
import { calculateAssayScore } from "./assayScoring";
import {
	MatchScoreEvidenceInvalid,
	type MatchScoreSubject,
	matchScoreSubject,
	signMatchReceipt,
	verifyMatchReceipt,
} from "./scoreReceipt";

const EVIDENCE = calculateAssayScore(
	{
		name_vector: 0.8,
		name_sequence: 0.6,
		alias_match: 1,
		dob_match: 0.5,
		country_match: 0.25,
	},
	{
		name_vector: 0.55,
		name_sequence: 0.2,
		alias_match: 0.35,
		dob_match: 0.1,
		country_match: 0.05,
	},
);

const CONTEXT = {
	engineVersion: "4.0.0",
	watchlistVersion: "OFAC@2026.08.24",
	inputsHash:
		"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
};

describe("Assay-backed match score receipt", () => {
	it("seals the exact five-term Assay result with the policy decision", () => {
		const subject = matchScoreSubject(
			{
				score: EVIDENCE.score,
				tier: "STRONG",
				possibleThreshold: 0.65,
				assay: EVIDENCE,
			},
			CONTEXT,
		);

		expect(subject.assay?.method.version).toBe("amlfilter.additive.v2");
		expect(subject.assay?.inputs_hash).toBe(EVIDENCE.inputs_hash);
		expect(subject.assay?.components.map((component) => component.id)).toEqual([
			"name_vector",
			"name_sequence",
			"alias_match",
			"dob_match",
			"country_match",
		]);
	});

	it("rejects a valid signature over score evidence that disagrees with the score", async () => {
		const seed = generateSeedHex();
		const pinned = await publicKeyHex(seed);
		const subject = matchScoreSubject(
			{
				score: EVIDENCE.score,
				tier: "STRONG",
				possibleThreshold: 0.65,
				assay: EVIDENCE,
			},
			CONTEXT,
		);
		const inconsistent = {
			...subject,
			assay: { ...EVIDENCE, score: 0.01 },
		} as MatchScoreSubject;
		const receipt = await signPayload(inconsistent, seed);

		await expect(verifyMatchReceipt(receipt, pinned)).rejects.toBeInstanceOf(
			MatchScoreEvidenceInvalid,
		);
	});

	it("verifies an untampered Assay-backed receipt offline", async () => {
		const seed = generateSeedHex();
		const pinned = await publicKeyHex(seed);
		const subject = matchScoreSubject(
			{
				score: EVIDENCE.score,
				tier: "STRONG",
				possibleThreshold: 0.65,
				assay: EVIDENCE,
			},
			CONTEXT,
		);

		await expect(
			verifyMatchReceipt(await signMatchReceipt(subject, seed), pinned),
		).resolves.toBeUndefined();
	});

	it("rejects a valid signature over a different additive formula", async () => {
		const seed = generateSeedHex();
		const pinned = await publicKeyHex(seed);
		const forgedEvidence = additive({
			method: "additive",
			method_version: "amlfilter.additive.v2",
			clamp: null,
			intercept: 0.95,
			terms: EVIDENCE.components.map((component) => ({
				id: component.id,
				label: component.id,
				value: 0,
				coefficient: 0,
				operation: "add" as const,
				interval: null,
			})),
		});
		const forged = {
			...matchScoreSubject(
				{
					score: EVIDENCE.score,
					tier: "STRONG",
					possibleThreshold: 0.65,
					assay: EVIDENCE,
				},
				CONTEXT,
			),
			score: forgedEvidence.score,
			tier: "WEAK",
			possible_threshold: 0.3,
			assay: forgedEvidence,
		} as MatchScoreSubject;

		await expect(
			verifyMatchReceipt(await signPayload(forged, seed), pinned),
		).rejects.toBeInstanceOf(MatchScoreEvidenceInvalid);
	});

	it("rejects impossible tiers and missing policy thresholds", async () => {
		const seed = generateSeedHex();
		const pinned = await publicKeyHex(seed);
		const subject = matchScoreSubject(
			{
				score: EVIDENCE.score,
				tier: "STRONG",
				possibleThreshold: 0.65,
				assay: EVIDENCE,
			},
			CONTEXT,
		);
		const impossible = {
			...subject,
			tier: "WEAK",
			assay: EVIDENCE,
		} as MatchScoreSubject;

		await expect(
			verifyMatchReceipt(await signPayload(impossible, seed), pinned),
		).rejects.toBeInstanceOf(MatchScoreEvidenceInvalid);
	});

	it("rejects wrong AML discriminants and empty versions", async () => {
		const seed = generateSeedHex();
		const pinned = await publicKeyHex(seed);
		const subject = matchScoreSubject(
			{
				score: EVIDENCE.score,
				tier: "STRONG",
				possibleThreshold: 0.65,
				assay: EVIDENCE,
			},
			CONTEXT,
		);
		const wrongPolicy = {
			...subject,
			kind: "not.aml",
			engine: "other",
			engine_version: "",
			watchlist_version: "",
		} as unknown as MatchScoreSubject;

		await expect(
			verifyMatchReceipt(await signPayload(wrongPolicy, seed), pinned),
		).rejects.toBeInstanceOf(MatchScoreEvidenceInvalid);
	});

	it("rejects a valid signature that omits current Assay proof", async () => {
		const seed = generateSeedHex();
		const pinned = await publicKeyHex(seed);
		// Omit the keys outright. avow >= 0.5 refuses `undefined` anywhere in a
		// payload (it is not JSON), where 0.4 silently dropped such keys.
		const {
			assay: _assay,
			possible_threshold: _threshold,
			...unproved
		} = matchScoreSubject(
			{
				score: EVIDENCE.score,
				tier: "STRONG",
				possibleThreshold: 0.65,
				assay: EVIDENCE,
			},
			CONTEXT,
		) as MatchScoreSubject & { possible_threshold?: number };

		await expect(
			verifyMatchReceipt(await signPayload(unproved, seed), pinned),
		).rejects.toBeInstanceOf(MatchScoreEvidenceInvalid);
	});

	it.each([
		["forged inputs hash", { inputs_hash: `sha256:${"0".repeat(64)}` }],
		[
			"out-of-range raw signal",
			{
				components: EVIDENCE.components.map((component, index) =>
					index === 0 ? { ...component, raw: 1.1 } : component,
				),
			},
		],
		[
			"drifted interval",
			{
				components: EVIDENCE.components.map((component, index) =>
					index === 0
						? {
								...component,
								contribution_interval: { low: 0.1, high: 0.2 },
							}
						: component,
				),
			},
		],
	] as const)(
		"rejects validly signed evidence with %s",
		async (_name, patch) => {
			const seed = generateSeedHex();
			const pinned = await publicKeyHex(seed);
			const subject = matchScoreSubject(
				{
					score: EVIDENCE.score,
					tier: "STRONG",
					possibleThreshold: 0.65,
					assay: EVIDENCE,
				},
				CONTEXT,
			);
			const forged = {
				...subject,
				assay: { ...EVIDENCE, ...patch },
			} as MatchScoreSubject;

			await expect(
				verifyMatchReceipt(await signPayload(forged, seed), pinned),
			).rejects.toBeInstanceOf(MatchScoreEvidenceInvalid);
		},
	);
});
