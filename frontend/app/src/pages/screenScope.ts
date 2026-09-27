/**
 * Which lists the public /screen search covers, per device.
 *
 * The home page promises four lists (US OFAC, EU, UN, UK), so a desktop searches
 * all of them. Measured against the live bundle (2026-09-26, 32,325 entries):
 * all four eager cost +161 MB RSS and +1.2 s cold boot over OFAC-only, with
 * 0.3–0.8 s searches. Phones start on US OFAC only: loading all four eagerly is
 * what ran iOS Safari out of memory before (PR #71), and the bounded streaming
 * mode takes ~8 s per search (each list is re-read and re-verified one at a
 * time), too slow for search-as-you-type. A phone can still opt in to all four
 * with one tap, which uses that bounded streaming mode.
 */
import type { RuntimeSelection } from "@amlfilter/browser";
import {
	type BrowserMemorySignals,
	isMobileBrowser,
} from "../lib/memoryPolicy";

export type ScreenScope = "all-lists" | "us-only" | "all-lists-streaming";

/** The list the US-only scope screens against. */
export const US_LIST_ID = "OFAC_SDN";

/** Desktop → every list; phone or tablet → US OFAC only, until the user opts in. */
export function initialScreenScope(
	signals?: BrowserMemorySignals,
): ScreenScope {
	return isMobileBrowser(signals) ? "us-only" : "all-lists";
}

/** The runtime selection for a scope. No `enabledLists` = every catalog list. */
export function screenSelection(scope: ScreenScope): RuntimeSelection {
	if (scope === "us-only") {
		return { enabledLists: [US_LIST_ID], residency: "eager" };
	}
	return { residency: scope === "all-lists" ? "eager" : "streaming" };
}
