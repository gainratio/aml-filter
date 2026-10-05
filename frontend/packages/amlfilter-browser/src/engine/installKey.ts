// The per-install signing key behind the Avow score receipt.
//
// A receipt is only meaningful if the same installation signs with a STABLE
// key: that is what lets a reviewer pin one public key and later verify every
// receipt this browser profile ever produced. So the seed is generated once,
// on first use, and kept; every later boot re-derives the same public key.
//
// Where it lives: one `install_key` row in SQLite on OPFS (installKeyStore.ts).
// SQLite is the only store for app data. Releases before this one kept the
// seed in localStorage; the first boot after the upgrade migrates it:
//
//   1. copy the old seed into SQLite (one transaction; a row already there wins)
//   2. read the row back and check its public key equals the old seed's
//   3. only then remove the old localStorage entry
//
// A crash anywhere leaves the old entry in place, so the next boot simply
// repeats the steps (idempotent). If SQLite only lives in memory (OPFS
// refused), step 3 is skipped: the old entry is the only durable copy.
//
// Key-custody honesty (the same caveat scoreReceipt.ts carries): the seed is
// held in ordinary browser storage. Same-origin script can read it. This is a
// tamper-EVIDENT provenance record, not a hardware-backed key boundary. It
// proves a receipt was not altered after signing; it does not prove the host
// was uncompromised at signing time. The seed is never logged.

import { generateSeedHex, publicKeyHex } from "@gainratio/avow";
import { sha256Hex } from "@gainratio/browser";
import {
	isRecord,
	openInstallKeyExport,
	parseJsonOrUndefined,
	sealInstallKeyExport,
} from "./installKeyExport";
import {
	type InstallKeyDb,
	type InstallKeyPersistence,
	type InstallKeySqlOpener,
	openInstallKeyDb,
	type QuarantineRecord,
	type StoredInstallKey,
	sqlInstallKeyOpener,
} from "./installKeyStore";

export type { InstallKeyPersistence } from "./installKeyStore";

/** The old release's localStorage key for the seed (read + retire only). */
export const INSTALL_SEED_KEY = "amlfilter.install_signing_seed.v1";

/** The old release's localStorage key for corrupt-seed metadata. */
export const INSTALL_SEED_QUARANTINE_KEY =
	"amlfilter.install_signing_seed.v1.quarantined";

/**
 * The slice of the old localStorage this module may touch: read and remove.
 * There is deliberately no setItem — nothing is ever written there again.
 */
export interface LegacyKeyStorage {
	getItem(key: string): string | null;
	removeItem(key: string): void;
}

/** A resolved install identity: the secret seed plus its public verify key. */
export interface InstallKey {
	/** Secret. Never log or display it. */
	readonly seedHex: string;
	readonly publicKeyHex: string;
	/**
	 * True when a CORRUPT old seed was found, quarantined, and replaced by a
	 * fresh key: receipts sealed before now verify against a key this store no
	 * longer holds. First-use generation is NOT a reset.
	 */
	readonly resetFromCorruptSeed: boolean;
	/** Where the key lives: OPFS, or memory (lost when the tab closes). */
	readonly persistence: InstallKeyPersistence;
}

/** Anything that can hand the sealer and verifier this install's key. */
export interface InstallKeySource {
	load(): Promise<InstallKey>;
}

/** The cross-tab "the key changed" signal (a BroadcastChannel in browsers). */
export interface InstallKeyChannel {
	postMessage(message: "changed"): void;
	addEventListener(type: "message", listener: () => void): void;
}

export interface InstallKeysDeps {
	readonly openSql: InstallKeySqlOpener;
	readonly legacy: LegacyKeyStorage | null;
	readonly channel: InstallKeyChannel | null;
}

const SEED_HEX = /^[0-9a-f]{64}$/;
const INSTALL_SIGNING_KEY_LOCK = "amlfilter.install-signing-key";
const CHANNEL_NAME = "amlfilter.install-key";

/** Run fn under the origin-wide exclusive Web Lock, where the browser has one. */
function underLock<T>(fn: () => Promise<T>): Promise<T> {
	const locks = globalThis.navigator?.locks;
	if (locks === undefined) {
		return fn();
	}
	return locks.request(INSTALL_SIGNING_KEY_LOCK, { mode: "exclusive" }, fn);
}

