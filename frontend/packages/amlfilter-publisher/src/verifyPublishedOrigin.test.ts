// The post-publish origin gate, proven against the COMMITTED demo bundle
// (frontend/app/public/bundle/origin — a real signed origin that verifies
// against the pinned frontend/app/public/public.key). The suite drives the
// exact checks CI runs against the live origin after every deploy: signed
// pointer → manifest content hash → every chunk through the client's
// zstd-decompress → content-address rule — plus the failure classes that
// motivated the gate (the 2026-07-13 outage class: served chunk bytes that do
// not verify), and the CLI runner's retry/propagation loop.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IntegrityError, SignatureError } from "@amlfilter/browser/engine";
import { describe, expect, it } from "vitest";
import {
	httpFetchBytes,
	nextPublishedSequence,
	type OriginFetch,
	OriginVerifyError,
	parseVerifyArgs,
	runNextPublishedSequence,
	runVerifyPublishedOrigin,
	sequenceAfterLive,
	verifyPublishedOrigin,
} from "./verifyPublishedOrigin.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_PUBLIC = join(HERE, "..", "..", "..", "app", "public");
const ORIGIN_DIR = join(APP_PUBLIC, "bundle", "origin");
const FIXTURES = join(HERE, "..", "fixtures");
const BASE = "https://origin.test/bundle/origin";

// The committed demo origin is signed with the THROWAWAY demo key; verify it
// against that key — no committed demo artifact carries the production pin now.
const PUBKEY = new Uint8Array(readFileSync(join(FIXTURES, "demo-public.key")));
// The production trust root the live SPA ships. Every pointer verifies against
// THIS pin only — there is no rotation fallback anymore (strict fail-closed).
const PROD_PIN = new Uint8Array(readFileSync(join(APP_PUBLIC, "public.key")));

// A pre-rotation live /latest: a pre-sequence pointer signed by the now-RETIRED
// key. Kept as a fixture to prove the strict fail-closed behavior — with the
// rotation dual-trust bridge removed it must be REJECTED, never trusted.
const LEGACY_LATEST =
	'{"manifest_hash":"9ca69ce7455f04b585c2d9210ce72d2c6ed242c0baf72a067550484b4eb2e434","version":"demo-1","signature":"TgCmN5VLFh6J6OFdNIAakEKuqrQbM9wOolPRxu4Ro8udgnF9f+9UuP4hDtKg7DOhhIg/THwF5uiggJStoDK9Bw=="}';

/** An OriginFetch backed by the committed demo origin tree. */
function fixtureFetch(): OriginFetch {
	return (url: string) => {
		if (!url.startsWith(`${BASE}/`)) {
			return Promise.reject(new Error(`unexpected url ${url}`));
		}
		const rel = url.slice(BASE.length + 1).split("/");
		return Promise.resolve(
			new Uint8Array(readFileSync(join(ORIGIN_DIR, ...rel))),
		);
	};
}

/** The same origin tree with its pre-sequence signed /latest pointer. */
function legacyFixtureFetch(): OriginFetch {
	const current = fixtureFetch();
	return (url: string) =>
		url === `${BASE}/latest`
			? Promise.resolve(new TextEncoder().encode(LEGACY_LATEST))
			: current(url);
}

function demoVersion(): string {
	const latest = JSON.parse(
		readFileSync(join(ORIGIN_DIR, "latest"), "utf8"),
	) as { version: string };
	return latest.version;
}

/** Wrap a fetch so one URL suffix gets doctored bytes. */
function tamper(
	inner: OriginFetch,
	match: (url: string) => boolean,
	doctor: (bytes: Uint8Array) => Uint8Array,
): OriginFetch {
	return async (url) => {
		const bytes = await inner(url);
		return match(url) ? doctor(bytes) : bytes;
	};
}

async function firstChunkUrl(): Promise<string> {
	const fetchBytes = fixtureFetch();
	const latest = JSON.parse(
		new TextDecoder().decode(await fetchBytes(`${BASE}/latest`)),
	) as { manifest_hash: string };
	const manifest = JSON.parse(
		new TextDecoder().decode(
			await fetchBytes(`${BASE}/manifest/${latest.manifest_hash}`),
		),
	) as { files: ReadonlyArray<{ chunks: ReadonlyArray<{ hash: string }> }> };
	const hash = manifest.files[0]?.chunks[0]?.hash;
	if (hash === undefined) {
		throw new Error("demo manifest has no chunks");
	}
	return `${BASE}/chunk/${hash}`;
}

