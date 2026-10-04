import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Drives ScreenPage's boot banner through a loading-model stage, with and
// without progress, asserting the percent renders and the banner stays an
// accessible role="status" line.

type BootStage =
	| {
			readonly kind: "downloading";
			readonly progress?: {
				readonly fetched: number;
				readonly total: number;
				readonly bytes: number;
			};
	  }
	| { readonly kind: "verified"; readonly version: string }
	| {
			readonly kind: "loading-model";
			readonly progress?: {
				readonly loaded: number;
				readonly total?: number;
				readonly pct?: number;
			};
	  }
	| { readonly kind: "ready" };

type OnStage = (stage: BootStage) => void;

// A runtime whose bootstrap emits a scripted sequence of stages before settling,
// so the banner is observed mid-load (where the percent must appear).
const stageScript: BootStage[] = [];

vi.mock("@amlfilter/browser", () => {
	class EngineRuntime {
		// The real runtime always exposes this, and /screen reads it to state the
		// age of the list it screens against. A mock without it would leave the page
		// permanently reporting "age unknown".
		catalogLists() {
			return Promise.resolve([
				{
					id: "OFAC_SDN",
					title: "OFAC SDN",
					version: "demo-1",
					entitiesCount: 1,
					fetchedAt: "2026-08-01T08:00:00Z",
					agedFrom: "fetchedAt",
					sourceUpdatedAt: null,
					stale: false,
					staleReason: null,
				},
			]);
		}
		bootstrap(_config: unknown, onStage: OnStage): Promise<void> {
			for (const stage of stageScript) {
				onStage(stage);
			}
			// Never resolve: keep the page in the booting phase so the banner is
			// the asserted surface.
			return new Promise<void>(() => {});
		}
		engine() {
			return null;
		}
		dispose(): Promise<void> {
			// The page disposes its page-owned runtime on real unmount (deferred one
			// macrotask); a resolved no-op keeps that teardown inert here.
			return Promise.resolve();
		}
	}
	return {
		// The signing-key notice only needs a key that never resolves here.
		installKeys: () => ({
			load: () => new Promise(() => undefined),
			onChange: () => () => undefined,
		}),
		EngineRuntime,
		configFromEnv: () => ({}),
		// jsdom lacks Worker/OPFS; force "supported" so boot reaches the banner.
		engineSupport: () => ({ supported: true, missing: [] }),
	};
});

import { ScreenPage } from "./ScreenPage";

function setScript(stages: BootStage[]): void {
	stageScript.length = 0;
	stageScript.push(...stages);
}

afterEach(() => {
	cleanup();
	setScript([]);
});

