// The encrypted signing-key export.
//
// New files (version 2) are standard age v1 files with a scrypt passphrase
// recipient, written through the @gainratio/browser seal seam, so `age -d`
// can open them too. Files written by the previous release (version 1:
// PBKDF2-SHA-256 + AES-256-GCM JSON) still import, read-only.

import { publicKeyHex } from "@gainratio/avow";
import { describe, expect, it, vi } from "vitest";
import goldenV1 from "./__fixtures__/install-key-export-v1.golden.json?raw";
import {
	INSTALL_KEY_EXPORT_FORMAT,
	INSTALL_KEY_EXPORT_VERSION,
	InstallKeyExportError,
	InstallKeyImportError,
	MIN_PASSPHRASE_LENGTH,
	openInstallKeyExport,
	sealInstallKeyExport,
} from "./installKeyExport";
import { sealBytes } from "./installKeySeal";
import { inlineSealRunner, type SealRunner } from "./installKeySealRunner";

// These tests seal and open at the production scrypt work factor (128 MiB): about 4 s per
// operation under coverage on a laptop and 2-3x that on the shared CI runner, so two
// operations can pass Vitest's 30 s limit there. Strength is not lowered; time is raised.
vi.setConfig({ testTimeout: 120_000 });

const SEED = "5a".repeat(32);
const PASSPHRASE = "correct horse battery staple";

// The golden v1 file was written by the previous release's own sealer
// (installKeyExport.ts at 2834faa) before this change. Never regenerate it.
const GOLDEN_SEED = "3c".repeat(32);
const GOLDEN_PASSPHRASE = "golden fixture passphrase v1";

async function exported(): Promise<Uint8Array> {
	return sealInstallKeyExport(SEED, await publicKeyHex(SEED), PASSPHRASE);
}

function editJson(
	text: string,
	change: (file: Record<string, unknown>) => void,
): string {
	const file = JSON.parse(text) as Record<string, unknown>;
	change(file);
	return JSON.stringify(file);
}

async function importRejection(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof InstallKeyImportError) {
			return error;
		}
		throw error;
	}
	throw new Error("expected a rejection");
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
	return (await importRejection(promise)).reason;
}

/** An age file whose payload is whatever JSON the test wants. */
const TEST_WORK_FACTOR = 10;

async function ageWith(payload: unknown): Promise<Uint8Array> {
	// Lowest work factor: these tests check payload handling, not scrypt strength (the
	// round-trip tests seal at the production default). Full strength under coverage
	// took over 30 s per test on the CI runner.
	const sealed = await sealBytes(
		new TextEncoder().encode(JSON.stringify(payload)),
		PASSPHRASE,
		TEST_WORK_FACTOR,
	);
	if (!sealed.ok) {
		throw new Error(sealed.reason);
	}
	return sealed.bytes;
}

function failingRunner(
	reason: "out_of_memory" | "unavailable" | "timed_out",
): SealRunner {
	return {
		seal: async () => ({ ok: false, reason }),
		open: async () => ({ ok: false, reason }),
	};
}

// scrypt at 128 MiB and PBKDF2 at 600,000 iterations are slow on purpose.
describe("sealInstallKeyExport", { timeout: 30_000 }, () => {
	it("round-trips the seed and its public key", async () => {
		const opened = await openInstallKeyExport(await exported(), PASSPHRASE);

		expect(opened.seedHex).toBe(SEED);
		expect(opened.publicKeyHex).toBe(await publicKeyHex(SEED));
	});

	it("writes a standard age file, never the seed in plaintext", async () => {
		const bytes = await exported();
		const text = new TextDecoder().decode(bytes);

		expect(text.startsWith("age-encryption.org/v1\n-> scrypt ")).toBe(true);
		expect(text).not.toContain(SEED);
		expect(text).not.toContain("PBKDF2");
		expect(INSTALL_KEY_EXPORT_FORMAT).toBe("amlfilter.install-key");
		expect(INSTALL_KEY_EXPORT_VERSION).toBe(2);
	});

	it("seals at scrypt work factor 17 (128 MiB)", async () => {
		const text = new TextDecoder().decode(await exported());

		expect(text.split("\n")[1]).toMatch(/^-> scrypt \S+ 17$/);
	});

	it("refuses a passphrase shorter than 12 characters, or none", async () => {
		expect(MIN_PASSPHRASE_LENGTH).toBe(12);
		const key = await publicKeyHex(SEED);

		await expect(
			sealInstallKeyExport(SEED, key, "elevenchars"),
		).rejects.toMatchObject({
			name: "InstallKeyExportError",
			reason: "too-short",
		});
		await expect(sealInstallKeyExport(SEED, key, "")).rejects.toMatchObject({
			reason: "empty",
		});
	});

	it("reports a device that cannot encrypt, honestly", async () => {
		const key = await publicKeyHex(SEED);
		for (const [reason, expected] of [
			["out_of_memory", "out-of-memory"],
			["unavailable", "unavailable"],
			["timed_out", "timed-out"],
		] as const) {
			const error = await sealInstallKeyExport(
				SEED,
				key,
				PASSPHRASE,
				failingRunner(reason),
			).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(InstallKeyExportError);
			expect((error as InstallKeyExportError).reason).toBe(expected);
		}
	});
});

