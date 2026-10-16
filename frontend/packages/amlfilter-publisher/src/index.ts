// @amlfilter/publisher — the Node-side signed-watchlist producer.
//
// Reads a source-entities JSONL, maps it to the v3 wire shape (recomputing
// name_canonical via the SAME canonicalize() the browser uses), precomputes the
// per-entity name vectors with transformers.js, and emits the four signed static
// files the browser tier syncs and verifies fail-closed:
//   watchlist.json(.sig)  +  watchlist.manifest.json(.sig)
//
// See docs/WATCHLIST_FORMAT.md for the wire contract. The embedder is injected so
// callers can pass a fake (tests) or the real Node embedder (CLI / build-demo).

export {
	buildCatalog,
	type Catalog,
	type CatalogList,
	writeSignedCatalog,
} from "./catalog.ts";
export { createNodeEmbedder } from "./nodeEmbedder.ts";
export {
	type EdgeprocCommand,
	edgeprocPublishArgs,
	type PublishBundleInput,
	publishBundle,
} from "./publishBundle.ts";
export {
	type CatalogSourceSpec,
	type PublishCatalogInput,
	publishCatalog,
} from "./publishCatalog.ts";
export {
	type PublishFromJsonl,
	type PublishFromLines,
	type PublishInput,
	publishWatchlist,
	toBytes,
} from "./publisher.ts";
export { derivePublicKey, signBytes, writeSigned } from "./signing.ts";
export {
	type SnapshotFile,
	type SnapshotManifest,
	type SnapshotSource,
	snapshotSources,
} from "./snapshotSources.ts";
export { parseEntities, toWatchlistEntity } from "./sourceEntity.ts";
export { CSL_SDN_SOURCE, parseCslSdn, splitCsvLine } from "./sources/csl.ts";
export { euSource } from "./sources/euSource.ts";
export { CSL_BASE, CSL_FILE, ofacSource } from "./sources/ofacSource.ts";
export {
	type AliasEnrichment,
	applyAliasEnrichment,
	fetchNonLatinAliases,
	LATIN_SCRIPT,
	NO_ENRICHMENT,
	parseNonLatinAliases,
	SDN_ALIAS_MIRROR_URL,
} from "./sources/sdnAliases.ts";
export {
	EU_LIST_ID,
	namespacedId,
	OFAC_LIST_ID,
	type RawListBytes,
	type SourceLine,
	UK_LIST_ID,
	UN_LIST_ID,
	type WatchlistSource,
} from "./sources/source.ts";
export { ukSource } from "./sources/ukSource.ts";
export { unSource } from "./sources/unSource.ts";
export {
	buildWatchlistSqlite,
	type DecodedWatchlistSqlite,
	readWatchlistSqlite,
	WATCHLIST_SQLITE_APP_ID,
	WATCHLIST_SQLITE_NAME,
	WATCHLIST_SQLITE_USER_VERSION,
	type WatchlistSqliteMeta,
} from "./sqliteBundle.ts";
export {
	type StageBundleOptions,
	type StagedList,
	stageBundle,
} from "./stageBundle.ts";
export type { Watchlist, WatchlistEntity, WatchlistManifest } from "./types.ts";
export { packVectors, vectorsToBase64, vectorsToBytes } from "./vectors.ts";
