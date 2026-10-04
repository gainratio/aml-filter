// In-browser query embedder. Reproduces edge-reco's Python ProductEncoder, which
// delegates to EdgeProc's TextEncoder: sentence-transformers all-MiniLM-L6-v2 with
// `normalize_embeddings=True`, i.e. mean-pooling over token embeddings followed by
// L2-normalization. transformers.js feature-extraction with
// `{ pooling: "mean", normalize: true }` is the byte-for-byte equivalent of that
// recipe, so embed(text) here matches encode_query(text) on the server to ~1e-3.
//
// The model load is async and heavy (~23 MB of weights), so the real pipeline is
// created once and cached. The Worker wrapper (createEmbedderWorkerHandler) keeps
// the load + inference off the main thread; the pure Embedder below is what the
// parity test exercises directly in Node.

import { env, pipeline } from "@huggingface/transformers";
import {
	type FetchScope,
	MODEL_ASSET_PREFIX,
	withModelFetchProgress,
} from "./modelFetchProgress";

// transformers.js browser env.
//
// Weights are self-hosted, not pulled from huggingface.co at runtime. The app's
// `prebuild` hook (app/scripts/download-model.mjs) mirrors this model's files
// into app/public/models/, so they ship inside the SPA's own origin. Setting
// `allowLocalModels = true` + `localModelPath = "/models/"` makes transformers.js
// resolve each file as `/models/<modelId>/<file>` — e.g.
// `/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx` — served same-origin
// instead of from the HF CDN. (In the browser the ONNX device is `wasm`; we pin
// dtype to the shared EMBEDDING_DTYPE (`q8`) EXPLICITLY rather than relying on the
// wasm device's implicit default, so the runtime deterministically requests the
// `_quantized` ONNX export — the SAME export the Node publisher embeds with. That
// shared constant is what keeps the precomputed list vectors and the in-tab query
// vectors in one embedding space; see nodeEmbedder.ts.)
//
// `useBrowserCache` is RE-ENABLED. The original `Ke(...).call is not a function`
// crash that once motivated disabling it was NOT a CacheStorage bug: it was
// esbuild downleveling native private fields (`#field`) to a WeakMap accessor
// under the es2020 build target, which transformers.js's minified worker
// mis-invoked — fixed by `target: "es2022"` in app/vite.config.ts. The
// cold/blocked-CDN e2e (app/tests/e2e-c1/screen-cold-blocked.spec.ts) drives the
// MINIFIED prod build in a real Chromium with the cache on and asserts ZERO
// in-page console errors as the ~23 MB model loads, so a re-introduction of the
// old downlevel crash re-trips that test. With the cache on, a returning visitor
// reuses the cached weights instead of re-fetching them from /models/.
env.useBrowserCache = true;
env.allowLocalModels = true;
env.localModelPath = MODEL_ASSET_PREFIX;
// FAIL CLOSED: never fall back to fetching an unpinned model from huggingface.co.
// transformers.js defaults `allowRemoteModels` to true, so a missing/renamed local
// weight would silently pull from the HF CDN — unacceptable for an AML tool, where
// the scoring model must be the exact self-hosted export. Off ⇒ a missing weight
// throws instead. The cold-blocked e2e proves boot succeeds with all CDNs aborted.
env.allowRemoteModels = false;
// With an explicit {mjs, wasm} pair, transformers.js would by default pre-fetch
// both and re-import the loader from a `blob:` URL; `script-src 'self'` (the
// production CSP in app/public/_headers) rejects that import. Off ⇒
// onnxruntime-web imports /ort/*.mjs directly, same-origin.
env.useWasmCache = false;

/** The explicit loader + binary pair onnxruntime-web fetches from /ort/. */
export interface OrtWasmPaths {
	readonly mjs: string;
	readonly wasm: string;
}

/** The onnxruntime-web wasm env knob the self-hosting config owns
 * (transformers.js exposes it as `env.backends.onnx.wasm`). Structural, so the
 * unit test can drive the decision with a fake alongside the real env. */
export interface OrtWasmEnvLike {
	wasmPaths?: string | OrtWasmPaths;
}

