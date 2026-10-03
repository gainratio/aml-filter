/**
 * @vitest-environment node
 *
 * WHY THIS ONE FILE OPTS OUT OF THE PACKAGE-WIDE jsdom ENVIRONMENT
 *
 * This suite is pure Ed25519 signing/verification — it touches no DOM, no
 * IndexedDB, no OPFS. Running it under jsdom does not make it more browser-like;
 * it makes it STRICTLY LESS faithful, because jsdom introduces a second
 * JavaScript realm that a real browser never has.
 *
 * The concrete failure jsdom caused (CI run 29797592065, three tests):
 *
 *   TypeError: Failed to execute 'digest' on 'SubtleCrypto': 2nd argument is
 *   not instance of ArrayBuffer, Buffer, TypedArray, or DataView.
 *     ❯ sha512Async @noble/ed25519@3.1.0/index.js:793
 *
 * @noble/ed25519 hashes via `subtle.digest('SHA-512', m.buffer)` — it passes a
 * bare ArrayBuffer (index.js:793). Under vitest's jsdom environment the test
 * realm's `ArrayBuffer` comes from the jsdom VM context, while `globalThis.
 * crypto.subtle` is Node's native `webcrypto.subtle` (verified: `crypto.subtle
 * === require('node:crypto').webcrypto.subtle` is true, and `Buffer.from([1])
 * instanceof Uint8Array` is FALSE — proof of the realm split). Node 22's
 * WebCrypto brand-check rejects that cross-realm ArrayBuffer.
 *
 * It is a HARNESS artifact, not a product defect, on three counts:
 *   1. A real browser has ONE realm, so `m.buffer` is always same-realm there.
 *   2. Node 24 accepts the cross-realm ArrayBuffer; Node 22.13.0 (frontend/
 *      .nvmrc, what CI installs) rejects it. Same commit, same lockfile — the
 *      Node version alone flips the result. That version skew is exactly why
 *      this passed on every local run and failed the moment CI executed it.
 *   3. Cross-realm *TypedArrays* are accepted on both; only the bare
 *      ArrayBuffer trips it. Nothing in this repo constructs that buffer —
 *      it is allocated and passed entirely inside @noble/ed25519.
 *
 * So there is no realm-safe buffer for aml-filter code to pass: the fix belongs
 * at the harness layer, and `node` is the environment whose single-realm shape
 * actually matches the browser for this module. The assertions below are
 * unchanged — nothing is skipped, loosened, or stubbed.
 *
 * Real-browser coverage is a SEPARATE obligation and is NOT satisfied by this
 * file. See the note in ./scoreReceipt.ts.
 */
import {
	generateSeedHex,
	publicKeyHex,
	ReceiptSchemaMismatch,
	SignatureInvalid,
	signPayload,
} from "@gainratio/avow";
import { describe, expect, it } from "vitest";
import { calculateAssayScore } from "./assayScoring";
import {
	InputsHashInvalid,
	MatchScoreEvidenceInvalid,
	type MatchScoreInput,
	type MatchScoreSubject,
	matchScoreSubject,
	ScoreOutOfRange,
	type ScoreReceiptContext,
	signMatchReceipt,
	verifyMatchReceipt,
} from "./scoreReceipt";
import { PRESETS } from "./scoring";

