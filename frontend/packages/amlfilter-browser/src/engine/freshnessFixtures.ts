// Test-only freshness fixtures.
//
// A NEW-FORMAT catalog entry / `meta.json` carries a per-list freshness block
// (see `ListFreshness` in watchlist.ts). That makes freshness part of the
// literal shape of every catalog fixture in this package, so it lives here once
// instead of being retyped in five test files.
//
// TWO SHAPES, deliberately. `FRESH` is the WIRE block a publisher
// stages. `FRESH_RESOLVED` is what the bundle path projects onto a catalog entry
// after the shared rule runs — the same fields plus `agedFrom`, which records
// WHICH instant the age came from. A pre-per-list-freshness bundle carries no
// wire block at all and resolves with `agedFrom: "generatedAt"`.
//
// NOT exported from any production barrel — imported only by *.test.ts files.
// Deliberately free of `node:` imports so jsdom-environment specs can use it.

import type { ListFreshness, ResolvedListFreshness } from "./watchlist";

/** A list refreshed successfully this run: fresh, no reason. */
export const FRESH: ListFreshness = {
	fetchedAt: "2026-08-01T00:00:00Z",
	sourceUpdatedAt: "2026-07-31T00:00:00Z",
	stale: false,
	staleReason: null,
};

/** {@link FRESH} as a PROJECTED catalog entry carries it. */
export const FRESH_RESOLVED: ResolvedListFreshness = {
	...FRESH,
	agedFrom: "fetchedAt",
};
