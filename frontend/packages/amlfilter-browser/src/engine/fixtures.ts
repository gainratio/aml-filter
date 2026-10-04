// Node-only test helpers (Vitest): load the REAL committed signed demo BUNDLE
// the SPA ships (frontend/app/public/bundle/origin/) — the signed `/latest`
// version pointer — plus the pinned public key the SPA verifies against. The
// signed-bundle delta-sync is the ONLY catalog/list path now (the flat signed
// JSON watchlist is retired), so the fail-closed crypto drift-guard verifies the
// committed pointer's detached signature against the committed key — the REAL
// pair the live demo boots on, not a synthetic stand-in. The node reference
// scopes Node types to this test-only file without leaking them into runtime
// code.
//
// NOT exported from any production barrel — imported only by *.test.ts files.

/// <reference types="node" />

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	canonicalBytes,
	type JsonValue,
	type VersionPointer,
} from "@gainratio/browser";
import type { Entity } from "./domain";
import type { Preset, ScoringQuery } from "./scoring";

const HERE = dirname(fileURLToPath(import.meta.url));
// src/engine -> amlfilter-browser -> packages -> frontend -> repo root.
const REPO_ROOT = join(HERE, "..", "..", "..", "..", "..");
const PUBLIC = join(REPO_ROOT, "frontend", "app", "public");
// The committed signed bundle the SPA ships; `latest` is the signed pointer.
const BUNDLE_LATEST = join(PUBLIC, "bundle", "origin", "latest");
// The committed demo bundle is signed with the THROWAWAY demo key (NOT the
// production trust root public/public.key). Verify it against that key's
// committed public half so the demo path is fully decoupled from the prod pin.
const PINNED_PUBKEY = join(
	REPO_ROOT,
	"frontend",
	"packages",
	"amlfilter-publisher",
	"fixtures",
	"demo-public.key",
);
const SCORING = join(HERE, "__fixtures__", "scoring");

const DECODER = new TextDecoder();

/** One expected weighted reason in the committed scoring snapshot. */
export interface GoldenReason {
	readonly signal: string;
	readonly value: number | string;
	readonly weight: number;
	readonly contribution: number;
	readonly description: string;
}

/** One (entity, query) scoring case: TS-shaped input + the expected output. */
export interface GoldenCase {
	readonly name: string;
	readonly preset: Preset;
	readonly entity: Entity;
	readonly query: ScoringQuery;
	readonly expected: {
		readonly score: number;
		readonly summary: string;
		readonly reasons: ReadonlyArray<GoldenReason>;
	};
}

/**
 * The scoring regression golden: a FROZEN, committed snapshot under
 * __fixtures__/scoring of the TS scorer's full output. The TS scorer is the
 * source of truth; this test fixture exists to catch unintended drift — the
 * live scorer must still reproduce every case byte-for-byte; see
 * scoring.parity.test.ts.
 */
export function scoringGolden(): ReadonlyArray<GoldenCase> {
	return JSON.parse(
		readFileSync(join(SCORING, "golden.json"), "utf-8"),
	) as GoldenCase[];
}

/** The committed demo bundle's ed25519 public key (the throwaway demo key's
 * public half, fixtures/demo-public.key — deliberately not the production pin). */
export function pubkeyRaw(): Uint8Array {
	return new Uint8Array(readFileSync(PINNED_PUBKEY));
}

/** The committed signed `/latest` version pointer (parsed). */
function pointer(): VersionPointer {
	return JSON.parse(
		DECODER.decode(readFileSync(BUNDLE_LATEST)),
	) as VersionPointer;
}

/** The EXACT signed message the pointer's detached signature covers: the pointer's
 * canonical bytes with the `signature` field excluded (mirrors the sync tier's
 * fetchPointer). Verifying this against {@link pubkeyRaw} reproduces the live
 * fail-closed boot check, over the REAL committed pointer. */
export function pointerMessage(): Uint8Array {
	const value = pointer();
	const exclude: Record<string, true> = { signature: true };
	if (value.bundle_id == null) exclude.bundle_id = true;
	if (value.channel == null) exclude.channel = true;
	return canonicalBytes(value as unknown as JsonValue, { exclude });
}

/** The detached base64 ed25519 signature carried by the committed pointer. */
export function pointerSig(): string {
	return pointer().signature;
}
