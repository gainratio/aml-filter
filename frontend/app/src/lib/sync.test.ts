import type { SyncResult } from "@amlfilter/workstation";
import { describe, expect, it, vi } from "vitest";
import {
	checkForWatchlistUpdates,
	runWatchlistSync,
	syncSummaryText,
	syncToAnnounce,
} from "./sync";
import type { WorkstationHandle } from "./workstation";

function makeHandle(
	version: string | null,
	result?: SyncResult,
): { handle: WorkstationHandle; syncWatchlist: ReturnType<typeof vi.fn> } {
	const syncWatchlist = vi.fn().mockResolvedValue(result);
	const handle = {
		watchlistVersion: () => version,
		rescan: { syncWatchlist },
	} as unknown as WorkstationHandle;
	return { handle, syncWatchlist };
}

const SUMMARY: SyncResult = {
	changed: true,
	version: "v2",
	customersScanned: 3,
	newHits: 1,
	clearedHits: 0,
};

describe("runWatchlistSync", () => {
	it("returns null and does not sync when the engine has not booted", async () => {
		const { handle, syncWatchlist } = makeHandle(null);
		expect(await runWatchlistSync(handle)).toBeNull();
		expect(syncWatchlist).not.toHaveBeenCalled();
	});

	it("passes the loaded version through to syncWatchlist", async () => {
		const { handle, syncWatchlist } = makeHandle("v2", SUMMARY);
		const result = await runWatchlistSync(handle);
		expect(syncWatchlist).toHaveBeenCalledWith("v2");
		expect(result).toEqual(SUMMARY);
	});

	it("surfaces a thrown sync error to the caller", async () => {
		const { handle, syncWatchlist } = makeHandle("v2");
		syncWatchlist.mockRejectedValue(new Error("rescan failed"));
		await expect(runWatchlistSync(handle)).rejects.toThrow(/rescan failed/);
	});
});

interface UpdateHandleMocks {
	readonly handle: WorkstationHandle;
	readonly fetchPublishedVersion: ReturnType<typeof vi.fn>;
	readonly reloadWatchlist: ReturnType<typeof vi.fn>;
	readonly syncWatchlist: ReturnType<typeof vi.fn>;
}

function makeUpdateHandle(
	loadedVersion: string | null,
	publishedVersion: string,
	syncResult?: SyncResult,
): UpdateHandleMocks {
	const fetchPublishedVersion = vi.fn().mockResolvedValue(publishedVersion);
	const reloadWatchlist = vi.fn().mockResolvedValue(undefined);
	const syncWatchlist = vi.fn().mockResolvedValue(syncResult);
	let currentVersion = loadedVersion;
	const handle = {
		watchlistVersion: () => currentVersion,
		fetchPublishedVersion,
		// reload advances what the handle reports as the loaded version.
		reloadWatchlist: reloadWatchlist.mockImplementation(async () => {
			currentVersion = publishedVersion;
		}),
		rescan: { syncWatchlist },
	} as unknown as WorkstationHandle;
	return { handle, fetchPublishedVersion, reloadWatchlist, syncWatchlist };
}

describe("checkForWatchlistUpdates", () => {
	it("returns null and polls nothing when the engine has not booted", async () => {
		const m = makeUpdateHandle(null, "demo-2");
		expect(await checkForWatchlistUpdates(m.handle)).toBeNull();
		expect(m.fetchPublishedVersion).not.toHaveBeenCalled();
		expect(m.reloadWatchlist).not.toHaveBeenCalled();
	});

	it("reloads + re-screens when a NEW version is published", async () => {
		const changed: SyncResult = {
			changed: true,
			version: "demo-2",
			customersScanned: 2,
			newHits: 1,
			clearedHits: 0,
		};
		const m = makeUpdateHandle("demo-1", "demo-2", changed);
		const result = await checkForWatchlistUpdates(m.handle);
		expect(m.fetchPublishedVersion).toHaveBeenCalledTimes(1);
		// The new publish was reloaded BEFORE re-screening against demo-2.
		expect(m.reloadWatchlist).toHaveBeenCalledTimes(1);
		expect(m.syncWatchlist).toHaveBeenCalledWith("demo-2");
		expect(result).toEqual(changed);
	});

	it("does NOT reload when the published version equals the loaded version", async () => {
		const unchanged: SyncResult = {
			changed: false,
			version: "demo-1",
			customersScanned: 0,
			newHits: 0,
			clearedHits: 0,
		};
		const m = makeUpdateHandle("demo-1", "demo-1", unchanged);
		const result = await checkForWatchlistUpdates(m.handle);
		expect(m.fetchPublishedVersion).toHaveBeenCalledTimes(1);
		expect(m.reloadWatchlist).not.toHaveBeenCalled();
		// Still calls syncWatchlist with the loaded version — a no-op that yields
		// the "already current" summary when nothing drifted.
		expect(m.syncWatchlist).toHaveBeenCalledWith("demo-1");
		expect(result).toEqual(unchanged);
	});
});

describe("syncSummaryText", () => {
	it("reports the rescan counts when the watchlist changed", () => {
		expect(syncSummaryText(SUMMARY)).toBe(
			"Re-screened 3 customer(s) — 1 new hit(s), 0 cleared.",
		);
	});

	it("reports 'already current' when nothing changed", () => {
		expect(
			syncSummaryText({
				changed: false,
				version: "v1",
				customersScanned: 0,
				newHits: 0,
				clearedHits: 0,
			}),
		).toBe("Watchlist already current.");
	});
});

describe("syncToAnnounce (the once-per-boot notice)", () => {
	function bootHandle(prior: string | null, result: SyncResult) {
		const syncWatchlist = vi.fn().mockResolvedValue(result);
		const handle = {
			watchlistVersion: () => "v2",
			store: { getSetting: vi.fn().mockResolvedValue(prior) },
			rescan: { syncWatchlist },
		} as unknown as WorkstationHandle;
		return { handle, syncWatchlist };
	}

	it("still syncs but announces nothing on the first-ever list load", async () => {
		const { handle, syncWatchlist } = bootHandle(null, SUMMARY);
		expect(await syncToAnnounce(handle)).toBeNull();
		expect(syncWatchlist).toHaveBeenCalledWith("v2");
	});

	it("announces a version change since the last recorded sync", async () => {
		const { handle } = bootHandle("v1", SUMMARY);
		expect(await syncToAnnounce(handle)).toEqual(SUMMARY);
	});

	it("announces nothing when the list is unchanged", async () => {
		const { handle } = bootHandle("v2", { ...SUMMARY, changed: false });
		expect(await syncToAnnounce(handle)).toBeNull();
	});

	it("announces nothing when a change re-screened no customers", async () => {
		const { handle } = bootHandle("v1", { ...SUMMARY, customersScanned: 0 });
		expect(await syncToAnnounce(handle)).toBeNull();
	});

	it("returns null before the engine has booted", async () => {
		const { handle, syncWatchlist } = bootHandle("v1", SUMMARY);
		(handle as { watchlistVersion: () => string | null }).watchlistVersion =
			() => null;
		expect(await syncToAnnounce(handle)).toBeNull();
		expect(syncWatchlist).not.toHaveBeenCalled();
	});
});
