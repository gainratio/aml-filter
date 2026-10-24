// verifyPublishedOrigin — the POST-PUBLISH integrity gate (2026-07-13 outage
// follow-up): after the nightly publish deploys, re-fetch the LIVE origin and
// verify the whole trust chain THROUGH THE CLIENT'S OWN DECODE PATH — signed
// /latest pointer → manifest content hash → every chunk's zstd-decompress →
// sha256(plaintext) == content-address (the exact rule the in-tab verifier
// enforces, imported from @amlfilter/browser/engine). If the served
// representation and the content addresses ever disagree — wrong bytes, a
// stray Content-Encoding transform, a stale deploy, a truncated upload — the
// workflow fails instead of shipping a bundle the app cannot load.
//
// Library + thin CLI runner (mirrors buildRealBundle.ts / buildRealBundleMain):
//   pnpm --filter @amlfilter/publisher run verify-published-origin -- \
//     --base-url https://aml-filter.com/bundle/origin \
//     --pubkey <path to the pinned public.key> \
//     --expect-version 2026-07-13 [--attempts 10] [--delay-seconds 15]
// The full verify retries (attempts × delay) so a just-finished Pages deploy
// has time to propagate before the gate votes.

import { readFileSync } from "node:fs";
import {
	canonicalBytes,
	decompressAndVerify,
	type JsonValue,
	sha256Hex,
	verifyEd25519,
} from "@amlfilter/browser/engine";

/** The published origin failed verification (or could not be interrogated). */
export class OriginVerifyError extends Error {
	public constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "OriginVerifyError";
	}
}

/** Fetch raw bytes for an origin URL (injectable for tests). */
export type OriginFetch = (url: string) => Promise<Uint8Array>;

export interface PointerWire {
	readonly manifest_hash: string;
	readonly version: string;
	readonly bundle_id?: string | null;
	readonly channel?: string | null;
	/** Absent only for a pre-sequence pointer during first-publish migration. */
	readonly sequence?: number;
	readonly signature: string;
}

interface ChunkRefWire {
	readonly hash: string;
}

interface FileWire {
	readonly path: string;
	readonly chunks: ReadonlyArray<ChunkRefWire>;
}

export interface ManifestWire {
	readonly files: ReadonlyArray<FileWire>;
}

export interface OriginVerifyReport {
	readonly version: string;
	readonly sequence: number;
	readonly manifestHash: string;
	readonly files: number;
	readonly chunksVerified: number;
	readonly compressedBytes: number;
}

const DECODER = new TextDecoder();
/** Mirrors the in-tab sync worker pool, so the gate exercises the same shape. */
const VERIFY_CONCURRENCY = 8;

function parseJson<T>(bytes: Uint8Array, what: string): T {
	try {
		return JSON.parse(DECODER.decode(bytes)) as T;
	} catch (cause) {
		throw new OriginVerifyError(`published ${what} is not valid JSON`, {
			cause,
		});
	}
}

function assertPointerWire(
	value: unknown,
	allowLegacySequence = false,
): asserts value is PointerWire {
	const p = value as Partial<PointerWire> | null;
	const sequenceValid =
		(p?.sequence === undefined && allowLegacySequence) ||
		(Number.isSafeInteger(p?.sequence) && (p?.sequence as number) >= 0);
	if (
		p === null ||
		typeof p !== "object" ||
		typeof p.manifest_hash !== "string" ||
		typeof p.version !== "string" ||
		!sequenceValid ||
		typeof p.signature !== "string"
	) {
		throw new OriginVerifyError(
			"published /latest pointer is missing manifest_hash/version/signature or a non-negative monotonic sequence",
		);
	}
}

function assertManifestWire(value: unknown): asserts value is ManifestWire {
	const m = value as Partial<ManifestWire> | null;
	if (m === null || typeof m !== "object" || !Array.isArray(m.files)) {
		throw new OriginVerifyError("published manifest has no files[] array");
	}
}

/** Every distinct chunk hash the manifest references. */
export function distinctChunkHashes(
	manifest: ManifestWire,
): ReadonlyArray<string> {
	const hashes = new Set<string>();
	for (const file of manifest.files) {
		for (const ref of file.chunks) {
			hashes.add(ref.hash);
		}
	}
	return [...hashes];
}

