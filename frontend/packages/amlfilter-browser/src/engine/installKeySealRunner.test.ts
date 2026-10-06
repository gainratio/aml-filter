// scrypt is synchronous and holds 128 MiB, so seal/open run in a Worker that
// lives for one call. These tests drive the message protocol with a fake
// Worker that runs the real handler.

import { describe, expect, it } from "vitest";
import sealSeamSource from "./installKeySeal.ts?raw";
import {
	handleSealRequest,
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
