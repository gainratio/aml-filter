import { readFileSync } from "node:fs";
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
	// names are deprecated and get no new releases. Only the Git-pinned browser
	// runtime keeps its @edgeproc/browser dependency key (the same alias almamesh
	// uses); its package name is already @gainratio/browser.
	it("takes the owner's npm libraries under their @gainratio names only", () => {
		const manifests = [
			appPackageFile,
			browserPackageFile,
			workstationPackageFile,
			publisherPackageFile,
		].map((file) => JSON.parse(readFileSync(file, "utf8")));
		const edgeprocKeys = manifests
			.flatMap((manifest) => [
				...Object.keys(manifest.dependencies ?? {}),
				...Object.keys(manifest.devDependencies ?? {}),
			])
			.filter((name) => name.startsWith("@edgeproc/"));
		expect(new Set(edgeprocKeys)).toEqual(new Set(["@edgeproc/browser"]));
		const [app, browser, workstation] = manifests;
		expect(app.dependencies?.["@gainratio/errors"]).toBe("^0.2.1");
		expect(app.dependencies?.["@gainratio/receipt-ui"]).toBe("^0.3.0");
		expect(browser.dependencies?.["@gainratio/avow"]).toBe("^0.5.2");
		expect(workstation.dependencies?.["@gainratio/avow"]).toBe("^0.5.2");
	});
});
