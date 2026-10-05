// @vitest-environment node
// The Cloudflare Pages per-file upload ceiling, enforced on every app build.
//
// Regression this guards (release PR #185, 2026-10-04): Dependabot bumped
// @huggingface/transformers 4.2.0 -> 4.3.0, which pulled onnxruntime-web 1.31.
// Vite started emitting `ort-wasm-simd-threaded.asyncify-*.wasm` (26,861,777
// bytes). PR CI stayed green; both production uploads then failed with
// "Pages only supports files up to 25 MiB in size".

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertPagesUploadLimits,
	listFiles,
	MAX_PAGES_UPLOAD_FILE_BYTES,
	MAX_PAGES_UPLOAD_FILE_COUNT,
} from "./check-pages-limits.mjs";

describe("Cloudflare Pages upload limits", () => {
	it("pins the documented limits (25 MiB per file, 20,000 files)", () => {
		// https://developers.cloudflare.com/pages/platform/limits/
		expect(MAX_PAGES_UPLOAD_FILE_BYTES).toBe(26_214_400);
		expect(MAX_PAGES_UPLOAD_FILE_COUNT).toBe(20_000);
	});

	it("rejects the asyncify wasm that broke the 2026-10-04 deploy, naming it", () => {
		const entries = [
			{ path: "index.html", bytes: 2_000 },
			{
				path: "assets/ort-wasm-simd-threaded.asyncify-CxOG5pUO.wasm",
				bytes: 26_861_777,
			},
		];
		expect(() => assertPagesUploadLimits(entries)).toThrow(
			/26214400-byte per-file limit: assets\/ort-wasm-simd-threaded\.asyncify-CxOG5pUO\.wasm \(26861777 bytes\)/,
		);
	});

	it("accepts a file of exactly 25 MiB and rejects one byte more", () => {
		expect(() =>
			assertPagesUploadLimits([{ path: "a.bin", bytes: 26_214_400 }]),
		).not.toThrow();
		expect(() =>
			assertPagesUploadLimits([{ path: "a.bin", bytes: 26_214_401 }]),
		).toThrow(/a\.bin \(26214401 bytes\)/);
	});

	it("rejects more than 20,000 files", () => {
		const entries = Array.from({ length: 20_001 }, (_, i) => ({
			path: `f${i}`,
			bytes: 1,
		}));
		expect(() => assertPagesUploadLimits(entries)).toThrow(
			/20000-file limit: 20001 files/,
		);
		expect(() => assertPagesUploadLimits(entries.slice(1))).not.toThrow();
	});

	it("walks nested directories and reports paths relative to the root", () => {
		const root = mkdtempSync(join(tmpdir(), "pages-limits-"));
		mkdirSync(join(root, "assets", "deep"), { recursive: true });
		writeFileSync(join(root, "index.html"), "abc");
		writeFileSync(join(root, "assets", "deep", "x.wasm"), "12345");
		const entries = listFiles(root).sort((a, b) =>
			a.path.localeCompare(b.path),
		);
		expect(entries).toEqual([
			{ path: join("assets", "deep", "x.wasm"), bytes: 5 },
			{ path: "index.html", bytes: 3 },
		]);
	});

	it("runs after every app build (gate, PR CI and deploy all build via `build`)", () => {
		const pkg = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		) as { scripts: Record<string, string> };
		expect(pkg.scripts.postbuild).toBe(
			"node scripts/check-pages-limits.mjs dist",
		);
	});
});
