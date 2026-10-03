// Avow score receipt — seal an in-tab risk/match score into a signed,
// offline-verifiable Avow receipt. Assay computes the score; this module seals
// that score, its ordered Assay component evidence, and the AML tier in the
// `@gainratio/avow` envelope (RFC-8785 canonical bytes + Ed25519), so a reviewer
// (or an auditor) can later verify "this score, for this watchlist version, was
// produced by this installation" without trusting any server.
//
// Key-custody honesty: the signing seed is held in the browser (see
// ./installKey). Same-origin script can read it — this is a
// tamper-EVIDENT provenance record, not a hardware-backed key boundary. It
// proves a receipt was not altered after signing; it does not prove the host
// was uncompromised at signing time.
//
// Where this module is proven:
//   • ./scoreReceipt.test.ts — unit suite. Runs under the `node` environment,
//     NOT the package-wide jsdom one: jsdom adds a second JavaScript realm that
//     no browser has, and @noble/ed25519 hashes via `subtle.digest(SHA-512,
//     m.buffer)` — a bare ArrayBuffer that Node 22's WebCrypto rejects when it
//     is cross-realm. That file's header documents the full diagnosis.
//   • app/tests/score-receipt-browser.spec.ts — real Chromium, Firefox, and
//     WebKit. Because
//     the unit suite deliberately leaves jsdom, browser behaviour must be shown
//     somewhere real; that spec drives sign -> verify -> tamper-reject ->
//     wrong-key-reject in an actual page.
//
//   • The production screening path seals through this module: matchReceipts.ts
//     (createMatchReceiptSealer) signs every returned match, and the user-facing
//     journey — seal → display → verify → rekey-fail-closed — is proven over the
//     minified build by app/tests/e2e-c1/receipt-badge.spec.ts.

import {
	type ScoreResult as AssayScoreResult,
	parseScoreResult,
} from "@gainratio/assay";
import {
	type JsonValue,
	type SignedReceipt,
	signPayload,
	verifySignature,
} from "@gainratio/avow";

import {
	calculateAssayScore,
	SCORING_POLICY_VERSION,
	type ScoringSignalValues,
	type ScoringSignalWeights,
} from "./assayScoring";
import { PRESETS } from "./scoring";
import type { MatchTier } from "./tiering";
import { classifyTier } from "./tiering";

/** Re-exported so a receipt consumer needs only this module. ONE definition
 * lives in ./tiering; @amlfilter/workstation re-exports that same one. */
export type { MatchTier };

/** The app-computed match result being attested — score plus its tier. */
export interface MatchScoreInput {
	readonly score: number;
	readonly tier: MatchTier;
	readonly possibleThreshold?: number;
	readonly assay?: AssayScoreResult;
}

/** Coded error: a score outside the engine's legitimate [0, 1] output range. */
export class ScoreOutOfRange extends RangeError {
	constructor(value: number) {
		super(
			`score receipt: score must be a finite number in [0, 1], got ${value}`,
		);
		this.name = "ScoreOutOfRange";
	}
}

/** Coded error: an inputs hash that is not a complete lowercase SHA-256 digest. */
export class InputsHashInvalid extends TypeError {
	constructor(value: string) {
		super(`score receipt: inputs_hash must be "sha256:<hex>", got "${value}"`);
		this.name = "InputsHashInvalid";
	}
}

/** Coded error: signed Assay evidence is malformed or disagrees with the score. */
export class MatchScoreEvidenceInvalid extends TypeError {
	public constructor(reason = "semantic replay failed") {
		super(`score receipt: Assay evidence is invalid (${reason})`);
		this.name = "MatchScoreEvidenceInvalid";
	}
}

declare const attestedScoreBrand: unique symbol;

/**
 * A score this engine can legitimately attest: a finite number in [0, 1].
 * The scorer clamps its final score into exactly that range (scoring.ts), so
 * anything outside it is a bug or hostile data — never a value to sign.
 */
export type AttestedScore = number & { readonly [attestedScoreBrand]: true };

/** The only digest scheme a score receipt may carry. */
export type Sha256Hash = `sha256:${string}`;

/** Runtime wire invariant for the `Sha256Hash` compile-time brand. */
const SHA256_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * Validate a raw score into an `AttestedScore`, or THROW `ScoreOutOfRange`.
 * Throwing (not clamping) is deliberate: the engine cannot produce an
 * out-of-range score, so clamping here would silently sign a fabricated value.
 */
export function attestedScore(value: number): AttestedScore {
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new ScoreOutOfRange(value);
	}
	return value as AttestedScore;
}

