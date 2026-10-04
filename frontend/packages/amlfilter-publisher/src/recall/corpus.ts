// Rebuild a query-ready screening engine from frozen feed lines, using the
// PRODUCTION path and nothing else.
//
// Every step below is the same code the published bundle goes through:
// `toWatchlistEntity` is the publisher's projection, `packVectors` is the
// publisher's embedding step, and `buildLoadedFromBundleFiles` is the browser's
// own bundle loader — the function the sync Worker calls after it has verified
// the chunk hashes. A harness that reimplemented any of them would measure the
// harness, not the product.

import {
	buildLoadedFromBundleFiles,
	createScreeningEngine,
	EMBEDDING_DIM,
	EMBEDDING_MODEL,
	type Embedder,
	type ScreeningEngine,
} from "@amlfilter/browser";
import { createNodeSqliteVectorIndex } from "@gainratio/browser/vector/sqlite/node";
import { toWatchlistEntity } from "../sourceEntity.ts";
import type { SourceLine } from "../sources/source.ts";
import { packVectors, vectorsToBytes } from "../vectors.ts";

const ENCODER = new TextEncoder();

/** A stand-in build stamp: the corpus is frozen, so it must not vary per run. */
const FIXED_GENERATED_AT = "1970-01-01T00:00:00.000Z";

function metaBytes(listId: string, version: string, count: number): Uint8Array {
	return ENCODER.encode(
		JSON.stringify({
			listId,
			version,
			generatedAt: FIXED_GENERATED_AT,
			model: EMBEDDING_MODEL,
			dim: EMBEDDING_DIM,
			entitiesCount: count,
			fetchedAt: FIXED_GENERATED_AT,
			sourceUpdatedAt: null,
			stale: false,
			staleReason: null,
		}),
	);
}

/** A loaded corpus and the engine that screens against it. */
export interface RecallCorpus {
	readonly engine: ScreeningEngine;
	readonly listId: string;
	readonly entities: number;
}

/**
 * Embed every entity's canonical name and build the engine over the result.
 * `listVersion` is stamped into the wire records; it does not affect scoring.
 */
export async function buildRecallCorpus(
	lines: readonly SourceLine[],
	embedder: Embedder,
	listVersion: string,
): Promise<RecallCorpus> {
	const entities = lines.map((line, i) => toWatchlistEntity(line, i + 1));
	const vectors = await packVectors(
		embedder,
		entities.map((e) => e.name_canonical),
	);
	const listId = lines[0]?.source_list ?? "UNKNOWN";
	const loaded = buildLoadedFromBundleFiles(
		{
			entitiesJsonl: ENCODER.encode(
				`${entities.map((e) => JSON.stringify(e)).join("\n")}\n`,
			),
			vectorsF32: vectorsToBytes(vectors),
			meta: metaBytes(listId, listVersion, entities.length),
			// No signed bundle exists here; the index marker still hashes every
			// id, lookup key and vector, so this label only names the corpus.
			manifestHash: `recall-corpus:${listId}@${listVersion}`,
		},
		createNodeSqliteVectorIndex,
	);
	return {
		engine: createScreeningEngine(loaded, embedder),
		listId,
		entities: entities.length,
	};
}