describe("verifyPublishedOrigin against the committed demo origin", () => {
	it("verifies the whole chain and reports what it checked", async () => {
		const report = await verifyPublishedOrigin({
			baseUrl: BASE,
			fetchBytes: fixtureFetch(),
			pubkey: PUBKEY,
			expectVersion: demoVersion(),
		});
		expect(report.version).toBe(demoVersion());
		expect(report.files).toBeGreaterThan(0);
		expect(report.chunksVerified).toBeGreaterThan(0);
		expect(report.compressedBytes).toBeGreaterThan(0);
	});

	it("rejects a chunk served as zero bytes (the 2026-07-13 outage class)", async () => {
		const target = await firstChunkUrl();
		const fetchBytes = tamper(
			fixtureFetch(),
			(url) => url === target,
			() => new Uint8Array(0),
		);
		// Still fail-closed, but now refused EARLIER and for a truer reason: zero
		// bytes are not a zstd frame, so no decompressed-size bound can be read
		// from them and nothing is handed to the decoder. It used to reach the
		// content-address check only after a vacuous decompress of empty input.
		await expect(
			verifyPublishedOrigin({ baseUrl: BASE, fetchBytes, pubkey: PUBKEY }),
		).rejects.toBeInstanceOf(IntegrityError);
		await expect(
			verifyPublishedOrigin({ baseUrl: BASE, fetchBytes, pubkey: PUBKEY }),
		).rejects.toThrow(/does not declare a decompressed size/);
	});

	it("rejects a chunk whose served bytes are corrupted", async () => {
		const target = await firstChunkUrl();
		const fetchBytes = tamper(
			fixtureFetch(),
			(url) => url === target,
			(bytes) => {
				const doctored = bytes.slice();
				doctored[12] = (doctored[12] ?? 0) ^ 0xff;
				return doctored;
			},
		);
		await expect(
			verifyPublishedOrigin({ baseUrl: BASE, fetchBytes, pubkey: PUBKEY }),
		).rejects.toBeInstanceOf(IntegrityError);
	});

	it("rejects a manifest whose served bytes do not hash to the pointer", async () => {
		const fetchBytes = tamper(
			fixtureFetch(),
			(url) => url.includes("/manifest/"),
			(bytes) => new Uint8Array([...bytes, 0x20]),
		);
		await expect(
			verifyPublishedOrigin({ baseUrl: BASE, fetchBytes, pubkey: PUBKEY }),
		).rejects.toThrow(/manifest .* failed content-address check/);
	});

	it("rejects a tampered pointer signature", async () => {
		const fetchBytes = tamper(
			fixtureFetch(),
			(url) => url.endsWith("/latest"),
			(bytes) => {
				const text = new TextDecoder().decode(bytes);
				const pointer = JSON.parse(text) as { version: string };
				pointer.version = `${pointer.version}-doctored`;
				return new TextEncoder().encode(JSON.stringify(pointer));
			},
		);
		await expect(
			verifyPublishedOrigin({ baseUrl: BASE, fetchBytes, pubkey: PUBKEY }),
		).rejects.toBeInstanceOf(SignatureError);
	});

	it("rejects a stale deploy: pointer version != the version just published", async () => {
		await expect(
			verifyPublishedOrigin({
				baseUrl: BASE,
				fetchBytes: fixtureFetch(),
				pubkey: PUBKEY,
				expectVersion: "2099-01-01",
			}),
		).rejects.toThrow(/expected "2099-01-01"/);
	});

	it("rejects a published pointer without the expected monotonic sequence", async () => {
		await expect(
			verifyPublishedOrigin({
				baseUrl: BASE,
				fetchBytes: fixtureFetch(),
				pubkey: PUBKEY,
				expectSequence: 29_433_222_924,
			}),
		).rejects.toThrow(/sequence/i);
	});
});

