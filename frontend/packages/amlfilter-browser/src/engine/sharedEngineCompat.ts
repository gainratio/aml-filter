import {
	declaredContentSize,
	IntegrityError,
	type JsonValue,
	canonicalBytes as sharedCanonicalBytes,
	decompressAndVerify as sharedDecompressAndVerify,
} from "@gainratio/browser";

export type { JsonValue };

interface CanonicalOptions {
	readonly exclude?: Readonly<Record<string, boolean>>;
}

/** Preserve AML's boolean exclusion map while delegating canonicalization. */
export function canonicalBytes(
	value: JsonValue,
	options: CanonicalOptions = {},
): Uint8Array {
	const exclude: Record<string, true> = {};
	for (const [key, enabled] of Object.entries(options.exclude ?? {})) {
		if (enabled) exclude[key] = true;
	}
	return sharedCanonicalBytes(value, { exclude });
}

/** Preserve the historical two-argument publisher seam. Runtime bundle reads
 * pass the signed manifest size directly inside `@gainratio/browser`; this
 * compatibility call derives only the zstd frame's binding declaration. */
export function decompressAndVerify(
	chunkHash: string,
	compressed: Uint8Array,
	expectedSize: number | null = declaredContentSize(compressed),
): Promise<Uint8Array> {
	if (expectedSize === null) {
		return Promise.reject(
			new IntegrityError(
				`chunk ${chunkHash} does not declare a decompressed size we can bound`,
			),
		);
	}
	return sharedDecompressAndVerify(chunkHash, compressed, expectedSize);
}
