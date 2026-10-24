// syncLiveBundle — mirror the REAL signed production watchlists for local runs.
//
// The committed app/public/bundle/origin is a tiny fictional fixture so tests
// and cold clones work offline. This pulls the live OFAC / UN / EU / UK bundle
// through mirrorPublishedOrigin — the deploy's fail-closed verifier (signed
// pointer -> manifest content-address -> every chunk) — pinned to the app's
// production trust root, into the gitignored app/public/bundle/live. The app
// reads it under `vite --mode live` (app/.env.live sets VITE_BUNDLE_BASE_URL).
// No age ceiling: a local mirror reports the list's real age instead.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_LIVE_BUNDLE_BASE_URL = "https://aml-filter.com/bundle/origin";

/**
 * Overridable so the memory e2e lane can mirror the SAME production artifact
 * through the Pages origin when the custom domain is behind a bot challenge.
 * The default stays the canonical domain for local `dev:live`.
 */
export const LIVE_BUNDLE_BASE_URL =
	process.env.AML_FILTER_LIVE_BUNDLE_BASE_URL ?? DEFAULT_LIVE_BUNDLE_BASE_URL;

const APP_PUBLIC = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"app",
	"public",
);

/** The production trust root the SPA pins — the live bundle's signer. */
export function productionPubkeyPath(): string {
	return join(APP_PUBLIC, "public.key");
}

/** Gitignored target served same-origin at /bundle/live. */
export function liveBundleOutDir(): string {
	return join(APP_PUBLIC, "bundle", "live");
}

/** Mirror CLI argv: defaults first, caller `--flag value` pairs override. */
export function liveBundleArgv(overrides: ReadonlyArray<string>): string[] {
	return [
		"--base-url",
		LIVE_BUNDLE_BASE_URL,
		"--pubkey",
		productionPubkeyPath(),
		"--out",
		liveBundleOutDir(),
		...overrides,
	];
}