export async function fetchAndVerifyPointer(
	baseUrl: string,
	fetchBytes: OriginFetch,
	pubkey: Uint8Array,
	allowLegacySequence = false,
): Promise<PointerWire> {
	const raw = await fetchBytes(`${baseUrl}/latest`);
	const pointer = parseJson<unknown>(raw, "/latest pointer");
	assertPointerWire(pointer, allowLegacySequence);
	const message = canonicalBytes(pointer as unknown as JsonValue, {
		exclude: {
			signature: true,
			bundle_id: pointer.bundle_id == null,
			channel: pointer.channel == null,
		},
	});
	// Fail-closed: the pointer must verify against the single pinned public key.
	await verifyEd25519(pubkey, message, pointer.signature);
	return pointer;
}

/** The only safe publish candidate is one greater than the currently served,
 * signature-verified pointer. Workflow identity is deliberately irrelevant: an
 * old workflow rerun still advances live state instead of rolling it back. */
export function sequenceAfterLive(current: number): number {
	if (!Number.isSafeInteger(current) || current < 0) {
		throw new OriginVerifyError(
			"live pointer sequence must be a non-negative safe integer",
		);
	}
	if (current === Number.MAX_SAFE_INTEGER) {
		throw new OriginVerifyError(
			"live pointer sequence exhausted safe integer range",
		);
	}
	return current + 1;
}

export async function nextPublishedSequence(args: {
	readonly baseUrl: string;
	readonly fetchBytes: OriginFetch;
	readonly pubkey: Uint8Array;
}): Promise<number> {
	const pointer = await fetchAndVerifyPointer(
		args.baseUrl,
		args.fetchBytes,
		args.pubkey,
		true,
	);
	// A valid pre-sequence pointer is the zero baseline. This branch is only for
	// the one-way first publish; all newly emitted pointers carry a sequence and
	// the post-publish verifier remains strict.
	return sequenceAfterLive(pointer.sequence ?? 0);
}

export async function fetchAndVerifyManifest(
	baseUrl: string,
	fetchBytes: OriginFetch,
	pointer: PointerWire,
): Promise<{ readonly manifest: ManifestWire; readonly bytes: Uint8Array }> {
	const raw = await fetchBytes(`${baseUrl}/manifest/${pointer.manifest_hash}`);
	if ((await sha256Hex(raw)) !== pointer.manifest_hash) {
		throw new OriginVerifyError(
			`published manifest ${pointer.manifest_hash} failed content-address check`,
		);
	}
	const manifest = parseJson<unknown>(raw, "manifest");
	assertManifestWire(manifest);
	return { manifest, bytes: raw };
}

/** Fetch + decode-verify every chunk with a bounded pool; return bytes seen. */
async function verifyAllChunks(
	baseUrl: string,
	fetchBytes: OriginFetch,
	hashes: ReadonlyArray<string>,
): Promise<number> {
	let nextIndex = 0;
	const verifyNext = async (): Promise<number> => {
		let workerBytes = 0;
		while (nextIndex < hashes.length) {
			const hash = hashes[nextIndex];
			nextIndex += 1;
			if (hash === undefined) {
				break;
			}
			const compressed = await fetchBytes(`${baseUrl}/chunk/${hash}`);
			// THE client decode path: zstd decompress, then sha256 == name.
			await decompressAndVerify(hash, compressed);
			workerBytes += compressed.byteLength;
		}
		return workerBytes;
	};
	const workers = Array.from(
		{ length: Math.min(VERIFY_CONCURRENCY, hashes.length) },
		verifyNext,
	);
	const perWorker = await Promise.all(workers);
	return perWorker.reduce((total, bytes) => total + bytes, 0);
}

/** Verify the published origin end-to-end; throws on the first mismatch. */
export async function verifyPublishedOrigin(args: {
	readonly baseUrl: string;
	readonly fetchBytes: OriginFetch;
	readonly pubkey: Uint8Array;
	readonly expectVersion?: string;
	readonly expectSequence?: number;
}): Promise<OriginVerifyReport> {
	const { baseUrl, fetchBytes, pubkey, expectVersion, expectSequence } = args;
	const pointer = await fetchAndVerifyPointer(baseUrl, fetchBytes, pubkey);
	if (pointer.sequence === undefined) {
		throw new OriginVerifyError(
			"published /latest pointer is missing a non-negative monotonic sequence",
		);
	}
	if (expectVersion !== undefined && pointer.version !== expectVersion) {
		throw new OriginVerifyError(
			`published pointer version is "${pointer.version}"; expected "${expectVersion}" — the deploy did not take (or has not propagated)`,
		);
	}
	if (expectSequence !== undefined && pointer.sequence !== expectSequence) {
		throw new OriginVerifyError(
			`published pointer sequence is ${pointer.sequence}; expected ${expectSequence} — the deploy did not take (or has not propagated)`,
		);
	}
	const { manifest } = await fetchAndVerifyManifest(
		baseUrl,
		fetchBytes,
		pointer,
	);
	const hashes = distinctChunkHashes(manifest);
	const compressedBytes = await verifyAllChunks(baseUrl, fetchBytes, hashes);
	return {
		version: pointer.version,
		sequence: pointer.sequence,
		manifestHash: pointer.manifest_hash,
		files: manifest.files.length,
		chunksVerified: hashes.length,
		compressedBytes,
	};
}