/**
 * Self-host the ORT wasm LOADER, not just the model (house standard §8.1b).
 * onnxruntime-web dynamically imports its wasm loader module (which then
 * fetches its `.wasm`) at runtime, and the library's default base for that
 * import is the jsDelivr CDN. The cold-blocked e2e caught exactly that on this
 * repo: with jsDelivr aborted, boot died fetching
 * `cdn.jsdelivr.net/npm/onnxruntime-web/…/ort-wasm-simd-threaded.asyncify.mjs`.
 * The staged same-origin copy under /ort/ is materialized by the app's
 * `prebuild` hook (app/scripts/stage-ort-wasm.mjs) from the lockfile-pinned
 * node_modules bytes.
 *
 * The pair is named EXPLICITLY and is the plain (non-asyncify) CPU build.
 * transformers.js loads the `onnxruntime-web/webgpu` bundle, whose default is
 * the asyncify build — that build exists for the WebGPU EP, which this app never
 * uses (device is `wasm`), and since onnxruntime-web 1.31 its .wasm is 26.9 MB,
 * over Cloudflare Pages' 25 MiB per-file limit. The plain build is ~14 MB and
 * runs the same CPU kernels (transformers.js itself falls back to it on Safari
 * below 26).
 */
export function configureOrtWasmPaths(ortWasm: OrtWasmEnvLike): void {
	ortWasm.wasmPaths = {
		mjs: "/ort/ort-wasm-simd-threaded.mjs",
		wasm: "/ort/ort-wasm-simd-threaded.wasm",
	};
}

/** The live onnxruntime-web wasm env, reached through transformers.js's loosely
 * typed `env.backends`. FAIL LOUD: if the `onnx.wasm` node is absent we throw at
 * module load rather than configure a throwaway `{}` — a silent no-op there would
 * leave `wasmPaths` unset and let onnxruntime-web dynamic-import its loader from
 * the jsDelivr CDN (the exact §8.1b dependency this self-host kills). A missing
 * knob means transformers.js moved it, and that must fail here, not in prod. */
function ortWasmEnv(): OrtWasmEnvLike {
	const backends = env.backends as { onnx?: { wasm?: OrtWasmEnvLike } };
	const wasm = backends.onnx?.wasm;
	if (wasm === undefined) {
		throw new Error(
			"onnxruntime-web wasm env (env.backends.onnx.wasm) is unavailable — " +
				"cannot pin the same-origin ORT loader; refusing to boot on the " +
				"jsDelivr CDN default (house standard §8.1b).",
		);
	}
	return wasm;
}

configureOrtWasmPaths(ortWasmEnv());

/** The sentence-transformers model id, mirrored as its Xenova ONNX export. */
export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

/** all-MiniLM-L6-v2 produces 384-dimensional embeddings. */
export const EMBEDDING_DIM = 384;

/**
 * The ONNX quantization the pipeline loads — the SINGLE knob both runtimes share.
 * The Node publisher (nodeEmbedder.ts) and this browser embedder must request the
 * SAME ONNX export so precomputed list vectors and in-tab query vectors live in
 * one space; `q8` is the `model_quantized.onnx` export self-hosted under
 * app/public/models. Pinned EXPLICITLY (not left to the wasm device's implicit
 * default) so the choice is shared, not coincidental.
 */
export const EMBEDDING_DTYPE = "q8";

/** Embeds a query string into a normalized 384-d vector. */
export interface Embedder {
	embed(text: string): Promise<Float32Array>;
	/** Release model state when a runtime is explicitly evicted. */
	dispose?(): void;
}

/**
 * Model-download progress, aggregated over the whole model load (see
 * modelFetchProgress.ts for why it is aggregated rather than per-file).
 *
 * `total` and `pct` are OPTIONAL on purpose. A server that answers without a
 * `content-length` (chunked transfer) leaves no honest denominator, and
 * inventing one would put a fabricated percentage on the boot banner. Bytes are
 * always known; a percentage is not.
 */
export interface EmbedProgress {
	/** Bytes streamed so far across the model files of this load. */
	readonly loaded: number;
	/** Sum of the declared file sizes, or undefined when a size was withheld. */
	readonly total?: number;
	/** Percent loaded (0–100), derived from loaded/total; undefined with no total. */
	readonly pct?: number;
}

/** A construction-time sink for model-load progress. Optional: progress is a
 * boot-banner nicety, not part of the shared {@link Embedder.embed} contract. */
export type OnEmbedProgress = (progress: EmbedProgress) => void;

/** A feature-extraction call producing a flat numeric data buffer. */
type ExtractFn = (
	text: string,
	options: { readonly pooling: "mean"; readonly normalize: boolean },
) => Promise<{ readonly data: ArrayLike<number> }>;

