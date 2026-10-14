import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Release timing is not a trust boundary. Exact versions, frozen locks, registry
// provenance, integrity hashes, and unsuppressed audits remain mandatory, but a
// package must not be accepted or rejected merely because of its publication age.

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workspaceFile = resolve(appDir, "..", "pnpm-workspace.yaml");
const browserPackageFile = resolve(
	appDir,
	"..",
	"packages",
	"amlfilter-browser",
	"package.json",
);
const lockFile = resolve(appDir, "..", "pnpm-lock.yaml");
const appPackageFile = resolve(appDir, "package.json");
const workstationPackageFile = resolve(
	appDir,
	"..",
	"packages",
	"amlfilter-workstation",
	"package.json",
);
const publisherPackageFile = resolve(
	appDir,
	"..",
	"packages",
	"amlfilter-publisher",
	"package.json",
);
// The version and integrity live in package.json and pnpm-lock.yaml (Dependabot
// bumps both). The test reads them there and asserts the property: an exact
// version, locked with a sha512 registry integrity. It holds no copy of either.
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA512_SRI = /^sha512-[A-Za-z0-9+/]{86}==$/;

/** The registry integrity pnpm locked for one exact `name@version`, if any. */
function lockedIntegrity(lock: string, spec: string): string | undefined {
	const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const entry = new RegExp(
		`^ {2}'${escaped}':\\n {4}resolution: \\{integrity: (\\S+)\\}`,
		"m",
	);
	return lock.match(entry)?.[1];
}

type Manifest = Record<string, unknown>;
const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
] as const;
const GIT_SPEC = /^(github:|git\+|git:|hseshadr\/)|github\.com[/:]hseshadr\//;

function workspaceManifestFiles(): string[] {
	const frontendDir = resolve(appDir, "..");
	const packagesDir = resolve(frontendDir, "packages");
	const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => resolve(packagesDir, entry.name, "package.json"));
	return [resolve(frontendDir, "package.json"), appPackageFile, ...packageDirs];
}

/** Every dependency that pulls one of our own libs by a legacy name or from Git. */
function ownLibDependencyViolations(manifests: Manifest[]): string[] {
	return manifests.flatMap((manifest) =>
		DEPENDENCY_FIELDS.flatMap((field) =>
			Object.entries((manifest[field] ?? {}) as Record<string, string>)
				.filter(
					([name, spec]) =>
						name.startsWith("@edgeproc/") ||
						spec.includes("@edgeproc/") ||
						GIT_SPEC.test(spec),
				)
				.map(
					([name, spec]) =>
						`${String(manifest.name)} ${field} ${name}: ${spec}`,
				),
		),
	);
}

function releaseAgeMinutes(yaml: string): number | undefined {
	const match = yaml.match(/^\s*minimumReleaseAge\s*:\s*(\d+)\s*$/m);
	return match ? Number(match[1]) : undefined;
}

describe("pnpm dependency policy", () => {
	it("pins nanoid to the patched 3.x line", () => {
		const yaml = readFileSync(workspaceFile, "utf8");
		expect(yaml).toContain('nanoid: ">=3.3.17 <4"');
	});

	it("does not delay exact registry dependencies with a release-age policy", () => {
		const minutes = releaseAgeMinutes(readFileSync(workspaceFile, "utf8"));
		expect(
			minutes,
			"pnpm 11 defaults to 1440 minutes unless explicitly disabled",
		).toBe(0);
	});

	it("pins the Assay npm artifact exactly, with a sha512 registry integrity", () => {
		const manifest = JSON.parse(readFileSync(browserPackageFile, "utf8"));
		const lock = readFileSync(lockFile, "utf8");
		const version = manifest.dependencies?.["@gainratio/assay"];
		expect(version).toMatch(EXACT_VERSION);
		expect(lockedIntegrity(lock, `@gainratio/assay@${version}`)).toMatch(
			SHA512_SRI,
		);
	});

	it("reads the locked integrity of one exact entry only", () => {
		const sri = `sha512-${"A".repeat(86)}==`;
		const lock = [
			"  '@gainratio/assay@1.0.0':",
			`    resolution: {integrity: ${sri}}`,
			"  '@gainratio/assay@1.0.1':",
			"    resolution: {tarball: https://example.test/assay.tgz}",
		].join("\n");
		expect(lockedIntegrity(lock, "@gainratio/assay@1.0.0")).toBe(sri);
		expect(lockedIntegrity(lock, "@gainratio/assay@1.0.1")).toBeUndefined();
		expect(lockedIntegrity(lock, "@gainratio/assay@1.0.2")).toBeUndefined();
	});

	// The owner's npm libraries moved from @edgeproc/* to @gainratio/*; the old
	// names are deprecated and get no new releases. Every workspace manifest takes
	// them from the npm registry under their @gainratio names: no @edgeproc/
	// dependency key or alias, and no Git (github:/git+) source for our own libs.
	it("flags legacy @edgeproc names and Git sources for our own libs", () => {
		const violations = ownLibDependencyViolations([
			{
				name: "fixture",
				dependencies: {
					"@edgeproc/browser": "^0.2.0",
					"@gainratio/browser": "github:hseshadr/edgeproc-browser#abc",
					alias: "npm:@edgeproc/core@1.0.0",
					"@gainratio/avow": "^0.5.2",
				},
				devDependencies: { tool: "git+https://github.com/hseshadr/x.git" },
			},
		]);
		expect(violations).toEqual([
			"fixture dependencies @edgeproc/browser: ^0.2.0",
			"fixture dependencies @gainratio/browser: github:hseshadr/edgeproc-browser#abc",
			"fixture dependencies alias: npm:@edgeproc/core@1.0.0",
			"fixture devDependencies tool: git+https://github.com/hseshadr/x.git",
		]);
	});

	it("takes the owner's npm libraries under their @gainratio names only", () => {
		const manifests = workspaceManifestFiles().map((file) =>
			JSON.parse(readFileSync(file, "utf8")),
		);
		expect(ownLibDependencyViolations(manifests)).toEqual([]);
		const [app, browser, workstation, publisher] = [
			appPackageFile,
			browserPackageFile,
			workstationPackageFile,
			publisherPackageFile,
		].map((file) => JSON.parse(readFileSync(file, "utf8")));
		expect(browser.dependencies?.["@gainratio/browser"]).toBe("^0.4.1");
		expect(publisher.dependencies?.["@gainratio/browser"]).toBe("^0.4.1");
		expect(app.dependencies?.["@gainratio/errors"]).toBe("^0.2.1");
		expect(app.dependencies?.["@gainratio/receipt-ui"]).toBe("^0.3.0");
		expect(browser.dependencies?.["@gainratio/avow"]).toBe("^0.5.2");
		// The workstation never imports avow; it reaches the app through @amlfilter/browser.
		expect(workstation.dependencies?.["@gainratio/avow"]).toBeUndefined();
	});
});
