// The per-install signing key. Stability is the whole point: a reviewer pins
// ONE public key and must be able to verify every receipt this install
// produced. The seed lives in SQLite (the `install_key` row); an older
// release kept it in localStorage, so the first boot after upgrade copies it
// across, verifies the copy, and only THEN retires the old entry.

import { publicKeyHex } from "@gainratio/avow";
import { sha256Hex } from "@gainratio/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type MemoryInstallKeySql,
	memoryInstallKeySql,
} from "../testing/memoryInstallKeySql";
import {
	INSTALL_SEED_KEY,
	INSTALL_SEED_QUARANTINE_KEY,
	type InstallKeyChannel,
	InstallKeys,
	installKeys,
	type LegacyKeyStorage,
	legacyKeyStorage,
} from "./installKey";
import { InstallKeyImportError } from "./installKeyExport";

const LEGACY_SEED = "11".repeat(32);
const PASSPHRASE = "correct horse battery staple";

/** The old release's localStorage, read + remove only (no setItem exists). */
function legacy(
	entries: Record<string, string> = {},
): LegacyKeyStorage & { has(key: string): boolean } {
	const map = new Map(Object.entries(entries));
	return {
		getItem: (k) => map.get(k) ?? null,
		removeItem: (k) => {
			map.delete(k);
		},
		has: (k) => map.has(k),
	};
}

function keysOver(
	sql: MemoryInstallKeySql,
	storage: LegacyKeyStorage | null = null,
	channel: InstallKeyChannel | null = null,
): InstallKeys {
	return new InstallKeys({ openSql: sql.open, legacy: storage, channel });
}

