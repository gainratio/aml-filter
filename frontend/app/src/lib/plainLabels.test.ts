import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import {
	listName,
	matchEventLabel,
	reasonLabel,
	resolutionLabel,
	riskLabel,
	tierLabel,
} from "./plainLabels";

// The stored codes stay the data contract (DB rows, CSV/JSON exports, receipts);
// these helpers are the ONLY place a code becomes words a visitor reads. The
// literals below are pinned on purpose: they are what the screen promises.
const t = i18n.getFixedT("en", "common");

describe("listName — the four signed lists by plain name", () => {
	it.each([
		["OFAC_SDN", "US OFAC"],
		["EU_CONSOLIDATED", "EU"],
		["UN_CONSOLIDATED", "UN"],
		["UK_OFSI", "UK Sanctions List"],
	])("%s reads as %s", (id, label) => {
		expect(listName(id, t)).toBe(label);
	});

	it("falls back to the signed catalog title for a list it does not know", () => {
		expect(listName("CH_SECO", t, "Swiss SECO")).toBe("Swiss SECO");
	});

	it("falls back to the id only when there is no title either", () => {
		expect(listName("CH_SECO", t)).toBe("CH_SECO");
	});
});

describe("review codes read as plain words", () => {
	it.each([
		["PENDING", "Needs review"],
		["TRUE_POSITIVE", "Confirmed match"],
		["FALSE_POSITIVE", "Not a match"],
		["RESOLVED", "Closed"],
	])("status %s reads as %s", (code, label) => {
		expect(resolutionLabel(code, t)).toBe(label);
	});

	it.each([
		["STRONG", "Strong"],
		["POSSIBLE", "Possible"],
		["WEAK", "Weak"],
	])("tier %s reads as %s", (code, label) => {
		expect(tierLabel(code, t)).toBe(label);
	});

	it.each([
		["DETECTED", "Match found"],
		["DISPOSITIONED", "Decision recorded"],
		["REOPENED", "Reopened"],
		["CHANGED", "Details changed"],
		["SUPPRESSED", "Unchanged, kept as decided"],
	])("event %s reads as %s", (code, label) => {
		expect(matchEventLabel(code, t)).toBe(label);
	});

	it("never shows an unknown status as a blank", () => {
		expect(resolutionLabel("ESCALATED", t)).toBe("ESCALATED");
	});
});

describe("score reasons read as plain words", () => {
	it.each([
		["name_vector", "Name likeness"],
		["name_sequence", "Spelling close"],
		["alias_match", "Matches a listed alias"],
		["dob_match", "Date of birth"],
		["country_match", "Country"],
		["entity_type_match", "Person or organisation"],
	])("%s reads as %s", (signal, label) => {
		expect(reasonLabel(signal, t)).toBe(label);
	});

	it("names the risk category in words", () => {
		expect(riskLabel("SANCTION", t)).toBe("Sanctioned");
	});
});
