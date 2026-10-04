// PROOF that the COMMITTED, content-addressed demo bundle the publisher emits
// (frontend/app/public/bundle/origin/) is consumable by THIS in-browser sync
// tier and is correctly signed with the COMMITTED pinned key.
//
// Unlike the old narrow drift-guard (which only re-verified the /latest pointer
// signature), this drives the REAL state machine end-to-end against the REAL
// committed bytes: a fs-backed FetchBytes shim feeds origin/{latest,manifest,chunk}
// into syncIndex; the pointer is verified ed25519 against frontend/app/public/
// demo public key; every chunk is content-addressed + zstd-decompressed; and each file
// is reassembled and its file_sha256 re-checked. A catalog / list / key / signing
// regression in the publisher fails THIS test in the normal Node unit run.
//
// The bundle is produced LOCALLY by `pnpm --filter @amlfilter/publisher run
// build-demo-bundle` (requires uv + edge-proc); it is committed, so this test is
// CI-safe (no uv, no network).

/// <reference types="node" />

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	canonicalBytes,
	type FetchBytes,
	type IndexManifest,
	type JsonValue,
	MemoryCacheStore,
	materializeFile,
	syncIndex,
	type Verify,
	type VersionPointer,
	verifyEd25519,
} from "@gainratio/browser";
import { describe, expect, it } from "vitest";

// engine -> src -> amlfilter-browser -> packages -> frontend.
const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "..", "..", "..", "..", "app", "public");
const ORIGIN = join(PUBLIC, "bundle", "origin");
// The committed demo bundle is signed with the THROWAWAY demo key, not the
// production pin (public/public.key) — verify it against the demo public half.
const PINNED_PUBKEY = join(
	HERE,
	"..",
	"..",
	"..",
	"amlfilter-publisher",
	"fixtures",
	"demo-public.key",
);

const DECODER = new TextDecoder();

/** The committed demo bundle's ed25519 public key (public half of demo.key). */
function pinnedPubkey(): Uint8Array {
	return new Uint8Array(readFileSync(PINNED_PUBKEY));
}

/**
 * A `FetchBytes` adapter over the COMMITTED origin tree, so the sync state
 * machine runs end-to-end without a network. Records the chunk hashes fetched.
 */
function originFetch(): {
	readonly fetchBytes: FetchBytes;
	chunkRequests: () => ReadonlyArray<string>;
} {
	const chunkUrls: string[] = [];
	const fetchBytes: FetchBytes = (url) => {
		if (url.endsWith("/latest")) {
			return Promise.resolve(
				new Uint8Array(readFileSync(join(ORIGIN, "latest"))),
			);
		}
		const manifestMatch = url.match(/\/manifest\/([0-9a-f]+)$/);
		if (manifestMatch?.[1] !== undefined) {
			return Promise.resolve(
				new Uint8Array(
					readFileSync(join(ORIGIN, "manifest", manifestMatch[1])),
				),
			);
		}
		const chunkMatch = url.match(/\/chunk\/([0-9a-f]+)$/);
		if (chunkMatch?.[1] !== undefined) {
			chunkUrls.push(chunkMatch[1]);
			return Promise.resolve(
				new Uint8Array(readFileSync(join(ORIGIN, "chunk", chunkMatch[1]))),
			);
		}
		return Promise.reject(new Error(`unexpected url ${url}`));
	};
	return { fetchBytes, chunkRequests: () => chunkUrls };
}

const PUBKEY = pinnedPubkey();
const realVerify: Verify = (message, signature) =>
	verifyEd25519(PUBKEY, message, signature);

function committedPointer(): VersionPointer {
	return JSON.parse(
		DECODER.decode(new Uint8Array(readFileSync(join(ORIGIN, "latest")))),
	) as VersionPointer;
}

const SLUGS = ["ofac", "eu", "un", "uk"] as const;
const PER_LIST_FILES = ["entities.jsonl", "vectors.f32", "meta.json"] as const;
const EXPECTED_FILES = [
	"catalog.json",
	...SLUGS.flatMap((slug) => PER_LIST_FILES.map((f) => `${slug}/${f}`)),
];

