// @vitest-environment node
//
// Root cause this file guards (the mobile lane's "webServer was not able to
// start" flake): Playwright checks the lane's port BEFORE the ~1 min production
// build, but `vite preview --strictPort` only binds AFTER it. Any process that
// takes the port inside that window (a sibling lane or worktree on the same
// default port — kyc and mobile both defaulted to 4178) made the preview exit
// with "Port N is already in use", or, if the squatter answered 200, made the
// lane test ANOTHER build. serve-preview.mjs closes the window by holding the
// port for the whole build, and fails before building when it is already taken.

import { existsSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runServePreview } from "./serve-preview.mjs";

const HOST = "localhost";
const servers: Server[] = [];

async function freePort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, HOST, resolve));
	const address = probe.address();
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	if (address === null || typeof address === "string") {
		throw new Error("no TCP address");
	}
	return address.port;
}

async function squat(port: number): Promise<void> {
	const squatter = createServer();
	servers.push(squatter);
	await new Promise<void>((resolve) => squatter.listen(port, HOST, resolve));
}

/** A node one-liner as a shell command (JSON quoting survives `sh -c`). */
function nodeCommand(source: string): string {
	return `node -e ${JSON.stringify(source.replace(/\s+/g, " ").trim())}`;
}

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve) => server.close(() => resolve())),
			),
	);
});

describe("serve-preview", () => {
	it("holds the port for the whole build, answering 503 so readiness waits", async () => {
		const port = await freePort();
		// The "build" proves both halves of the reservation from the outside: a
		// sibling cannot bind the port, and Playwright's readiness poll sees a
		// not-ready status instead of a server it would accept.
		const probe = nodeCommand(`
			const net = require("node:net");
			const http = require("node:http");
			const s = net.createServer();
			s.once("error", (e) => {
				if (e.code !== "EADDRINUSE") process.exit(3);
				http.get("http://${HOST}:${port}/screen", (r) => process.exit(r.statusCode === 503 ? 0 : 4))
					.on("error", () => process.exit(5));
			});
			s.listen(${port}, "${HOST}", () => process.exit(2));
		`);
		const code = await runServePreview({
			port,
			buildCommand: probe,
			serveCommand: nodeCommand("process.exit(0)"),
		});
		expect(code).toBe(0);
	});

	it("releases the port before serving, so the preview can bind it", async () => {
		const port = await freePort();
		const serve = nodeCommand(`
			const s = require("node:net").createServer();
			s.once("error", () => process.exit(6));
			s.listen(${port}, "${HOST}", () => s.close(() => process.exit(0)));
		`);
		const code = await runServePreview({
			port,
			buildCommand: nodeCommand("process.exit(0)"),
			serveCommand: serve,
		});
		expect(code).toBe(0);
	});

	it("refuses an occupied port BEFORE spending a build on it", async () => {
		const port = await freePort();
		await squat(port);
		const marker = join(mkdtempSync(join(tmpdir(), "serve-preview-")), "built");
		const errors: string[] = [];
		const code = await runServePreview({
			port,
			buildCommand: nodeCommand(
				`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`,
			),
			serveCommand: nodeCommand("process.exit(0)"),
			log: (line: string) => errors.push(line),
		});
		expect(code).not.toBe(0);
		expect(existsSync(marker)).toBe(false);
		expect(errors.join("\n")).toMatch(
			new RegExp(`port ${port} is already in use`),
		);
	});

	it("propagates a failed build without starting the preview", async () => {
		const port = await freePort();
		const marker = join(
			mkdtempSync(join(tmpdir(), "serve-preview-")),
			"served",
		);
		const code = await runServePreview({
			port,
			buildCommand: nodeCommand("process.exit(7)"),
			serveCommand: nodeCommand(
				`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`,
			),
		});
		expect(code).toBe(7);
		expect(existsSync(marker)).toBe(false);
	});
});

describe("the mobile lane's webServer", () => {
	it("serves through serve-preview on its own port and never reuses a foreign server", async () => {
		// Read the DEFAULTS: a developer's exported lane ports must not hide a clash.
		for (const name of [
			"E2E_MOBILE_SPA_PORT",
			"E2E_KYC_SPA_PORT",
			"E2E_C1_SPA_PORT",
			"E2E_BUNDLE_SPA_PORT",
			"E2E_MEMORY_PORT",
		]) {
			vi.stubEnv(name, undefined);
		}
		const [{ default: mobile }, { default: kyc }, { default: c1 }] =
			await Promise.all([
				import("../playwright.mobile.config.ts"),
				import("../playwright.kyc.config.ts"),
				import("../playwright.c1.config.ts"),
			]);
		const [{ default: bundle }, { default: memory }] = await Promise.all([
			import("../playwright.bundle.config.ts"),
			import("../playwright.memory.config.ts"),
		]);
		const portOf = (config: { use?: { baseURL?: string } }) =>
			new URL(config.use?.baseURL ?? "http://x").port;
		const mobilePort = portOf(mobile);
		// Pin the literal: a sibling lane's default (kyc was 4178) is the clash.
		expect(mobilePort).toBe("4177");
		for (const other of [kyc, c1, bundle, memory]) {
			expect(portOf(other)).not.toBe(mobilePort);
		}
		const server = Array.isArray(mobile.webServer)
			? mobile.webServer[0]
			: mobile.webServer;
		expect(server?.command).toMatch(
			/^node scripts\/serve-preview\.mjs --port 4177$/,
		);
		expect(server?.reuseExistingServer).toBe(false);
	});
});

describe("every production-preview lane's webServer", () => {
	it("serves through serve-preview and never reuses a foreign server", async () => {
		for (const name of [
			"E2E_KYC_SPA_PORT",
			"E2E_C1_SPA_PORT",
			"E2E_BUNDLE_SPA_PORT",
			"E2E_MATRIX_SPA_PORT",
		]) {
			vi.stubEnv(name, undefined);
		}
		const lanes = await Promise.all([
			import("../playwright.kyc.config.ts"),
			import("../playwright.c1.config.ts"),
			import("../playwright.bundle.config.ts"),
			import("../playwright.matrix.config.ts"),
		]);
		// Pinned literals: the four lanes' documented default ports.
		const expectedPorts = ["4178", "4175", "4176", "4184"];
		lanes.forEach(({ default: config }, index) => {
			const servers = Array.isArray(config.webServer)
				? config.webServer
				: [config.webServer];
			const server = servers[0];
			expect(server?.command).toBe(
				`node scripts/serve-preview.mjs --port ${expectedPorts[index]}`,
			);
			expect(server?.reuseExistingServer).toBe(false);
		});
	});
});
