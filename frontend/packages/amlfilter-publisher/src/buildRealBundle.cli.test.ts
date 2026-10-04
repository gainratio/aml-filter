// runRealBundle end-to-end, offline: the argv contract, fail-closed required
// source policy, and the happy-path
// orchestration (stage -> publish -> drop the producer-side CAS mirror -> clean
// the staging dir). The two heavyweight boundaries are replaced at their module
// seams: createNodeEmbedder (the 23 MB MiniLM) with the deterministic fake
// embedder, and publishBundle (`uv run edgeproc publish`) with a recorder that
// writes the origin-tree shape edge-proc would. Every upstream fetch goes to a
// stubbed `fetch` serving tiny in-repo fixtures — the suite never goes online.

import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BUNDLE_SOURCES, runRealBundle } from "./buildRealBundle.ts";
import { rejectionAfterBackoff } from "./sources/backoffTestClock.ts";

const state = vi.hoisted(() => ({
	publishCalls: [] as {
		srcDir: string;
		originDir: string;
		bundleId: string;
		version: string;
		sequence: number;
		stagedEntries: string[];
	}[],
}));

vi.mock("./nodeEmbedder.ts", async () => {
	const { createFakeEmbedder } = await import("./fakeEmbedder.ts");
	return { createNodeEmbedder: () => createFakeEmbedder() };
});

vi.mock("./publishBundle.ts", async () => {
	const { mkdir, readdir, writeFile: write } = await import("node:fs/promises");
	const { join: joinPath } = await import("node:path");
	return {
		publishBundle: async (input: {
			srcDir: string;
			originDir: string;
			keyPath: string;
			bundleId: string;
			version: string;
			sequence: number;
		}): Promise<void> => {
			state.publishCalls.push({
				srcDir: input.srcDir,
				originDir: input.originDir,
				bundleId: input.bundleId,
				version: input.version,
				sequence: input.sequence,
				stagedEntries: (await readdir(input.srcDir)).sort(),
			});
			// Mirror the tree `edgeproc publish` writes: the served contract
			// (latest, manifest/, chunk/) plus the producer-side CAS mirror
			// (chunks/, manifests/) that runRealBundle must drop afterwards.
			for (const dir of ["manifest", "chunk", "chunks/aa", "manifests"]) {
				await mkdir(joinPath(input.originDir, dir), { recursive: true });
			}
			await write(joinPath(input.originDir, "latest"), "{}\n");
		},
	};
});

// Tiny upstream fixtures — one entity per feed, in each feed's real format.
// OFAC SDN now arrives inside Commerce's Consolidated Screening List, so this
// fixture is a CSL slice: the header, one SDN row, and one NON-SDN row that must
// be filtered out before it can reach the published OFAC_SDN list.
const CSL_CSV = [
	"source,entity_number,type,name,alt_names,dates_of_birth,citizenships,nationalities",
	'"Specially Designated Nationals (SDN) - Treasury Department",12345,Individual,"DOE, John","Johnny D",1970-01-01,,CU',
	'"Entity List (EL) - Bureau of Industry and Security",99999,Entity,"NOT SDN INC",,,,',
	"",
].join("\n");
const UN_XML = [
	'<CONSOLIDATED_LIST dateGenerated="2026-07-01">',
	"<INDIVIDUALS><INDIVIDUAL>",
	"<DATAID>101</DATAID>",
	"<FIRST_NAME>Test</FIRST_NAME><SECOND_NAME>Person</SECOND_NAME>",
	"<INDIVIDUAL_ALIAS><ALIAS_NAME>TP</ALIAS_NAME></INDIVIDUAL_ALIAS>",
	"<INDIVIDUAL_DATE_OF_BIRTH><DATE>1970-01-01</DATE></INDIVIDUAL_DATE_OF_BIRTH>",
	"<NATIONALITY><VALUE>Testland</VALUE></NATIONALITY>",
	"</INDIVIDUAL></INDIVIDUALS>",
	"</CONSOLIDATED_LIST>",
].join("");
const EU_XML = [
	'<export generationDate="2026-07-01T00:00:00.000Z">',
	'<sanctionEntity logicalId="55">',
	'<subjectType code="person"/>',
	'<nameAlias wholeName="Eu Person"/>',
	'<birthdate birthdate="1970-01-01"/>',
	'<citizenship countryIso2Code="FR"/>',
	"</sanctionEntity>",
	"</export>",
].join("");
const UK_CSV = [
	"Report Date: 01-Jul-2026",
	"Unique ID,Name 1,Name 2,Name 3,Name 4,Name 5,Name 6,D.O.B,Nationality(/ies),Designation Type,Name type,Sanctions Imposed",
	"TST0123,John,,,,,Doe,01/01/1970,Testland,Individual,Primary name,Asset freeze",
	"",
].join("\n");

