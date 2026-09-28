import { describe, expect, it } from "vitest";
import { LIST_PROBES, reviewBadgeText } from "../../tests/e2e-live/probes";
import i18n from "../i18n";
import { listName } from "../lib/plainLabels";

// The post-deploy live smoke (tests/e2e-live) only runs against production,
// after a deploy, so PR CI never executes it. When #152 turned the Review Board
// source-list badge from the raw code ("OFAC_SDN") into plain words ("US OFAC"),
// the smoke kept looking for "OFAC_SDN", the deploy of 993a5de9 failed its live
// check, and production was rolled back. This contract runs in PR CI and holds
// the smoke's expectations to what the Review Board actually renders.

const t = i18n.getFixedT("en", "common");

describe("live smoke probes match the Review Board badge", () => {
	it.each(LIST_PROBES.map((probe) => [probe.list]))(
		"%s: the smoke expects the badge the Review Board renders",
		(list) => {
			expect(reviewBadgeText(list)).toBe(listName(list, t));
		},
	);

	it.each([
		["OFAC_SDN", "US OFAC"],
		["EU_CONSOLIDATED", "EU"],
		["UN_CONSOLIDATED", "UN"],
		["UK_OFSI", "UK Sanctions List"],
	])("%s is looked for as %s, never as the raw code", (list, badge) => {
		expect(reviewBadgeText(list)).toBe(badge);
	});

	it("falls back to the code for a list with no label, as the app does", () => {
		expect(reviewBadgeText("CH_SECO")).toBe(listName("CH_SECO", t));
		expect(reviewBadgeText("CH_SECO")).toBe("CH_SECO");
	});

	it("covers every signed list", () => {
		expect(LIST_PROBES.map((probe) => probe.list).sort()).toEqual([
			"EU_CONSOLIDATED",
			"OFAC_SDN",
			"UK_OFSI",
			"UN_CONSOLIDATED",
		]);
	});
});