describe("next published monotonic sequence", () => {
	it("increments the verified live pointer, independent of an older workflow run id", async () => {
		const live = JSON.parse(
			new TextDecoder().decode(await fixtureFetch()(`${BASE}/latest`)),
		) as { sequence: number };
		expect(sequenceAfterLive(live.sequence)).toBe(live.sequence + 1);
		// A rerun of an old GitHub workflow still derives from LIVE state; no run id
		// participates in this operation.
		expect(sequenceAfterLive(50_000)).toBe(50_001);
	});

	it("fetches and signature-verifies the live pointer before incrementing", async () => {
		const live = JSON.parse(
			new TextDecoder().decode(await fixtureFetch()(`${BASE}/latest`)),
		) as { sequence: number };
		await expect(
			nextPublishedSequence({
				baseUrl: BASE,
				fetchBytes: fixtureFetch(),
				pubkey: PUBKEY,
			}),
		).resolves.toBe(live.sequence + 1);
	});

	it("rejects a tampered live pointer instead of deriving from it", async () => {
		const fetchBytes = tamper(
			fixtureFetch(),
			(url) => url.endsWith("/latest"),
			(bytes) => {
				const pointer = JSON.parse(new TextDecoder().decode(bytes)) as {
					sequence: number;
				};
				pointer.sequence += 1;
				return new TextEncoder().encode(JSON.stringify(pointer));
			},
		);
		await expect(
			nextPublishedSequence({
				baseUrl: BASE,
				fetchBytes,
				pubkey: PUBKEY,
			}),
		).rejects.toBeInstanceOf(SignatureError);
	});

	it("refuses to overflow JavaScript's safe-integer sequence space", () => {
		expect(() => sequenceAfterLive(Number.MAX_SAFE_INTEGER)).toThrow(
			/safe integer/i,
		);
	});

	it("prints one shell-safe decimal candidate for workflow consumption", async () => {
		const lines: string[] = [];
		const sequence = await runNextPublishedSequence(
			["--base-url", BASE, "--pubkey", join(APP_PUBLIC, "public.key")],
			{
				fetchBytes: fixtureFetch(),
				readFile: () => PUBKEY,
				log: (line) => lines.push(line),
			},
		);
		expect(lines).toEqual([String(sequence)]);
		expect(sequence).toBeGreaterThan(0);
	});

	// THE bridge-removal proof. The pre-rotation live /latest is signed by the
	// now-retired key; the ONLY trust root is the new pin. With the removed
	// dual-trust bridge this pointer would have been ACCEPTED (sequence 1); it
	// must now fail closed against the single pinned key.
	it("rejects an old-key-signed prior pointer — strict single-key fail-closed", async () => {
		await expect(
			nextPublishedSequence({
				baseUrl: BASE,
				fetchBytes: legacyFixtureFetch(),
				pubkey: PROD_PIN,
			}),
		).rejects.toBeInstanceOf(SignatureError);
	});

	// Guard the non-vacuity of the two pin tests below/above: the demo key the
	// committed origin is signed with is genuinely NOT the production pin, so
	// "rejects against PROD_PIN" is a real signature failure, not a same-key pass.
	it("the demo signing key is not the production pin", () => {
		expect(PUBKEY).not.toEqual(PROD_PIN);
	});

	it("the post-publish gate verifies bundles against the NEW pin ONLY (no dual-trust)", async () => {
		// verifyPublishedOrigin exposes no fallback. Serve a well-formed, sequenced
		// bundle NOT signed by the new pin (the committed demo origin is demo-signed)
		// — the shipping gate rejects it on the signature, no dual-trust.
		await expect(
			verifyPublishedOrigin({
				baseUrl: BASE,
				fetchBytes: fixtureFetch(),
				pubkey: PROD_PIN,
			}),
		).rejects.toBeInstanceOf(SignatureError);
	});

	// Regression guard: the removed rotation bridge's CLI flag must no longer be
	// accepted. `--fallback-pubkey` is now an unknown flag and fails closed, so a
	// workflow cannot silently reopen the dual-trust path.
	it("CLI: rejects the removed --fallback-pubkey flag as unknown", async () => {
		await expect(
			runNextPublishedSequence(
				[
					"--base-url",
					BASE,
					"--pubkey",
					"prod.key",
					"--fallback-pubkey",
					"old.key",
				],
				{
					fetchBytes: legacyFixtureFetch(),
					readFile: () => PROD_PIN,
					log: () => {},
				},
			),
		).rejects.toThrow(/unknown flag --fallback-pubkey/);
	});

	it("CLI: rejects an unknown flag on next-published-sequence", async () => {
		await expect(
			runNextPublishedSequence(
				["--base-url", BASE, "--pubkey", "prod.key", "--nope", "x"],
				{
					fetchBytes: legacyFixtureFetch(),
					readFile: () => PROD_PIN,
					log: () => {},
				},
			),
		).rejects.toThrow(/unknown flag --nope/);
	});
});

