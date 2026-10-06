// scrypt is synchronous and holds 128 MiB, so seal/open run in a Worker that
// lives for one call. These tests drive the message protocol with a fake
// Worker that runs the real handler.

import { afterEach, describe, expect, it, vi } from "vitest";
import sealSeamSource from "./installKeySeal.ts?raw";
import {
	handleSealRequest,
	SEAL_WORKER_TIMEOUT_MS,
	type SealRequest,
	type SealResponse,
	type SealWorkerLike,
	workerSealRunner,
} from "./installKeySealRunner";

const PASSPHRASE = "correct horse battery staple";
const PAYLOAD = new TextEncoder().encode("payload");

/** A Worker that answers with the real handler, and records termination. */
function fakeWorker(): SealWorkerLike & { terminated: boolean } {
	const worker = {
		terminated: false,
		onmessage: null as ((event: { data: SealResponse }) => void) | null,
		onerror: null as (() => void) | null,
		onmessageerror: null as (() => void) | null,
		postMessage(request: SealRequest) {
			void handleSealRequest(request).then((data) =>
				worker.onmessage?.({ data }),
			);
		},
		terminate() {
			worker.terminated = true;
		},
	};
	return worker;
}

/** A Worker whose script never loads. */
function brokenWorker(): SealWorkerLike & { terminated: boolean } {
	const worker = {
		terminated: false,
		onmessage: null,
		onerror: null as (() => void) | null,
		onmessageerror: null,
		postMessage() {
			queueMicrotask(() => worker.onerror?.());
		},
		terminate() {
			worker.terminated = true;
		},
	};
	return worker;
}

describe("workerSealRunner", { timeout: 30_000 }, () => {
	it("seals and opens in a Worker, and ends each Worker after its call", async () => {
		const spawned: Array<{ terminated: boolean }> = [];
		const runner = workerSealRunner(() => {
			const worker = fakeWorker();
			spawned.push(worker);
			return worker;
		});

		const sealed = await runner.seal(PAYLOAD, PASSPHRASE);
		if (!sealed.ok) {
			throw new Error(sealed.reason);
		}
		const opened = await runner.open(sealed.bytes, PASSPHRASE);

		expect(opened.ok && new TextDecoder().decode(opened.bytes)).toBe("payload");
		expect(spawned.map((w) => w.terminated)).toEqual([true, true]);
	});

	it("reports a Worker that fails to load as unavailable", async () => {
		const worker = brokenWorker();
		const runner = workerSealRunner(() => worker);

		expect(await runner.seal(PAYLOAD, PASSPHRASE)).toEqual({
			ok: false,
			reason: "unavailable",
		});
		expect(await runner.open(PAYLOAD, PASSPHRASE)).toEqual({
			ok: false,
			reason: "unavailable",
		});
		expect(worker.terminated).toBe(true);
	});

	it("reports a Worker that cannot be created as unavailable", async () => {
		const runner = workerSealRunner(() => {
			throw new Error("no workers here");
		});

		expect(await runner.open(PAYLOAD, PASSPHRASE)).toEqual({
			ok: false,
			reason: "unavailable",
		});
	});
});

/** A Worker that took the request and then died without a word. */
function silentWorker(): SealWorkerLike & {
	terminated: boolean;
	reply(data: SealResponse): void;
} {
	const worker = {
		terminated: false,
		onmessage: null as ((event: { data: SealResponse }) => void) | null,
		onerror: null,
		onmessageerror: null as (() => void) | null,
		postMessage() {},
		terminate() {
			worker.terminated = true;
		},
		reply(data: SealResponse) {
			worker.onmessage?.({ data });
		},
	};
	return worker;
}

/** Settles `promise` into a box so a test can see whether it is still pending. */
function track<T>(promise: Promise<T>): { settled: boolean; value?: T } {
	const box: { settled: boolean; value?: T } = { settled: false };
	void promise.then((value) => {
		box.settled = true;
		box.value = value;
	});
	return box;
}

const TIMED_OUT = { ok: false, reason: "timed_out" } as const;

describe("workerSealRunner when the Worker goes quiet", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("waits 60 s: generous for scrypt work factor 18 on a slow phone", () => {
		expect(SEAL_WORKER_TIMEOUT_MS).toBe(60_000);
	});

	it.each(["seal", "open"] as const)(
		"%s gives up at the limit, ends the Worker, and says it timed out",
		async (op) => {
			vi.useFakeTimers();
			const worker = silentWorker();
			const runner = workerSealRunner(() => worker);

			const call: Promise<unknown> = runner[op](PAYLOAD, PASSPHRASE);
			const result = track(call);
			await vi.advanceTimersByTimeAsync(SEAL_WORKER_TIMEOUT_MS - 1);
			expect(result.settled).toBe(false);
			expect(worker.terminated).toBe(false);

			await vi.advanceTimersByTimeAsync(1);
			expect(result).toEqual({ settled: true, value: TIMED_OUT });
			expect(worker.terminated).toBe(true);
		},
	);

	it("ignores a reply that arrives after it gave up", async () => {
		vi.useFakeTimers();
		const worker = silentWorker();
		const pending = workerSealRunner(() => worker).seal(PAYLOAD, PASSPHRASE);

		await vi.advanceTimersByTimeAsync(SEAL_WORKER_TIMEOUT_MS);
		worker.reply({ ok: true, bytes: PAYLOAD });

		expect(await pending).toEqual(TIMED_OUT);
	});

	it("clears its timer once the Worker answers", async () => {
		vi.useFakeTimers();
		const worker = silentWorker();
		const pending = workerSealRunner(() => worker).open(PAYLOAD, PASSPHRASE);

		worker.reply({ ok: false, reason: "wrong_passphrase_or_tampered" });

		expect(await pending).toEqual({
			ok: false,
			reason: "wrong_passphrase_or_tampered",
		});
		expect(vi.getTimerCount()).toBe(0);
		expect(worker.terminated).toBe(true);
	});

	it("reports a reply that cannot be read as unavailable", async () => {
		vi.useFakeTimers();
		const worker = silentWorker();
		const pending = workerSealRunner(() => worker).seal(PAYLOAD, PASSPHRASE);

		worker.onmessageerror?.();

		expect(await pending).toEqual({ ok: false, reason: "unavailable" });
		expect(vi.getTimerCount()).toBe(0);
		expect(worker.terminated).toBe(true);
	});
});

describe("the seal seam", () => {
	it("is the only module that names @gainratio/browser/seal", () => {
		const modules = import.meta.glob<string>(
			["../**/*.ts", "../**/*.tsx", "!../**/*.test.ts", "!../**/*.test.tsx"],
			{ query: "?raw", import: "default", eager: true },
		);
		const importers = Object.entries(modules)
			.filter(([, source]) => source.includes('"@gainratio/browser/seal"'))
			.map(([path]) => path);

		expect(importers).toEqual(["./installKeySeal.ts"]);
		expect(sealSeamSource).toContain('from "@gainratio/browser/seal"');
	});
});
