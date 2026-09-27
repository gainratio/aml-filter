// Which lists the public search covers. The home page promises four lists, so a
// visitor must be able to see — and get — a search across all four. A desktop
// searches every list in the signed catalog; a phone starts on US OFAC only (the
// all-four eager load ran iOS Safari out of memory, PR #71) and says so, with a
// one-tap way to include every list.

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const IPHONE =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1";

function catalogList(id: string, title: string, entitiesCount: number) {
	return {
		id,
		title,
		version: "demo-1",
		entitiesCount,
		fetchedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
		agedFrom: "fetchedAt",
		sourceUpdatedAt: null,
		stale: false,
		staleReason: null,
	};
}

const CATALOG = [
	catalogList("OFAC_SDN", "OFAC SDN", 19391),
	catalogList("UN_CONSOLIDATED", "UN Consolidated", 1011),
	catalogList("EU_CONSOLIDATED", "EU Consolidated", 6241),
	catalogList("UK_OFSI", "UK Sanctions List", 5682),
];

const calls: { bootstrap: unknown[]; reload: unknown[] } = {
	bootstrap: [],
	reload: [],
};

vi.mock("@amlfilter/browser", async (importActual) => {
	const actual = await importActual<typeof import("@amlfilter/browser")>();
	class EngineRuntime {
		bootstrap(_c: unknown, _s: unknown, selection: unknown): Promise<void> {
			calls.bootstrap.push(selection);
			return Promise.resolve();
		}
		reload(selection: unknown): Promise<void> {
			calls.reload.push(selection);
			return Promise.resolve();
		}
		catalogLists() {
			return Promise.resolve(CATALOG);
		}
		version() {
			return "demo-1";
		}
		engine() {
			return {
				allEntities: () => [],
				screen: () => Promise.resolve({ matches: [], execution_time_ms: 1 }),
			};
		}
		dispose() {}
	}
	return {
		...actual,
		EngineRuntime,
		configFromEnv: () => ({}),
		engineSupport: () => ({ supported: true, missing: [] }),
	};
});

import { ScreenPage } from "./ScreenPage";

function useUserAgent(ua: string): void {
	vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
}

beforeEach(() => {
	calls.bootstrap = [];
	calls.reload = [];
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("ScreenPage — list scope on a desktop", () => {
	it("boots every catalog list, not just OFAC", async () => {
		render(<ScreenPage />);
		await waitFor(() => expect(calls.bootstrap).toHaveLength(1));
		expect(calls.bootstrap[0]).toEqual({ residency: "eager" });
	});

	it("tells the visitor which lists the search covers, by plain name", async () => {
		render(<ScreenPage />);
		expect(
			await screen.findByText(
				"Searching 4 lists: US OFAC, UN, EU, UK Sanctions List",
			),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /search all/i }),
		).not.toBeInTheDocument();
	});

	it("does not promise OFAC-only in the lede", () => {
		render(<ScreenPage />);
		expect(screen.queryByText(/OFAC sanctions list/i)).not.toBeInTheDocument();
	});
});

describe("ScreenPage — list scope on a phone", () => {
	it("starts on US OFAC only and says so plainly", async () => {
		useUserAgent(IPHONE);
		render(<ScreenPage />);
		await waitFor(() => expect(calls.bootstrap).toHaveLength(1));
		expect(calls.bootstrap[0]).toEqual({
			enabledLists: ["OFAC_SDN"],
			residency: "eager",
		});
		expect(
			await screen.findByText(
				"Searching US OFAC only on this device, to save memory.",
			),
		).toBeInTheDocument();
	});

	it("switches to every list with one tap, streaming one list at a time", async () => {
		useUserAgent(IPHONE);
		render(<ScreenPage />);
		fireEvent.click(
			await screen.findByRole("button", { name: "Search all 4 lists" }),
		);
		await waitFor(() => expect(calls.reload).toHaveLength(1));
		expect(calls.reload[0]).toEqual({ residency: "streaming" });
		expect(
			await screen.findByText(
				"Searching 4 lists: US OFAC, UN, EU, UK Sanctions List",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(/Each search takes a few seconds on this device/),
		).toBeInTheDocument();
	});
});
