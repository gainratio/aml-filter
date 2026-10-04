// Preflight regression suite for the ORT wasm runtime staging
// (stage-ort-wasm.mjs) plus the Cloudflare Pages deploy-size preflight
// (house standard §8.1b). Offline by construction: everything resolves from the
// lockfile-pinned node_modules and the download-model.mjs pinned manifest — no
// network.

import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODEL_FILES } from "./download-model.mjs";
import {
	ORT_RUNTIME_FILES,
	ortDir,
	ortDistDir,
	stageOrtWasm,
} from "./stage-ort-wasm.mjs";

/** Cloudflare Pages rejects any single static asset over 25 MiB. */
const PAGES_ASSET_LIMIT_BYTES = 25 * 1024 * 1024;

describe("stage-ort-wasm", () => {
	it("stages exactly the plain (non-asyncify) loader + wasm pair", () => {
		// The asyncify build only serves the WebGPU EP, which this app never uses,
		// and since onnxruntime-web 1.31 its .wasm (26.9 MB) is over the Pages
		// limit. The plain build is the CPU wasm EP, at ~14 MB.
		expect(ORT_RUNTIME_FILES).toEqual([
			"ort-wasm-simd-threaded.mjs",
			"ort-wasm-simd-threaded.wasm",
		]);
	});

	it("ortDir stages under the app's public/ort (served same-origin at /ort/)", () => {
		expect(ortDir().endsWith(join("app", "public", "ort"))).toBe(true);
	});

	it("the lockfile-pinned onnxruntime-web ships both runtime files", async () => {
		const dist = ortDistDir();
		for (const file of ORT_RUNTIME_FILES) {
			const info = await stat(join(dist, file));
			expect(info.size, `${file} is empty`).toBeGreaterThan(0);
		}
	});

	it("copies the pair byte-identically into the destination", async () => {
		const dest = join(tmpdir(), `ort-stage-test-${process.pid}`);
		try {
			await stageOrtWasm(dest);
			const dist = ortDistDir();
			for (const file of ORT_RUNTIME_FILES) {
				const [got, want] = await Promise.all([
					readFile(join(dest, file)),
					readFile(join(dist, file)),
				]);
				expect(got.equals(want), `${file} differs from node_modules`).toBe(
					true,
				);
			}
		} finally {
			await rm(dest, { recursive: true, force: true });
		}
	});

	it("fails loudly when a source file is missing", async () => {
		const dest = join(tmpdir(), `ort-stage-test-missing-${process.pid}`);
		try {
			await expect(
				stageOrtWasm(dest, join(tmpdir(), "definitely-not-ort-dist")),
			).rejects.toThrow(/ENOENT/);
		} finally {
			await rm(dest, { recursive: true, force: true });
		}
	});
});

describe("Cloudflare Pages 25 MiB asset-size preflight (§8.1b)", () => {
	it("every staged ORT runtime file fits under the Pages limit", async () => {
		// Pages rejects any single asset over 25 MiB. An onnxruntime-web bump
		// that outgrows it must fail HERE in CI, not on deploy.
		const dist = ortDistDir();
		for (const file of ORT_RUNTIME_FILES) {
			const info = await stat(join(dist, file));
			expect(
				info.size,
				`${file} (${info.size} B) exceeds the Pages limit (${PAGES_ASSET_LIMIT_BYTES} B)`,
			).toBeLessThan(PAGES_ASSET_LIMIT_BYTES);
		}
	});

	it("every pinned model file fits under the Pages limit", () => {
		// The self-hosted MiniLM weights ride the same deploy: a model bump whose
		// pinned size outgrows the limit must fail here, not on deploy. The pins
		// are the download script's own sha256-verified manifest, so this stays
		// offline-deterministic.
		for (const file of MODEL_FILES) {
			expect(
				file.size,
				`${file.path} (pinned ${file.size} B) exceeds the Pages limit (${PAGES_ASSET_LIMIT_BYTES} B)`,
			).toBeLessThan(PAGES_ASSET_LIMIT_BYTES);
		}
	});
});
