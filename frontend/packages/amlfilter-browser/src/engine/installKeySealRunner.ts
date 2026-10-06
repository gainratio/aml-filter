// Where scrypt runs. It is synchronous and holds 128 MiB, so on the page it
// would freeze the tab; each seal/open gets its own short-lived Worker, which
// is terminated after the call so the memory goes back at once.
//
// Where there is no Worker (Node, jsdom tests) the inline runner calls the
// seam directly.

import {
	type OpenResult,
	openAgeBytes,
	type SealResult,
	sealBytes,
} from "./installKeySeal";

/** The two operations that run scrypt. */
export interface SealRunner {
	seal(plaintext: Uint8Array, passphrase: string): Promise<SealResult>;
	open(sealed: Uint8Array, passphrase: string): Promise<OpenResult>;
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

function runOnce(
	spawn: () => SealWorkerLike,
	request: SealRequest,
): Promise<SealResponse> {
	let worker: SealWorkerLike;
	try {
		worker = spawn();
	} catch {
		return Promise.resolve(UNAVAILABLE);
	}
	return new Promise<SealResponse>((resolve) => {
		worker.onmessage = (event) => resolve(event.data);
		worker.onerror = () => resolve(UNAVAILABLE);
		worker.postMessage(request);
	}).finally(() => worker.terminate());
}

/** A runner that gives every call its own Worker from `spawn`. */
export function workerSealRunner(spawn: () => SealWorkerLike): SealRunner {
	return {
		seal: (bytes, passphrase) =>
			runOnce(spawn, { op: "seal", bytes, passphrase }) as Promise<SealResult>,
		open: (bytes, passphrase) =>
			runOnce(spawn, { op: "open", bytes, passphrase }) as Promise<OpenResult>,
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
