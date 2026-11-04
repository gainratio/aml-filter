// Contract guard for the deploy-time bundle/key check. The production incident
// this pins: /screen served public/bundle/origin (demo-1, signed with the demo
// key) while pinning the production public.key, so in-tab verification failed
// for every visitor. These tests execute the real script — never a copy of its
// logic — through execFile with process.execPath, so no shell is involved.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(APP_ROOT, "scripts/assert-bundle-key.mjs");
const PRODUCTION_KEY = join(APP_ROOT, "public/public.key");
const DEMO_KEY = resolve(
	APP_ROOT,
	"../packages/amlfilter-publisher/fixtures/demo-public.key",
);
const LIVE_BUNDLE = join(APP_ROOT, "public/bundle/live");
const ORIGIN_BUNDLE = join(APP_ROOT, "public/bundle/origin");
/** A local-only mirror of the deployed production bundle (gitignored). CI
 * cannot have it; the committed origin cases below are the always-on guard. */
const HAS_LIVE_BUNDLE = existsSync(join(LIVE_BUNDLE, "latest"));
const TEMP_DIRS: string[] = [];

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** Run the real guard exactly as the deploy does: node + execFile, no shell. */
function runGuard(args: readonly string[]): Promise<RunResult> {
	return new Promise((resolvePromise) => {
		execFile(
			process.execPath,
			[SCRIPT, ...args],
			{ cwd: APP_ROOT, encoding: "utf8" },
			(error, stdout, stderr) => {
				resolvePromise({
					code:
						error === null
							? 0
							: typeof error.code === "number"
								? error.code
								: 1,
					stdout,
					stderr,
				});
			},
		);
	});
}

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "aml-assert-bundle-key-"));
	TEMP_DIRS.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(
		TEMP_DIRS.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("assert-bundle-key", () => {
	it.skipIf(!HAS_LIVE_BUNDLE)(
		"accepts public/bundle/live against the production key",
		async () => {
			const result = await runGuard([
				`--bundle=${LIVE_BUNDLE}`,
				`--key=${PRODUCTION_KEY}`,
			]);

			expect(result.code, result.stderr).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toMatch(/verifies against .*public\.key/);
		},
	);

	it("rejects public/bundle/origin against the production key (the incident)", async () => {
		const result = await runGuard([
			`--bundle=${ORIGIN_BUNDLE}`,
			`--key=${PRODUCTION_KEY}`,
		]);

		expect(result.code).not.toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(
			`bundle ${ORIGIN_BUNDLE} (demo-1) does not verify`,
		);
		expect(result.stderr).toContain(PRODUCTION_KEY);
		expect(result.stderr).toContain("different key");
	});

	it("accepts a validly signed pointer with its matching key (control)", async () => {
		const result = await runGuard([
			`--bundle=${ORIGIN_BUNDLE}`,
			`--key=${DEMO_KEY}`,
		]);

		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain("demo-1");
	});

	it("rejects a pointer tampered after signing", async () => {
		const dir = await makeTempDir();
		const pointer: unknown = JSON.parse(
			await readFile(join(ORIGIN_BUNDLE, "latest"), "utf8"),
		);
		expect(pointer).toMatchObject({ version: "demo-1" });
		await writeFile(
			join(dir, "latest"),
			JSON.stringify({
				...(pointer as Record<string, unknown>),
				version: "demo-1-tampered",
			}),
		);

		const result = await runGuard([`--bundle=${dir}`, `--key=${DEMO_KEY}`]);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("demo-1-tampered");
		expect(result.stderr).toContain("does not verify");
	});

	it("defaults to public/bundle/origin and public/public.key", async () => {
		const result = await runGuard([]);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain(join(APP_ROOT, "public/bundle/origin"));
		expect(result.stderr).toContain(PRODUCTION_KEY);
	});
});
