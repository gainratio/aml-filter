/// <reference types="vitest/config" />
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { configDefaults } from "vitest/config";
import { resolveOrtAsset } from "./src/dev/ortDevAsset";
import {
	cspFromHeadersFile,
	localhostPreviewCsp,
} from "./src/dev/previewHeaders";

const APP_ROOT = dirname(fileURLToPath(import.meta.url));

// DEV-ONLY: serve the staged onnxruntime-web runtime under /ort/ as raw files.
// In production /ort/ is plain static output and its loader module dynamic-
// imports cleanly, but the dev server routes .mjs requests through the module
// pipeline and refuses to import files that live in public/ ("can only be
// referenced via HTML tags"). Serving them raw here keeps dev === prod: the
// embedder's `wasmPaths = "/ort/"` works on the dev server too, so even local
// dev never touches the jsDelivr CDN (house standard §8.1b). The request path is
// run through resolveOrtAsset, which rejects anything that escapes the staged
// /ort dir via `..` traversal (unit-tested in src/dev/ortDevAsset.test.ts).
function serveOrtRuntimeRawInDev(): Plugin {
	const publicDir = join(APP_ROOT, "public");
	return {
		name: "amlfilter:serve-ort-runtime-raw",
		apply: "serve",
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const urlPath = (req.url ?? "").split("?")[0];
				const asset = resolveOrtAsset(publicDir, urlPath);
				if (asset === null) {
					next();
					return;
				}
				readFile(asset.file).then(
					(bytes) => {
						res.setHeader("Content-Type", asset.contentType);
						res.end(bytes);
					},
					() => next(),
				);
			});
		},
	};
}

// Preview fidelity: Cloudflare Pages applies public/_headers in production,
// but plain `vite preview` serves no CSP. Reusing the actual catch-all policy
// makes every minified production E2E lane exercise the same network and
// WebAssembly restrictions as the deployed site. This is preview-only;
// `vite dev` needs its own inline React-refresh allowances.
function previewProdCspPlugin(): Plugin {
	return {
		name: "amlfilter:preview-prod-csp",
		configurePreviewServer(server) {
			const csp = localhostPreviewCsp(
				cspFromHeadersFile(
					readFileSync(join(APP_ROOT, "public/_headers"), "utf8"),
				),
			);
			server.middlewares.use((_req, res, next) => {
				res.setHeader("Content-Security-Policy", csp);
				next();
			});
		},
	};
}

