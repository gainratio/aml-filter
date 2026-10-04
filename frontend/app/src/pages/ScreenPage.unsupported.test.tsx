import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// An unsupported device (older iOS Safari / locked-down WebView) must NOT spawn
// the engine Worker — the capability preflight routes straight to an explicit
// "can't run the local engine" screen. bootstrap must never be called (spawning
// the Worker would throw deep inside it, or on iOS hang with no catchable error).
const bootCalls = { count: 0 };

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
		bootstrap(): Promise<void> {
			bootCalls.count += 1;
			return Promise.resolve();
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
		// This browser is missing the capabilities the local engine needs.
		engineSupport: () => ({ supported: false, missing: ["Web Workers"] }),
	};
});

import { ScreenPage } from "./ScreenPage";

afterEach(() => {
	cleanup();
	bootCalls.count = 0;
});

describe("ScreenPage — unsupported device", () => {
	it("shows the unsupported-device screen and never spawns the engine", async () => {
		render(<ScreenPage />);

		const alert = await waitFor(() => screen.getByRole("alert"));
		expect(alert.textContent ?? "").toMatch(/can’t run the local engine/i);
		expect(alert.textContent ?? "").toMatch(/desktop browser/i);
		// The missing capability is named so a technical visitor can see why.
		expect(alert.textContent ?? "").toMatch(/Web Workers/);

		// The search box stays disabled — there is no engine to screen against.
		const box = screen.getByPlaceholderText(/Search a name/);
		expect((box as HTMLInputElement).disabled).toBe(true);

		// No Retry: retrying can't add a missing browser capability.
		expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();

		// Crucially, bootstrap was never attempted on the unsupported device.
		expect(bootCalls.count).toBe(0);
	});
});