describe("parseVerifyArgs", () => {
	it("parses flags and applies defaults", () => {
		const args = parseVerifyArgs([
			"--base-url",
			"https://aml-filter.com/bundle/origin/",
			"--pubkey",
			"public.key",
			"--expect-version",
			"2026-07-13",
			"--expect-sequence",
			"29433222924",
		]);
		expect(args).toEqual({
			baseUrl: "https://aml-filter.com/bundle/origin",
			pubkeyPath: "public.key",
			expectVersion: "2026-07-13",
			expectSequence: 29_433_222_924,
			attempts: 10,
			delaySeconds: 15,
		});
	});

	it.each([
		[[], /--base-url and --pubkey are required/],
		[["--base-url"], /expected --flag value pairs/],
		[["--nope", "x"], /unknown flag --nope/],
		[
			["--base-url", "u", "--pubkey", "k", "--attempts", "0"],
			/--attempts must be a positive integer/,
		],
		[
			["--base-url", "u", "--pubkey", "k", "--delay-seconds", "-1"],
			/--delay-seconds must be >= 0/,
		],
	])("rejects bad argv %j", (argv, message) => {
		expect(() => parseVerifyArgs(argv as ReadonlyArray<string>)).toThrow(
			message,
		);
	});
});

describe("runVerifyPublishedOrigin (CLI runner)", () => {
	const CLI = [
		"--base-url",
		BASE,
		"--pubkey",
		join(FIXTURES, "demo-public.key"),
		"--delay-seconds",
		"0",
	];

	it("retries through a propagation window, then reports success", async () => {
		let calls = 0;
		const flaky: OriginFetch = (url) => {
			calls += 1;
			if (calls <= 1) {
				return Promise.reject(
					new OriginVerifyError("fetch failed: 522 origin unreachable"),
				);
			}
			return fixtureFetch()(url);
		};
		const lines: string[] = [];
		const report = await runVerifyPublishedOrigin([...CLI, "--attempts", "3"], {
			fetchBytes: flaky,
			sleep: () => Promise.resolve(),
			log: (line) => lines.push(line),
		});
		expect(report.chunksVerified).toBeGreaterThan(0);
		expect(lines.some((line) => line.includes("attempt 1/3 failed"))).toBe(
			true,
		);
		expect(lines.some((line) => line.includes("published origin OK"))).toBe(
			true,
		);
	});

	it("throws the last failure once attempts are exhausted", async () => {
		const dead: OriginFetch = () =>
			Promise.reject(new OriginVerifyError("fetch failed: 522"));
		await expect(
			runVerifyPublishedOrigin([...CLI, "--attempts", "2"], {
				fetchBytes: dead,
				sleep: () => Promise.resolve(),
				log: () => {},
			}),
		).rejects.toThrow(/522/);
	});
});

describe("httpFetchBytes", () => {
	it("fails closed on a non-2xx response", async () => {
		// A well-known always-404 (no network: use a data-less local server is
		// overkill) — stub global fetch instead.
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (() =>
			Promise.resolve(
				new Response("nope", { status: 404, statusText: "Not Found" }),
			)) as typeof fetch;
		try {
			await expect(httpFetchBytes("https://x/latest")).rejects.toThrow(
				/404 Not Found/,
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("returns the raw bytes on success", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (() =>
			Promise.resolve(new Response(new Uint8Array([1, 2, 3])))) as typeof fetch;
		try {
			await expect(httpFetchBytes("https://x/latest")).resolves.toEqual(
				new Uint8Array([1, 2, 3]),
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
