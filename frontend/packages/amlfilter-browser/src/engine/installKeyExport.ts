// The encrypted signing-key export file.
//
// Version 2 (written now): a standard age v1 file with a scrypt passphrase
// recipient (work factor 17, 128 MiB), made through the seal seam
// (installKeySeal.ts). `age -d` can open it without this app. The encrypted
// payload is JSON:
//   { format: "amlfilter.install-key", version: 2, public_key_hex, seed_hex }
// age authenticates the whole file, so any edit fails like a wrong
// passphrase. After decrypting, the seed's derived public key must equal the
// payload's.
//
// Version 1 (read only): the previous release's JSON file, PBKDF2-SHA-256
// (600,000 iterations) + AES-256-GCM with the header as additional data. It
// is opened by the library's legacy opener; this app never writes it again.

import { publicKeyHex as derivePublicKeyHex } from "@gainratio/avow";
import {
	checkNewInstallKeyPassphrase,
	isAgeFile,
	type LegacyOpenResult,
	MIN_PASSPHRASE_LENGTH,
	type NewPassphraseRejection,
	type OpenResult,
	openLegacyInstallKey,
} from "./installKeySeal";
import { defaultSealRunner, type SealRunner } from "./installKeySealRunner";

export { MIN_PASSPHRASE_LENGTH };

export const INSTALL_KEY_EXPORT_FORMAT = "amlfilter.install-key";
/** The version this release writes (an age file). */
export const INSTALL_KEY_EXPORT_VERSION = 2;
/** The previous release's PBKDF2 + AES-GCM JSON file (read only). */
const LEGACY_VERSION = 1;

/** Why an import was refused. Nothing was changed when you see one. */
export type InstallKeyImportRejection =
	| "malformed"
	| "unsupported-version"
	| "unsupported"
	| "wrong-passphrase-or-tampered"
	| "key-mismatch"
	| "too-costly"
	| "out-of-memory"
	| "unavailable";

export class InstallKeyImportError extends Error {
	override readonly name = "InstallKeyImportError";
	readonly reason: InstallKeyImportRejection;
	/** For "too-costly": the file's scrypt work factor (log2 N). */
	readonly workFactor: number | undefined;
	constructor(
		reason: InstallKeyImportRejection,
		message: string,
		workFactor?: number,
	) {
		super(message);
		this.reason = reason;
		this.workFactor = workFactor;
	}
}

/** Why an export was refused. Nothing was saved when you see one. */
export type InstallKeyExportRejection =
	| "empty"
	| "too-short"
	| "out-of-memory"
	| "unavailable";

export class InstallKeyExportError extends Error {
	override readonly name = "InstallKeyExportError";
	readonly reason: InstallKeyExportRejection;
	constructor(reason: InstallKeyExportRejection, message: string) {
		super(message);
		this.reason = reason;
	}
}

/** The decrypted key. `seedHex` is a secret: never log it. */
export interface OpenedInstallKey {
	readonly seedHex: string;
	readonly publicKeyHex: string;
}

