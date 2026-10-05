import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// A returning visitor whose durable rollback floor refuses the served pointer
// (edgeproc-browser #13 keeps that floor across key changes). The boot keeps
// failing with the Worker's `rollback` code until the cached lists are cleared,
// and /screen must offer that clear in-app — warned, confirmed, never automatic.
const state = {
	code: "rollback" as "rollback" | "integrity",
	cleared: false,
	boots: 0,
	clears: 0,
};

function workerError(code: string, message: string): Error {
	const error = new Error(message) as Error & { code: string };
	error.name = "EngineOperationError";
	error.code = code;
	return error;
}

vi.mock("@amlfilter/browser", () => {
	class EngineRuntime {
		catalogLists() {
			return Promise.resolve([]);
		}
		bootstrap(): Promise<void> {
			state.boots += 1;
			if (!state.cleared) {
				return Promise.reject(
					workerError(
						state.code,
						state.code === "rollback"
							? "refusing rollback: sequence is not fresher than the active pointer's"
							: "signature verification failed",
					),
				);
			}
			return Promise.resolve();
		}
		clearListCache(): Promise<void> {
			state.clears += 1;
			state.cleared = true;
			return Promise.resolve();
		}
		engine() {
			return {
				allEntities: () => [],
				screen: () =>
					Promise.resolve({
						request_id: "t",
						list_versions_used: {},
						execution_time_ms: 1,
						matches: [],
					}),
			};
		}
		dispose(): Promise<void> {
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
		engineSupport: () => ({ supported: true, missing: [] }),
	};
});

import { ScreenPage } from "./ScreenPage";

afterEach(() => {
	cleanup();
	state.code = "rollback";
	state.cleared = false;
	state.boots = 0;
	state.clears = 0;
});

describe("ScreenPage — in-app recovery from a refused bundle", () => {
	it("warns on a rollback, clears only after a confirm, then re-boots", async () => {
		render(<ScreenPage />);
		const alert = await waitFor(() => screen.getByRole("alert"));
		expect(alert.textContent).toMatch(/older version of the screening lists/i);
		expect(
			screen.getByRole("link", { name: /open settings/i }).getAttribute("href"),
		).toBe("/settings");
		// Never automatic.
		expect(state.clears).toBe(0);

		fireEvent.click(
			screen.getByRole("button", { name: /^clear cached lists$/i }),
		);
		expect(state.clears).toBe(0);
		fireEvent.click(
			screen.getByRole("button", { name: /yes, clear cached lists/i }),
		);

		await waitFor(() => {
			const box = screen.getByPlaceholderText(/Search a name/);
			expect((box as HTMLInputElement).disabled).toBe(false);
		});
		expect(state.clears).toBe(1);
		expect(state.boots).toBe(2);
		// The boot-failure card is gone (the empty mock catalog's own "age unknown"
		// list notice is a different, expected alert).
		expect(
			screen.queryByText(/older version of the screening lists/i),
		).toBeNull();
		expect(screen.queryByTestId("cache-recovery")).toBeNull();
	});

	it("offers the same confirmed clear, without the rollback warning, for an integrity failure", async () => {
		state.code = "integrity";
		render(<ScreenPage />);
		const alert = await waitFor(() => screen.getByRole("alert"));
		expect(alert.textContent).toMatch(/verification failed/i);
		expect(alert.textContent).not.toMatch(/older version/i);
		expect(
			screen.getByRole("button", { name: /^clear cached lists$/i }),
		).toBeTruthy();
	});
});