/** The screening context that makes a score reproducible and auditable. */
export interface ScoreReceiptContext {
	readonly engineVersion: string;
	readonly watchlistVersion: string;
	/** `sha256:<hex>` over the screened identity pair (the scoring inputs). */
	readonly inputsHash: Sha256Hash;
}

/**
 * The signed subject. A `type` (not `interface`) so it carries an implicit
 * index signature and satisfies `@gainratio/avow`'s `JsonValue` bound.
 */
export type MatchScoreSubject = {
	readonly kind: "aml.match_score";
	readonly engine: "amlfilter-sequenceMatcher";
	readonly engine_version: string;
	readonly watchlist_version: string;
	readonly inputs_hash: Sha256Hash;
	readonly score: AttestedScore;
	readonly tier: MatchTier;
	readonly possible_threshold?: number;
	readonly assay?: AssayScoreResult & JsonValue;
};

// Compile-time proof the subject is a valid Avow payload.
type _AssertJson = MatchScoreSubject extends JsonValue ? true : never;
const _assertJson: _AssertJson = true;
void _assertJson;

/** Build the deterministic score subject from a match result + its context. */
export function matchScoreSubject(
	match: MatchScoreInput,
	context: ScoreReceiptContext,
): MatchScoreSubject {
	const subject: MatchScoreSubject = {
		kind: "aml.match_score",
		engine: "amlfilter-sequenceMatcher",
		engine_version: context.engineVersion,
		watchlist_version: context.watchlistVersion,
		inputs_hash: context.inputsHash,
		score: attestedScore(match.score),
		tier: match.tier,
		...(match.possibleThreshold === undefined
			? {}
			: { possible_threshold: match.possibleThreshold }),
		...(match.assay === undefined
			? {}
			: { assay: match.assay as AssayScoreResult & JsonValue }),
	};
	assertAttestable(subject);
	return subject;
}

const EXPECTED_COMPONENTS = [
	"name_vector",
	"name_sequence",
	"alias_match",
	"dob_match",
	"country_match",
] as const;

const SUBJECT_KEYS = new Set([
	"kind",
	"engine",
	"engine_version",
	"watchlist_version",
	"inputs_hash",
	"score",
	"tier",
	"possible_threshold",
	"assay",
]);

const APPROVED_COEFFICIENTS = Object.values(PRESETS).map((preset) =>
	EXPECTED_COMPONENTS.map((id) => preset.weights[id]),
);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasApprovedCoefficients(evidence: AssayScoreResult): boolean {
	const coefficients = evidence.components.map(
		(component) => component.coefficient,
	);
	return APPROVED_COEFFICIENTS.some((approved) =>
		approved.every((value, index) => value === coefficients[index]),
	);
}

function isTier(value: unknown): value is MatchTier {
	return value === "STRONG" || value === "POSSIBLE" || value === "WEAK";
}

function validThreshold(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= 1
	);
}

function pointEvidenceMismatch(evidence: AssayScoreResult): string | null {
	const invalidRaw = evidence.components.find(
		(component) => !validThreshold(component.raw),
	);
	if (invalidRaw !== undefined) {
		return `${invalidRaw.id} raw signal out of range`;
	}
	const derived = evidence.components.find(
		(component) =>
			component.normalized !== null ||
			component.declared_weight !== null ||
			component.contribution_interval !== null,
	);
	return derived === undefined ? null : `${derived.id} carried derived bounds`;
}

function replayAssayEvidence(evidence: AssayScoreResult): AssayScoreResult {
	const raw = evidence.components.map((component) => component.raw);
	const weights = evidence.components.map((component) => component.coefficient);
	const signals: ScoringSignalValues = {
		name_vector: raw[0] ?? Number.NaN,
		name_sequence: raw[1] ?? Number.NaN,
		alias_match: raw[2] ?? Number.NaN,
		dob_match: raw[3] ?? Number.NaN,
		country_match: raw[4] ?? Number.NaN,
	};
	const coefficients: ScoringSignalWeights = {
		name_vector: weights[0] ?? Number.NaN,
		name_sequence: weights[1] ?? Number.NaN,
		alias_match: weights[2] ?? Number.NaN,
		dob_match: weights[3] ?? Number.NaN,
		country_match: weights[4] ?? Number.NaN,
	};
	return calculateAssayScore(signals, coefficients);
}

