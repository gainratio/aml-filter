// Test-only builder for a REAL signed bundle origin.
//
// Every gate that reads the published origin — the freshness checker, the
// carry-forward, the parity suite — has to be driven over the exact trust chain
// the browser verifies: catalog bytes -> content-addressed chunk -> manifest ->
// Ed25519-signed `/latest` pointer. This builds that chain in memory so a suite
// can publish any catalog it likes, including a deliberately broken one.
//
// NOT exported from the package barrel — imported only by *.test.ts files.

import {
	canonicalBytes,
	type JsonValue,
	sha256Hex,
} from "@amlfilter/browser/engine";
import { signBytes } from "./signing.ts";
import type { OriginFetch } from "./verifyPublishedOrigin.ts";

const ENCODER = new TextEncoder();

/**
 * A single zstd frame carrying one RAW (uncompressed) block.
 *
 * Production chunks are compressed by `edgeproc publish`, whose zstd encoder is
 * not resolvable from this package. A raw-block frame is still one legitimate
 * frame that bindingly declares its Frame_Content_Size, so the CLIENT decode
 * path (`decompressAndVerify`, through @gainratio/browser) accepts and decodes it
 * exactly as it does a compressed chunk — which is the path under test.
 */
export function zstdRawFrame(plaintext: Uint8Array): Uint8Array {
	const frame = new Uint8Array(12 + plaintext.byteLength);
	const view = new DataView(frame.buffer);
	view.setUint32(0, 0xfd2f_b528, true); // Magic_Number
	view.setUint8(4, 0b1010_0000); // FCS field = 4 bytes, Single_Segment set
	view.setUint32(5, plaintext.byteLength, true); // Frame_Content_Size
	// Block_Header, 24-bit LE: Last_Block=1, Block_Type=Raw(0), Block_Size.
	const header = (plaintext.byteLength << 3) | 1;
	frame[9] = header & 0xff;
	frame[10] = (header >>> 8) & 0xff;
	frame[11] = (header >>> 16) & 0xff;
	frame.set(plaintext, 12);
	return frame;
}

export interface OriginOptions {
	readonly version?: string;
	readonly sequence?: number;
	/** Sign with this key instead of the factory's key. */
	readonly signWith?: Uint8Array;
	/** Drop catalog.json from the manifest entirely. */
	readonly omitCatalog?: boolean;
	/** Publish these exact bytes as catalog.json, valid JSON or not. */
	readonly rawCatalog?: string;
}

function catalogFile(chunkHash: string): unknown {
	return {
		path: "catalog.json",
		file_type: "json",
		file_sha256: chunkHash,
		chunks: [{ hash: chunkHash }],
	};
}

/** Build a REAL signed origin whose only file is the given catalog, rooted at
 * `base` and signed with `privkey`. */
export function signedOriginFactory(
	base: string,
	privkey: Uint8Array,
): (
	catalog: unknown,
	options?: OriginOptions,
) => Promise<Map<string, Uint8Array>> {
	return async (catalog, options = {}) => {
		const version = options.version ?? "2026-08-01";
		const catalogBytes = ENCODER.encode(
			options.rawCatalog ?? `${JSON.stringify(catalog, null, 2)}\n`,
		);
		const chunkHash = await sha256Hex(catalogBytes);
		const files = options.omitCatalog === true ? [] : [catalogFile(chunkHash)];
		const manifestBytes = ENCODER.encode(
			JSON.stringify({ schema_version: 1, version, files }),
		);
		const manifestHash = await sha256Hex(manifestBytes);
		const pointer = {
			manifest_hash: manifestHash,
			version,
			bundle_id: null,
			channel: null,
			sequence: options.sequence ?? 50,
		};
		const signature = await signBytes(
			options.signWith ?? privkey,
			canonicalBytes(pointer as unknown as JsonValue, {
				exclude: { signature: true, bundle_id: true, channel: true },
			}),
		);
		return new Map([
			[
				`${base}/latest`,
				ENCODER.encode(JSON.stringify({ ...pointer, signature })),
			],
			[`${base}/manifest/${manifestHash}`, manifestBytes],
			[`${base}/chunk/${chunkHash}`, zstdRawFrame(catalogBytes)],
		]);
	};
}

/** An OriginFetch over an in-memory origin; an unknown URL is a 404, not a pass. */
export function fetchFrom(tree: Map<string, Uint8Array>): OriginFetch {
	return (url: string) => {
		const bytes = tree.get(url);
		return bytes === undefined
			? Promise.reject(new Error(`fetch ${url} failed: 404 Not Found`))
			: Promise.resolve(bytes);
	};
}
