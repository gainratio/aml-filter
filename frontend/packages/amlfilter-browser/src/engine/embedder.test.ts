import { env, type ProgressInfo } from "@huggingface/transformers";
import { describe, expect, it, vi } from "vitest";
import {
	configureOrtWasmPaths,
	createEmbedder,
	createEmbedderWith,
	createEmbedderWithPipeline,
	EMBEDDING_DTYPE,
	EMBEDDING_MODEL,
	type EmbedProgress,
	type OrtWasmEnvLike,
	transformersFetchScope,
} from "./embedder";
import { type FetchScope, MODEL_ASSET_PREFIX } from "./modelFetchProgress";

const MODEL_FILE = `${MODEL_ASSET_PREFIX}${EMBEDDING_MODEL}/onnx/model_quantized.onnx`;

/** A fetch scope that answers the model URL with a two-chunk 100-byte body —
 * the smallest stand-in for the ~23 MB weights the real load streams. */
function fakeModelScope(): FetchScope {
	return {
		fetch: () =>
			Promise.resolve(
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array(40));
							controller.enqueue(new Uint8Array(60));
							controller.close();
						},
					}),
					{ status: 200, headers: { "content-length": "100" } },
				),
			),
	};
}

describe("createEmbedder progress threading", () => {
	it("still omits the progress callback that makes transformers.js re-fetch the ONNX model", async () => {
		// The library callback stays off: in 4.2.0 its presence adds a metadata
		// pass that, under allowLocalModels, is a SECOND full GET of the weights.
		let receivedOptions: {
			dtype?: string;
			progress_callback?: (i: ProgressInfo) => void;
		} = {};
		const fakePipeline = vi.fn(
			async (
				_task: string,
				_model: string,
				opts?: {
					dtype?: string;
					progress_callback?: (i: ProgressInfo) => void;
				},
			) => {
				receivedOptions = opts ?? {};
				return async () => ({ data: new Float32Array(384) });
			},
		);
		const embedder = createEmbedderWithPipeline(fakePipeline, vi.fn());
		await embedder.embed("warm up");

		expect(receivedOptions.progress_callback).toBeUndefined();
	});

	it("feeds the sink real download bytes metered off the fetch scope", async () => {
		// The bug this fixes: the sink was wired end-to-end (worker → client →
		// runtime → banner) and dropped on the floor here, so the ~23 MB model
		// phase was the one part of the boot that showed no progress at all.
		const seen: EmbedProgress[] = [];
		const scope = fakeModelScope();
		const fakePipeline = vi.fn(async () => {
			await (await scope.fetch(MODEL_FILE)).arrayBuffer();
			return async () => ({ data: new Float32Array(384) });
		});

		const embedder = createEmbedderWithPipeline(
			fakePipeline,
			(p) => seen.push(p),
			() => scope,
		);
		await embedder.embed("warm up");

		expect(seen.map((p) => p.loaded)).toEqual([40, 100]);
		expect(seen.at(-1)?.pct).toBe(100);
	});

	it("restores the scope's fetch once the load is done", async () => {
		const scope = fakeModelScope();
		const original = scope.fetch;
		const fakePipeline = vi.fn(async () => {
			await (await scope.fetch(MODEL_FILE)).arrayBuffer();
			return async () => ({ data: new Float32Array(384) });
		});

		const embedder = createEmbedderWithPipeline(
			fakePipeline,
			vi.fn(),
			() => scope,
		);
		await embedder.embed("warm up");

		expect(scope.fetch).toBe(original);
	});

	it("does not touch the fetch scope when no sink is wired", async () => {
		const scope = fakeModelScope();
		const original = scope.fetch;
		const fakePipeline = vi.fn(async () => {
			expect(scope.fetch).toBe(original);
			return async () => ({ data: new Float32Array(384) });
		});

		const embedder = createEmbedderWithPipeline(
			fakePipeline,
			undefined,
			() => scope,
		);
		await embedder.embed("warm up");

		expect(fakePipeline).toHaveBeenCalledOnce();
	});
});

describe("transformersFetchScope", () => {
	it("resolves the REAL transformers.js env.fetch knob", () => {
		// Not a fake: if the library ever moves `env.fetch`, metering would
		// silently stop and the banner would freeze again. That must fail here.
		expect(typeof transformersFetchScope().fetch).toBe("function");
		expect(transformersFetchScope().fetch).toBe(
			(env as unknown as FetchScope).fetch,
		);
	});
});

