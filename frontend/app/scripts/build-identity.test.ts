import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildIdentity,
	run,
	stampBuildIdentity,
	verifyDeployedIdentity,
} from "./build-identity.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const RUN_ID = "123456789";
const TEMP = join(tmpdir(), `aml-build-identity-${process.pid}`);

afterEach(async () => {
	vi.restoreAllMocks();
	await rm(TEMP, { recursive: true, force: true });
});

describe("deployment build identity", () => {
	it("accepts only an exact immutable commit sha and positive workflow run id", () => {
		expect(buildIdentity(SHA, RUN_ID)).toEqual({
			git_sha: SHA,
			github_run_id: RUN_ID,
		});
		expect(() => buildIdentity("main", RUN_ID)).toThrow(/40 lowercase/);
		expect(() => buildIdentity(SHA.toUpperCase(), RUN_ID)).toThrow(
			/40 lowercase/,
		);
		expect(() => buildIdentity(SHA, "0")).toThrow(/positive integer/);
		expect(() => buildIdentity(SHA, "attempt-1")).toThrow(/positive integer/);
	});

	it("stamps the exact identity into the uploaded dist tree", async () => {
		await stampBuildIdentity(TEMP, SHA, RUN_ID);
		expect(await readFile(join(TEMP, "build.json"), "utf8")).toBe(
			`${JSON.stringify({ git_sha: SHA, github_run_id: RUN_ID })}\n`,
		);
	});

	it("rejects a successful no-op/stale deploy and accepts the exact artifact", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ git_sha: "f".repeat(40), github_run_id: RUN_ID }),
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ git_sha: SHA, github_run_id: RUN_ID })),
			);

		await expect(
			verifyDeployedIdentity({
				url: "https://aml-filter.com/build.json",
				sha: SHA,
				runId: RUN_ID,
				attempts: 2,
				delayMs: 0,
				fetchImpl,
			}),
		).resolves.toEqual({ git_sha: SHA, github_run_id: RUN_ID });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("fails after bounded attempts when the live site stays stale", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockImplementation(() =>
				Promise.resolve(
					new Response(
						JSON.stringify({ git_sha: "f".repeat(40), github_run_id: RUN_ID }),
					),
				),
			);
		await expect(
			verifyDeployedIdentity({
				url: "https://aml-filter.com/build.json",
				sha: SHA,
				runId: RUN_ID,
				attempts: 3,
				delayMs: 0,
				fetchImpl,
			}),
		).rejects.toThrow(/stale build identity/);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	it("retries a bad HTTP response and then verifies exact identity", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ git_sha: SHA, github_run_id: RUN_ID })),
			);
		await expect(
			verifyDeployedIdentity({
				url: "https://aml-filter.com/build.json",
				sha: SHA,
				runId: RUN_ID,
				attempts: 2,
				delayMs: 0,
				fetchImpl,
			}),
		).resolves.toEqual({ git_sha: SHA, github_run_id: RUN_ID });
	});

	it("falls back to aml-filter.pages.dev when aml-filter.com returns 403", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("challenge", { status: 403 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ git_sha: SHA, github_run_id: RUN_ID })),
			);
		await expect(
			verifyDeployedIdentity({
				url: "https://aml-filter.com/build.json",
				sha: SHA,
				runId: RUN_ID,
				attempts: 1,
				delayMs: 0,
				fetchImpl,
			}),
		).resolves.toEqual({ git_sha: SHA, github_run_id: RUN_ID });
		expect(fetchImpl).toHaveBeenNthCalledWith(
			1,
			"https://aml-filter.com/build.json",
			{ cache: "no-store" },
		);
		expect(fetchImpl).toHaveBeenNthCalledWith(
			2,
			"https://aml-filter.pages.dev/build.json",
			{ cache: "no-store" },
		);
	});

	it("surfaces a deterministic error when every fetch throws a non-Error", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue("offline");
		await expect(
			verifyDeployedIdentity({
				url: "https://aml-filter.com/build.json",
				sha: SHA,
				runId: RUN_ID,
				attempts: 1,
				delayMs: 0,
				fetchImpl,
			}),
		).rejects.toThrow("deployment identity verification failed");
	});

	it("drives the stamp CLI and rejects malformed or incomplete commands", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		await run(["stamp", "--dist", TEMP, "--sha", SHA, "--run-id", RUN_ID]);
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining(`"git_sha":"${SHA}"`),
		);
		await expect(run(["stamp", "--dist"])).rejects.toThrow(/malformed/);
		await expect(
			run(["stamp", "--dist", TEMP, "--run-id", RUN_ID]),
		).rejects.toThrow("missing required --sha");
		await expect(
			run(["unknown", "--sha", SHA, "--run-id", RUN_ID]),
		).rejects.toThrow(/expected command/);
	});
});