// --- CLI runner ------------------------------------------------------------

export interface VerifyCliArgs {
	readonly baseUrl: string;
	readonly pubkeyPath: string;
	readonly expectVersion?: string;
	readonly expectSequence?: number;
	readonly attempts: number;
	readonly delaySeconds: number;
}

/** Parse `--flag value` pairs; unknown flags and missing values fail loudly. */
export function parseVerifyArgs(argv: ReadonlyArray<string>): VerifyCliArgs {
	const values = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 2) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (flag === undefined || !flag.startsWith("--") || value === undefined) {
			throw new OriginVerifyError(
				`expected --flag value pairs, got "${String(flag)}"`,
			);
		}
		values.set(flag.slice(2), value);
	}
	const known = new Set([
		"base-url",
		"pubkey",
		"expect-version",
		"expect-sequence",
		"attempts",
		"delay-seconds",
	]);
	for (const flag of values.keys()) {
		if (!known.has(flag)) {
			throw new OriginVerifyError(`unknown flag --${flag}`);
		}
	}
	const baseUrl = values.get("base-url");
	const pubkeyPath = values.get("pubkey");
	if (baseUrl === undefined || pubkeyPath === undefined) {
		throw new OriginVerifyError("--base-url and --pubkey are required");
	}
	const attempts = Number(values.get("attempts") ?? "10");
	const delaySeconds = Number(values.get("delay-seconds") ?? "15");
	const expectSequenceValue = values.get("expect-sequence");
	const expectSequence =
		expectSequenceValue === undefined ? undefined : Number(expectSequenceValue);
	if (!Number.isInteger(attempts) || attempts < 1) {
		throw new OriginVerifyError("--attempts must be a positive integer");
	}
	if (!Number.isFinite(delaySeconds) || delaySeconds < 0) {
		throw new OriginVerifyError("--delay-seconds must be >= 0");
	}
	if (
		expectSequence !== undefined &&
		(!Number.isSafeInteger(expectSequence) || expectSequence < 0)
	) {
		throw new OriginVerifyError(
			"--expect-sequence must be a non-negative safe integer",
		);
	}
	return {
		baseUrl: baseUrl.replace(/\/$/, ""),
		pubkeyPath,
		expectVersion: values.get("expect-version"),
		expectSequence,
		attempts,
		delaySeconds,
	};
}

const HTTP_FETCH_ATTEMPTS = 4;
const HTTP_FETCH_RETRY_DELAY_MS = 250;
const CUSTOM_ORIGIN_PREFIX = "https://aml-filter.com/";
const PAGES_ORIGIN_PREFIX = "https://aml-filter.pages.dev/";

async function fetchOriginResponse(url: string): Promise<Response> {
	const response = await fetch(url);
	if (response.status === 403 && url.startsWith(CUSTOM_ORIGIN_PREFIX)) {
		return fetch(url.replace(CUSTOM_ORIGIN_PREFIX, PAGES_ORIGIN_PREFIX));
	}
	return response;
}

/** Default transport: plain fetch with bounded retry on transient network/5xx errors, fail-closed on non-2xx. */
export async function httpFetchBytes(
	url: string,
	sleepMs: (ms: number) => Promise<void> = (ms) =>
		new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Uint8Array> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= HTTP_FETCH_ATTEMPTS; attempt += 1) {
		let response: Response;
		try {
			response = await fetchOriginResponse(url);
		} catch (error) {
			lastError = error;
			if (attempt < HTTP_FETCH_ATTEMPTS) {
				await sleepMs(HTTP_FETCH_RETRY_DELAY_MS * attempt);
			}
			continue;
		}
		if (!response.ok) {
			const err = new OriginVerifyError(
				`fetch ${url} failed: ${response.status} ${response.statusText}`,
			);
			if (
				(response.status >= 500 || response.status === 429) &&
				attempt < HTTP_FETCH_ATTEMPTS
			) {
				lastError = err;
				await sleepMs(HTTP_FETCH_RETRY_DELAY_MS * attempt);
				continue;
			}
			throw err;
		}
		try {
			return new Uint8Array(await response.arrayBuffer());
		} catch (error) {
			lastError = error;
			if (attempt < HTTP_FETCH_ATTEMPTS) {
				await sleepMs(HTTP_FETCH_RETRY_DELAY_MS * attempt);
			}
		}
	}
	throw lastError instanceof Error
		? lastError
		: new OriginVerifyError(String(lastError));
}

