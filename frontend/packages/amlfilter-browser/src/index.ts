// @amlfilter/browser — the in-browser tier of aml-filter.
//
// Delta-sync a signed, content-addressed watchlist bundle (the ONLY catalog/list
// path), verify its detached ed25519 signature (fail-closed) against a pinned
// key, decode the precomputed name vectors, and screen a name entirely in the
// tab — no backend. The publisher
// (frontend/packages/amlfilter-publisher) and this browser consumer share one
// wire format (see docs/WATCHLIST_FORMAT.md) and one explainable scoring
// contract (see ./engine/domain + ./engine/scoring): the wire format, the
// normalizer, and the scorer's full output (score, reasons, and each reason's
// description) are locked by frozen golden snapshots of this TypeScript
// implementation, which is the source of truth (the Python backend and its
// golden generators were retired; see ./engine/scoring for the weights).
//
// Primary entry point: EngineRuntime.bootstrap() → MultiListScreeningEngine.

export { EngineOperationError } from "@gainratio/browser";
// --- Assay additive score composition and policy decision contract ---
export {
	calculateAssayScore,
	SCORING_POLICY_VERSION,
	type ScoringPolicyDecision,
	type ScoringSignalValues,
	type ScoringSignalWeights,
	scoringPolicyDecision,
} from "./engine/assayScoring";
// --- storage-quota preflight: refuse fail-fast rather than hang mid-sync ---
export { QuotaError } from "./engine/bundleErrors";
// --- cold-sync download progress shape (threaded into the downloading banner) ---
export type { OnSyncProgress, SyncProgress } from "./engine/bundleProgress";
// --- the signed-bundle delta-sync path: open + materialize a signed bundle ---
export {
	type BundleEngineClient,
	type BundleSource,
	type BundleSourceDeps,
	CLEAR_BUNDLE_STORE_TIMEOUT_MS,
	clearBundleStore,
	openBundleSource,
} from "./engine/bundleSource";
// --- device-support preflight: is the local engine runnable on this browser? ---
export {
	type CapabilityScope,
	DeviceUnsupportedError,
	detectCapabilities,
	type EngineCapabilities,
	engineSupport,
	isEngineSupported,
	missingCapabilities,
} from "./engine/deviceSupport";
// --- the domain contract (single source of truth, mirrors the backend) ---
export {
	type Alias,
	EMPTY_IDENTIFIERS,
	type Entity,
	type EntityType,
	type Identifiers,
	type Match,
	type MatchReason,
	type OfacBundleMeta,
	type RetrievalChannel,
	type RiskCategory,
	type ScreenQuery,
	type ScreenResponse,
} from "./engine/domain";
// --- the embedder seam (transformers.js in production, stubbable in tests) ---
export {
	EMBEDDING_DIM,
	EMBEDDING_DTYPE,
	EMBEDDING_MODEL,
	type Embedder,
} from "./engine/embedder";
// --- the fuzzy/phonetic seam (fuzzball + double-metaphone live behind this) ---
// Exported for the decision harness's name-similarity study
// (packages/amlfilter-publisher/src/decision/pairStudy.ts), which measures the
// error rate of the exact functions the alias tiers decide with. A study that
// re-implemented either function would be grading the study.
export {
	phoneticKeys,
	tokenSetSimilarity,
	tokenSortSimilarity,
} from "./engine/fuzzyText";
// --- the per-install signing key behind every score receipt ---
export {
	defaultKeyStorage,
	INSTALL_SEED_KEY,
	type InstallKey,
	type KeyStorage,
	loadInstallKey,
} from "./engine/installKey";
// --- the sealer that wraps each returned match in a signed score receipt ---
export {
	createMatchReceiptSealer,
	inputsHash,
	type MatchReceiptSealer,
	type SealContext,
} from "./engine/matchReceipts";
// --- the multi-list screen: one warm embedder, N signed lists, one contract ---
export {
	createMultiListScreeningEngine,
	createStreamingMultiListScreeningEngine,
	type ListThresholds,
	MultiListScreeningEngine,
	type StreamingListSource,
} from "./engine/multiEngine";
// --- the canonical-name pipeline (shared by the engine and the UI's gates) ---
export { canonicalize, normalizeDob } from "./engine/normalize";
// --- runtime: bootstrap the multi-list engine over the signed catalog + lists ---
export {
	BOOT_TIMEOUT_MS,
	type BootStage,
	bootTimeoutMs,
	type CatalogListInfo,
	compositeVersion,
	configFromEnv,
	createEmbedder,
	defaultRuntimeDeps,
	EngineRuntime,
	MODEL_LOAD_IDLE_TIMEOUT_MS,
	type OnStage,
	type RuntimeConfig,
	type RuntimeDeps,
	type RuntimeSelection,
} from "./engine/runtime";
// --- the Avow score receipt: seal a score into an offline-verifiable envelope ---
export {
	MatchScoreEvidenceInvalid,
	type MatchScoreInput,
	type MatchScoreSubject,
	matchScoreSubject,
	type ScoreReceiptContext,
	signMatchReceipt,
	verifyMatchReceipt,
} from "./engine/scoreReceipt";
// --- the scoring port: preset weights/threshold + the explainable signals ---
export {
	computeScore,
	PRESETS,
	type Preset,
	type PresetConfig,
	type ScoreResult,
	type ScoringQuery,
	type ScoringWeights,
} from "./engine/scoring";
// --- the screen surface + its option/return contracts ---
export {
	createScreeningEngine,
	ScreeningEngine,
	type ScreenOptions,
} from "./engine/screeningEngine";
// --- match-strength tiers (ONE definition; the workstation re-exports these) ---
export {
	classifyTier,
	type MatchTier,
	STRONG_TIER_FLOOR,
} from "./engine/tiering";
export type {
	AmlVectorIndexFactory,
	VectorIndexStorage,
} from "./engine/vectorIndex";
export {
	subscribeVectorIndexStorage,
	vectorIndexFallbackLists,
	vectorIndexStorage,
} from "./engine/vectorIndex";
// --- the engine version stamped into receipts + the composite list stamp ---
export { ENGINE_VERSION } from "./engine/version";
// --- the bundle-files builder + the shared watchlist/catalog shapes ---
export {
	type BundleListFiles,
	type BundleListMeta,
	buildLoadedFromBundleFiles,
	buildLoadedWatchlist,
	buildLoadedWatchlistMetadataFromBundleFiles,
	hasFetchedAt,
	type ListAgeSource,
	type ListFreshness,
	type LoadedWatchlist,
	type LoadedWatchlistMetadata,
	type ResolvedListAge,
	type ResolvedListFreshness,
	resolveListAge,
	resolveListFreshness,
	type Watchlist,
	type WatchlistCatalog,
	type WatchlistCatalogEntry,
	type WatchlistEntity,
	WatchlistFormatError,
	type WatchlistManifest,
} from "./engine/watchlist";
