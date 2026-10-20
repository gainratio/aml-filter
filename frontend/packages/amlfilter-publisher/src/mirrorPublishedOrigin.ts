// mirrorPublishedOrigin — keep the last good signed bundle live when an
// upstream sanctions feed is unreachable.
//
// WHY THIS EXISTS. Cloudflare Pages deploys a whole directory: whatever is in
// `frontend/app/dist` becomes the site. The signed bundle is served from that
// same tree, so a deploy that omits it would take the watchlist offline. Before
// this module, a code deploy deleted the served origin and rebuilt it from the
// four live feeds — meaning any feed outage (2026-07-30: Treasury's new AWS WAF
// 403ing our fetch) failed the release and froze the ENTIRE site, docs and all.
//
// WHAT IT DOES. Re-publish the bytes that are already live. It fetches the
// currently-served origin and re-verifies the complete trust chain — signed
// /latest pointer against the pinned public key, manifest content-address, and
// every chunk through the client's own zstd-decompress -> sha256 rule — then
// writes those EXACT bytes to the output tree.
//
// WHAT IT DELIBERATELY DOES NOT DO. It never re-signs, never synthesizes a
// pointer, never relaxes a check, and never invents a fresher build date. The
// mirrored pointer keeps its ORIGINAL `version`, so the site continues to state
// the true age of the list it is serving. Nothing is written until every byte
// has verified, so a refused mirror leaves no partial bundle behind.
//
// FAIL-CLOSED CEILING. Serving the last good list is right for a bad afternoon,
// not forever. `maxServedAgeDays` caps how long that is acceptable; past it the
// mirror REFUSES and the deploy goes red, because a silently ancient sanctions
// list is worse than a loud failure. A pointer whose version is not a parseable
// date cannot be aged, so it is refused too whenever a ceiling is in force.

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { decompressAndVerify } from "@amlfilter/browser/engine";
import {
	distinctChunkHashes,
	fetchAndVerifyManifest,
	fetchAndVerifyPointer,
	httpFetchBytes,
	type OriginFetch,
} from "./verifyPublishedOrigin.ts";

/** The live bundle is too old to keep serving (or its age cannot be proven). */
export class MirrorStaleError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "MirrorStaleError";
	}
}

/** What was re-published, and how stale it is. */
export interface MirrorReport {
	readonly version: string;
	readonly sequence: number;
	readonly manifestHash: string;
	readonly chunks: number;
	readonly bytes: number;
	/** Whole days between the pointer's build date and now; null if undateable. */
	readonly ageDays: number | null;
	/** Always false — a mirror is by definition NOT a refreshed list. */
	readonly refreshed: false;
}

export interface MirrorInput {
	readonly baseUrl: string;
	readonly fetchBytes: OriginFetch;
	readonly pubkey: Uint8Array;
	readonly outDir: string;
	readonly maxServedAgeDays?: number;
	readonly now?: () => Date;
}

const MS_PER_DAY = 24 * 60 * 60 * 1_000;
const MIRROR_CONCURRENCY = 8;
/** One file staged in memory; nothing touches disk until all of them verify. */
interface PendingWrite {
	readonly relPath: readonly string[];
	readonly bytes: Uint8Array;
}

/** Whole days between a `YYYY-MM-DD` bundle version and now; null if unparseable. */
export function bundleAgeDays(version: string, now: Date): number | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(version)) {
		return null;
	}
	const built = Date.parse(`${version}T00:00:00Z`);
	if (!Number.isFinite(built)) {
		return null;
	}
	return Math.floor((now.getTime() - built) / MS_PER_DAY);
}

/** Refuse to keep serving a list we cannot prove is recent enough. */
function assertWithinCeiling(
	version: string,
	ageDays: number | null,
	maxServedAgeDays: number | undefined,
): void {
	if (maxServedAgeDays === undefined) {
		return;
	}
	if (ageDays === null) {
		throw new MirrorStaleError(
			`live bundle version "${version}" is not a dated build, so its age cannot be proven against the ${maxServedAgeDays}-day ceiling`,
		);
	}
	if (ageDays > maxServedAgeDays) {
		throw new MirrorStaleError(
			`live bundle was built ${ageDays} days ago (${version}), past the ${maxServedAgeDays}-day ceiling for serving an unrefreshed sanctions list`,
		);
	}
}

/** Fetch every chunk with a bounded worker pool and prove it through the client's decode path. */
async function verifiedChunks(
	baseUrl: string,
	fetchBytes: OriginFetch,
	hashes: ReadonlyArray<string>,
): Promise<readonly PendingWrite[]> {
	const staged = new Array<PendingWrite>(hashes.length);
	let nextIndex = 0;
	const verifyNext = async (): Promise<void> => {
		while (nextIndex < hashes.length) {
			const idx = nextIndex;
			nextIndex += 1;
			const hash = hashes[idx];
			if (hash === undefined) {
				break;
			}
			const compressed = await fetchBytes(`${baseUrl}/chunk/${hash}`);
			// THE client rule: zstd-decompress, then sha256(plaintext) == its name.
			await decompressAndVerify(hash, compressed);
			staged[idx] = { relPath: ["chunk", hash], bytes: compressed };
		}
	};
	const workers = Array.from(
		{ length: Math.min(MIRROR_CONCURRENCY, hashes.length) },
		verifyNext,
	);
	await Promise.all(workers);
	return staged;
}

