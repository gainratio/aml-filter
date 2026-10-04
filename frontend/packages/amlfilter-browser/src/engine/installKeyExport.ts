// The encrypted signing-key export file.
//
// Standard WebCrypto only: the passphrase is stretched with PBKDF2-SHA-256
// (600,000 iterations, the OWASP 2023 floor for PBKDF2-SHA-256) into an
// AES-256-GCM key. The 32-byte seed is the plaintext. The header — format,
// version, public key, KDF and cipher parameters — is the AES-GCM additional
// data, so editing any of it (say, relabelling the public key) fails
// decryption exactly like a wrong passphrase. After decrypting, the seed's
// derived public key must equal the header's.
//
// File (JSON, version 1):
//   { format: "amlfilter.install-key", version: 1, public_key_hex,
//     kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt },
//     cipher: { name: "AES-GCM", iv }, ciphertext, exported_at }
// salt / iv / ciphertext are base64.

import { publicKeyHex as derivePublicKeyHex } from "@gainratio/avow";

export const INSTALL_KEY_EXPORT_FORMAT = "amlfilter.install-key";
export const INSTALL_KEY_EXPORT_VERSION = 1;
export const PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSPHRASE_LENGTH = 12;
/** Bounds on a file's KDF cost: no downgrade, no CPU-burning import. */
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 10_000_000;

/** Why an import was refused. Nothing was changed when you see one. */
export type InstallKeyImportRejection =
	| "malformed"
	| "unsupported-version"
	| "wrong-passphrase-or-tampered"
	| "key-mismatch";

export class InstallKeyImportError extends Error {
	override readonly name = "InstallKeyImportError";
	constructor(
		readonly reason: InstallKeyImportRejection,
		message: string,
	) {
		super(message);
	}
}

interface ExportHeader {
	readonly format: typeof INSTALL_KEY_EXPORT_FORMAT;
	readonly version: number;
	readonly public_key_hex: string;
	readonly kdf: {
		readonly name: "PBKDF2";
		readonly hash: "SHA-256";
		readonly iterations: number;
		readonly salt: string;
	};
	readonly cipher: { readonly name: "AES-GCM"; readonly iv: string };
}

interface ExportFile extends ExportHeader {
	readonly ciphertext: string;
	readonly exported_at: string;
}

/** The decrypted key. `seedHex` is a secret: never log it. */
export interface OpenedInstallKey {
	readonly seedHex: string;
	readonly publicKeyHex: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

function toBase64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i += 1) {
		bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The AES-GCM additional data: the header, in a fixed field order. */
function additionalData(header: ExportHeader): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(
		JSON.stringify([
			header.format,
			header.version,
			header.public_key_hex,
			header.kdf.name,
			header.kdf.hash,
			header.kdf.iterations,
			header.kdf.salt,
			header.cipher.name,
			header.cipher.iv,
		]),
	);
}

async function deriveAesKey(
	passphrase: string,
	salt: Uint8Array<ArrayBuffer>,
	iterations: number,
): Promise<CryptoKey> {
	const material = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(passphrase),
		"PBKDF2",
		false,
		["deriveKey"],
	);
	return crypto.subtle.deriveKey(
		{ name: "PBKDF2", hash: "SHA-256", salt, iterations },
		material,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

/** Encrypt the seed under a passphrase. Returns the file's JSON text. */
export async function sealInstallKeyExport(
	seedHex: string,
	publicKeyHex: string,
	passphrase: string,
): Promise<string> {
	if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
		throw new RangeError(
			`passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`,
		);
	}
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const header: ExportHeader = {
		format: INSTALL_KEY_EXPORT_FORMAT,
		version: INSTALL_KEY_EXPORT_VERSION,
		public_key_hex: publicKeyHex,
		kdf: {
			name: "PBKDF2",
			hash: "SHA-256",
			iterations: PBKDF2_ITERATIONS,
			salt: toBase64(salt),
		},
		cipher: { name: "AES-GCM", iv: toBase64(iv) },
	};
	const key = await deriveAesKey(passphrase, salt, PBKDF2_ITERATIONS);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: additionalData(header) },
		key,
		hexToBytes(seedHex),
	);
	const file: ExportFile = {
		...header,
		ciphertext: toBase64(new Uint8Array(ciphertext)),
		exported_at: new Date().toISOString(),
	};
	return JSON.stringify(file, null, 2);
}

function malformed(detail: string): InstallKeyImportError {
	return new InstallKeyImportError(
		"malformed",
		`not a signing-key file: ${detail}`,
	);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** JSON.parse that returns undefined for text that is not JSON. */
export function parseJsonOrUndefined(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

function parseJson(text: string): Record<string, unknown> {
	const value = parseJsonOrUndefined(text);
	if (isRecord(value)) {
		return value;
	}
	throw malformed("not JSON");
}

function validKdf(kdf: unknown): kdf is ExportHeader["kdf"] {
	return (
		isRecord(kdf) &&
		kdf.name === "PBKDF2" &&
		kdf.hash === "SHA-256" &&
		typeof kdf.salt === "string" &&
		typeof kdf.iterations === "number" &&
		Number.isInteger(kdf.iterations) &&
		kdf.iterations >= MIN_ITERATIONS &&
		kdf.iterations <= MAX_ITERATIONS
	);
}

function validCipher(cipher: unknown): cipher is ExportHeader["cipher"] {
	return (
		isRecord(cipher) &&
		cipher.name === "AES-GCM" &&
		typeof cipher.iv === "string"
	);
}

function parseFile(text: string): ExportFile {
	const file = parseJson(text);
	if (file.format !== INSTALL_KEY_EXPORT_FORMAT) {
		throw malformed("wrong format");
	}
	if (file.version !== INSTALL_KEY_EXPORT_VERSION) {
		throw new InstallKeyImportError(
			"unsupported-version",
			`unsupported signing-key file version ${String(file.version)}`,
		);
	}
	const shaped =
		typeof file.public_key_hex === "string" &&
		HEX64.test(file.public_key_hex) &&
		typeof file.ciphertext === "string" &&
		validKdf(file.kdf) &&
		validCipher(file.cipher);
	if (!shaped) {
		throw malformed("missing or invalid fields");
	}
	return file as unknown as ExportFile;
}

async function decryptSeed(
	file: ExportFile,
	passphrase: string,
): Promise<Uint8Array> {
	try {
		const key = await deriveAesKey(
			passphrase,
			fromBase64(file.kdf.salt),
			file.kdf.iterations,
		);
		const plain = await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: fromBase64(file.cipher.iv),
				additionalData: additionalData(file),
			},
			key,
			fromBase64(file.ciphertext),
		);
		return new Uint8Array(plain);
	} catch {
		throw new InstallKeyImportError(
			"wrong-passphrase-or-tampered",
			"wrong passphrase, or the file was changed",
		);
	}
}

/** Decrypt and check a signing-key file. Throws InstallKeyImportError. */
export async function openInstallKeyExport(
	text: string,
	passphrase: string,
): Promise<OpenedInstallKey> {
	const file = parseFile(text);
	const seedHex = bytesToHex(await decryptSeed(file, passphrase));
	if (!HEX64.test(seedHex)) {
		throw malformed("seed is not 32 bytes");
	}
	const publicKeyHex = await derivePublicKeyHex(seedHex);
	if (publicKeyHex !== file.public_key_hex) {
		throw new InstallKeyImportError(
			"key-mismatch",
			"the decrypted key does not match the file's public key",
		);
	}
	return { seedHex, publicKeyHex };
}
