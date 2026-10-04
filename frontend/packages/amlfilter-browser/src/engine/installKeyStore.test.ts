// The install-key SQL seam: the schema that holds the signing seed, and the
// opener's honesty about WHERE it lives (OPFS, or memory and why).

import { describe, expect, it, vi } from "vitest";
import { memoryInstallKeySql } from "../testing/memoryInstallKeySql";
import {
	INSTALL_KEY_DATABASE,
	type InstallKeySql,
	InstallKeyUnavailable,
	openInstallKeyDb,
	type SqlStorage,
	sqlInstallKeyOpener,
} from "./installKeyStore";

const SEED = "11".repeat(32);
const PUBLIC = "22".repeat(32);

function fakeSql(storage: SqlStorage): InstallKeySql & { closed: number } {
	const db = {
		storage,
		closed: 0,
		exec: vi.fn(async () => ({ changes: 0, lastInsertRowid: 0 })),
		query: vi.fn(async () => []),
		transaction: vi.fn(async () => ({ changes: 0, results: [] })),
		close: vi.fn(async () => {
			db.closed += 1;
		}),
	};
	return db;
}

describe("install_key schema", () => {
	it("stores ONE row and converges concurrent first writers on it", async () => {
		const sql = await memoryInstallKeySql();
		const db = await openInstallKeyDb(sql.open);

		const first = await db.insertIfAbsent(SEED, PUBLIC, "generated");
		const second = await db.insertIfAbsent(
			"33".repeat(32),
			PUBLIC,
			"generated",
		);

		expect(first.seedHex).toBe(SEED);
		expect(second.seedHex).toBe(SEED);
		expect(await sql.query("SELECT count(*) AS n FROM install_key")).toEqual([
			{ n: 1 },
		]);
	});

	it("refuses a seed that is not 32 bytes of lowercase hex", async () => {
		const sql = await memoryInstallKeySql();
		const db = await openInstallKeyDb(sql.open);

		await expect(
			db.insertIfAbsent("not-hex", PUBLIC, "generated"),
		).rejects.toThrow(/CHECK constraint/);
		expect(await db.read()).toBeNull();
	});

	it("clear() deletes the row", async () => {
		const sql = await memoryInstallKeySql();
		const db = await openInstallKeyDb(sql.open);
		await db.insertIfAbsent(SEED, PUBLIC, "generated");

		await db.clear();

		expect(await db.read()).toBeNull();
	});

	it("replace() swaps the row in one transaction", async () => {
		const sql = await memoryInstallKeySql();
		const db = await openInstallKeyDb(sql.open);
		await db.insertIfAbsent(SEED, PUBLIC, "generated");

		await db.replace("44".repeat(32), PUBLIC, "imported");

		expect((await db.read())?.seedHex).toBe("44".repeat(32));
		expect(await sql.query("SELECT origin FROM install_key")).toEqual([
			{ origin: "imported" },
		]);
	});

	it("records quarantine METADATA, never a value column", async () => {
		const sql = await memoryInstallKeySql();
		const db = await openInstallKeyDb(sql.open);

		await db.quarantine({
			sha256: "ab".repeat(32),
			valueLength: 7,
			quarantinedAt: "2026-10-04T00:00:00.000Z",
			source: "localStorage",
		});

		const columns = await sql.query(
			"SELECT name FROM pragma_table_info('install_key_quarantine')",
		);
		expect(columns.map((c) => c.name)).not.toContain("value");
		expect(
			await sql.query(
				"SELECT value_length, source FROM install_key_quarantine",
			),
		).toEqual([{ value_length: 7, source: "localStorage" }]);
	});

	it("reports where the key lives", async () => {
		const persistent = await memoryInstallKeySql();
		const memory = await memoryInstallKeySql({
			persistence: "memory",
			reason: "opfs-unavailable",
		});

		expect((await openInstallKeyDb(persistent.open)).persistence).toEqual({
			kind: "opfs",
		});
		expect((await openInstallKeyDb(memory.open)).persistence).toEqual({
			kind: "memory",
			reason: "opfs-unavailable",
		});
	});
});

describe("openInstallKeyDb failures", () => {
	it("closes the session when the schema cannot be created", async () => {
		const db = fakeSql({ persistence: "opfs", pool: "p", file: "f" });
		db.exec = vi.fn(async () => {
			throw new Error("disk I/O error");
		});

		await expect(openInstallKeyDb(async () => db)).rejects.toThrow(/disk I\/O/);
		expect(db.closed).toBe(1);
	});

	it("refuses to return a key when the row is missing after the insert", async () => {
		const db = fakeSql({ persistence: "opfs", pool: "p", file: "f" });
		const session = await openInstallKeyDb(async () => db);

		await expect(
			session.insertIfAbsent(SEED, PUBLIC, "generated"),
		).rejects.toThrow(/missing after insert/);
	});
});

describe("sqlInstallKeyOpener", () => {
	it("opens the named database with an in-memory fallback, never IndexedDB", async () => {
		const open = vi.fn(async () =>
			fakeSql({ persistence: "opfs", pool: "p", file: "f" }),
		);

		await sqlInstallKeyOpener(open)();

		expect(INSTALL_KEY_DATABASE).toBe("amlfilter-install-key");
		expect(open).toHaveBeenCalledWith({
			name: "amlfilter-install-key",
			fallback: "memory",
		});
	});

	it("opens OPFS per session and really closes it (other tabs can use it)", async () => {
		const db = fakeSql({ persistence: "opfs", pool: "p", file: "f" });
		const opener = sqlInstallKeyOpener(async () => db);

		await (await opener()).close();

		expect(db.closed).toBe(1);
	});

	it("keeps ONE in-memory database for the tab when OPFS is refused", async () => {
		const memory = fakeSql({
			persistence: "memory",
			reason: "opfs-unavailable",
		});
		const open = vi.fn(async () => memory);
		const opener = sqlInstallKeyOpener(open);

		const first = await opener();
		await first.close();
		const second = await opener();

		expect(second).toBe(first);
		expect(memory.closed).toBe(0);
		expect(open).toHaveBeenCalledTimes(1);
	});

	it("refuses to invent a key when another tab holds the database", async () => {
		const busy = fakeSql({ persistence: "memory", reason: "pool-in-use" });
		const opener = sqlInstallKeyOpener(async () => busy);

		await expect(opener()).rejects.toBeInstanceOf(InstallKeyUnavailable);
		expect(busy.closed).toBe(1);
	});
});
