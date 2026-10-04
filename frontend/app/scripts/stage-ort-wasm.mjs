// Prebuild: self-host the onnxruntime-web wasm runtime so the browser never
// pulls it from jsDelivr at runtime (house standard §8.1b — zero runtime CDN).
//
// onnxruntime-web (pulled by @huggingface/transformers) dynamically imports its
// wasm LOADER MODULE at runtime — `ort-wasm-simd-threaded.asyncify.mjs`, which
// then fetches its sibling `.wasm` relative to its own URL — and the library's
// default base for that import is the jsDelivr CDN. The cold-CDN-blocked audit
// on this repo caught exactly that: with jsDelivr aborted, /screen never
// reached ready, and the recorded blocked fetches were precisely
// `cdn.jsdelivr.net/npm/onnxruntime-web@…/dist/ort-wasm-simd-threaded.asyncify.{mjs,wasm}`.
// The old cold spec blocked HuggingFace globs only, so the dependency was
// invisible to every lane until jsDelivr itself was aborted.
//
// The fix pair: `env.backends.onnx.wasm.wasmPaths = "/ort/"` (set in
// packages/amlfilter-browser/src/engine/embedder.ts) makes the runtime import
// same-origin, and THIS script materializes those files into app/public/ort/
// by copying them out of the LOCKFILE-PINNED node_modules copy of
// onnxruntime-web — the exact bytes pnpm resolved, no network, fully
// deterministic. Runs from the app's `prebuild` hook, so every e2e lane's
// `pnpm build && vite preview` webServer stages it too; the staged files are
// git-ignored like the model weights.
//
// Only the plain (non-asyncify) pair is staged: embedder.ts names it explicitly
// as `wasmPaths = { mjs, wasm }`. The asyncify build exists for the WebGPU EP,
// which this app never uses, and since onnxruntime-web 1.31 its .wasm (26.9 MB)
// is over the Cloudflare Pages 25 MiB per-file limit. If onnxruntime-web ever
// asks for a different variant, the cold-blocked e2e fails loudly and this list
// grows.

import { copyFile, mkdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The runtime files onnxruntime-web requests from `wasmPaths` at runtime. */
export const ORT_RUNTIME_FILES = Object.freeze([
	"ort-wasm-simd-threaded.mjs",
	"ort-wasm-simd-threaded.wasm",
]);

const here = dirname(fileURLToPath(import.meta.url));

/** Where the staged runtime lands: app/public/ort/<file>. */
export function ortDir() {
	return join(here, "..", "public", "ort");
}

/**
 * The dist/ directory of the onnxruntime-web copy the lockfile pinned.
 * Resolved THROUGH @huggingface/transformers (its direct dependent — pnpm's
 * strict layout hides transitive deps from the app itself) so the staged bytes
 * are exactly the ones the bundled transformers.js will request. Both packages
 * fence their `exports`, so the MAIN entry is resolved and the package root is
 * derived from its path.
 */
export function ortDistDir() {
	const req = createRequire(join(here, "..", "package.json"));
	const transformersMain = req.resolve("@huggingface/transformers");
	const ortMain = createRequire(transformersMain).resolve("onnxruntime-web");
	const marker = `${sep}node_modules${sep}onnxruntime-web${sep}`;
	const at = ortMain.lastIndexOf(marker);
	if (at === -1) {
		throw new Error(
			`cannot locate onnxruntime-web package root from ${ortMain}`,
		);
	}
	return join(ortMain.slice(0, at + marker.length), "dist");
}

/** Copy the runtime pair into `destDir`; fail loudly if a source is missing. */
export async function stageOrtWasm(destDir, srcDir) {
	const from = srcDir ?? ortDistDir();
	await mkdir(destDir, { recursive: true });
	for (const file of ORT_RUNTIME_FILES) {
		const src = join(from, file);
		const size = (await stat(src)).size; // throws loudly if absent
		await copyFile(src, join(destDir, file));
		console.log(`  stage  ${file} (${size} bytes, from node_modules)`);
	}
	console.log("ORT wasm runtime staged (same-origin, no runtime CDN).");
}

// Invoked as a script (the `prebuild` hook); a bare import stays side-effect
// free so the vitest preflight suite can exercise the pieces.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await stageOrtWasm(ortDir());
}
