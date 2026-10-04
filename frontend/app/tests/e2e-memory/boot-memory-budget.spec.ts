import { expect, test } from "@playwright/test";
import { WasmMemoryTracker } from "./wasmMemory";

/**
 * Regression guard for "Browser memory limit reached" on iPhone Safari
 * (`[wasm] RangeError: Out of memory`, 2026-10-03).
 *
 * Two properties, both measured in the production build over the real bundle:
 *
 * 1. ORDER. The ONNX/WASM model must be built BEFORE any signed-list bytes are
 *    downloaded, so its largest WebAssembly allocation lands on an empty tab
 *    rather than on top of the verified list + SQLite index. Deterministic: the
 *    model file request must start before the first list chunk request.
 * 2. BUDGET. Total WebAssembly.Memory across the page's workers at "ready" stays
 *    under WASM_BUDGET_BYTES. Wasm memory never shrinks, so this is the floor the
 *    tab carries for its lifetime. Measured 2026-10-03: ~166 MB (ORT 78, SQLite
 *    72, bundle store 16). The ceiling is 256 MB: a 2 GB iPhone's Safari tab is
 *    jetsammed near 0.6-0.7 GB of total footprint, and wasm is the part that
 *    cannot be reclaimed, so more than a quarter-GB of it is already too much.
 */
const CDP_PORT = Number(process.env.E2E_MEMORY_CDP_PORT ?? 9341);
const WASM_BUDGET_BYTES = 256 * 1024 * 1024;

test("model loads before the list bytes, and wasm memory stays inside the phone budget", async ({
	page,
	context,
}) => {
	test.setTimeout(240_000);
	const starts: { readonly url: string; readonly at: number }[] = [];
	context.on("request", (r) =>
		starts.push({ url: r.url(), at: starts.length }),
	);

	const tracker = await WasmMemoryTracker.connect(CDP_PORT);
	await page.goto("/screen");
	const search = page.getByLabel("Search the sanctions list", { exact: true });
	await expect(search).toBeEnabled({ timeout: 180_000 });

	const model = starts.findIndex((s) => s.url.includes("model_quantized.onnx"));
	const chunk = starts.findIndex((s) =>
		s.url.includes("/bundle/origin/chunk/"),
	);
	expect(model, "the model file was requested").toBeGreaterThanOrEqual(0);
	expect(chunk, "a list chunk was requested").toBeGreaterThanOrEqual(0);
	expect(model, "model before list bytes").toBeLessThan(chunk);

	const wasm = await tracker.totalBytes();
	tracker.close();
	// Not vacuous: the tracker must have seen the ORT + SQLite heaps (>= 100 MB).
	expect(wasm, "wasm tracker saw the engine heaps").toBeGreaterThan(
		100 * 1024 * 1024,
	);
	expect(
		wasm,
		`wasm bytes at ready (budget ${WASM_BUDGET_BYTES})`,
	).toBeLessThan(WASM_BUDGET_BYTES);
});
