import { describe, expect, it } from "vitest";
import {
	LIST_PROBES,
	reviewBadgePattern,
	reviewBadgeText,
} from "../../tests/e2e-live/probes";
import { i18n } from "../i18n";
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

	// The smoke runs against TWO releases: @prime against the one still live
	// before a deploy, @fresh/@returning against the new one. After #152 the
	// old release shows the raw code and the new one the plain name, so a
	// matcher that knows only the new name fails @prime and no deploy can ever
	// pass (runs 36446124822 and 36446124361). It must accept either spelling
	// of the SAME list, and nothing else.
	it.each([
		["OFAC_SDN", "OFAC_SDN", "US OFAC"],
		["EU_CONSOLIDATED", "EU_CONSOLIDATED", "EU"],
		["UN_CONSOLIDATED", "UN_CONSOLIDATED", "UN"],
		["UK_OFSI", "UK_OFSI", "UK Sanctions List"],
	])(
		"%s badge matches the previous release (%s) and the new one (%s)",
		(list, previous, current) => {
			expect(reviewBadgePattern(list).test(previous)).toBe(true);
			expect(reviewBadgePattern(list).test(current)).toBe(true);
		},
	);

	it("pins the exact, anchored pattern for each list", () => {
		expect(reviewBadgePattern("OFAC_SDN").source).toBe(
			"^(?:OFAC_SDN|US OFAC)$",
		);
		expect(reviewBadgePattern("EU_CONSOLIDATED").source).toBe(
			"^(?:EU_CONSOLIDATED|EU)$",
		);
		expect(reviewBadgePattern("UN_CONSOLIDATED").source).toBe(
			"^(?:UN_CONSOLIDATED|UN)$",
		);
		expect(reviewBadgePattern("UK_OFSI").source).toBe(
			"^(?:UK_OFSI|UK Sanctions List)$",
		);
	});

	it("rejects a badge from any other list, in either spelling", () => {
		for (const probe of LIST_PROBES) {
			const pattern = reviewBadgePattern(probe.list);
			for (const other of LIST_PROBES) {
				if (other.list === probe.list) continue;
				expect(pattern.test(other.list)).toBe(false);
				expect(pattern.test(reviewBadgeText(other.list))).toBe(false);
			}
		}
	});

	it("matches the whole badge only", () => {
		const pattern = reviewBadgePattern("OFAC_SDN");
		for (const text of [
			"US OFAC SDN",
			"xOFAC_SDN",
			"OFAC_SDN2",
			"US OFAC|EU",
			"",
		]) {
			expect(pattern.test(text)).toBe(false);
		}
	});

	it("uses one spelling for a list with no label, as the app does", () => {
		expect(reviewBadgePattern("CH_SECO").source).toBe("^(?:CH_SECO)$");
	});

	it("escapes regex characters in a list code or label", () => {
		const pattern = reviewBadgePattern("A.B+");
		expect(pattern.test("A.B+")).toBe(true);
		expect(pattern.test("AxBBB")).toBe(false);
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