describe("committed demo bundle ↔ in-browser sync tier", () => {
	it("syncs the signed pointer, fetches every chunk, promotes the version", async () => {
		const store = new MemoryCacheStore();
		const { fetchBytes, chunkRequests } = originFetch();

		const result = await syncIndex({
			baseUrl: "/o",
			store,
			fetchBytes,
			verify: realVerify,
		});

		expect(result.version).toBe("demo-1");
		expect(result.manifestHash).toBe(committedPointer().manifest_hash);
		expect(result.chunksReused).toBe(0);
		expect(result.chunksFetched).toBeGreaterThan(0);
		expect(chunkRequests().length).toBeGreaterThan(0);

		// Atomic promote: the active pointer is now the committed, signed one.
		const active = await store.readActive();
		expect(active?.version).toBe("demo-1");
		expect(active?.signature).toBe(committedPointer().signature);
	});

	it("materializes every expected file, reassembly + content-hash verified", async () => {
		const store = new MemoryCacheStore();
		const { fetchBytes } = originFetch();
		const result = await syncIndex({
			baseUrl: "/o",
			store,
			fetchBytes,
			verify: realVerify,
		});

		const manifest = JSON.parse(
			DECODER.decode(await store.getManifest(result.manifestHash)),
		) as IndexManifest;

		expect(manifest.bundle_id).toBe("amlfilter-watchlists");
		expect(manifest.schema_version).toBe(2);
		expect(manifest.files.map((f) => f.path).sort()).toEqual(
			[...EXPECTED_FILES].sort(),
		);

		// materializeFile reassembles chunks and re-checks each file's file_sha256
		// (a throw here = a content-hash failure). Byte length must match the entry.
		for (const entry of manifest.files) {
			const bytes = await materializeFile(store, manifest, entry.path);
			expect(bytes.byteLength).toBe(entry.size);
		}
	});

	it("materialized catalog.json + per-list files parse to the expected shape", async () => {
		const store = new MemoryCacheStore();
		const { fetchBytes } = originFetch();
		const result = await syncIndex({
			baseUrl: "/o",
			store,
			fetchBytes,
			verify: realVerify,
		});
		const manifest = JSON.parse(
			DECODER.decode(await store.getManifest(result.manifestHash)),
		) as IndexManifest;

		const catalog = JSON.parse(
			DECODER.decode(await materializeFile(store, manifest, "catalog.json")),
		) as {
			schemaVersion: number;
			lists: { id: string; slug: string; entitiesCount: number }[];
		};
		expect(catalog.schemaVersion).toBe(1);
		expect(catalog.lists.map((l) => l.slug)).toEqual([...SLUGS]);

		// Each list's vectors.f32 is entitiesCount * dim Float32s; entities.jsonl
		// has one line per entity; meta.json agrees on the count.
		for (const list of catalog.lists) {
			const meta = JSON.parse(
				DECODER.decode(
					await materializeFile(store, manifest, `${list.slug}/meta.json`),
				),
			) as { dim: number; entitiesCount: number };
			const vectors = await materializeFile(
				store,
				manifest,
				`${list.slug}/vectors.f32`,
			);
			expect(vectors.byteLength).toBe(meta.entitiesCount * meta.dim * 4);

			const jsonl = DECODER.decode(
				await materializeFile(store, manifest, `${list.slug}/entities.jsonl`),
			);
			const lines = jsonl.split("\n").filter((l) => l.length > 0);
			expect(lines.length).toBe(meta.entitiesCount);
			expect(meta.entitiesCount).toBe(list.entitiesCount);
		}
	});

	it("the committed /latest signature verifies against the pinned demo key", async () => {
		const pointer = committedPointer();
		// syncIndex already enforces this via realVerify, but assert it directly
		// over the canonical (signature-excluded) bytes so a re-sign-without-re-pin
		// (or vice versa) is unambiguous in the failure.
		const exclude: Record<string, true> = { signature: true };
		if (pointer.bundle_id == null) exclude.bundle_id = true;
		if (pointer.channel == null) exclude.channel = true;
		const message = canonicalBytes(pointer as unknown as JsonValue, {
			exclude,
		});
		await expect(
			realVerify(message, pointer.signature),
		).resolves.toBeUndefined();
	});
});
