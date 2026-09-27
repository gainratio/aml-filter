/**
 * Watchlist sync orchestration (Wave 2, bidirectional auto-rescan).
 *
 * The loaded watchlist version is only known AFTER the screening engine has
 * bootstrapped. `runWatchlistSync` reads that version off the handle; if the
 * engine has not booted yet it returns null so the caller can retry once the
 * engine is ready. Otherwise it delegates to the package's idempotent
 * RescanService.syncWatchlist — a no-op when the stored version already matches.
 *
 * `checkForWatchlistUpdates` is the LIVE new-publish path the "Check for
 * updates" button drives: it polls the cheap signed manifest for the currently
 * PUBLISHED version, and if that differs from the version this tab loaded at
 * boot it RELOADS the watchlist into the running engine (re-fetch + re-verify,
 * fail-closed, over the warm embedder) BEFORE re-screening every customer
 * against the new list. This is what makes an already-open tab notice a list
 * that was published after it booted — without it the loaded version is frozen
 * for the tab's lifetime.
 */

import {
	LAST_SYNCED_VERSION_KEY,
	type SyncResult,
} from "@amlfilter/workstation";
import i18n from "../i18n";
import type { WorkstationHandle } from "./workstation";

/**
 * Sync the in-tab KYC records against the currently-loaded watchlist version.
 * Returns null when the engine has not booted yet (no version to sync against);
 * otherwise the SyncResult (changed:false when already current).
 */
export async function runWatchlistSync(
	handle: WorkstationHandle,
): Promise<SyncResult | null> {
	const version = handle.watchlistVersion();
	if (version === null) {
		return null;
	}
	return handle.rescan.syncWatchlist(version);
}

/**
 * The once-per-boot sync, reduced to what deserves a "Watchlist updated" notice.
 * The sync always runs; the result is returned only when the list genuinely
 * changed since a PREVIOUSLY RECORDED sync and re-screened someone. The first
 * list load on a device has no prior version: its re-screen is a baseline (it
 * re-checks the customer being onboarded right now), not an update, so it stays
 * silent and the onboarding alert is the one event on screen.
 */
export async function syncToAnnounce(
	handle: WorkstationHandle,
): Promise<SyncResult | null> {
	if (handle.watchlistVersion() === null) {
		return null;
	}
	const prior = await handle.store.getSetting(LAST_SYNCED_VERSION_KEY);
	const result = await runWatchlistSync(handle);
	const isUpdate = prior !== null && result?.changed === true;
	return isUpdate && result.customersScanned > 0 ? result : null;
}

/**
 * Poll for a new watchlist publish and, if one is found, reload it into the
 * running engine and re-screen every customer against it. Returns null when the
 * engine has not booted yet (nothing loaded to compare against). When the
 * published version matches the loaded one, no reload happens and the
 * (idempotent) sync against the loaded version yields the "already current"
 * summary.
 */
export async function checkForWatchlistUpdates(
	handle: WorkstationHandle,
): Promise<SyncResult | null> {
	const loaded = handle.watchlistVersion();
	if (loaded === null) {
		return null;
	}
	const published = await handle.fetchPublishedVersion();
	if (published !== loaded) {
		// A new list went live after this tab booted: swap it into the engine
		// (fail-closed verify) so the re-screen runs against the new entities.
		await handle.reloadWatchlist();
	}
	return handle.rescan.syncWatchlist(published);
}

/** Plain-language one-liner for a completed sync — shared by every surface. */
export function syncSummaryText(result: SyncResult): string {
	if (!result.changed) {
		return i18n.t("common:sync.alreadyCurrent");
	}
	return i18n.t("common:sync.summary", {
		scanned: result.customersScanned,
		newHits: result.newHits,
		clearedHits: result.clearedHits,
	});
}
