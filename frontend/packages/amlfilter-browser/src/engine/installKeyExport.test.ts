// The encrypted signing-key export: passphrase → PBKDF2-SHA-256 → AES-256-GCM.
// The file names its public key in the clear (so a reviewer can pin it) and
// carries the seed only as ciphertext bound to that header.

import { publicKeyHex } from "@gainratio/avow";
import { describe, expect, it } from "vitest";
import {
	INSTALL_KEY_EXPORT_FORMAT,
	InstallKeyImportError,
	MIN_PASSPHRASE_LENGTH,
	openInstallKeyExport,
	PBKDF2_ITERATIONS,
	sealInstallKeyExport,
} from "./installKeyExport";

const SEED = "5a".repeat(32);
const PASSPHRASE = "correct horse battery staple";

async function exported(): Promise<string> {
	return sealInstallKeyExport(SEED, await publicKeyHex(SEED), PASSPHRASE);
}

function edit(text: string, change: (file: Record<string, unknown>) => void) {
	const file = JSON.parse(text) as Record<string, unknown>;
	change(file);
	return JSON.stringify(file);
}

async function rejection(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof InstallKeyImportError) {
			return error.reason;
		}
		throw error;
	}
	throw new Error("expected a rejection");
}

// PBKDF2 at 600,000 iterations is deliberately slow; give a loaded runner room.
describe("sealInstallKeyExport", { timeout: 30_000 }, () => {
	it("round-trips the seed and its public key", async () => {
		const opened = await openInstallKeyExport(await exported(), PASSPHRASE);

		expect(opened.seedHex).toBe(SEED);
		expect(opened.publicKeyHex).toBe(await publicKeyHex(SEED));
	});

	it("never writes the seed in plaintext, and pins the KDF cost", async () => {
		const text = await exported();
		const file = JSON.parse(text) as {
			format: string;
			version: number;
			public_key_hex: string;
			kdf: { name: string; hash: string; iterations: number };
			cipher: { name: string };
		};

		expect(text).not.toContain(SEED);
		expect(file.format).toBe("amlfilter.install-key");
		expect(INSTALL_KEY_EXPORT_FORMAT).toBe("amlfilter.install-key");
		expect(file.version).toBe(1);
		expect(file.public_key_hex).toBe(await publicKeyHex(SEED));
		expect(file.kdf).toMatchObject({
			name: "PBKDF2",
			hash: "SHA-256",
			iterations: 600_000,
		});
		expect(PBKDF2_ITERATIONS).toBe(600_000);
		expect(file.cipher.name).toBe("AES-GCM");
	});

	it("refuses a passphrase shorter than 12 characters", async () => {
		expect(MIN_PASSPHRASE_LENGTH).toBe(12);
		await expect(
			sealInstallKeyExport(SEED, await publicKeyHex(SEED), "short"),
		).rejects.toThrow(/at least 12/);
	});
});

describe("openInstallKeyExport", { timeout: 30_000 }, () => {
	it("rejects a wrong passphrase", async () => {
		expect(
			await rejection(
				openInstallKeyExport(await exported(), "the wrong passphrase"),
			),
		).toBe("wrong-passphrase-or-tampered");
	});

	it("rejects a header swapped to another public key", async () => {
		const forged = edit(await exported(), (file) => {
			file.public_key_hex = "00".repeat(32);
		});

		expect(await rejection(openInstallKeyExport(forged, PASSPHRASE))).toBe(
			"wrong-passphrase-or-tampered",
		);
	});

	it("rejects a file that is not JSON, or not this format", async () => {
		expect(await rejection(openInstallKeyExport("not json", PASSPHRASE))).toBe(
			"malformed",
		);
		expect(
			await rejection(openInstallKeyExport('{"format":"x"}', PASSPHRASE)),
		).toBe("malformed");
	});

	it("rejects an unknown version", async () => {
		const future = edit(await exported(), (file) => {
			file.version = 2;
		});

		expect(await rejection(openInstallKeyExport(future, PASSPHRASE))).toBe(
			"unsupported-version",
		);
	});

	it("rejects a KDF cost outside the accepted range", async () => {
		const cheap = edit(await exported(), (file) => {
			file.kdf = { name: "PBKDF2", hash: "SHA-256", iterations: 1, salt: "AA" };
		});

		expect(await rejection(openInstallKeyExport(cheap, PASSPHRASE))).toBe(
			"malformed",
		);
	});

	it("rejects a decrypted secret that is not a 32-byte seed", async () => {
		const short = await sealInstallKeyExport(
			"aa".repeat(31),
			await publicKeyHex(SEED),
			PASSPHRASE,
		);

		expect(await rejection(openInstallKeyExport(short, PASSPHRASE))).toBe(
			"malformed",
		);
	});

	it("rejects a decrypted seed whose public key does not match the header", async () => {
		// A consistent file for a DIFFERENT seed, relabelled — the AAD binds the
		// header, so re-seal it with the wrong label to reach the post-decrypt check.
		const other = "6b".repeat(32);
		const relabelled = await sealInstallKeyExport(
			other,
			await publicKeyHex(SEED),
			PASSPHRASE,
		);

		expect(await rejection(openInstallKeyExport(relabelled, PASSPHRASE))).toBe(
			"key-mismatch",
		);
	});
});