async function storedSeed(sql: MemoryInstallKeySql): Promise<unknown> {
	return (await sql.query("SELECT seed_hex FROM install_key"))[0]?.seed_hex;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("InstallKeys.load", () => {
	it("generates a seed on first use and keeps it in the SQLite install_key row", async () => {
		const sql = await memoryInstallKeySql();

		const key = await keysOver(sql).load();

		expect(key.seedHex).toMatch(/^[0-9a-f]{64}$/);
		expect(await storedSeed(sql)).toBe(key.seedHex);
		expect(key.persistence).toEqual({ kind: "opfs" });
		expect(key.resetFromCorruptSeed).toBe(false);
	});

	it("returns the same key after a reload (a fresh service on the same database)", async () => {
		const sql = await memoryInstallKeySql();
		const first = await keysOver(sql).load();

		const second = await keysOver(sql).load();

		expect(second.publicKeyHex).toBe(first.publicKeyHex);
	});

	it("derives the public key the Avow verifier pins", async () => {
		const sql = await memoryInstallKeySql();

		const key = await keysOver(sql).load();

		expect(key.publicKeyHex).toBe(await publicKeyHex(key.seedHex));
	});

	it("opens the database once, then serves the cached key", async () => {
		const sql = await memoryInstallKeySql();
		const keys = keysOver(sql);

		await keys.load();
		await keys.load();

		expect(sql.opens()).toBe(1);
	});

	it("retries after a failed load instead of caching the failure", async () => {
		const sql = await memoryInstallKeySql();
		sql.faults.failTransactionAt = 0;
		const keys = keysOver(sql);

		await expect(keys.load()).rejects.toThrow(/simulated crash/);
		await expect(keys.load()).resolves.toMatchObject({
			persistence: { kind: "opfs" },
		});
	});

	it("serializes key work under the origin Web Lock", async () => {
		const names: string[] = [];
		vi.stubGlobal("navigator", {
			locks: {
				request: async (
					name: string,
					options: { mode: "exclusive" },
					callback: () => Promise<unknown>,
				) => {
					names.push(name);
					expect(options).toEqual({ mode: "exclusive" });
					return callback();
				},
			},
		});
		const sql = await memoryInstallKeySql();

		await keysOver(sql).load();

		expect(names).toEqual(["amlfilter.install-signing-key"]);
	});

	it("refuses a row whose stored public key does not match its seed", async () => {
		const sql = await memoryInstallKeySql();
		await keysOver(sql).load();
		await (await sql.open()).exec("UPDATE install_key SET public_key_hex = ?", [
			"00".repeat(32),
		]);

		await expect(keysOver(sql).load()).rejects.toThrow(/does not match/);
	});

	it("says so when OPFS was refused and the key lives in memory", async () => {
		const sql = await memoryInstallKeySql({
			persistence: "memory",
			reason: "opfs-unavailable",
		});

		const key = await keysOver(sql).load();

		expect(key.persistence).toEqual({
			kind: "memory",
			reason: "opfs-unavailable",
		});
	});
});

describe("migration from the old localStorage seed", () => {
	it("keeps the SAME public key and retires the old entry", async () => {
		const sql = await memoryInstallKeySql();
		const old = legacy({ [INSTALL_SEED_KEY]: LEGACY_SEED });

		const key = await keysOver(sql, old).load();

		expect(key.publicKeyHex).toBe(await publicKeyHex(LEGACY_SEED));
		expect(await storedSeed(sql)).toBe(LEGACY_SEED);
		expect(await sql.query("SELECT origin FROM install_key")).toEqual([
			{ origin: "migrated" },
		]);
		expect(old.has(INSTALL_SEED_KEY)).toBe(false);
	});

	it("leaves the old entry in place when the SQLite write fails (crash before commit)", async () => {
		const sql = await memoryInstallKeySql();
		const old = legacy({ [INSTALL_SEED_KEY]: LEGACY_SEED });
		sql.faults.failTransactionAt = 1;

		await expect(keysOver(sql, old).load()).rejects.toThrow(/simulated crash/);

		expect(old.getItem(INSTALL_SEED_KEY)).toBe(LEGACY_SEED);
		expect(await storedSeed(sql)).toBeUndefined();
	});

	it("resumes after a crash between the commit and the retire", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const sql = await memoryInstallKeySql();
		const old = legacy({ [INSTALL_SEED_KEY]: LEGACY_SEED });
		const dying: LegacyKeyStorage = {
			getItem: (k) => old.getItem(k),
			removeItem: () => {
				throw new Error("tab closed mid-migration");
			},
		};
		// The key is already committed and verified in SQLite, so this boot
		// still signs with it; only the retire is left for next time.
		const interrupted = await keysOver(sql, dying).load();
		expect(interrupted.publicKeyHex).toBe(await publicKeyHex(LEGACY_SEED));
		expect(old.has(INSTALL_SEED_KEY)).toBe(true);
		expect(warn).toHaveBeenCalledWith(
			"amlfilter.install_key.legacy_retire_failed",
			expect.any(Object),
		);

		const resumed = await keysOver(sql, old).load();

		expect(resumed.publicKeyHex).toBe(await publicKeyHex(LEGACY_SEED));
		expect(old.has(INSTALL_SEED_KEY)).toBe(false);
	});

	it("is idempotent: re-running after it finished changes nothing", async () => {
		const sql = await memoryInstallKeySql();
		const old = legacy({ [INSTALL_SEED_KEY]: LEGACY_SEED });
		const first = await keysOver(sql, old).load();

		const again = await keysOver(sql, old).load();

		expect(again.publicKeyHex).toBe(first.publicKeyHex);
		expect(await sql.query("SELECT count(*) AS n FROM install_key")).toEqual([
			{ n: 1 },
		]);
	});

	it("never deletes the old entry when SQLite already holds a DIFFERENT key", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const sql = await memoryInstallKeySql();
		const existing = await keysOver(sql).load();
		const old = legacy({ [INSTALL_SEED_KEY]: LEGACY_SEED });

		const key = await keysOver(sql, old).load();

		expect(key.publicKeyHex).toBe(existing.publicKeyHex);
		expect(old.getItem(INSTALL_SEED_KEY)).toBe(LEGACY_SEED);
		expect(warn).toHaveBeenCalledWith(
			"amlfilter.install_key.migration_conflict",
			expect.any(Object),
		);
		expect(JSON.stringify(warn.mock.calls)).not.toContain(LEGACY_SEED);
	});

	it("never deletes the old entry while the key only lives in memory", async () => {
		const sql = await memoryInstallKeySql({
			persistence: "memory",
			reason: "opfs-unavailable",
		});
		const old = legacy({ [INSTALL_SEED_KEY]: LEGACY_SEED });

		const key = await keysOver(sql, old).load();

		expect(key.publicKeyHex).toBe(await publicKeyHex(LEGACY_SEED));
		expect(old.getItem(INSTALL_SEED_KEY)).toBe(LEGACY_SEED);
	});

	it("still works when localStorage cannot be read at all", async () => {
		const sql = await memoryInstallKeySql();
		const blocked: LegacyKeyStorage = {
			getItem: () => {
				throw new DOMException("blocked", "SecurityError");
			},
			removeItem: () => undefined,
		};

		await expect(keysOver(sql, blocked).load()).resolves.toMatchObject({
			persistence: { kind: "opfs" },
		});
	});

	it("moves old quarantine metadata into SQLite and retires it", async () => {
		const sql = await memoryInstallKeySql();
		const metadata = JSON.stringify({
			sha256: "ab".repeat(32),
			valueLength: 9,
			quarantined_at: "2026-09-01T00:00:00.000Z",
		});
		const old = legacy({ [INSTALL_SEED_QUARANTINE_KEY]: metadata });

		await keysOver(sql, old).load();

		expect(
			await sql.query(
				"SELECT sha256, value_length, source FROM install_key_quarantine",
			),
		).toEqual([
			{ sha256: "ab".repeat(32), value_length: 9, source: "localStorage" },
		]);
		expect(old.has(INSTALL_SEED_QUARANTINE_KEY)).toBe(false);
	});

	it("drops unreadable old quarantine metadata after recording that it existed", async () => {
		const sql = await memoryInstallKeySql();
		const old = legacy({ [INSTALL_SEED_QUARANTINE_KEY]: "{not json" });

		await keysOver(sql, old).load();

		expect(
			await sql.query("SELECT value_length FROM install_key_quarantine"),
		).toEqual([{ value_length: 9 }]);
		expect(old.has(INSTALL_SEED_QUARANTINE_KEY)).toBe(false);
	});
});