describe("openInstallKeyExport: version 1 files from the previous release", {
	timeout: 30_000,
}, () => {
	it("opens the golden file the previous release wrote", async () => {
		const opened = await openInstallKeyExport(goldenV1, GOLDEN_PASSPHRASE);

		expect(opened.seedHex).toBe(GOLDEN_SEED);
		expect(opened.publicKeyHex).toBe(await publicKeyHex(GOLDEN_SEED));
	});

	it("opens it from the raw file bytes too", async () => {
		const opened = await openInstallKeyExport(
			new TextEncoder().encode(goldenV1),
			GOLDEN_PASSPHRASE,
		);

		expect(opened.seedHex).toBe(GOLDEN_SEED);
	});

	it("rejects a wrong passphrase", async () => {
		expect(
			await reasonOf(openInstallKeyExport(goldenV1, "the wrong passphrase")),
		).toBe("wrong-passphrase-or-tampered");
	});

	it("rejects a header swapped to another public key", async () => {
		const forged = editJson(goldenV1, (file) => {
			file.public_key_hex = "00".repeat(32);
		});

		expect(
			await reasonOf(openInstallKeyExport(forged, GOLDEN_PASSPHRASE)),
		).toBe("wrong-passphrase-or-tampered");
	});

	it("rejects an unknown JSON version", async () => {
		const future = editJson(goldenV1, (file) => {
			file.version = 3;
		});

		expect(
			await reasonOf(openInstallKeyExport(future, GOLDEN_PASSPHRASE)),
		).toBe("unsupported-version");
	});

	it("refuses a KDF cost outside the accepted range", async () => {
		const cheap = editJson(goldenV1, (file) => {
			file.kdf = { name: "PBKDF2", hash: "SHA-256", iterations: 1, salt: "AA" };
		});

		expect(await reasonOf(openInstallKeyExport(cheap, GOLDEN_PASSPHRASE))).toBe(
			"unsupported",
		);
	});

	it("rejects a file that is not JSON, or not this format", async () => {
		expect(await reasonOf(openInstallKeyExport("not json", PASSPHRASE))).toBe(
			"malformed",
		);
		expect(
			await reasonOf(openInstallKeyExport('{"format":"x"}', PASSPHRASE)),
		).toBe("malformed");
		expect(
			await reasonOf(
				openInstallKeyExport(
					editJson(goldenV1, (file) => {
						file.ciphertext = 42;
					}),
					GOLDEN_PASSPHRASE,
				),
			),
		).toBe("malformed");
	});
});

describe("openInstallKeyExport: version 2 (age) files", {
	timeout: 30_000,
}, () => {
	it("rejects a wrong passphrase", async () => {
		expect(
			await reasonOf(
				openInstallKeyExport(await exported(), "the wrong passphrase"),
			),
		).toBe("wrong-passphrase-or-tampered");
	});

	it("rejects a file changed after export", async () => {
		const bytes = await exported();
		const tampered = bytes.slice();
		const last = tampered.length - 1;
		tampered[last] = (tampered[last] ?? 0) ^ 0x01;

		expect(await reasonOf(openInstallKeyExport(tampered, PASSPHRASE))).toBe(
			"wrong-passphrase-or-tampered",
		);
	});

	it("refuses a file that asks for more memory than allowed, and says how much", async () => {
		const text = new TextDecoder().decode(await exported());
		const costly = text.replace(/^(-> scrypt \S+) 17$/m, "$1 20");

		const error = await importRejection(
			openInstallKeyExport(new TextEncoder().encode(costly), PASSPHRASE),
		);

		expect(error.reason).toBe("too-costly");
		expect(error.workFactor).toBe(20);
	});

	it("rejects a payload whose seed does not match its public key", async () => {
		const relabelled = await ageWith({
			format: INSTALL_KEY_EXPORT_FORMAT,
			version: 2,
			public_key_hex: await publicKeyHex(SEED),
			seed_hex: "6b".repeat(32),
		});

		expect(await reasonOf(openInstallKeyExport(relabelled, PASSPHRASE))).toBe(
			"key-mismatch",
		);
	});

	it("rejects a payload from an unknown version", async () => {
		const future = await ageWith({
			format: INSTALL_KEY_EXPORT_FORMAT,
			version: 3,
			public_key_hex: await publicKeyHex(SEED),
			seed_hex: SEED,
		});

		expect(await reasonOf(openInstallKeyExport(future, PASSPHRASE))).toBe(
			"unsupported-version",
		);
	});

	it("rejects an age file that does not hold a signing key", async () => {
		for (const payload of [
			"just a note",
			{ format: "other", version: 2 },
			{
				format: INSTALL_KEY_EXPORT_FORMAT,
				version: 2,
				public_key_hex: "zz",
				seed_hex: SEED,
			},
		]) {
			expect(
				await reasonOf(
					openInstallKeyExport(await ageWith(payload), PASSPHRASE),
				),
			).toBe("malformed");
		}
	});

	it("says the passphrase was not judged when the device fails", async () => {
		const file = await exported();
		for (const [reason, expected] of [
			["out_of_memory", "out-of-memory"],
			["unavailable", "unavailable"],
			["timed_out", "timed-out"],
		] as const) {
			expect(
				await reasonOf(
					openInstallKeyExport(file, PASSPHRASE, failingRunner(reason)),
				),
			).toBe(expected);
		}
	});

	it("opens through the inline runner the same way", async () => {
		const opened = await openInstallKeyExport(
			await exported(),
			PASSPHRASE,
			inlineSealRunner,
		);

		expect(opened.seedHex).toBe(SEED);
	});
});
