/**
 * The live smoke's probes, kept free of Playwright so a Vitest contract can
 * check them against what the app renders (src/__tests__/liveSmokeProbes.contract.test.ts).
 * The live smoke only runs after a deploy, so a probe that drifts from the UI
 * is otherwise first caught in production.
 */

import common from "../../src/locales/en/common.json" with { type: "json" };

/** One known designation per list: the name a user types, the designated name
 * the match renders, and the list it must be tagged with. Chosen from the live
 * catalog (2026-09-25) as long-standing, high-profile designations. */
export interface ListProbe {
	readonly list: string;
	readonly query: string;
	readonly name: RegExp;
	/** The designation's published identifiers, entered as an analyst would. */
	readonly dob?: string;
	readonly country?: string;
}

export const LIST_PROBES: readonly ListProbe[] = [
	{
		list: "OFAC_SDN",
		query: "Maduro Moros Nicolas",
		name: /maduro moros nicolas/i,
		dob: "1962-11-23",
		country: "VE",
	},
	{
		list: "EU_CONSOLIDATED",
		query: "Roman Abramovich",
		name: /roman abramovi/i,
		dob: "1966-10-24",
		country: "RU",
	},
	{
		list: "UN_CONSOLIDATED",
		query: "Kim Jong Sik",
		name: /kim jong sik/i,
		country: "KP",
	},
	// A UK Sanctions List (FCDO) asset-freeze designation — the list that was
	// silently carried forward for weeks.
	{
		list: "UK_OFSI",
		query: "Igor Ivanovich Sechin",
		name: /igor ivanovich sechin/i,
		dob: "1960-09-07",
		country: "RU",
	},
];

/** The public /screen route screens OFAC only, by design (ScreenPage.tsx). */
export const SCREEN_PROBE: ListProbe = {
	list: "OFAC_SDN",
	query: "Nicolas Maduro Moros",
	name: /maduro moros nicolas/i,
};

const LIST_LABELS: Readonly<Record<string, string>> = common.labels.lists;

/** The source-list badge a Review Board row shows for a list: its plain name
 * from the same English strings the app renders (plainLabels.listName), falling
 * back to the code for a list with no label, exactly as the app does. */
export function reviewBadgeText(list: string): string {
	return LIST_LABELS[list] ?? list;
}
