// Test-only: run a feed fetch whose retries really sleep (5s, 10s, 20s) without
// waiting for them. Only setTimeout/clearTimeout are faked, so real I/O
// (fs, setImmediate) keeps running between the fast-forwarded backoff pauses.

import { vi } from "vitest";

const realTick = (): Promise<void> =>
	new Promise((resolve) => setImmediate(resolve));

/** The rejection `run` ends with once every backoff pause is skipped. */
export async function rejectionAfterBackoff(
	run: () => Promise<unknown>,
): Promise<Error> {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		let outcome: { readonly error: unknown } | undefined;
		run().then(
			() => {
				outcome = { error: new Error("expected a rejection, got success") };
			},
			(error: unknown) => {
				outcome = { error };
			},
		);
		while (outcome === undefined) {
			await vi.runAllTimersAsync();
			await realTick();
		}
		return outcome.error instanceof Error
			? outcome.error
			: new Error(String(outcome.error));
	} finally {
		vi.useRealTimers();
	}
}
