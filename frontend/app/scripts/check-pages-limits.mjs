// Postbuild: refuse a build Cloudflare Pages would refuse to upload.
//
// Cloudflare Pages direct upload caps every file at 25 MiB and a deployment at
// 20,000 files (https://developers.cloudflare.com/pages/platform/limits/).
// Release PR #185 (2026-10-04) shipped CI-green with a 26,861,777-byte
// `assets/ort-wasm-simd-threaded.asyncify-*.wasm` in dist/, and only the
// production upload noticed. Running as the app's `postbuild` hook puts this
// check in every build: `pnpm gate` (and so the Dagger `quality` check in PR
// CI), every e2e webServer build, and the deploy pipeline's own app build.

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_PAGES_UPLOAD_FILE_BYTES = 26_214_400; // 25 MiB
export const MAX_PAGES_UPLOAD_FILE_COUNT = 20_000;

/** Every file under `root`, as `{ path, bytes }` with `path` relative to root. */
export function listFiles(root, dir = root) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listFiles(root, full));
		else out.push({ path: relative(root, full), bytes: statSync(full).size });
	}
	return out;
}

/** Throw, naming the offenders, when Cloudflare Pages would reject the upload. */
export function assertPagesUploadLimits(entries) {
	if (entries.length > MAX_PAGES_UPLOAD_FILE_COUNT) {
		throw new Error(
			`Cloudflare Pages upload exceeds the ${MAX_PAGES_UPLOAD_FILE_COUNT}-file limit: ${entries.length} files`,
		);
	}
	const oversize = entries.filter((e) => e.bytes > MAX_PAGES_UPLOAD_FILE_BYTES);
	if (oversize.length > 0) {
		const detail = oversize.map((e) => `${e.path} (${e.bytes} bytes)`).join(", ");
		throw new Error(
			`Cloudflare Pages upload exceeds the ${MAX_PAGES_UPLOAD_FILE_BYTES}-byte per-file limit: ${detail}`,
		);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const root = process.argv[2] ?? "dist";
	const entries = listFiles(root);
	try {
		assertPagesUploadLimits(entries);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
	const largest = entries.reduce((max, e) => (e.bytes > max.bytes ? e : max));
	console.log(
		`Cloudflare Pages upload within limits: ${entries.length} files, largest ${largest.path} (${largest.bytes} bytes)`,
	);
}