// LOCAL-SERVER ONLY: serve the verify key that matches the bundle we actually serve.
//
// Two different Ed25519 keys are in play, on purpose:
//   • public/bundle/origin/  — the committed DEMO bundle, signed with the throwaway
//     demo key (packages/amlfilter-publisher/fixtures/demo-public.key).
//   • public/public.key      — the PRODUCTION trust root, deliberately NOT the demo
//     key (packages/amlfilter-publisher/src/signing.test.ts asserts they differ).
//
// A local `vite dev` / `vite preview` server can only ever serve the committed demo
// bundle, so it must serve the demo verify key at /public.key or the in-tab verifier
// fails closed and /screen never boots. That is exactly what happened on a cold
// clone: the browser fetched the prod pin, the demo bundle failed to verify, and the
// user got "Local screening engine unavailable" with no way forward. The e2e lanes
// hid it because each one opted in via an env var the documented human path never set.
//
// This is a LOCAL SERVER concern only, and it changes no shipped byte: `vite build`
// copies the real public/public.key into dist/ untouched, and the deploy workflow
// republishes the bundle signed with the PROD key — so the deployed site always pairs
// the production bundle with the production pin. The banner keeps it non-silent, so a
// trust root swapped under you is never something you have to infer.
function localDemoPubkeyPin(): Plugin {
	const demoPubkey = join(
		APP_ROOT,
		"..",
		"packages",
		"amlfilter-publisher",
		"fixtures",
		"demo-public.key",
	);
	const serveDemoPubkey = (
		req: { url?: string | undefined },
		res: {
			setHeader: (k: string, v: string) => void;
			end: (b: Buffer) => void;
		},
		next: () => void,
	): void => {
		if ((req.url ?? "").split("?")[0] !== "/public.key") {
			next();
			return;
		}
		res.setHeader("Content-Type", "application/octet-stream");
		res.end(readFileSync(demoPubkey));
	};
	// Announce at server start through Vite's own logger, NEVER from inside the
	// request handler. A first-request `console.info` here wedged the mobile lane:
	// /settings hung on "Loading settings…" forever, deterministically, with a clean
	// browser console and a byte-identical network trace. Logging is not free when it
	// sits in the path that serves the trust root the engine boot is blocked on, so
	// this stays a startup-time statement about configuration — which is what it is.
	// Vitest also loads this config; it has no dev server to narrate, so it stays quiet.
	const announce = (logger: { info: (msg: string) => void }): void => {
		if (process.env.VITEST !== undefined) {
			return;
		}
		logger.info(
			"[aml-filter] local server: serving the DEMO verify key at /public.key " +
				"(it pairs with the committed demo bundle). Production ships public/public.key.",
		);
	};
	return {
		name: "amlfilter:local-demo-pubkey-pin",
		configureServer(server) {
			announce(server.config.logger);
			server.middlewares.use(serveDemoPubkey);
		},
		configurePreviewServer(server) {
			announce(server.config.logger);
			server.middlewares.use(serveDemoPubkey);
		},
	};
}

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [
		react(),
		serveOrtRuntimeRawInDev(),
		previewProdCspPlugin(),
		localDemoPubkeyPin(),
	],
	build: {
		// esbuild's default build target ('modules' ≈ es2020) downlevels native
		// class private fields (#load/#extract in the embedder) to a WeakMap-based
		// accessor. transformers.js's own minified worker hits that mis-compiled
		// path and throws `Ke(...).call is not a function` the instant the model
		// loads — only in the minified production build, which is why the Node and
		// dev-server paths never caught it. es2022 keeps native private fields, so
		// the accessor is emitted as a real `#field` and the worker boots. (Mirrors
		// edge-reco's app tsconfig target = es2023, where the identical embedder
		// works.)
		target: "es2022",
		rolldownOptions: {
			input: {
				main: join(APP_ROOT, "index.html"),
				screen: join(APP_ROOT, "screen.html"),
				customers: join(APP_ROOT, "customers.html"),
				review: join(APP_ROOT, "review.html"),
				settings: join(APP_ROOT, "settings.html"),
			},
		},
	},
	optimizeDeps: {
		// sqlite-wasm resolves its .wasm + helper assets relative to its own
		// module URL; esbuild pre-bundling breaks that resolution (official
		// @sqlite.org/sqlite-wasm guidance for Vite).
		exclude: ["@sqlite.org/sqlite-wasm"],
		// The landing page reads the signed catalog on first paint, which reaches
		// the bundle-sync worker's import of this entry. Left to runtime discovery,
		// Vite optimizes it mid-page and force-reloads ("optimized dependencies
		// changed. reloading"), which destroyed the receipt lane's page.evaluate
		// context on a cold dep cache (CI). Pre-bundle it at server start instead.
		include: ["@amlfilter/browser > @edgeproc/browser/worker"],
	},
	worker: {
		// The DB worker imports the sqlite-wasm ES module; classic-script
		// worker bundling cannot. The engine workers are already module
		// workers, so this is a no-op for them.
		format: "es",
	},
	server: {
		port: 5173,
	},
	preview: {
		allowedHosts: ["preview"],
	},
	test: {
		environment: "jsdom",
		globals: true,
		setupFiles: ["./src/test/setup.ts"],
		// Playwright owns tests/ (e2e). The build scripts in scripts/ are split by
		// runner, not by directory: the *.test.ts specs there are ordinary Vitest
		// unit tests and must run here, while the *.test.mjs files are node:test
		// contract suites run by `pnpm test:contract` (node --test). Vitest cannot
		// load those — it fails with `Cannot bundle Node.js built-in "node:test"` —
		// so exclude the .mjs contract files specifically. Excluding all of
		// scripts/** to dodge that error silently drops five real unit-test files.
		exclude: [...configDefaults.exclude, "tests/**", "scripts/**/*.test.mjs"],
		// House standard §2 floors, enforced because the gate's test step runs with --coverage.
		coverage: {
			thresholds: { statements: 90, lines: 90, functions: 90, branches: 85 },
		},
	},
});
