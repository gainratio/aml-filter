#!/usr/bin/env node
// Immutable deployment identity for production truth. `stamp` writes the exact
// checked-out commit + workflow run into dist/build.json before Pages upload;
// `verify` polls the real domain and refuses a stale/no-op deployment.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/;

export function buildIdentity(sha, runId) {
	if (!SHA_PATTERN.test(sha)) {
		throw new Error("build sha must be exactly 40 lowercase hexadecimal chars");
	}
	if (!RUN_ID_PATTERN.test(runId)) {
		throw new Error("GitHub run id must be a positive integer");
	}
	return Object.freeze({ git_sha: sha, github_run_id: runId });
}

export async function stampBuildIdentity(distDir, sha, runId) {
	const identity = buildIdentity(sha, runId);
	await mkdir(distDir, { recursive: true });
	await writeFile(
		join(distDir, "build.json"),
		`${JSON.stringify(identity)}\n`,
		"utf8",
	);
	return identity;
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const CUSTOM_ORIGIN_PREFIX = "https://aml-filter.com/";
const PAGES_ORIGIN_PREFIX = "https://aml-filter.pages.dev/";

async function fetchIdentityResponse(url, fetchImpl) {
	const response = await fetchImpl(url, { cache: "no-store" });
	if (response.status === 403 && url.startsWith(CUSTOM_ORIGIN_PREFIX)) {
		const fallbackUrl = url.replace(CUSTOM_ORIGIN_PREFIX, PAGES_ORIGIN_PREFIX);
		return fetchImpl(fallbackUrl, { cache: "no-store" });
	}
	return response;
}

export async function verifyDeployedIdentity({
	url,
	sha,
	runId,
	attempts = 10,
	delayMs = 15_000,
	fetchImpl = fetch,
}) {
	const expected = buildIdentity(sha, runId);
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			const response = await fetchIdentityResponse(url, fetchImpl);
			if (!response.ok) {
				throw new Error(`build identity returned HTTP ${response.status}`);
			}
			const actual = await response.json();
			if (
				actual?.git_sha === expected.git_sha &&
				actual?.github_run_id === expected.github_run_id
			) {
				return expected;
			}
			throw new Error(
				`stale build identity: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
			);
		} catch (error) {
			lastError = error;
			if (attempt < attempts) await delay(delayMs);
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error("deployment identity verification failed");
}

function parseArgs(argv) {
	const command = argv[0];
	const values = new Map();
	for (let i = 1; i < argv.length; i += 2) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (!flag?.startsWith("--") || value === undefined) {
			throw new Error(`malformed argument near ${flag ?? "end"}`);
		}
		values.set(flag.slice(2), value);
	}
	return { command, values };
}

function required(values, key) {
	const value = values.get(key);
	if (value === undefined) throw new Error(`missing required --${key}`);
	return value;
}

export async function run(argv) {
	const { command, values } = parseArgs(argv);
	const sha = required(values, "sha");
	const runId = required(values, "run-id");
	if (command === "stamp") {
		const identity = await stampBuildIdentity(
			required(values, "dist"),
			sha,
			runId,
		);
		console.log(`stamped ${JSON.stringify(identity)}`);
		return;
	}
	if (command === "verify") {
		const identity = await verifyDeployedIdentity({
			url: required(values, "url"),
			sha,
			runId,
		});
		console.log(`verified deployed ${JSON.stringify(identity)}`);
		return;
	}
	throw new Error('expected command "stamp" or "verify"');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	run(process.argv.slice(2)).catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
