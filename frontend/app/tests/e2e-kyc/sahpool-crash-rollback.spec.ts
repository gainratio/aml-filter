import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

/**
 * e2e-kyc — a tab killed mid-transaction must never leave a torn KYC database.
 *
 * The bug: the official opfs-sahpool VFS (through @sqlite.org/sqlite-wasm
 * 3.53.4-build2) answers xCheckReservedLock with a hard-coded "someone holds a
 * RESERVED lock". SQLite therefore never treats a leftover rollback journal as
 * hot, so the pages a dying transaction already spilled into the database file
 * stay there, and `PRAGMA integrity_check` still says "ok". Upstream fixed it in
 * check-in 9168a6f1be (forum b2fbb61642, 2026-09-30), with the per-path lock
 * table of 9e2caaa382 (GitHub 3b28aa1c) and the no-op xSleep of c9dd4d88e4
 * (GitHub cdbfe6a9, forum 3f0794c5d8); no npm build carries them yet, so
 * frontend/patches/ backports all three. The second test pins c9dd4d88e4.
 *
 * This drives the EXACT installed package the workstation DB worker bundles
 * (packages/amlfilter-workstation/node_modules/@sqlite.org/sqlite-wasm) in a
 * real Worker on a secure localhost origin, with the same privacy pragmas
 * db/sqlite.ts applies (secure_delete ON, journal_mode DELETE):
 *
 *   1. seed    — 200 rows, each balance 100, committed.
 *   2. crash   — BEGIN; bump every balance by 1 with a 1-page cache so dirty
 *                pages spill into the DB file; signal; terminate() the worker
 *                before COMMIT. That is a killed tab.
 *   3. verify  — a fresh worker reopens the pool.
 *
 * Application invariant: the batch never committed, so every balance is still
 * exactly 100 (total 20,000). A torn file shows a mix of 100 and 101.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SQLITE_DIST = join(
	HERE,
	"../../../packages/amlfilter-workstation/node_modules/@sqlite.org/sqlite-wasm/dist",
);
const HARNESS = "/__sahpool-crash-harness";
const ROWS = 200;
const SEED_BALANCE = 100;

const WORKER_SOURCE = `
import sqlite3InitModule from "./sqlite/index.mjs";
const POOL = "sahpool-crash-harness";
const FILE = "/ledger.sqlite3";
const sqlite3Ready = sqlite3InitModule({ print() {}, printErr() {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openPool() {
	const sqlite3 = await sqlite3Ready;
	let lastError;
	// The killed worker releases its access handles asynchronously.
	for (let attempt = 0; attempt < 60; attempt += 1) {
		try {
			return await sqlite3.installOpfsSAHPoolVfs({
				name: POOL,
				forceReinitIfPreviouslyFailed: true,
			});
		} catch (error) {
			lastError = error;
			await sleep(50);
		}
	}
	throw lastError;
}

function openDb(pool) {
	const db = new pool.OpfsSAHPoolDb(FILE);
	db.exec("PRAGMA secure_delete = ON");
	db.exec("PRAGMA journal_mode = DELETE");
	return db;
}

const steps = {
	async seed(pool) {
		await pool.wipeFiles();
		const db = openDb(pool);
		db.exec(
			"CREATE TABLE account (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL, pad BLOB NOT NULL)",
		);
		db.transaction(() => {
			for (let id = 1; id <= ${ROWS}; id += 1) {
				db.exec({
					sql: "INSERT INTO account (id, balance, pad) VALUES (?, ${SEED_BALANCE}, randomblob(1500))",
					bind: [id],
				});
			}
		});
		db.close();
		return { seeded: true };
	},
	async crash(pool) {
		const db = openDb(pool);
		db.exec("PRAGMA cache_size = 1");
		db.exec("BEGIN IMMEDIATE");
		for (let id = 1; id <= ${ROWS}; id += 1) {
			db.exec({ sql: "UPDATE account SET balance = balance + 1 WHERE id = ?", bind: [id] });
		}
		const journal = pool.getFileNames().includes(FILE + "-journal");
		postMessage({ inTransaction: true, journal });
		await new Promise(() => {}); // never COMMIT: the page kills us here
	},
	async busy(pool) {
		// Two handles on one file in this thread, as the KYC worker can hold.
		await pool.wipeFiles();
		const a = openDb(pool);
		a.exec("CREATE TABLE t (x INTEGER)");
		const b = openDb(pool);
		b.exec("PRAGMA busy_timeout = 3000");
		a.exec("BEGIN IMMEDIATE");
		const started = performance.now();
		let message = "";
		try {
			b.exec("BEGIN IMMEDIATE");
		} catch (error) {
			message = String(error && error.message ? error.message : error);
		}
		const elapsedMs = performance.now() - started;
		a.exec("ROLLBACK");
		a.close();
		b.close();
		return { busy: /BUSY/.test(message), elapsedMs };
	},
	async verify(pool) {
		const db = openDb(pool);
		const [row] = db.selectObjects(
			"SELECT count(*) AS n, sum(balance) AS total, min(balance) AS lo, max(balance) AS hi FROM account",
		);
		const integrity = db.selectValue("PRAGMA integrity_check");
		db.close();
		return { ...row, integrity, files: pool.getFileNames() };
	},
};

onmessage = async ({ data }) => {
	try {
		const pool = await openPool();
		postMessage({ done: await steps[data](pool) });
	} catch (error) {
		postMessage({ error: String(error && error.stack ? error.stack : error) });
	}
};
`;

interface VerifyResult {
	n: number;
	total: number;
	lo: number;
	hi: number;
	integrity: string;
	files: string[];
}

async function serveHarness(page: Page): Promise<void> {
	await page.route(`**${HARNESS}/**`, async (route) => {
		const path = new URL(route.request().url()).pathname.slice(HARNESS.length);
		if (path === "/index.html") {
			return route.fulfill({
				contentType: "text/html",
				body: "<!doctype html><title>harness</title>",
			});
		}
		if (path === "/worker.mjs") {
			return route.fulfill({
				contentType: "text/javascript",
				body: WORKER_SOURCE,
			});
		}
		if (path === "/sqlite/index.mjs" || path === "/sqlite/sqlite3.wasm") {
			const file = path.slice("/sqlite/".length);
			return route.fulfill({
				contentType: file.endsWith(".wasm")
					? "application/wasm"
					: "text/javascript",
				body: await readFile(join(SQLITE_DIST, file)),
			});
		}
		return route.fulfill({ status: 404, body: "not found" });
	});
}

/** Runs one step in a fresh worker; "crash" resolves once the txn is open. */
function runStep(
	page: Page,
	step: "seed" | "crash" | "verify" | "busy",
): Promise<unknown> {
	return page.evaluate(
		({ url, name }) =>
			new Promise((resolve, reject) => {
				const worker = new Worker(url, { type: "module" });
				worker.onerror = (event) =>
					reject(new Error(`${name}: ${event.message}`));
				worker.onmessage = ({ data }) => {
					if (data.error) {
						worker.terminate();
						reject(new Error(`${name}: ${data.error}`));
					} else if (data.inTransaction) {
						worker.terminate(); // the tab dies before COMMIT
						resolve(data);
					} else {
						worker.terminate();
						resolve(data.done);
					}
				};
				worker.postMessage(name);
			}),
		{ url: `${HARNESS}/worker.mjs`, name: step },
	);
}