interface RunDeps {
	readonly fetchBytes?: OriginFetch;
	readonly readFile?: (path: string) => Uint8Array;
	readonly sleep?: (seconds: number) => Promise<void>;
	readonly log?: (line: string) => void;
}

interface NextSequenceRunDeps {
	readonly fetchBytes?: OriginFetch;
	readonly readFile?: (path: string) => Uint8Array;
	readonly log?: (line: string) => void;
}

function parseNextSequenceArgs(argv: ReadonlyArray<string>): {
	readonly baseUrl: string;
	readonly pubkeyPath: string;
} {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!flag?.startsWith("--") || value === undefined) {
			throw new OriginVerifyError("expected --flag value pairs");
		}
		values.set(flag.slice(2), value);
	}
	const known = new Set(["base-url", "pubkey"]);
	for (const flag of values.keys()) {
		if (!known.has(flag)) {
			throw new OriginVerifyError(`unknown flag --${flag}`);
		}
	}
	const baseUrl = values.get("base-url");
	const pubkeyPath = values.get("pubkey");
	if (baseUrl === undefined || pubkeyPath === undefined) {
		throw new OriginVerifyError("--base-url and --pubkey are required");
	}
	return {
		baseUrl: baseUrl.replace(/\/$/, ""),
		pubkeyPath,
	};
}

/** CLI runner used before every publish. Stdout is intentionally one decimal
 * line so the shell can assign it to `SEQUENCE` without parsing logs. */
export async function runNextPublishedSequence(
	argv: ReadonlyArray<string>,
	deps: NextSequenceRunDeps = {},
): Promise<number> {
	const args = parseNextSequenceArgs(argv);
	const fetchBytes = deps.fetchBytes ?? httpFetchBytes;
	const readFile =
		deps.readFile ?? ((path: string) => new Uint8Array(readFileSync(path)));
	const sequence = await nextPublishedSequence({
		baseUrl: args.baseUrl,
		fetchBytes,
		pubkey: readFile(args.pubkeyPath),
	});
	(deps.log ?? ((line: string) => console.log(line)))(String(sequence));
	return sequence;
}

const defaultSleep = (seconds: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * Run the gate from CLI argv, retrying the WHOLE verify (attempts × delay) so
 * a just-deployed origin has time to propagate. Resolves with the report on
 * the first clean pass; throws the last failure once attempts are exhausted.
 */
export async function runVerifyPublishedOrigin(
	argv: ReadonlyArray<string>,
	deps: RunDeps = {},
): Promise<OriginVerifyReport> {
	const args = parseVerifyArgs(argv);
	const fetchBytes = deps.fetchBytes ?? httpFetchBytes;
	const readFile =
		deps.readFile ?? ((path: string) => new Uint8Array(readFileSync(path)));
	const sleep = deps.sleep ?? defaultSleep;
	const log = deps.log ?? ((line: string) => console.log(line));
	const pubkey = readFile(args.pubkeyPath);

	let lastError: unknown;
	for (let attempt = 1; attempt <= args.attempts; attempt += 1) {
		try {
			const report = await verifyPublishedOrigin({
				baseUrl: args.baseUrl,
				fetchBytes,
				pubkey,
				expectVersion: args.expectVersion,
				expectSequence: args.expectSequence,
			});
			log(
				`published origin OK: version=${report.version} sequence=${report.sequence} files=${report.files} ` +
					`chunks=${report.chunksVerified} compressedBytes=${report.compressedBytes} ` +
					`manifest=${report.manifestHash}`,
			);
			return report;
		} catch (error) {
			lastError = error;
			const message = error instanceof Error ? error.message : String(error);
			log(`attempt ${attempt}/${args.attempts} failed: ${message}`);
			if (attempt < args.attempts) {
				await sleep(args.delaySeconds);
			}
		}
	}
	throw lastError instanceof Error
		? lastError
		: new OriginVerifyError(String(lastError));
}
