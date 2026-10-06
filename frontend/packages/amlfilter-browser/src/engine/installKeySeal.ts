// The passphrase-encryption seam: the ONLY module in this repo that names
// "@gainratio/browser/seal". Everything else asks this file, so upgrading or
// swapping the library touches one place.
//
// New files are standard age v1 files (scrypt recipient, work factor 17 =
// 128 MiB), so `age -d` opens them without this app. Files from the previous
// release (PBKDF2-SHA-256 + AES-256-GCM JSON, "install-key v1") open
// read-only through the library's legacy opener.
//
// The library loads `age-encryption` with a dynamic import on the first
// seal/open, so importing this file for `checkNewInstallKeyPassphrase` or
// `isAgeFile` costs nothing. scrypt is synchronous: call seal/open through
// installKeySealRunner.ts, which runs them in a Worker.

import {
	checkNewPassphrase,
	isSealed,
	type LegacyOpenResult,
	type NewPassphraseCheck,
	type NewPassphraseRejection,
	type OpenResult,
	openLegacyPbkdf2AesGcm,
	openWithPassphrase,
	type SealResult,
	sealWithPassphrase,
} from "@gainratio/browser/seal";

export type {
	LegacyOpenResult,
	NewPassphraseCheck,
	NewPassphraseRejection,
	OpenResult,
	SealResult,
};

/** Minimum passphrase length, in code points after NFC. */
export const MIN_PASSPHRASE_LENGTH = 12;

/** Check a passphrase the user is choosing, plus its confirmation. */
export function checkNewInstallKeyPassphrase(
	passphrase: string,
	confirmation: string,
): NewPassphraseCheck {
	return checkNewPassphrase(passphrase, confirmation, {
		minLength: MIN_PASSPHRASE_LENGTH,
	});
}

/** True for an age file. Does not authenticate. */
export function isAgeFile(bytes: Uint8Array): boolean {
	return isSealed(bytes);
}

/** Seal bytes as an age file. Blocks its thread: run it in a Worker. */
export function sealBytes(
	plaintext: Uint8Array,
	passphrase: string,
): Promise<SealResult> {
	return sealWithPassphrase(plaintext, passphrase);
}

/** Open an age file. Blocks its thread: run it in a Worker. */
export function openAgeBytes(
	sealed: Uint8Array,
	passphrase: string,
): Promise<OpenResult> {
	return openWithPassphrase(sealed, passphrase);
}

/** Open a version 1 file (PBKDF2 + AES-GCM). Async WebCrypto, no Worker needed. */
export function openLegacyInstallKey(
	file: Uint8Array | string,
	passphrase: string,
): Promise<LegacyOpenResult> {
	return openLegacyPbkdf2AesGcm(file, passphrase);
}