function readLegacy(storage: LegacyKeyStorage | null, key: string) {
	try {
		return storage?.getItem(key) ?? null;
	} catch {
		// localStorage throws outright when storage is blocked by policy.
		return null;
	}
}

function retireLegacy(storage: LegacyKeyStorage | null, key: string): void {
	try {
		storage?.removeItem(key);
	} catch (error) {
		// The key is safe in SQLite; the next boot retries the retire.
		console.warn("amlfilter.install_key.legacy_retire_failed", {
			storageKey: key,
			error: error instanceof Error ? error.name : typeof error,
		});
	}
}

async function digestRecord(value: string, source: string) {
	return {
		sha256: await sha256Hex(new TextEncoder().encode(value)),
		valueLength: value.length,
		quarantinedAt: new Date().toISOString(),
		source,
	};
}

function canRetire(db: InstallKeyDb): boolean {
	return db.persistence.kind === "opfs";
}

/** Move the old quarantine metadata (not secret) into SQLite. */
async function migrateLegacyQuarantine(
	db: InstallKeyDb,
	legacy: LegacyKeyStorage | null,
): Promise<void> {
	const raw = readLegacy(legacy, INSTALL_SEED_QUARANTINE_KEY);
	if (raw === null) {
		return;
	}
	const record = await digestRecord(raw, "localStorage");
	await db.quarantine({ ...record, ...parseQuarantine(raw) });
	if (canRetire(db)) {
		retireLegacy(legacy, INSTALL_SEED_QUARANTINE_KEY);
	}
}

/** The old metadata's fields, or {} to keep the digest of the raw text. */
function parseQuarantine(raw: string): Partial<QuarantineRecord> {
	const parsed = parseJsonOrUndefined(raw);
	if (
		isRecord(parsed) &&
		typeof parsed.sha256 === "string" &&
		typeof parsed.valueLength === "number" &&
		typeof parsed.quarantined_at === "string"
	) {
		return {
			sha256: parsed.sha256,
			valueLength: parsed.valueLength,
			quarantinedAt: parsed.quarantined_at,
		};
	}
	return {};
}

/** Quarantine a corrupt old seed: metadata only, never the value. */
async function quarantineCorruptSeed(
	db: InstallKeyDb,
	legacy: LegacyKeyStorage | null,
	corrupt: string,
): Promise<void> {
	await db.quarantine(await digestRecord(corrupt, "localStorage"));
	console.warn("amlfilter.install_key.corrupt_seed_quarantined", {
		storageKey: INSTALL_SEED_KEY,
		valueLength: corrupt.length,
	});
	if (canRetire(db)) {
		retireLegacy(legacy, INSTALL_SEED_KEY);
	}
}

/** Copy → verify → retire. Returns the row the copy landed on. */
async function migrateLegacySeed(
	db: InstallKeyDb,
	legacy: LegacyKeyStorage | null,
	seedHex: string,
): Promise<StoredInstallKey> {
	const expected = await publicKeyHex(seedHex);
	const stored = await db.insertIfAbsent(seedHex, expected, "migrated");
	const verified =
		stored.publicKeyHex === expected &&
		(await publicKeyHex(stored.seedHex)) === expected;
	if (!verified) {
		// SQLite already holds a different key. Keep the old entry: it may be
		// the only copy of a key that signed past receipts.
		console.warn("amlfilter.install_key.migration_conflict", {
			storageKey: INSTALL_SEED_KEY,
		});
		return stored;
	}
	if (canRetire(db)) {
		retireLegacy(legacy, INSTALL_SEED_KEY);
	}
	return stored;
}

interface Resolved {
	readonly stored: StoredInstallKey;
	readonly resetFromCorruptSeed: boolean;
}

async function generate(db: InstallKeyDb): Promise<StoredInstallKey> {
	const seedHex = generateSeedHex();
	return db.insertIfAbsent(seedHex, await publicKeyHex(seedHex), "generated");
}