test("a worker killed mid-transaction leaves no torn rows after reopen (hot journal rolled back)", async ({
	page,
}) => {
	await serveHarness(page);
	await page.goto(`${HARNESS}/index.html`);

	expect(await runStep(page, "seed")).toEqual({ seeded: true });
	expect(await runStep(page, "crash")).toEqual({
		inTransaction: true,
		journal: true,
	});

	const after = (await runStep(page, "verify")) as VerifyResult;
	expect(after.integrity).toBe("ok");
	expect(after.n).toBe(ROWS);
	// The invariant: the uncommitted batch left no trace at all.
	expect({ lo: after.lo, hi: after.hi, total: after.total }).toEqual({
		lo: SEED_BALANCE,
		hi: SEED_BALANCE,
		total: ROWS * SEED_BALANCE,
	});
	// The hot journal was consumed by the rollback, not left behind.
	expect(after.files).not.toContain("/ledger.sqlite3-journal");
});

test("a second writer gets SQLITE_BUSY at once: the pool never sleeps in the busy handler", async ({
	page,
}) => {
	await serveHarness(page);
	await page.goto(`${HARNESS}/index.html`);
	// Contention in an opfs-sahpool only comes from handles in this same thread,
	// so sleeping out a busy_timeout can never resolve it; it only freezes the
	// worker (upstream c9dd4d88e4). A 3 s busy_timeout must still fail fast.
	const result = (await runStep(page, "busy")) as {
		busy: boolean;
		elapsedMs: number;
	};
	expect(result.busy).toBe(true);
	expect(result.elapsedMs).toBeLessThan(1_000);
});