/** Stub global fetch to serve `routes` by URL substring (404 otherwise). */
function stubFetchRoutes(
	routes: readonly [needle: string, body: string][],
): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			const hit = routes.find(([needle]) => url.includes(needle));
			if (hit === undefined) {
				return new Response("not found", {
					status: 404,
					statusText: "Not Found",
				});
			}
			return new Response(hit[1], {
				headers: { "Last-Modified": "Wed, 01 Jul 2026 00:00:00 GMT" },
			});
		}),
	);
}

describe("runRealBundle argv contract", () => {
	test.each([
		[["--version"], 'malformed argument near "--version"'],
		[["version", "1"], 'malformed argument near "version"'],
		[["--key", "k", "--out", "o"], "missing required --version"],
		[
			["--version", "v", "--sequence", "1", "--out", "o"],
			"missing required --key",
		],
		[
			["--version", "v", "--sequence", "1", "--key", "k"],
			"missing required --out",
		],
		[
			["--version", "v", "--key", "k", "--out", "o"],
			"missing required --sequence",
		],
	])("rejects %j", async (argv, message) => {
		await expect(runRealBundle(argv)).rejects.toThrow(message);
	});
});

describe("runRealBundle with a required feed down", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	test("fails immediately and does not publish a partial bundle", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (): Promise<Response> => {
				throw new Error("network down");
			}),
		);
		const dir = await mkdtemp(join(tmpdir(), "aml-real-cli-"));
		try {
			// A connection error is retried with real backoff; fast-forward it.
			const error = await rejectionAfterBackoff(() =>
				runRealBundle([
					"--version",
					"v1",
					"--sequence",
					"1",
					"--key",
					join(dir, "signing.key"),
					"--out",
					join(dir, "out"),
					"--models",
					join(dir, "models"),
				]),
			);
			expect(error.message).toMatch(/OFAC_SDN.*required feed.*network down/i);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
		expect(state.publishCalls).toHaveLength(0);
	});
});

describe("runRealBundle happy path", () => {
	let workDir: string;
	let outDir: string;

	beforeEach(async () => {
		state.publishCalls.length = 0;
		workDir = await mkdtemp(join(tmpdir(), "aml-real-cli-"));
		outDir = join(workDir, "origin");
		stubFetchRoutes([
			["consolidated.csv", CSL_CSV],
			["scsanctions.un.org", UN_XML],
			["webgate.ec.europa.eu", EU_XML],
			["sanctionslist.fcdo.gov.uk", UK_CSV],
		]);
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		await rm(workDir, { recursive: true, force: true });
	});

	test("stages all four lists, publishes once, drops the CAS mirror", async () => {
		const keyPath = join(workDir, "signing.key");
		await writeFile(keyPath, new Uint8Array(32).fill(7));
		const stdoutSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);

		await runRealBundle(
			[
				"--version",
				"2026-07-11",
				"--sequence",
				"12345",
				"--key",
				keyPath,
				"--out",
				outDir,
			],
			{
				sources: BUNDLE_SOURCES.map((spec) => ({
					...spec,
					health: { ...spec.health, minimumEntities: 1 },
				})),
				now: () => new Date("2026-07-15T00:00:00.000Z"),
			},
		);

		expect(state.publishCalls).toHaveLength(1);
		const call = state.publishCalls[0];
		expect(call?.bundleId).toBe("amlfilter-watchlists");
		expect(call?.version).toBe("2026-07-11");
		expect(call?.sequence).toBe(12345);
		expect(call?.originDir).toBe(outDir);
		// stageBundle wrote catalog.json + one dir per fetched list before publish.
		expect(call?.stagedEntries).toEqual([
			"catalog.json",
			"eu",
			"ofac",
			"uk",
			"un",
		]);
		// The staging temp dir is cleaned up after the publish.
		expect(existsSync(call?.srcDir ?? "/nonexistent")).toBe(false);
		// The producer-side CAS mirror is dropped; the served contract remains.
		expect(existsSync(join(outDir, "chunks"))).toBe(false);
		expect(existsSync(join(outDir, "manifests"))).toBe(false);
		expect(existsSync(join(outDir, "latest"))).toBe(true);
		expect(existsSync(join(outDir, "manifest"))).toBe(true);
		expect(existsSync(join(outDir, "chunk"))).toBe(true);

		const printed = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
		expect(printed).toContain(
			"real bundle (4 lists: OFAC_SDN, UN_CONSOLIDATED, EU_CONSOLIDATED, UK_OFSI, v2026-07-11)",
		);
	});
});