describe("a corrupt old seed", () => {
	it("is quarantined as a digest only, warned about, and signalled as a reset", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const corrupt = "not-a-valid-hex-seed";
		const sql = await memoryInstallKeySql();
		const old = legacy({ [INSTALL_SEED_KEY]: corrupt });

		const key = await keysOver(sql, old).load();

		expect(key.resetFromCorruptSeed).toBe(true);
		expect(
			await sql.query(
				"SELECT sha256, value_length FROM install_key_quarantine",
			),
		).toEqual([
			{
				sha256: await sha256Hex(new TextEncoder().encode(corrupt)),
				value_length: corrupt.length,
			},
		]);
		expect(old.has(INSTALL_SEED_KEY)).toBe(false);
		expect(warn).toHaveBeenCalledWith(
			"amlfilter.install_key.corrupt_seed_quarantined",
			expect.objectContaining({ valueLength: corrupt.length }),
		);
		expect(JSON.stringify(warn.mock.calls)).not.toContain(corrupt);
	});

	it("does not signal a reset when SQLite already holds a good key", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const sql = await memoryInstallKeySql();
		const existing = await keysOver(sql).load();
		const old = legacy({ [INSTALL_SEED_KEY]: "garbage" });

		const key = await keysOver(sql, old).load();

		expect(key.resetFromCorruptSeed).toBe(false);
		expect(key.publicKeyHex).toBe(existing.publicKeyHex);
	});
});

describe("InstallKeys.reset", () => {
	it("clears the key, so the next load makes a NEW one", async () => {
		const sql = await memoryInstallKeySql();
		const keys = keysOver(sql);
		const before = await keys.load();

		await keys.reset();

		expect(await storedSeed(sql)).toBeUndefined();
		const after = await keys.load();
		expect(after.publicKeyHex).not.toBe(before.publicKeyHex);
	});

	it("also clears a leftover old entry, so reset cannot resurrect the old key", async () => {
		const sql = await memoryInstallKeySql();
		const old = legacy({ [INSTALL_SEED_KEY]: LEGACY_SEED });
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await keysOver(sql).load();
		const keys = keysOver(sql, old);

		await keys.reset();
		const after = await keys.load();

		expect(old.has(INSTALL_SEED_KEY)).toBe(false);
		expect(after.publicKeyHex).not.toBe(await publicKeyHex(LEGACY_SEED));
	});

	it("tells listeners in this tab and other tabs", async () => {
		const sql = await memoryInstallKeySql();
		const posted: unknown[] = [];
		const keys = keysOver(sql, null, {
			postMessage: (m) => posted.push(m),
			addEventListener: () => undefined,
		});
		const heard = vi.fn();
		keys.onChange(heard);

		await keys.reset();

		expect(heard).toHaveBeenCalledTimes(1);
		expect(posted).toEqual(["changed"]);
	});
});

describe("another tab changed the key", () => {
	it("drops the cached key and tells listeners", async () => {
		const sql = await memoryInstallKeySql();
		let deliver: (() => void) | undefined;
		const keys = keysOver(sql, null, {
			postMessage: () => undefined,
			addEventListener: (_type, listener) => {
				deliver = listener;
			},
		});
		const heard = vi.fn();
		const unsubscribe = keys.onChange(heard);
		const before = await keys.load();
		await keysOver(sql).reset();

		deliver?.();
		const after = await keys.load();

		expect(heard).toHaveBeenCalledTimes(1);
		expect(after.publicKeyHex).not.toBe(before.publicKeyHex);
		unsubscribe();
		deliver?.();
		expect(heard).toHaveBeenCalledTimes(1);
	});
});