const EVIDENCE = calculateAssayScore(
	{
		name_vector: 0.8,
		name_sequence: 0.6,
		alias_match: 1,
		dob_match: 0,
		country_match: 0,
	},
	PRESETS.balanced.weights,
);
const MATCH: MatchScoreInput = {
	score: EVIDENCE.score,
	tier: "STRONG",
	possibleThreshold: 0.65,
	assay: EVIDENCE,
};
const CONTEXT: ScoreReceiptContext = {
	engineVersion: "4.0.0",
	watchlistVersion: "2026.06.09",
	inputsHash:
		"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

describe("matchScoreSubject", () => {
	it("carries the app-computed score, tier, and screening context verbatim", () => {
		const subject = matchScoreSubject(MATCH, CONTEXT);
		expect(subject).toMatchObject({
			kind: "aml.match_score",
			engine: "amlfilter-sequenceMatcher",
			engine_version: "4.0.0",
			watchlist_version: "2026.06.09",
			inputs_hash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			score: EVIDENCE.score,
			tier: "STRONG",
			possible_threshold: 0.65,
			assay: EVIDENCE,
		});
	});

	it("is a pure function of its inputs (byte-identical subjects re-run)", () => {
		expect(matchScoreSubject(MATCH, CONTEXT)).toEqual(
			matchScoreSubject(MATCH, CONTEXT),
		);
	});
});

describe("signMatchReceipt + verifyMatchReceipt", () => {
	it("seals a score into a receipt that verifies offline under the pinned key", async () => {
		const seed = generateSeedHex();
		const pinned = await publicKeyHex(seed);
		const receipt = await signMatchReceipt(
			matchScoreSubject(MATCH, CONTEXT),
			seed,
		);

		expect(receipt.public_key).toBe(pinned);
		expect(receipt.payload.score).toBe(EVIDENCE.score);
		await expect(verifyMatchReceipt(receipt, pinned)).resolves.toBeUndefined();
	});

	it("REJECTS a tampered score before granting semantic verification", async () => {
		const seed = generateSeedHex();
		const pinned = await publicKeyHex(seed);
		const receipt = await signMatchReceipt(
			matchScoreSubject(MATCH, CONTEXT),
			seed,
		);
		const tampered = {
			...receipt,
			payload: { ...receipt.payload, score: 0.01 } as MatchScoreSubject,
		};
		await expect(verifyMatchReceipt(tampered, pinned)).rejects.toBeInstanceOf(
			MatchScoreEvidenceInvalid,
		);
	});

	it("REJECTS a receipt pinned to the wrong signer (coded SignatureInvalid)", async () => {
		const seed = generateSeedHex();
		const receipt = await signMatchReceipt(
			matchScoreSubject(MATCH, CONTEXT),
			seed,
		);
		const otherKey = await publicKeyHex(generateSeedHex());
		await expect(verifyMatchReceipt(receipt, otherKey)).rejects.toBeInstanceOf(
			SignatureInvalid,
		);
	});

	// THE Ed25519 CASE. Verification has three gates and they fire in a fixed
	// order: content-hash, then pinned signer, then signature bytes. Both tamper
	// tests above stop at an EARLIER gate — the mutated score dies at the hash
	// compare (its payload_hash is left stale), and the wrong key dies at the
	// signer compare (a plain string !==). Neither one ever reaches the
	// signature check, so neither can prove that check runs.
	//
	// This was measured, not assumed: forcing avow's Ed25519 verdict to
	// always-succeed left this package's entire suite green. Only the test
	// below turns red under that mutation.
	it("REJECTS corrupted signature bytes — a valid hash and the RIGHT signer, one flipped nibble", async () => {
		const seed = generateSeedHex();
		const pinned = await publicKeyHex(seed);
		const receipt = await signMatchReceipt(
			matchScoreSubject(MATCH, CONTEXT),
			seed,
		);

		// Flip ONE hex nibble of the signature and change nothing else, so the
		// payload (and therefore payload_hash) and public_key both stay correct.
		// Both earlier gates PASS and control reaches the Ed25519 check.
		const forged = {
			...receipt,
			signature:
				(receipt.signature[0] === "0" ? "1" : "0") + receipt.signature.slice(1),
		};
		expect(forged.signature).not.toBe(receipt.signature);
		expect(forged.signature).toHaveLength(receipt.signature.length);
		expect(forged.payload).toEqual(receipt.payload);
		expect(forged.payload_hash).toBe(receipt.payload_hash);
		expect(forged.public_key).toBe(pinned);

		await expect(verifyMatchReceipt(forged, pinned)).rejects.toBeInstanceOf(
			SignatureInvalid,
		);
	});

	// avow 0.5 versions the envelope: every receipt carries
	// `schema: "avow.receipt/v1"`, and verification refuses one that does not,
	// before it looks at the hash, signer or signature.
	it("seals the avow.receipt/v1 envelope and REJECTS a receipt without it", async () => {
		const seed = generateSeedHex();
		const pinned = await publicKeyHex(seed);
		const receipt = await signMatchReceipt(
			matchScoreSubject(MATCH, CONTEXT),
			seed,
		);
		expect(receipt.schema).toBe("avow.receipt/v1");

		const { schema: _dropped, ...unversioned } = receipt;
		await expect(
			verifyMatchReceipt(unversioned as typeof receipt, pinned),
		).rejects.toBeInstanceOf(ReceiptSchemaMismatch);
	});
});

// The attested-score bound. The engine's scorer clamps its final score into
// [0, 1] (scoring.ts: Math.max(0.0, Math.min(1.0, total))), so a value outside
// that range can never be a legitimate engine output — it is a bug or hostile
// data. Sealing therefore THROWS rather than clamps: clamping would sign a
// fabricated value, and the receipt's whole purpose is that the sealed number
// is the number the engine produced.
describe("attested score bounds", () => {
	const boundaryEvidence = (score: 0 | 1) =>
		calculateAssayScore(
			{
				name_vector: score,
				name_sequence: score,
				alias_match: score,
				dob_match: score,
				country_match: score,
			},
			PRESETS.balanced.weights,
		);
	const subjectWith = (score: number) =>
		matchScoreSubject(
			{
				score,
				tier: score === 0 ? "WEAK" : "STRONG",
				possibleThreshold: 0.65,
				assay: score === 0 || score === 1 ? boundaryEvidence(score) : EVIDENCE,
			},
			CONTEXT,
		);

	it.each([[1.5], [-0.1], [Number.NaN], [Number.POSITIVE_INFINITY]])(
		"REFUSES to seal an impossible score (%s) — coded ScoreOutOfRange",
		(score) => {
			expect(() => subjectWith(score)).toThrow(ScoreOutOfRange);
		},
	);

	it("seals the boundary scores 0 and 1", () => {
		expect(subjectWith(0).score).toBe(0);
		expect(subjectWith(1).score).toBe(1);
	});

	it("REJECTS at verify a receipt VALIDLY SIGNED over an out-of-range score (the range check is not vacuous)", async () => {
		// Bypass the seal-time guard the way a buggy or rogue sealer would: sign
		// the out-of-range subject directly through avow. The signature verifies,
		// so only a real verify-side range check can catch this.
		const seed = generateSeedHex();
		const pinned = await publicKeyHex(seed);
		const rogue = {
			...matchScoreSubject(MATCH, CONTEXT),
			score: 1.5,
		} as unknown as MatchScoreSubject;
		const receipt = await signPayload(rogue, seed);
		await expect(verifyMatchReceipt(receipt, pinned)).rejects.toBeInstanceOf(
			ScoreOutOfRange,
		);
	});

	it("REJECTS at verify a payload tampered to an out-of-range score", async () => {
		const seed = generateSeedHex();
		const pinned = await publicKeyHex(seed);
		const receipt = await signMatchReceipt(
			matchScoreSubject(MATCH, CONTEXT),
			seed,
		);
		const tampered = {
			...receipt,
			payload: { ...receipt.payload, score: 1.5 } as MatchScoreSubject,
		};
		await expect(verifyMatchReceipt(tampered, pinned)).rejects.toBeInstanceOf(
			ScoreOutOfRange,
		);
	});

	it("REJECTS at verify a payload whose inputs_hash is not sha256-scheme", async () => {
		const seed = generateSeedHex();
		const pinned = await publicKeyHex(seed);
		const rogue = {
			...matchScoreSubject(MATCH, CONTEXT),
			inputs_hash: "md5:abc",
		} as unknown as MatchScoreSubject;
		const receipt = await signPayload(rogue, seed);
		await expect(verifyMatchReceipt(receipt, pinned)).rejects.toBeInstanceOf(
			InputsHashInvalid,
		);
	});

	it("REJECTS at verify a sha256-scheme payload whose digest is not 64 lowercase hex characters", async () => {
		const seed = generateSeedHex();
		const pinned = await publicKeyHex(seed);
		const rogue = {
			...matchScoreSubject(MATCH, CONTEXT),
			inputs_hash: "sha256:abc",
		} as unknown as MatchScoreSubject;
		const receipt = await signPayload(rogue, seed);
		await expect(verifyMatchReceipt(receipt, pinned)).rejects.toBeInstanceOf(
			InputsHashInvalid,
		);
	});
});