describe("ORT wasm loader self-hosting (house standard §8.1b)", () => {
	it("configureOrtWasmPaths points the loader at the same-origin /ort/ copy", () => {
		const fakeOrt: OrtWasmEnvLike = {};
		configureOrtWasmPaths(fakeOrt);
		expect(fakeOrt.wasmPaths).toEqual({
			mjs: "/ort/ort-wasm-simd-threaded.mjs",
			wasm: "/ort/ort-wasm-simd-threaded.wasm",
		});
	});

	it("turns off the transformers.js wasm cache (its blob: factory import breaks the CSP)", () => {
		// With an object wasmPaths, transformers.js would re-import the loader
		// from a blob: URL, which `script-src 'self'` rejects.
		expect(env.useWasmCache).toBe(false);
	});

	it("disables remote model fallback so a missing local weight fails closed (no HF fetch)", () => {
		// allowRemoteModels defaults to true in transformers.js — a missing local
		// weight would then be fetched from an UNPINNED model on huggingface.co. For
		// an AML tool that is unacceptable; the module-load side effect pins it off.
		expect(env.allowRemoteModels).toBe(false);
	});

	it("importing the embedder wires the REAL env.backends.onnx.wasm knob", () => {
		// Not a fake: this asserts the module-load side effect reached the live
		// transformers.js env, so onnxruntime-web dynamic-imports its wasm loader
		// from the staged same-origin /ort/ copy instead of the jsDelivr CDN. If
		// transformers.js ever moves the knob, this fails here — not in prod.
		const backends = env.backends as { onnx?: { wasm?: OrtWasmEnvLike } };
		expect(backends.onnx?.wasm?.wasmPaths).toEqual({
			mjs: "/ort/ort-wasm-simd-threaded.mjs",
			wasm: "/ort/ort-wasm-simd-threaded.wasm",
		});
	});
});

describe("embedder pipeline caching + dimension guard", () => {
	it("loads the pipeline once and reuses the extractor across embeds", async () => {
		const load = vi.fn(async () => {
			return async (): Promise<{ data: ArrayLike<number> }> => ({
				data: new Float32Array(384),
			});
		});
		const embedder = createEmbedderWith(load);
		await embedder.embed("first query");
		await embedder.embed("second query");
		// The heavy load ran exactly once; the second embed reused the extractor.
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("fail-closes on an embedding of the wrong dimension", async () => {
		const embedder = createEmbedderWith(async () => {
			return async (): Promise<{ data: ArrayLike<number> }> => ({
				data: new Float32Array(3),
			});
		});
		await expect(embedder.embed("query")).rejects.toThrow(
			/has 3 dims; expected 384/,
		);
	});
});

describe("pipeline options", () => {
	it("pins the shared dtype and omits progress_callback when no sink is wired", async () => {
		const { createEmbedderWithPipeline } = await import("./embedder");
		const load = vi.fn(async (_task: string, _model: string) => {
			return async (): Promise<{ data: ArrayLike<number> }> => ({
				data: new Float32Array(384),
			});
		});
		const embedder = createEmbedderWithPipeline(load);
		await embedder.embed("warm up");

		// No sink → the options carry ONLY the pinned dtype; a progress_callback
		// key must not appear (transformers.js treats its presence as opt-in).
		expect(load).toHaveBeenCalledWith("feature-extraction", EMBEDDING_MODEL, {
			dtype: EMBEDDING_DTYPE,
		});
	});

	it("createEmbedder builds a lazy embedder (no model load at construction)", () => {
		// The real ~23 MB pipeline is only loaded on the first embed; constructing
		// the default embedder must be free and synchronous.
		const embedder = createEmbedder();
		expect(typeof embedder.embed).toBe("function");
	});
});

describe("ortWasmEnv fail-loud (missing onnx wasm backend)", () => {
	it("importing against an env with no onnx.wasm node throws, not silently no-ops", async () => {
		// FAIL LOUD: a transformers.js env whose backends tree lacks the onnx.wasm
		// node must make the module-load side effect THROW — a silent inert `{}`
		// there would leave wasmPaths unset and let onnxruntime-web dynamic-import
		// its loader from the jsDelivr CDN (the §8.1b dependency this self-host
		// kills). A missing knob means the library moved it; that fails here.
		vi.resetModules();
		vi.doMock("@huggingface/transformers", () => ({
			env: { backends: {} },
			pipeline: vi.fn(),
		}));
		await expect(import("./embedder")).rejects.toThrow(
			/env\.backends\.onnx\.wasm.*unavailable/is,
		);
		vi.doUnmock("@huggingface/transformers");
		vi.resetModules();
	});
});