async function resolve(
	db: InstallKeyDb,
	legacy: LegacyKeyStorage | null,
): Promise<Resolved> {
	await migrateLegacyQuarantine(db, legacy);
	const old = readLegacy(legacy, INSTALL_SEED_KEY);
	if (old !== null && SEED_HEX.test(old)) {
		return {
			stored: await migrateLegacySeed(db, legacy, old),
			resetFromCorruptSeed: false,
		};
	}
	const existing = await db.read();
	if (old !== null) {
		await quarantineCorruptSeed(db, legacy, old);
	}
	return {
		stored: existing ?? (await generate(db)),
		resetFromCorruptSeed: old !== null && existing === null,
	};
}

async function checked(
	db: InstallKeyDb,
	resolved: Resolved,
): Promise<InstallKey> {
	const { stored } = resolved;
	if ((await publicKeyHex(stored.seedHex)) !== stored.publicKeyHex) {
		throw new Error(
			"stored install key is damaged: its public key does not match its seed",
		);
	}
	return {
		seedHex: stored.seedHex,
		publicKeyHex: stored.publicKeyHex,
		resetFromCorruptSeed: resolved.resetFromCorruptSeed,
		persistence: db.persistence,
	};
}

/**
 * This install's signing key: load (cached per tab), reset, and the
 * encrypted export/import. Every operation runs under one origin-wide Web
 * Lock and one short database session.
 */
export class InstallKeys implements InstallKeySource {
	private cached: Promise<InstallKey> | null = null;
	private readonly listeners = new Set<() => void>();

	constructor(private readonly deps: InstallKeysDeps) {
		deps.channel?.addEventListener("message", () => this.changed());
	}

	load(): Promise<InstallKey> {
		if (this.cached === null) {
			const pending = this.session(async (db) =>
				checked(db, await resolve(db, this.deps.legacy)),
			);
			this.cached = pending;
			pending.catch(() => {
				if (this.cached === pending) {
					this.cached = null;
				}
			});
		}
		return this.cached;
	}

	/** Delete the key (and any old localStorage copy). The next load makes a new one. */
	async reset(): Promise<void> {
		await this.session(async (db) => {
			await db.clear();
			retireLegacy(this.deps.legacy, INSTALL_SEED_KEY);
		});
		this.announce();
	}

	/** The key, encrypted under a passphrase, as the export file's text. */
	async exportEncrypted(passphrase: string): Promise<string> {
		const key = await this.load();
		return sealInstallKeyExport(key.seedHex, key.publicKeyHex, passphrase);
	}

	/** Decrypt an export file and make it this install's key. */
	async importEncrypted(text: string, passphrase: string): Promise<InstallKey> {
		const opened = await openInstallKeyExport(text, passphrase);
		await this.session(async (db) => {
			await db.replace(opened.seedHex, opened.publicKeyHex, "imported");
			retireLegacy(this.deps.legacy, INSTALL_SEED_KEY);
		});
		this.announce();
		return this.load();
	}

	/** Called after the key changes in this tab or another. Returns unsubscribe. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private async session<T>(work: (db: InstallKeyDb) => Promise<T>) {
		return underLock(async () => {
			const db = await openInstallKeyDb(this.deps.openSql);
			try {
				return await work(db);
			} finally {
				await db.close();
			}
		});
	}

	private announce(): void {
		this.deps.channel?.postMessage("changed");
		this.changed();
	}

	private changed(): void {
		this.cached = null;
		for (const listener of this.listeners) {
			listener();
		}
	}
}

/**
 * This tab's old localStorage, for migration only, or null where it is
 * unavailable (a Worker, or storage blocked by policy).
 */
export function legacyKeyStorage(): LegacyKeyStorage | null {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
}

function defaultChannel(): InstallKeyChannel | null {
	return typeof BroadcastChannel === "undefined"
		? null
		: (new BroadcastChannel(CHANNEL_NAME) as unknown as InstallKeyChannel);
}

let defaultKeys: InstallKeys | null = null;

/** The tab's install key service, over the real SQLite seam. */
export function installKeys(): InstallKeys {
	defaultKeys ??= new InstallKeys({
		openSql: sqlInstallKeyOpener(),
		legacy: legacyKeyStorage(),
		channel: defaultChannel(),
	});
	return defaultKeys;
}
