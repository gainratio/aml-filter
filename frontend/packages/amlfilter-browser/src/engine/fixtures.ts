// Node-only test helpers (Vitest): load the committed scoring golden snapshot.
// The committed signed demo bundle is verified against its pinned demo key by
// bundleSource.test.ts and sharedBundleParity.test.ts. The node reference
// scopes Node types to this test-only file without leaking them into runtime
// code.
//
// NOT exported from any production barrel — imported only by *.test.ts files.

/// <reference types="node" />

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Entity } from "./domain";
import type { Preset, ScoringQuery } from "./scoring";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCORING = join(HERE, "__fixtures__", "scoring");

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
