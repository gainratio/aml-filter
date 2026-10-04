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
const ASSAY_VERSION = "0.5.0-dev.6";
const ASSAY_SRI =
	"sha512-VOH1brU6gHHOZ1jRO4DXRPseSCnOLAlKewlfuzYumG3Kswb9KvrngoN5mPv7rdw61O3EuqGQO+WFPON8AV3NzQ==";

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

	it("pins the reviewed Assay npm artifact and registry integrity", () => {
		const manifest = JSON.parse(readFileSync(browserPackageFile, "utf8"));
		const lock = readFileSync(lockFile, "utf8");
		expect(manifest.dependencies?.["@gainratio/assay"]).toBe(ASSAY_VERSION);
		expect(lock).toContain(`'@gainratio/assay@${ASSAY_VERSION}':`);
		expect(lock).toContain(`resolution: {integrity: ${ASSAY_SRI}}`);
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
		expect(browser.dependencies?.["@gainratio/browser"]).toBe("^0.2.0");
		expect(publisher.dependencies?.["@gainratio/browser"]).toBe("^0.2.0");
		expect(app.dependencies?.["@gainratio/errors"]).toBe("^0.2.1");
		expect(app.dependencies?.["@gainratio/receipt-ui"]).toBe("^0.3.0");
		expect(browser.dependencies?.["@gainratio/avow"]).toBe("^0.5.2");
		expect(workstation.dependencies?.["@gainratio/avow"]).toBe("^0.5.2");
	});
});