interface PayloadV2 {
	readonly format: typeof INSTALL_KEY_EXPORT_FORMAT;
	readonly version: typeof INSTALL_KEY_EXPORT_VERSION;
	readonly public_key_hex: string;
	readonly seed_hex: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
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

// ------------------------------------------------------------------ export

const EXPORT_REFUSAL: Record<
	NewPassphraseRejection,
	InstallKeyExportRejection
> = { empty: "empty", too_short: "too-short", mismatch: "too-short" };

function checkExportPassphrase(passphrase: string): void {
	const check = checkNewInstallKeyPassphrase(passphrase, passphrase);
	if (!check.ok) {
		throw new InstallKeyExportError(
			EXPORT_REFUSAL[check.reason],
			`passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`,
		);
	}
}

/** Encrypt the seed under a passphrase. Returns the age file's bytes. */
export async function sealInstallKeyExport(
	seedHex: string,
	publicKeyHex: string,
	passphrase: string,
	runner: SealRunner = defaultSealRunner(),
): Promise<Uint8Array<ArrayBuffer>> {
	checkExportPassphrase(passphrase);
	const payload: PayloadV2 = {
		format: INSTALL_KEY_EXPORT_FORMAT,
		version: INSTALL_KEY_EXPORT_VERSION,
		public_key_hex: publicKeyHex,
		seed_hex: seedHex,
	};
	const sealed = await runner.seal(
		new TextEncoder().encode(JSON.stringify(payload)),
		passphrase,
	);
	if (sealed.ok) {
		// A copy on a plain ArrayBuffer, so it can go straight into a Blob.
		return new Uint8Array(sealed.bytes);
	}
	const reason =
		sealed.reason === "out_of_memory" ? "out-of-memory" : "unavailable";
	throw new InstallKeyExportError(reason, `could not encrypt: ${reason}`);
}

// ------------------------------------------------------------------ import

const IMPORT_MESSAGES: Record<InstallKeyImportRejection, string> = {
	malformed: "not a signing-key file",
	"unsupported-version": "unsupported signing-key file version",
	unsupported: "the file uses encryption settings this app will not open",
	"wrong-passphrase-or-tampered": "wrong passphrase, or the file was changed",
	"key-mismatch": "the decrypted key does not match the file's public key",
	"too-costly": "the file needs more memory to open than this app allows",
	"out-of-memory":
		"the device ran out of memory; the passphrase was not checked",
	unavailable:
		"the decryption code failed to load; the passphrase was not checked",
};

function refuse(
	reason: InstallKeyImportRejection,
	workFactor?: number,
): InstallKeyImportError {
	return new InstallKeyImportError(reason, IMPORT_MESSAGES[reason], workFactor);
}

type LibraryFailure =
	| Extract<OpenResult, { ok: false }>
	| Extract<LegacyOpenResult, { ok: false }>;

const LIBRARY_REASON: Record<
	LibraryFailure["reason"],
	InstallKeyImportRejection
> = {
	wrong_passphrase_or_tampered: "wrong-passphrase-or-tampered",
	not_sealed: "malformed",
	malformed: "malformed",
	unsupported: "unsupported",
	too_costly: "too-costly",
	too_large: "malformed",
	out_of_memory: "out-of-memory",
	unavailable: "unavailable",
};

function libraryFailure(failure: LibraryFailure): InstallKeyImportError {
	const workFactor = "workFactor" in failure ? failure.workFactor : undefined;
	return refuse(LIBRARY_REASON[failure.reason], workFactor);
}

/** The seed's derived public key must equal the one the file names. */
async function checked(
	seedHex: string,
	claimedPublicKeyHex: string,
): Promise<OpenedInstallKey> {
	if (!HEX64.test(seedHex)) {
		throw refuse("malformed");
	}
	const publicKeyHex = await derivePublicKeyHex(seedHex);
	if (publicKeyHex !== claimedPublicKeyHex) {
		throw refuse("key-mismatch");
	}
	return { seedHex, publicKeyHex };
}

function parsePayload(bytes: Uint8Array): PayloadV2 {
	const payload = parseJsonOrUndefined(new TextDecoder().decode(bytes));
	if (!isRecord(payload) || payload.format !== INSTALL_KEY_EXPORT_FORMAT) {
		throw refuse("malformed");
	}
	if (payload.version !== INSTALL_KEY_EXPORT_VERSION) {
		throw refuse("unsupported-version");
	}
	const shaped =
		typeof payload.public_key_hex === "string" &&
		HEX64.test(payload.public_key_hex) &&
		typeof payload.seed_hex === "string";
	if (!shaped) {
		throw refuse("malformed");
	}
	return payload as unknown as PayloadV2;
}

async function openAgeFile(
	bytes: Uint8Array,
	passphrase: string,
	runner: SealRunner,
): Promise<OpenedInstallKey> {
	const opened = await runner.open(bytes, passphrase);
	if (!opened.ok) {
		throw libraryFailure(opened);
	}
	const payload = parsePayload(opened.bytes);
	return checked(payload.seed_hex, payload.public_key_hex);
}

/** The version 1 header's public key, after its format and version check out. */
function legacyPublicKey(bytes: Uint8Array): string {
	const file = parseJsonOrUndefined(new TextDecoder().decode(bytes));
	if (!isRecord(file) || file.format !== INSTALL_KEY_EXPORT_FORMAT) {
		throw refuse("malformed");
	}
	if (file.version !== LEGACY_VERSION) {
		throw refuse("unsupported-version");
	}
	return typeof file.public_key_hex === "string" ? file.public_key_hex : "";
}

async function openLegacyFile(
	bytes: Uint8Array,
	passphrase: string,
): Promise<OpenedInstallKey> {
	const claimed = legacyPublicKey(bytes);
	const opened = await openLegacyInstallKey(bytes, passphrase);
	if (!opened.ok) {
		throw libraryFailure(opened);
	}
	return checked(bytesToHex(opened.bytes), claimed);
}

/** Decrypt and check a signing-key file (v2 age, or v1). Throws InstallKeyImportError. */
export function openInstallKeyExport(
	file: Uint8Array | string,
	passphrase: string,
	runner: SealRunner = defaultSealRunner(),
): Promise<OpenedInstallKey> {
	const bytes =
		typeof file === "string" ? new TextEncoder().encode(file) : file;
	return isAgeFile(bytes)
		? openAgeFile(bytes, passphrase, runner)
		: openLegacyFile(bytes, passphrase);
}
