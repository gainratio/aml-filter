// The real Node embedder: transformers.js feature-extraction over MiniLM, run on
// onnxruntime-node. Same model + recipe (mean pooling, L2-normalize) as the
// browser's PipelineEmbedder, so the published vectors match in-tab query
// embeddings to ~1e-3.
//
// CRITICAL: @amlfilter/browser's embedder.ts sets, at import time, the *browser*
// env (localModelPath = "/models/", a browser URL). That is wrong for Node, so we
// override `env` here for a Node filesystem path. transformers.js resolves
// `pathJoin(localModelPath, modelId, file)`, so localModelPath must be the dir
// that CONTAINS the `Xenova/all-MiniLM-L6-v2/...` layout (i.e. public/models).
//
// The only ONNX export on disk is `model_quantized.onnx` (the wasm q8 build), so
// we request the shared EMBEDDING_DTYPE (`q8`) to match it — the SAME constant the
// browser embedder pins, so one knob drives both runtimes' ONNX export choice;
// `allowRemoteModels` is left on so a missing local mirror falls back to an HF
// download (used by the CI lane).

import {
	EMBEDDING_DIM,
	EMBEDDING_DTYPE,
	EMBEDDING_MODEL,
	type Embedder,
} from "@amlfilter/browser";
import { env, pipeline } from "@huggingface/transformers";

/** A feature-extraction call producing a flat numeric data buffer. */
type ExtractFn = (
	text: string,
	options: { readonly pooling: "mean"; readonly normalize: boolean },
) => Promise<{ readonly data: ArrayLike<number> }>;

/** Point transformers.js at a Node filesystem model mirror (not the browser URL
 * the @amlfilter/browser import sets), while keeping a remote fallback. */
function configureNodeEnv(modelsDir: string): void {
	env.allowLocalModels = true;
	env.localModelPath = modelsDir;
	env.allowRemoteModels = true;
	env.useBrowserCache = false;
}

/**
 * Build the Node embedder. `modelsDir` is the directory that CONTAINS the
 * `Xenova/all-MiniLM-L6-v2/...` layout (e.g. frontend/app/public/models).
 */
export function createNodeEmbedder(modelsDir: string): Embedder {
	configureNodeEnv(modelsDir);
	let extract: ExtractFn | undefined;
	const load = async (): Promise<ExtractFn> => {
		if (extract === undefined) {
			extract = (await pipeline("feature-extraction", EMBEDDING_MODEL, {
				dtype: EMBEDDING_DTYPE,
				session_options: { graphOptimizationLevel: "basic" },
			})) as unknown as ExtractFn;
		}
		return extract;
	};
	return {
		async embed(text: string): Promise<Float32Array> {
			const fn = await load();
			const out = await fn(text, { pooling: "mean", normalize: true });
			const vector = Float32Array.from(out.data);
			if (vector.length !== EMBEDDING_DIM) {
				throw new Error(
					`embedding has ${vector.length} dims; expected ${EMBEDDING_DIM}`,
				);
			}
			return vector;
		},
	};
}