/** Pipeline options this module passes through. The dtype stays pinned, and the
 * transformers.js progress callback stays deliberately OMITTED: in 4.2.0 its
 * mere presence makes `pipeline()` probe every expected file first, and under
 * this app's `allowLocalModels` self-hosting that probe is a second full GET of
 * the ~23 MB ONNX. Progress is metered at the transport instead — see
 * modelFetchProgress.ts. */
interface PipelineOptions {
	readonly dtype?: string;
}

/** A narrowed view of transformers.js `pipeline`: building the feature-extraction
 * task yields a callable ExtractFn. The library's own overload union over every
 * task is too large for the compiler to represent (TS2590), so it is collapsed to
 * the one signature this module uses. */
type LoadFeatureExtraction = (
	task: "feature-extraction",
	model: string,
	options?: PipelineOptions,
) => Promise<ExtractFn>;

class PipelineEmbedder implements Embedder {
	readonly #load: () => Promise<ExtractFn>;
	#extract: ExtractFn | undefined;

	public constructor(load: () => Promise<ExtractFn>) {
		this.#load = load;
	}

	public async embed(text: string): Promise<Float32Array> {
		if (this.#extract === undefined) {
			this.#extract = await this.#load();
		}
		const output = await this.#extract(text, {
			pooling: "mean",
			normalize: true,
		});
		const vector = Float32Array.from(output.data);
		if (vector.length !== EMBEDDING_DIM) {
			throw new Error(
				`embedding has ${vector.length} dims; expected ${EMBEDDING_DIM}`,
			);
		}
		return vector;
	}

	public dispose(): void {
		this.#extract = undefined;
	}
}

/** Build the `pipeline` options without the unsafe 4.2.0 progress callback. */
function pipelineOptions(): PipelineOptions {
	return { dtype: EMBEDDING_DTYPE };
}

/**
 * The transformers.js fetch knob, reached through its loosely typed `env`.
 * FAIL LOUD if it is missing: `env.fetch` is what every weight download goes
 * through, so an absent knob means the library moved it — and a silent no-op
 * here would put the frozen banner back without anyone noticing.
 */
export function transformersFetchScope(): FetchScope {
	const scope = env as unknown as Partial<FetchScope>;
	if (typeof scope.fetch !== "function") {
		throw new Error(
			"transformers.js fetch knob (env.fetch) is unavailable — cannot meter " +
				"the model download; refusing to boot with a frozen progress banner.",
		);
	}
	return scope as FetchScope;
}

/**
 * Load the feature-extraction pipeline via an injected `pipeline`, pinning the
 * shared dtype. When a sink is wired, the load runs inside
 * {@link withModelFetchProgress}, which counts the model bytes as they stream
 * and restores the original fetch when the load settles either way. Without a
 * sink nothing is wrapped at all.
 */
function loadWith(
	load: LoadFeatureExtraction,
	onProgress: OnEmbedProgress | undefined,
	scope: () => FetchScope = transformersFetchScope,
): () => Promise<ExtractFn> {
	const start = (): Promise<ExtractFn> =>
		load("feature-extraction", EMBEDDING_MODEL, pipelineOptions());
	if (onProgress === undefined) {
		return start;
	}
	return () => withModelFetchProgress(scope(), onProgress, start);
}

/**
 * The default embedder, backed by the transformers.js feature-extraction
 * pipeline. The model is fetched + compiled lazily on the first embed call and
 * cached for the lifetime of the embedder. When a progress sink is supplied it
 * receives the real byte counts of the ~23 MB download, metered off `env.fetch`.
 */
export function createEmbedder(onProgress?: OnEmbedProgress): Embedder {
	const load = pipeline as unknown as LoadFeatureExtraction;
	return new PipelineEmbedder(loadWith(load, onProgress));
}

/**
 * An embedder over an injected `pipeline` — the seam tests use to verify the
 * production options without the real ~23 MB download. The fetch scope is
 * injectable too, so a test can drive progress without touching a global.
 */
export function createEmbedderWithPipeline(
	load: LoadFeatureExtraction,
	onProgress?: OnEmbedProgress,
	scope?: () => FetchScope,
): Embedder {
	return new PipelineEmbedder(loadWith(load, onProgress, scope));
}

/**
 * An embedder over an injected extractor — the seam the parity test uses to run
 * the real transformers.js pipeline in Node without a Worker.
 */
export function createEmbedderWith(load: () => Promise<ExtractFn>): Embedder {
	return new PipelineEmbedder(load);
}

export type { ExtractFn };
