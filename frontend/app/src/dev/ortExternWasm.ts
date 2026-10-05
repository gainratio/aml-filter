// Build-time seam for onnxruntime-web (registered in vite.config.ts).
//
// @huggingface/transformers imports `onnxruntime-web/webgpu`. That export's
// default build embeds `new URL("ort-wasm-simd-threaded.asyncify.wasm",
// import.meta.url)`, so Vite emits the file into dist/assets. Since
// onnxruntime-web 1.31 (pulled by transformers 4.3.0) it is 26,861,777 bytes,
// over Cloudflare Pages' 25 MiB per-file cap, and it broke the 2026-10-04
// deploy. The app never loads it: embedder.ts pins `wasmPaths` to the plain
// `/ort/ort-wasm-simd-threaded.{mjs,wasm}` pair staged by
// scripts/stage-ort-wasm.mjs. ORT's documented `onnxruntime-web-use-extern-wasm`
// export condition resolves the same entry without the embedded binary, so the
// runtime keeps loading the staged pair and dist/ stops carrying the dead file.
import { defaultClientConditions, type Plugin } from "vite";

/** onnxruntime-web's package-exports condition for "do not embed the wasm". */
export const ORT_EXTERN_WASM_CONDITION = "onnxruntime-web-use-extern-wasm";

export function ortExternWasmPlugin(): Plugin {
	return {
		name: "amlfilter:ort-extern-wasm",
		config() {
			return {
				resolve: {
					conditions: [...defaultClientConditions, ORT_EXTERN_WASM_CONDITION],
				},
			};
		},
	};
}
