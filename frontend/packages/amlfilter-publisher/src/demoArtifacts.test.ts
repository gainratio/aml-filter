// Prove the COMMITTED signed BUNDLE artifacts (frontend/app/public/bundle/origin/)
// verify against the COMMITTED public.key — the same fail-closed contract the
// browser sync tier enforces — and that a flipped byte is rejected. Guards the
// REAL shipped bytes, not a synthetic stand-in: a pointer-signature, manifest
// content-address, or demo-structure regression is caught here.
//
// The bundle layout (content-addressed, produced by `edgeproc publish`):
//   latest                   — VersionPointer { manifest_hash, version, sequence, signature }
//   manifest/<manifest_hash> — IndexManifest JSON; sha256(bytes) === <manifest_hash>
//   chunk/<plaintext_hash>   — zstd-COMPRESSED chunk; sha256(decompress(bytes)) === <name>
//
// This publisher-side guard covers the parts that need no zstd (pointer signature,
// manifest content-address, demo structure/version). The FULL chunk decompression +
// content-address + reassembly + demo-content (Ivan Fakovich) verification over the
// SAME committed bundle is done in the browser package's
// engine/sharedBundleParity.test.ts (through @gainratio/browser, portable across Node
// versions — Node's built-in node:zlib zstd is only present on Node >= 22.15).
//
// Verification primitives are reused from the same fail-closed crypto tier the
// browser uses (`@amlfilter/browser/engine`: verifyEd25519 / SignatureError /
// sha256Hex).

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	SignatureError,
	sha256Hex,
	verifyEd25519,
} from "@amlfilter/browser/engine";
import { describe, expect, test } from "vitest";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const PUBLIC = resolve(HERE, "../../../app/public");
const ORIGIN = resolve(PUBLIC, "bundle", "origin");
// The committed demo bundle is signed with the THROWAWAY demo key, not the
// production pin (public/public.key) — verify it against the demo public half.
const PUBLIC_KEY_PATH = resolve(HERE, "../fixtures/demo-public.key");

/** The committed demo bundle's published version (read from `latest`). */
const EXPECTED_VERSION = "demo-1";
/** Per-list materialized files the demo bundle must cover. */
const EXPECTED_FILES = [
	"catalog.json",
	"eu/entities.jsonl",
	"eu/meta.json",
	"eu/vectors.f32",
	"ofac/entities.jsonl",
	"ofac/meta.json",
	"ofac/vectors.f32",
	"uk/entities.jsonl",
	"uk/meta.json",
	"uk/vectors.f32",
	"un/entities.jsonl",
	"un/meta.json",
	"un/vectors.f32",
] as const;

interface VersionPointer {
	readonly manifest_hash: string;
	readonly version: string;
	readonly sequence: number;
	readonly signature: string;
}

interface ManifestFile {
	readonly path: string;
	readonly file_sha256: string;
}

interface IndexManifest {
	readonly bundle_id: string;
	readonly schema_version: number;
	readonly files: readonly ManifestFile[];
}

const DECODER = new TextDecoder();

async function publicKey(): Promise<Uint8Array> {
	return new Uint8Array(await readFile(PUBLIC_KEY_PATH));
}

async function readPointer(): Promise<VersionPointer> {
	return JSON.parse(
		await readFile(join(ORIGIN, "latest"), "utf8"),
	) as VersionPointer;
}

async function readManifest(hash: string): Promise<IndexManifest> {
	const bytes = await readFile(join(ORIGIN, "manifest", hash));
	return JSON.parse(DECODER.decode(bytes)) as IndexManifest;
}

function flipFirstByte(bytes: Uint8Array): Uint8Array {
	const tampered = Uint8Array.from(bytes);
	tampered[0] = (tampered[0] ?? 0) ^ 0xff;
	return tampered;
}

/**
 * Canonical, signature-excluded bytes of the pointer — byte-identical to the
 * engine's `canonicalBytes(pointer, { exclude: { signature: true } })`: object
 * keys sorted recursively, no whitespace. The pointer is a flat string-valued
 * object, so a sorted-key `JSON.stringify` reproduces those exact bytes (the
 * pointer signature is over precisely this message).
 */
function pointerSignedMessage(pointer: VersionPointer): Uint8Array {
	return new TextEncoder().encode(
		JSON.stringify({
			manifest_hash: pointer.manifest_hash,
			sequence: pointer.sequence,
			version: pointer.version,
		}),
	);
}

describe("committed signed demo bundle verifies against public.key", () => {
	test("latest pointer signature verifies; a flipped message byte fails closed", async () => {
		const pointer = await readPointer();
		expect(pointer.sequence).toBe(1);
		const message = pointerSignedMessage(pointer);
		await expect(
			verifyEd25519(await publicKey(), message, pointer.signature),
		).resolves.toBeUndefined();
		await expect(
			verifyEd25519(
				await publicKey(),
				flipFirstByte(message),
				pointer.signature,
			),
		).rejects.toThrow(SignatureError);
	});

	test("manifest is content-addressed: sha256(bytes) === pointer.manifest_hash", async () => {
		const pointer = await readPointer();
		const bytes = new Uint8Array(
			await readFile(join(ORIGIN, "manifest", pointer.manifest_hash)),
		);
		expect(await sha256Hex(bytes)).toBe(pointer.manifest_hash);
		expect(await sha256Hex(flipFirstByte(bytes))).not.toBe(
			pointer.manifest_hash,
		);
	});

	test("bundle is the demo-1 version and covers the four demo lists", async () => {
		const pointer = await readPointer();
		expect(pointer.version).toBe(EXPECTED_VERSION);
		const manifest = await readManifest(pointer.manifest_hash);
		expect(manifest.bundle_id).toBe("amlfilter-watchlists");
		expect(manifest.schema_version).toBe(2);
		expect(manifest.files.map((f) => f.path).sort()).toEqual(
			[...EXPECTED_FILES].sort(),
		);
	});
});
