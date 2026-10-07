import {
	canonicalBytes,
	classifyEngineError,
	decompressAndVerify,
	EngineClient,
	EngineOperationError,
	fetchBytes,
	IntegrityError,
	MemoryCacheStore,
	materializeFile,
	NetworkError,
	ResponseTooLargeError,
	RollbackError,
	SignatureError,
	SyncCapError,
	sha256Hex,
	syncIndex,
	verifyEd25519,
	verifyPlaintext,
} from "@gainratio/browser";
import { assertVectorIndexConformance } from "@gainratio/browser/vector";
import {
	createSqliteVectorIndex,
	SqliteVectorIndexClient,
} from "@gainratio/browser/vector/sqlite";
import { describe, expect, it } from "vitest";
import workspaceText from "../../../../pnpm-workspace.yaml?raw";
import packageJsonText from "../../package.json?raw";
import vectorIndexSource from "./vectorIndex.ts?raw";

// Contract reversed (2026-10-04): this used to pin an exact public Git commit.
// The app now tracks our library's latest npm release through a caret range
// with no upper cap; the committed lockfile fixes what a deploy actually builds.
const GAINRATIO_BROWSER_RANGE = "^0.4.1";
const PUBLIC_IMPORTS = [
	"@gainratio/browser",
	"@gainratio/browser/vector",
	"@gainratio/browser/vector/sqlite",
];

describe("@gainratio/browser consumer dependency", () => {
	it("takes the standalone package from npm by caret range, not a Git pin", () => {
		const manifest = JSON.parse(packageJsonText) as {
			dependencies?: Record<string, string>;
		};

		expect(manifest.dependencies?.["@gainratio/browser"]).toBe(
			GAINRATIO_BROWSER_RANGE,
		);
		expect(manifest.dependencies?.["@edgeproc/browser"]).toBeUndefined();
		expect(workspaceText).not.toContain('"@gainratio/browser": "link:');
	});

	it("resolves both public entrypoints from the installed standalone package", () => {
		for (const packageImport of PUBLIC_IMPORTS) {
			const resolved = import.meta.resolve(packageImport);
			expect(resolved).toContain("/node_modules/@gainratio/browser/dist/");
			expect(resolved).not.toContain("/oss/edgeproc-browser/dist/");
			expect(resolved).not.toContain("/amlfilter-browser/src/");
		}
	});

	it("provides signed-bundle primitives from the public root only", () => {
		expect([
			canonicalBytes,
			classifyEngineError,
			EngineClient,
			EngineOperationError,
			MemoryCacheStore,
			decompressAndVerify,
			fetchBytes,
			materializeFile,
			sha256Hex,
			syncIndex,
			verifyEd25519,
			verifyPlaintext,
		]).not.toContain(undefined);
		expect([
			IntegrityError,
			NetworkError,
			ResponseTooLargeError,
			RollbackError,
			SignatureError,
			SyncCapError,
		]).toEqual([
			expect.any(Function),
			expect.any(Function),
			expect.any(Function),
			expect.any(Function),
			expect.any(Function),
			expect.any(Function),
		]);
	});

	it("uses the shared SQLite + sqlite-vector worker adapter for browser retrieval", () => {
		expect(createSqliteVectorIndex).toEqual(expect.any(Function));
		expect(SqliteVectorIndexClient).toEqual(expect.any(Function));
		expect(assertVectorIndexConformance).toEqual(expect.any(Function));
		expect(vectorIndexSource).toContain("@gainratio/browser/vector/sqlite");
		expect(vectorIndexSource).not.toContain("PackedVectorIndex");
	});
});