describe("ScreenPage boot banner — model-load progress", () => {
	it("renders the percent when loading-model carries progress", async () => {
		setScript([
			{ kind: "loading-model", progress: { loaded: 42, total: 100, pct: 42 } },
		]);
		render(<ScreenPage />);
		// The boot banner is the role="status" region.
		await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
		expect(screen.getByRole("status").textContent).toMatch(/42\s*%/);
	});

	it("shows megabytes, never a fabricated percent, when no total is known", async () => {
		// A server that withholds content-length leaves no honest denominator.
		// The banner must still move — bytes are always known — but it must not
		// print a percentage derived from a made-up total.
		setScript([{ kind: "loading-model", progress: { loaded: 5_242_880 } }]);
		render(<ScreenPage />);
		await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
		const text = screen.getByRole("status").textContent ?? "";
		expect(text).toMatch(/5\.2\s*MB/i);
		expect(text).not.toMatch(/%/);
	});

	it("renders the plain loading line when there is no progress yet", async () => {
		setScript([{ kind: "loading-model" }]);
		render(<ScreenPage />);
		await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
		const text = screen.getByRole("status").textContent ?? "";
		expect(text).toMatch(/model/i);
		expect(text).not.toMatch(/%/);
	});

	/**
	 * CONTRACT CHANGE: this used to assert a raw chunk counter ("42/1269").
	 * The intent — the long download must read as moving, never frozen — is
	 * unchanged, but the representation is now a percentage plus megabytes,
	 * because "42/1269" does not tell a visitor what a chunk is or how much
	 * of the wait is left. The old assertion is inverted, not deleted.
	 */
	it("shows live download progress on the downloading stage (not a frozen banner)", async () => {
		setScript([
			{
				kind: "downloading",
				progress: { fetched: 634, total: 1269, bytes: 24_000_000 },
			},
		]);
		render(<ScreenPage />);
		await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
		const text = screen.getByRole("status").textContent ?? "";
		expect(text).toMatch(/downloading/i);
		expect(text).toMatch(/50\s*%/);
		expect(text).toMatch(/24\s*MB/i);
		// The bare chunk count is deliberately gone.
		expect(text).not.toMatch(/634\s*\/\s*1269/);
	});

	it("shows the plain downloading line before any chunk progress arrives", async () => {
		setScript([{ kind: "downloading" }]);
		render(<ScreenPage />);
		await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
		const text = screen.getByRole("status").textContent ?? "";
		expect(text).toMatch(/downloading/i);
		expect(text).not.toMatch(/\//);
	});
});

/**
 * A cold boot moves ~70 MB and takes 11–13s on broadband, far longer on a phone.
 * A counter alone ("427/1296") does not tell a first-time visitor what is being
 * downloaded, how far along it is, or why it is worth waiting. These assert the
 * three things the banner owes them: how far (a percentage), how much (real
 * megabytes, not an extrapolated guess), and what they get for it (it is a
 * one-time download and screening then happens in the tab, with nothing typed
 * leaving the device).
 *
 * The payoff note USED to promise offline use, and these tests asserted the word
 * "offline" as its marker. The app has no service worker, so that promise was
 * false. The marker is now "leaves the device" — the part of the note that is
 * actually true — because the withdrawal copy elsewhere contains the word
 * "offline" and matching on it would keep passing while proving nothing.
 */
describe("ScreenPage boot banner — a first-time visitor can tell what is happening", () => {
	it("reports how far along the download is as a percentage", async () => {
		setScript([
			{
				kind: "downloading",
				progress: { fetched: 324, total: 1296, bytes: 12_000_000 },
			},
		]);
		render(<ScreenPage />);
		await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
		// 324/1296 is exactly 25% — chunk counts are known exactly, so this
		// percentage is real rather than an estimate.
		expect(screen.getByRole("status").textContent ?? "").toMatch(/25\s*%/);
	});

	it("reports megabytes actually downloaded so far", async () => {
		setScript([
			{
				kind: "downloading",
				progress: { fetched: 324, total: 1296, bytes: 12_000_000 },
			},
		]);
		render(<ScreenPage />);
		await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
		expect(screen.getByRole("status").textContent ?? "").toMatch(/12\s*MB/i);
	});

	it("reports kilobytes rather than a meaningless '0 MB' early in the download", async () => {
		// The first ticks of a real cold sync carry tens of KB. Rounding those to
		// "0 MB" makes a working download look stuck at zero — observed on the
		// live site, where the first second of the sync read "0 MB so far".
		setScript([
			{
				kind: "downloading",
				progress: { fetched: 2, total: 1296, bytes: 74_000 },
			},
		]);
		render(<ScreenPage />);
		await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
		const text = screen.getByRole("status").textContent ?? "";
		expect(text).toMatch(/74\s*KB/i);
		// Scoped to the stage line: the payoff note legitimately says "70 MB".
		expect(text).not.toMatch(/0\s*MB so far/i);
	});

	it("keeps one decimal just above a megabyte, where it still carries meaning", async () => {
		setScript([
			{
				kind: "downloading",
				progress: { fetched: 40, total: 1296, bytes: 1_450_000 },
			},
		]);
		render(<ScreenPage />);
		await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
		expect(screen.getByRole("status").textContent ?? "").toMatch(/1\.4\s*MB/i);
	});

	it("tells the visitor the download is one-time and that screening stays in the tab", async () => {
		setScript([
			{
				kind: "downloading",
				progress: { fetched: 324, total: 1296, bytes: 12_000_000 },
			},
		]);
		render(<ScreenPage />);
		await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
		const text = screen.getByRole("status").textContent ?? "";
		expect(text).toMatch(/once|one-time|first/i);
		expect(text).toMatch(/leaves the device/i);
		// The note must NOT resurrect the withdrawn promise.
		expect(text).not.toMatch(/runs offline|works offline|offline use/i);
	});

	it("keeps the payoff note up during the model phase too", async () => {
		setScript([{ kind: "loading-model" }]);
		render(<ScreenPage />);
		await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
		expect(screen.getByRole("status").textContent ?? "").toMatch(
			/leaves the device/i,
		);
	});

	it("does NOT claim a one-time download before any bytes have moved", async () => {
		// The verify step is instant and carries no download; promising a
		// one-time download there would be noise on a warm reload.
		setScript([{ kind: "verified", version: "2026-08-01" }]);
		render(<ScreenPage />);
		await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
		expect(screen.getByRole("status").textContent ?? "").not.toMatch(
			/leaves the device/i,
		);
	});
});