// PBKDF2 at 600,000 iterations runs twice per test; give a loaded runner room.
describe("encrypted export and import", { timeout: 30_000 }, () => {
	it("round-trips the key into another browser's empty store", async () => {
		const source = keysOver(await memoryInstallKeySql());
		const original = await source.load();
		const file = await source.exportEncrypted(PASSPHRASE);
		const target = keysOver(await memoryInstallKeySql());

		const imported = await target.importEncrypted(file, PASSPHRASE);

		expect(imported.publicKeyHex).toBe(original.publicKeyHex);
		expect((await target.load()).publicKeyHex).toBe(original.publicKeyHex);
	});

	it("replaces an existing key and records the import", async () => {
		const source = keysOver(await memoryInstallKeySql());
		const file = await source.exportEncrypted(PASSPHRASE);
		const sql = await memoryInstallKeySql();
		const target = keysOver(sql);
		await target.load();

		await target.importEncrypted(file, PASSPHRASE);

		expect((await target.load()).publicKeyHex).toBe(
			(await source.load()).publicKeyHex,
		);
		expect(await sql.query("SELECT origin FROM install_key")).toEqual([
			{ origin: "imported" },
		]);
	});

	it("changes nothing on a wrong passphrase", async () => {
		const file = await keysOver(await memoryInstallKeySql()).exportEncrypted(
			PASSPHRASE,
		);
		const target = keysOver(await memoryInstallKeySql());
		const before = await target.load();

		await expect(
			target.importEncrypted(file, "the wrong passphrase"),
		).rejects.toBeInstanceOf(InstallKeyImportError);

		expect((await target.load()).publicKeyHex).toBe(before.publicKeyHex);
	});
});

describe("while the key only lives in memory", () => {
	it("records corrupt-seed and quarantine evidence but retires nothing", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const sql = await memoryInstallKeySql({
			persistence: "memory",
			reason: "opfs-unavailable",
		});
		const old = legacy({
			[INSTALL_SEED_KEY]: "garbage",
			[INSTALL_SEED_QUARANTINE_KEY]: "{}",
		});

		await keysOver(sql, old).load();

		expect(old.has(INSTALL_SEED_KEY)).toBe(true);
		expect(old.has(INSTALL_SEED_QUARANTINE_KEY)).toBe(true);
		expect(
			await sql.query("SELECT count(*) AS n FROM install_key_quarantine"),
		).toEqual([{ n: 2 }]);
	});
});

describe("a failed retire of the old entry", () => {
	it("logs a non-Error failure by its type", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const sql = await memoryInstallKeySql();

		await keysOver(sql, {
			getItem: (k) => (k === INSTALL_SEED_KEY ? LEGACY_SEED : null),
			removeItem: () => {
				throw "quota";
			},
		}).load();

		expect(warn).toHaveBeenCalledWith(
			"amlfilter.install_key.legacy_retire_failed",
			expect.objectContaining({ error: "string" }),
		);
	});
});

describe("a change notice that lands while a load is failing", () => {
	it("keeps the newer load instead of clearing it", async () => {
		const sql = await memoryInstallKeySql();
		let deliver: (() => void) | undefined;
		const keys = keysOver(sql, null, {
			postMessage: () => undefined,
			addEventListener: (_type, listener) => {
				deliver = listener;
			},
		});
		sql.faults.failTransactionAt = 0;
		const failing = keys.load();
		deliver?.();
		const newer = keys.load();

		await expect(failing).rejects.toThrow(/simulated crash/);

		expect(keys.load()).toBe(newer);
		await expect(newer).resolves.toMatchObject({
			persistence: { kind: "opfs" },
		});
	});
});

describe("installKeys", () => {
	it("is one service per tab", () => {
		expect(installKeys()).toBe(installKeys());
	});
});

describe("legacyKeyStorage", () => {
	it("resolves this tab's localStorage when it is readable", () => {
		expect(legacyKeyStorage()).toBe(globalThis.localStorage);
	});

	it("returns null where there is no localStorage (a Worker)", () => {
		vi.stubGlobal("localStorage", undefined);
		expect(legacyKeyStorage()).toBeNull();
	});

	it("returns null when the browser blocks storage", () => {
		const original = Object.getOwnPropertyDescriptor(
			globalThis,
			"localStorage",
		);
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			get: () => {
				throw new DOMException("blocked", "SecurityError");
			},
		});
		try {
			expect(legacyKeyStorage()).toBeNull();
		} finally {
			if (original !== undefined) {
				Object.defineProperty(globalThis, "localStorage", original);
			}
		}
	});
});