function assayReplayMismatch(evidence: AssayScoreResult): string | null {
	const pointMismatch = pointEvidenceMismatch(evidence);
	if (pointMismatch !== null) {
		return pointMismatch;
	}
	if (
		evidence.interval !== null ||
		evidence.weight_total !== null ||
		evidence.selected_component_id !== null
	) {
		return "non-point AML signal evidence";
	}
	const replayed = replayAssayEvidence(evidence);
	if (replayed.inputs_hash !== evidence.inputs_hash) {
		return "inputs hash mismatch";
	}
	if (replayed.score !== evidence.score) {
		return "replayed score mismatch";
	}
	if (
		JSON.stringify(replayed.components) !== JSON.stringify(evidence.components)
	) {
		return "component replay mismatch";
	}
	return null;
}

function requireEvidence(value: boolean, reason: string): asserts value {
	if (!value) {
		throw new MatchScoreEvidenceInvalid(reason);
	}
}

function assertAssayEvidence(payload: MatchScoreSubject): void {
	if (payload.assay === undefined) {
		throw new MatchScoreEvidenceInvalid("proof omitted");
	}
	try {
		const evidence = parseScoreResult(payload.assay);
		const ids = evidence.components.map((component) => component.id);
		requireEvidence(evidence.method.id === "additive", "wrong method");
		requireEvidence(
			evidence.method.version === SCORING_POLICY_VERSION,
			"wrong policy version",
		);
		requireEvidence(evidence.score === payload.score, "score mismatch");
		requireEvidence(evidence.clamp === "clamp", "wrong clamp policy");
		requireEvidence(evidence.intercept === 0, "wrong intercept");
		requireEvidence(
			ids.join("\u0000") === EXPECTED_COMPONENTS.join("\u0000"),
			"wrong component order",
		);
		requireEvidence(
			evidence.components.every((component) => component.operation === "add"),
			"wrong component operation",
		);
		requireEvidence(
			validThreshold(payload.possible_threshold),
			"effective threshold omitted",
		);
		requireEvidence(
			hasApprovedCoefficients(evidence),
			"unapproved coefficients",
		);
		const replayMismatch = assayReplayMismatch(evidence);
		requireEvidence(
			replayMismatch === null,
			replayMismatch ?? "replay mismatch",
		);
		requireEvidence(
			classifyTier(payload.score, payload.possible_threshold) === payload.tier,
			"tier mismatch",
		);
	} catch (error: unknown) {
		if (error instanceof MatchScoreEvidenceInvalid) {
			throw error;
		}
		throw new MatchScoreEvidenceInvalid();
	}
}

/**
 * The subject invariants, re-checked on the VERIFY side. The seal-time guard
 * cannot protect a verifier: a buggy or rogue sealer can validly SIGN an
 * out-of-range subject, and its signature would check out. So bounds are
 * enforced at both ends — reject before the signature even gets a say.
 */
function assertAttestable(payload: MatchScoreSubject): void {
	attestedScore(payload.score);
	if (!SHA256_HASH_PATTERN.test(payload.inputs_hash)) {
		throw new InputsHashInvalid(payload.inputs_hash);
	}
	if (
		payload.kind !== "aml.match_score" ||
		payload.engine !== "amlfilter-sequenceMatcher" ||
		!payload.engine_version.trim() ||
		!payload.watchlist_version.trim() ||
		!isTier(payload.tier) ||
		(payload.possible_threshold !== undefined &&
			!validThreshold(payload.possible_threshold))
	) {
		throw new MatchScoreEvidenceInvalid();
	}
	assertAssayEvidence(payload);
}

/** Parse the signed wire subject before either signing or signature acceptance. */
export function parseMatchScoreSubject(value: unknown): MatchScoreSubject {
	if (
		!isPlainRecord(value) ||
		Object.keys(value).some((key) => !SUBJECT_KEYS.has(key)) ||
		typeof value.kind !== "string" ||
		typeof value.engine !== "string" ||
		typeof value.engine_version !== "string" ||
		typeof value.watchlist_version !== "string" ||
		typeof value.inputs_hash !== "string" ||
		typeof value.score !== "number" ||
		typeof value.tier !== "string"
	) {
		throw new MatchScoreEvidenceInvalid();
	}
	const payload = value as MatchScoreSubject;
	assertAttestable(payload);
	return payload;
}

/** Hash + Ed25519-sign the score subject into a verifiable receipt. */
export function signMatchReceipt(
	subject: MatchScoreSubject,
	seedHex: string,
): Promise<SignedReceipt<MatchScoreSubject>> {
	return signPayload(parseMatchScoreSubject(subject), seedHex);
}

/** Fail-closed verify of a score receipt against a pinned signer key. */
export async function verifyMatchReceipt(
	receipt: SignedReceipt<MatchScoreSubject>,
	expectedPublicKey: string,
): Promise<void> {
	parseMatchScoreSubject(receipt.payload);
	return verifySignature(receipt, expectedPublicKey);
}