/** Write the staged tree once every byte has verified. */
async function flush(
	outDir: string,
	writes: readonly PendingWrite[],
): Promise<number> {
	let bytes = 0;
	for (const write of writes) {
		const target = join(outDir, ...write.relPath);
		await mkdir(join(target, ".."), { recursive: true });
		await writeFile(target, write.bytes);
		bytes += write.bytes.byteLength;
	}
	return bytes;
}

/** Re-publish the currently-live signed bundle into `outDir`, verified. */
export async function mirrorPublishedOrigin(
	input: MirrorInput,
): Promise<MirrorReport> {
	const { baseUrl, fetchBytes, pubkey, outDir } = input;
	const now = (input.now ?? (() => new Date()))();

	const pointerBytes = await fetchBytes(`${baseUrl}/latest`);
	const pointer = await fetchAndVerifyPointer(baseUrl, fetchBytes, pubkey);
	const ageDays = bundleAgeDays(pointer.version, now);
	assertWithinCeiling(pointer.version, ageDays, input.maxServedAgeDays);

	const { manifest, bytes: manifestBytes } = await fetchAndVerifyManifest(
		baseUrl,
		fetchBytes,
		pointer,
	);
	const hashes = distinctChunkHashes(manifest);
	const chunks = await verifiedChunks(baseUrl, fetchBytes, hashes);

	const bytes = await flush(outDir, [
		{ relPath: ["latest"], bytes: pointerBytes },
		{ relPath: ["manifest", pointer.manifest_hash], bytes: manifestBytes },
		...chunks,
	]);

	return {
		version: pointer.version,
		sequence: pointer.sequence ?? 0,
		manifestHash: pointer.manifest_hash,
		chunks: hashes.length,
		bytes,
		ageDays,
		refreshed: false,
	};
}

// --- CLI runner ------------------------------------------------------------

export interface MirrorCliArgs {
	readonly baseUrl: string;
	readonly pubkeyPath: string;
	readonly outDir: string;
	readonly maxServedAgeDays?: number;
}

/** Parse `--flag value` pairs; unknown flags and missing values fail loudly. */
export function parseMirrorArgs(argv: ReadonlyArray<string>): MirrorCliArgs {
	const values = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 2) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (flag === undefined || !flag.startsWith("--") || value === undefined) {
			throw new Error(`expected --flag value pairs, got "${String(flag)}"`);
		}
		values.set(flag.slice(2), value);
	}
	for (const flag of values.keys()) {
		if (!["base-url", "pubkey", "out", "max-age-days"].includes(flag)) {
			throw new Error(`unknown flag --${flag}`);
		}
	}
	const baseUrl = values.get("base-url");
	const pubkeyPath = values.get("pubkey");
	const outDir = values.get("out");
	if (
		baseUrl === undefined ||
		pubkeyPath === undefined ||
		outDir === undefined
	) {
		throw new Error("--base-url, --pubkey and --out are required");
	}
	const rawAge = values.get("max-age-days");
	const maxServedAgeDays = rawAge === undefined ? undefined : Number(rawAge);
	if (
		maxServedAgeDays !== undefined &&
		(!Number.isInteger(maxServedAgeDays) || maxServedAgeDays < 0)
	) {
		throw new Error("--max-age-days must be a non-negative integer");
	}
	return {
		baseUrl: baseUrl.replace(/\/$/, ""),
		pubkeyPath,
		outDir: resolve(outDir),
		...(maxServedAgeDays === undefined ? {} : { maxServedAgeDays }),
	};
}

interface MirrorRunDeps {
	readonly fetchBytes?: OriginFetch;
	readonly readFile?: (path: string) => Uint8Array;
	readonly log?: (line: string) => void;
}

/** CLI entry: mirror the live origin and print what the deploy will serve.
 * The `SERVED_*` lines are consumed by the deploy workflow, which appends them
 * to $GITHUB_ENV so the post-deploy verifier checks the version ACTUALLY
 * served rather than the one this run hoped to build. */
export async function runMirrorPublishedOrigin(
	argv: ReadonlyArray<string>,
	deps: MirrorRunDeps = {},
): Promise<MirrorReport> {
	const args = parseMirrorArgs(argv);
	const readFile =
		deps.readFile ?? ((path: string) => new Uint8Array(readFileSync(path)));
	const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
	const report = await mirrorPublishedOrigin({
		baseUrl: args.baseUrl,
		fetchBytes: deps.fetchBytes ?? httpFetchBytes,
		pubkey: readFile(args.pubkeyPath),
		outDir: args.outDir,
		...(args.maxServedAgeDays === undefined
			? {}
			: { maxServedAgeDays: args.maxServedAgeDays }),
	});
	log(`SERVED_VERSION=${report.version}`);
	log(`SERVED_SEQUENCE=${report.sequence}`);
	log(`SERVED_AGE_DAYS=${report.ageDays ?? "unknown"}`);
	process.stderr.write(
		`mirrored the last good signed bundle: version ${report.version}, sequence ${report.sequence}, ${report.chunks} chunks, ${report.bytes} bytes — the sanctions list was NOT refreshed by this run\n`,
	);
	return report;
}
