import { expect, type Page, test } from "@playwright/test";
import { WasmMemoryTracker } from "./wasmMemory";

/**
 * Regression guard for "Browser memory limit reached" on iPhone Safari
 * (`[wasm] RangeError: Out of memory`, 2026-10-03).
 *
 * Three properties, all measured in the production build over the real bundle:
 *
 * 1. ORDER. The ONNX/WASM model must be built BEFORE any signed-list bytes are
 *    downloaded, so its largest WebAssembly allocation lands on an empty tab
 *    rather than on top of the verified list + SQLite index. Deterministic: the
 *    runtime sets the User Timing mark "aml:model-ready" once the embedder
 *    warmup has FINISHED, and the first list chunk request is held at the
 *    network layer while the test reads whether that mark already exists.
 *    "Model request started first" is not enough: a runtime that fires the
 *    model download and then streams list chunks alongside it passes that.
 * 2. BUDGET. Total WebAssembly.Memory across the page's workers at "ready" stays
 *    under WASM_BUDGET_BYTES. Wasm memory never shrinks, so this is the floor the
 *    tab carries for its lifetime. Measured 2026-10-03: 166 MB with the index in
 *    memory (ORT 78, SQLite 72, bundle store 16), 102 MB with the persistent
 *    OPFS index. The ceiling is 128 MB, so moving the index back into wasm heap
 *    (166 MB) fails here even if the storage-mode checks were bypassed. A 2 GB
 *    iPhone's Safari tab is jetsammed near 0.6-0.7 GB of total footprint, and
 *    wasm is the part that cannot be reclaimed.
 *
 * 3. PERSISTENT INDEX. The sanctions vector index is a persistent SQLite file on
 *    OPFS (SQLite's own page cache, sized by memoryProfile "auto"), not an
 *    in-memory database inside the wasm heap. Proven two ways: the app reports
 *    storage mode "opfs" (not "memory-fallback") and the OPFS directory the
 *    vector worker owns actually holds the index bytes.
 */
const CDP_PORT = Number(process.env.E2E_MEMORY_CDP_PORT ?? 9341);
/** Set by EngineRuntime when the embedder warmup has finished (MODEL_READY_MARK). */
const MODEL_READY_MARK = "aml:model-ready";
const LIST_CHUNK = /\/bundle\/(live|origin)\/chunk\//;
const WASM_BUDGET_BYTES = 128 * 1024 * 1024;
/** The phone-scope index is ~48 MB; anything under 1 MB means it is not on disk. */
const MIN_PERSISTED_INDEX_BYTES = 1024 * 1024;

/** Total bytes of every file under OPFS directories named like the vector worker's pool. */
async function opfsVectorBytes(page: Page): Promise<number> {
	return page.evaluate(async () => {
		type Dir = FileSystemDirectoryHandle & {
			values(): AsyncIterable<FileSystemHandle>;
		};
		const walk = async (dir: Dir, inPool: boolean): Promise<number> => {
			let bytes = 0;
			for await (const entry of dir.values()) {
				const pooled = inPool || entry.name.includes("edgeproc-vector-");
				if (entry.kind === "directory") {
					bytes += await walk(entry as Dir, pooled);
				} else if (pooled) {
					bytes += (await (entry as FileSystemFileHandle).getFile()).size;
				}
			}
			return bytes;
		};
		return walk((await navigator.storage.getDirectory()) as Dir, false);
	});
}

test("model is ready before the list bytes, and wasm memory stays inside the phone budget", async ({
	page,
	context,
}) => {
	test.setTimeout(240_000);
	const starts: { readonly url: string; readonly at: number }[] = [];
	context.on("request", (r) =>
		starts.push({ url: r.url(), at: starts.length }),
	);
	// Hold the FIRST list chunk request until we have read, in the page, whether
	// the embedder had already finished. Only the first one matters: every later
	// chunk is after it.
	let modelReadyAtFirstChunk: boolean | undefined;
	await context.route(LIST_CHUNK, async (route) => {
		if (modelReadyAtFirstChunk === undefined) {
			modelReadyAtFirstChunk = await page.evaluate(
				(mark) => performance.getEntriesByName(mark).length > 0,
				MODEL_READY_MARK,
			);
		}
		await route.continue();
	});

	const tracker = await WasmMemoryTracker.connect(CDP_PORT);
	await page.goto("/screen");
	const search = page.getByLabel("Search the sanctions list", { exact: true });
	await expect(search).toBeEnabled({ timeout: 180_000 });

	const model = starts.findIndex((s) => s.url.includes("model_quantized.onnx"));
	const chunk = starts.findIndex((s) => LIST_CHUNK.test(s.url));
	expect(model, "the model file was requested").toBeGreaterThanOrEqual(0);
	expect(chunk, "a list chunk was requested").toBeGreaterThanOrEqual(0);
	expect(model, "model request before list bytes").toBeLessThan(chunk);
	expect(
		modelReadyAtFirstChunk,
		"the embedder was READY (warmup finished) before the first list chunk was fetched",
	).toBe(true);

	await expect(page.locator("html")).toHaveAttribute(
		"data-aml-index-storage",
		"opfs",
	);
	await expect(page.getByTestId("index-fallback-notice")).toHaveCount(0);
	const persisted = await opfsVectorBytes(page);
	expect(persisted, "index bytes are persisted in OPFS").toBeGreaterThan(
		MIN_PERSISTED_INDEX_BYTES,
	);

	const wasm = await tracker.totalBytes();
	tracker.close();
	test.info().annotations.push({
		type: "wasm-mb",
		description: String(Math.round(wasm / 1048576)),
	});
	console.log(
		`wasm at ready: ${Math.round(wasm / 1048576)} MB, persisted index: ${Math.round(persisted / 1048576)} MB`,
	);
	// Not vacuous: the tracker must have seen the ORT + SQLite heaps (>= 100 MB).
	expect(wasm, "wasm tracker saw the engine heaps").toBeGreaterThan(
		100 * 1024 * 1024,
	);
	expect(
		wasm,
		`wasm bytes at ready (budget ${WASM_BUDGET_BYTES})`,
	).toBeLessThan(WASM_BUDGET_BYTES);
});
