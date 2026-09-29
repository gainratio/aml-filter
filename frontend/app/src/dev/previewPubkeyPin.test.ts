// @vitest-environment node

import { readFileSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type PreviewServer, preview } from "vite";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Which verify key a LOCAL preview serves at /public.key.
 *
 * The default local server serves the committed demo bundle, so it must pin the
 * demo key. `--mode live` (pnpm build:live / dev:live) serves the REAL bundle
 * mirrored from aml-filter.com, signed with the production key, so it must pin
 * the production key. Pinning the demo key there made every local live preview
 * fail closed with "signature verification failed" and the live smoke could not
 * be run before a deploy.
 */

const appRoot = resolve(import.meta.dirname, "../..");
const productionKey = readFileSync(join(appRoot, "public/public.key"));
const demoKey = readFileSync(
	join(appRoot, "../packages/amlfilter-publisher/fixtures/demo-public.key"),
);
let server: PreviewServer | undefined;
let dist: string | undefined;

function fetchPubkey(port: number): Promise<Buffer> {
	return new Promise((resolveBody, reject) => {
		const req = request(
			{ host: "127.0.0.1", port, path: "/public.key" },
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () => resolveBody(Buffer.concat(chunks)));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

async function servedPubkey(mode: string | undefined): Promise<Buffer> {
	dist = await mkdtemp(join(tmpdir(), "aml-filter-pubkey-"));
	await copyFile(join(appRoot, "public/public.key"), join(dist, "public.key"));
	server = await preview({
		root: appRoot,
		...(mode === undefined ? {} : { mode }),
		logLevel: "silent",
		build: { outDir: dist },
		preview: { host: "127.0.0.1", port: 0 },
	});
	return fetchPubkey((server.httpServer.address() as AddressInfo).port);
}

afterEach(async () => {
	server?.httpServer.close();
	server = undefined;
	if (dist !== undefined) await rm(dist, { recursive: true, force: true });
});

describe("local preview verify-key pin", () => {
	it("keeps the two keys distinct, so the pin choice is observable", () => {
		expect(productionKey.equals(demoKey)).toBe(false);
	});

	it("pins the demo key for the default preview of the demo bundle", async () => {
		expect((await servedPubkey(undefined)).equals(demoKey)).toBe(true);
	});

	it("pins the production key in live mode, which serves the real signed bundle", async () => {
		expect((await servedPubkey("live")).equals(productionKey)).toBe(true);
	});
});
