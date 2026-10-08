import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A workflow is executable code holding this repo's deploy tokens and secrets.
// A `uses:` ref pinned to a moving tag (`@v7`) or a branch (`@main`) lets
// whoever controls that upstream ref run arbitrary code in this repo's CI — a
// full 40-hex commit SHA cannot be repointed, so the code we audited is the
// code that runs. First-party refs (`hseshadr/...`) get NO carve-out: a moving
// first-party tag nested under an OIDC publish workflow is exactly how a live
// supply-chain hole once hid behind a green gate elsewhere in this portfolio.
// Only `./` local actions (shipped in this commit) and `docker://` image refs
// (not git refs at all) are exempt by nature.

const repoRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"..",
);
const workflowsDir = resolve(repoRoot, ".github", "workflows");

/** Matches `uses: <ref>` / `- uses: <ref>`, stopping before a trailing comment. */
const USES = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm;

/** owner/repo[/sub/path]@<40 lowercase hex> */
const PINNED = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/;

/**
 * Local (`./`) actions ship in this commit and `docker://` refs name an image,
 * not a git ref. Everything else — including first-party `hseshadr/*` reusable
 * workflows — must pin a full commit SHA.
 */
function isImmutable(ref: string): boolean {
	return (
		ref.startsWith("./") || ref.startsWith("docker://") || PINNED.test(ref)
	);
}

type Workflow = { readonly file: string; readonly yaml: string };
type Use = { readonly file: string; readonly ref: string };

/** Every workflow file — `.yaml` as well as `.yml`, so neither extension can smuggle. */
function readWorkflows(): readonly Workflow[] {
	return readdirSync(workflowsDir)
		.filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
		.sort()
		.map((file) => ({
			file,
			yaml: readFileSync(join(workflowsDir, file), "utf8"),
		}));
}

function scanUses(workflows: readonly Workflow[]): readonly Use[] {
	const uses: Use[] = [];
	for (const { file, yaml } of workflows) {
		for (const match of yaml.matchAll(USES)) {
			const ref = match[1];
			if (ref !== undefined) uses.push({ file, ref });
		}
	}
	return uses;
}

describe("GitHub Actions workflow pinning", () => {
	it("finds workflows and refs to scan (guards against a vacuous pass)", () => {
		expect(readWorkflows().length).toBeGreaterThan(0);
		expect(scanUses(readWorkflows()).length).toBeGreaterThan(0);
	});

	it("pins every action and reusable-workflow ref to a full commit SHA", () => {
		const unpinned = scanUses(readWorkflows())
			.filter(({ ref }) => !isImmutable(ref))
			.map(({ file, ref }) => `${file}: ${ref}`);
		expect(unpinned).toEqual([]);
	});
});

// The signing-path edge-proc dependency is loaded by Dagger, not a `uses:` ref.
// Pinning remains transitive: its source commit must be immutable too.
describe("signing-path edge-proc pin", () => {
	it("pins edge-proc to a full commit SHA, not a movable ref", () => {
		const module = readFileSync(
			join(repoRoot, ".dagger/src/aml_filter/main.py"),
			"utf8",
		);
		const pin = module.match(/EDGEPROC_COMMIT:\s*Final\s*=\s*"([0-9a-f]+)"/);
		expect(pin?.[1]).toMatch(/^[0-9a-f]{40}$/);
		expect(module).not.toMatch(/EDGEPROC_REF/);
	});
});

// GITHUB_TOKEN defaults are repo-wide; a workflow that never writes must say
// so. A top-level `permissions:` block (column 0) is the least-privilege floor
// for every workflow in this repo.
describe("workflow permissions", () => {
	it("every workflow declares a top-level permissions block", () => {
		const missing = readWorkflows()
			.filter(({ yaml }) => !/^permissions:/m.test(yaml))
			.map(({ file }) => file);
		expect(missing).toEqual([]);
	});
});

describe("mobile WebKit release gate", () => {
	it("installs WebKit and runs the iPhone profile in the canonical CI gate", () => {
		const module = readFileSync(
			join(repoRoot, ".dagger/src/aml_filter/main.py"),
			"utf8",
		);
		const mobileConfig = readFileSync(
			join(repoRoot, "frontend", "app", "playwright.mobile.config.ts"),
			"utf8",
		);
		const appPackage = JSON.parse(
			readFileSync(join(repoRoot, "frontend", "app", "package.json"), "utf8"),
		) as { readonly scripts: Readonly<Record<string, string>> };

		expect(module).toContain(
			"playwright install --with-deps chromium firefox webkit",
		);
		expect(appPackage.scripts["test:e2e:mobile:ci"]).toContain(
			"--project=ios-webkit",
		);
		expect(mobileConfig).toMatch(
			/node scripts\/serve-preview\.mjs --port \$\{SPA_PORT\}/,
		);
	});
});

describe("memory budget gate", () => {
	it("runs the persistent-index + wasm-budget lane inside the canonical gate", () => {
		const root = JSON.parse(
			readFileSync(join(repoRoot, "frontend", "package.json"), "utf8"),
		) as { readonly scripts: Readonly<Record<string, string>> };
		const app = JSON.parse(
			readFileSync(join(repoRoot, "frontend", "app", "package.json"), "utf8"),
		) as { readonly scripts: Readonly<Record<string, string>> };
		const spec = readFileSync(
			join(
				repoRoot,
				"frontend",
				"app",
				"tests",
				"e2e-memory",
				"boot-memory-budget.spec.ts",
			),
			"utf8",
		);

		expect(root.scripts.gate).toContain("run test:e2e:memory");
		expect(app.scripts["test:e2e:memory"]).toContain(
			"playwright.memory.config.ts",
		);
		expect(spec).toContain('"data-aml-index-storage"');
		expect(spec).toContain("MIN_PERSISTED_INDEX_BYTES");
		expect(spec).toContain("WASM_BUDGET_BYTES");
	});
});

describe("the pin rule itself", () => {
	it.each([
		["a moving major tag", "actions/checkout@v7"],
		["an exact version tag", "actions/checkout@v7.0.0"],
		["a branch", "actions/checkout@main"],
		["a short SHA", "actions/checkout@9c091bb"],
		["a truncated SHA", `actions/checkout@${"a".repeat(39)}`],
		["an uppercase SHA", `actions/checkout@${"A".repeat(40)}`],
		["no ref at all", "actions/checkout"],
		[
			"a first-party moving tag (NO first-party carve-out)",
			"gainratio/ci/.github/workflows/ts-publish.yml@ci-v2",
		],
	])("rejects %s", (_label, ref) => {
		expect(isImmutable(ref)).toBe(false);
	});

	it.each([
		[
			"a pinned action",
			"actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
		],
		[
			"a pinned first-party reusable workflow",
			`gainratio/ci/.github/workflows/ts-publish.yml@${"b".repeat(40)}`,
		],
		["a local action", "./.github/actions/setup"],
		["a docker image ref", "docker://alpine:3.20"],
	])("accepts %s", (_label, ref) => {
		expect(isImmutable(ref)).toBe(true);
	});

	it("extracts refs from real workflow syntax, ignoring comments", () => {
		const yaml = [
			"      - uses: actions/checkout@abc # v7",
			"        uses: pnpm/action-setup@def",
			"      # uses: not/a-real@ref",
		].join("\n");
		const refs = [...yaml.matchAll(USES)].map((m) => m[1]);
		expect(refs).toEqual(["actions/checkout@abc", "pnpm/action-setup@def"]);
	});
});
