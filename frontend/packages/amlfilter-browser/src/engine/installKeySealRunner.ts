// Where scrypt runs. It is synchronous and holds 128 MiB, so on the page it
// would freeze the tab; each seal/open gets its own short-lived Worker, which
// is terminated after the call so the memory goes back at once.
//
// Where there is no Worker (Node, jsdom tests) the inline runner calls the
// seam directly.
//
// A Worker can also die without a word (killed for memory on a phone, a reply
// that cannot be deserialised). Every call therefore ends: it answers, fails as
// `unavailable`, or gives up as `timed_out` after SEAL_WORKER_TIMEOUT_MS, and the
// Worker is terminated either way, so import/export never spins forever.

import {
	type OpenResult,
	openAgeBytes,
	type SealResult,
	sealBytes,
} from "./installKeySeal";

/**
 * How long one seal/open may take before the runner gives up on its Worker.
 *
 * Measured: scrypt at work factor 17 (128 MiB) takes about 0.3-0.5 s on a
 * desktop. Opening allows up to work factor 18 (the library's default cap),
 * twice that: about 1 s. A low-end phone is 10-20x slower, so about 20 s at
 * worst, plus Worker start-up and the age module load. 60 s is three times that
 * worst case, so a slow but healthy device is never cut off.
 */
export const SEAL_WORKER_TIMEOUT_MS = 60_000;

/** The Worker stopped answering; the runner gave up and ended it. */
export interface SealTimedOut {
	readonly ok: false;
	readonly reason: "timed_out";
}

export type SealRunResult = SealResult | SealTimedOut;
export type OpenRunResult = OpenResult | SealTimedOut;

/** The two operations that run scrypt. */
export interface SealRunner {
	seal(plaintext: Uint8Array, passphrase: string): Promise<SealRunResult>;
	open(sealed: Uint8Array, passphrase: string): Promise<OpenRunResult>;
}

export type SealRequest =
	| {
			readonly op: "seal";
			readonly bytes: Uint8Array;
			readonly passphrase: string;
	  }
	| {
			readonly op: "open";
			readonly bytes: Uint8Array;
			readonly passphrase: string;
	  };

export type SealResponse = SealResult | OpenResult;

/** The slice of a Worker the runner uses. */
export interface SealWorkerLike {
	onmessage: ((event: { data: SealResponse }) => void) | null;
	onerror: (() => void) | null;
	onmessageerror: (() => void) | null;
	postMessage(request: SealRequest): void;
	terminate(): void;
}

/** What the Worker does with one request. Never throws. */
export function handleSealRequest(request: SealRequest): Promise<SealResponse> {
	return request.op === "seal"
		? sealBytes(request.bytes, request.passphrase)
		: openAgeBytes(request.bytes, request.passphrase);
}

/** Runs scrypt on the calling thread. For Node and tests. */
export const inlineSealRunner: SealRunner = {
	seal: (plaintext, passphrase) => sealBytes(plaintext, passphrase),
	open: (sealed, passphrase) => openAgeBytes(sealed, passphrase),
};

const UNAVAILABLE = { ok: false, reason: "unavailable" } as const;
const TIMED_OUT: SealTimedOut = { ok: false, reason: "timed_out" };

type RunResponse = SealResponse | SealTimedOut;

function runOnce(
	spawn: () => SealWorkerLike,
	request: SealRequest,
): Promise<RunResponse> {
	let worker: SealWorkerLike;
	try {
		worker = spawn();
	} catch {
		return Promise.resolve(UNAVAILABLE);
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	return new Promise<RunResponse>((resolve) => {
		timer = setTimeout(() => resolve(TIMED_OUT), SEAL_WORKER_TIMEOUT_MS);
		worker.onmessage = (event) => resolve(event.data);
		worker.onerror = () => resolve(UNAVAILABLE);
		worker.onmessageerror = () => resolve(UNAVAILABLE);
		worker.postMessage(request);
	}).finally(() => {
		clearTimeout(timer);
		worker.terminate();
	});
}

/** A runner that gives every call its own Worker from `spawn`. */
export function workerSealRunner(spawn: () => SealWorkerLike): SealRunner {
	return {
		seal: (bytes, passphrase) =>
			runOnce(spawn, {
				op: "seal",
				bytes,
				passphrase,
			}) as Promise<SealRunResult>,
		open: (bytes, passphrase) =>
			runOnce(spawn, {
				op: "open",
				bytes,
				passphrase,
			}) as Promise<OpenRunResult>,
	};
}

function spawnSealWorker(): SealWorkerLike {
	return new Worker(new URL("./installKeySeal.worker.ts", import.meta.url), {
		type: "module",
		name: "amlfilter-install-key-seal",
	}) as unknown as SealWorkerLike;
}

/** A Worker runner in the browser; inline where there is no Worker. */
export function defaultSealRunner(): SealRunner {
	return typeof Worker === "undefined"
		? inlineSealRunner
		: workerSealRunner(spawnSealWorker);
}
