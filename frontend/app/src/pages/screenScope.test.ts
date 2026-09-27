import { describe, expect, it } from "vitest";
import { isMobileBrowser } from "../lib/memoryPolicy";
import { initialScreenScope, screenSelection } from "./screenScope";

const IPHONE =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari";
const MAC_CHROME =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36";

describe("isMobileBrowser", () => {
	it.each([
		["iPhone Safari", { userAgent: IPHONE }],
		["Android Chrome", { userAgent: ANDROID }],
		[
			"iPad in desktop mode",
			{
				userAgent:
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15",
				maxTouchPoints: 5,
			},
		],
	])("treats %s as mobile", (_name, signals) => {
		expect(isMobileBrowser(signals)).toBe(true);
	});

	it("treats a desktop browser as desktop, whatever deviceMemory says", () => {
		// Chrome caps navigator.deviceMemory at 8, so memory is no desktop signal.
		expect(isMobileBrowser({ userAgent: MAC_CHROME, deviceMemory: 8 })).toBe(
			false,
		);
		expect(isMobileBrowser({ userAgent: MAC_CHROME })).toBe(false);
	});
});

describe("/screen list scope", () => {
	it("searches every list on a desktop", () => {
		expect(initialScreenScope({ userAgent: MAC_CHROME })).toBe("all-lists");
	});

	it("starts phones on US OFAC only (all four eagerly ran iOS Safari out of memory, PR #71)", () => {
		expect(initialScreenScope({ userAgent: IPHONE })).toBe("us-only");
		expect(initialScreenScope({ userAgent: ANDROID })).toBe("us-only");
	});

	it("loads every catalog list eagerly for the all-lists scope", () => {
		// No enabledLists = every list in the signed catalog.
		expect(screenSelection("all-lists")).toEqual({ residency: "eager" });
	});

	it("pins OFAC eagerly for the US-only scope", () => {
		expect(screenSelection("us-only")).toEqual({
			enabledLists: ["OFAC_SDN"],
			residency: "eager",
		});
	});

	it("streams every list, one resident at a time, when a phone opts in", () => {
		expect(screenSelection("all-lists-streaming")).toEqual({
			residency: "streaming",
		});
	});
});
