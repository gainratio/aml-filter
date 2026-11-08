import { describe, expect, it } from "vitest";
import { residencyForBrowser } from "./memoryPolicy";

describe("residencyForBrowser", () => {
	it("streams on iPhone Safari even when deviceMemory is unavailable", () => {
		expect(
			residencyForBrowser({
				userAgent:
					"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1",
			}),
		).toBe("streaming");
	});

	it("streams on low-memory Android devices", () => {
		expect(
			residencyForBrowser({
				userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari",
				deviceMemory: 4,
			}),
		).toBe("streaming");
	});

	it("detects iPad desktop-mode Safari from touch points", () => {
		expect(
			residencyForBrowser({
				userAgent:
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15",
				maxTouchPoints: 5,
			}),
		).toBe("streaming");
	});

	it("uses eager residency on desktop browsers that omit deviceMemory (Safari/Firefox)", () => {
		expect(
			residencyForBrowser({
				userAgent:
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15",
				maxTouchPoints: 0,
			}),
		).toBe("eager");
	});

	it("streams when the environment has no userAgent signal", () => {
		expect(
			residencyForBrowser({
				userAgent: "",
			}),
		).toBe("streaming");
	});

	it("streams on a low-memory desktop at or below the 4 GB floor", () => {
		expect(
			residencyForBrowser({
				userAgent:
					"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/138 Safari/537.36",
				deviceMemory: 4,
				maxTouchPoints: 0,
			}),
		).toBe("streaming");
	});

	it("uses eager residency on a standard desktop at the W3C 8 GB deviceMemory cap", () => {
		expect(
			residencyForBrowser({
				userAgent:
					"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/138 Safari/537.36",
				deviceMemory: 8,
				maxTouchPoints: 0,
			}),
		).toBe("eager");
	});

	it("keeps eager residency for an explicitly high-memory desktop", () => {
		expect(
			residencyForBrowser({
				userAgent:
					"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/138 Safari/537.36",
				deviceMemory: 16,
				maxTouchPoints: 0,
			}),
		).toBe("eager");
	});
});
