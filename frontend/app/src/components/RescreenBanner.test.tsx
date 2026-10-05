// One re-screen, one banner. The gate's background sync and the Customers
// page's "Check for updates" click can land on the SAME sync: RescanService
// collapses concurrent syncWatchlist calls into one in-flight run, so both
// surfaces receive the same result. The user must see a single
// "re-screened N customer(s)" banner, not one from each surface.

import type { SyncResult } from "@amlfilter/workstation";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../lib/api";
import { workstation } from "../lib/workstation";
import { CustomersPage } from "../pages/CustomersPage";
import { WorkstationGate } from "./WorkstationGate";

vi.mock("../lib/api", () => ({
	apiClient: {
		listCustomers: vi.fn(),
		onboardCustomer: vi.fn(),
		importCustomers: vi.fn(),
		updateCustomer: vi.fn(),
		deleteCustomer: vi.fn(),
		listReviewMatches: vi.fn(),
	},
}));

vi.mock("../lib/workstation", () => ({
	workstation: vi.fn(),
	retainWorkstationRuntime: vi.fn(() => vi.fn()),
}));

const RESCREENED = /re-screened \d+ customer\(s\)/i;

/**
 * A handle whose syncWatchlist hands the boot-time sync (call 1) and the click
 * (call 2) the SAME result object, as RescanService's shared in-flight run does.
 * `firstSettles` picks which surface hears about it first.
 */
function sharedRunHandle(firstSettles: "gate" | "click") {
	// A fresh object per run: "already reported" is tracked per result object.
	const update: SyncResult = {
		changed: true,
		version: "wl-v2",
		customersScanned: 1,
		newHits: 0,
		clearedHits: 0,
	};
	let settleGate!: (result: SyncResult) => void;
	const gateRun = new Promise<SyncResult>((resolve) => {
		settleGate = resolve;
	});
	const syncWatchlist = vi.fn((_version: string) =>
		syncWatchlist.mock.calls.length === 1 && firstSettles === "click"
			? gateRun
			: Promise.resolve(update),
	);
	const handle = {
		store: {
			getSetting: vi.fn((key: string) =>
				Promise.resolve(
					key === "last_synced_watchlist_version" ? "wl-v1" : "Avery Analyst",
				),
			),
			setSetting: vi.fn().mockResolvedValue(undefined),
		},
		engineBoot: vi.fn().mockResolvedValue(undefined),
		watchlistVersion: vi.fn(() => "wl-v1"),
		fetchPublishedVersion: vi.fn().mockResolvedValue("wl-v2"),
		reloadWatchlist: vi.fn().mockResolvedValue(undefined),
		rescan: { syncWatchlist },
	};
	return { handle, settleGate: () => settleGate(update) };
}

function renderGateWithCustomers(handle: unknown) {
	// biome-ignore lint/suspicious/noExplicitAny: structural fake for the mocked seam
	vi.mocked(workstation).mockResolvedValue(handle as any);
	render(
		<WorkstationGate>
			<CustomersPage />
		</WorkstationGate>,
	);
}

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(apiClient.listCustomers).mockResolvedValue([]);
	vi.mocked(apiClient.listReviewMatches).mockResolvedValue([]);
});

describe("re-screen banner", () => {
	it("the click reports first: the background sync of the same run stays silent", async () => {
		const { handle, settleGate } = sharedRunHandle("click");
		renderGateWithCustomers(handle);
		// The gate's boot-time sync is in flight before the analyst clicks.
		await waitFor(() =>
			expect(handle.rescan.syncWatchlist).toHaveBeenCalledTimes(1),
		);
		fireEvent.click(
			await screen.findByRole("button", { name: "Check for updates" }),
		);
		await screen.findByText(/^Re-screened 1 customer\(s\)/);
		await act(async () => {
			settleGate();
		});
		await flush();
		expect(screen.getAllByText(RESCREENED)).toHaveLength(1);
	});

	it("the background banner is up first: the click's report of the same run replaces it", async () => {
		const { handle } = sharedRunHandle("gate");
		renderGateWithCustomers(handle);
		await screen.findByText(/watchlist updated: re-screened 1 customer/i);
		fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
		await screen.findByText(/^Re-screened 1 customer\(s\)/);
		await flush();
		expect(screen.getAllByText(RESCREENED)).toHaveLength(1);
		expect(screen.queryByText(/watchlist updated/i)).toBeNull();
	});
});
