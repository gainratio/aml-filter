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
	OpfsCacheStore,
	ResponseTooLargeError,
	RollbackError,
	SignatureError,
	SyncCapError,
	sha256Hex,
	syncIndex,
	verifyEd25519,
	verifyPlaintext,
} from "@edgeproc/browser";
import { assertVectorIndexConformance } from "@edgeproc/browser/vector";
import {
	createSqliteVectorIndex,
	SqliteVectorIndexClient,
} from "@edgeproc/browser/vector/sqlite";
import { describe, expect, it } from "vitest";
import workspaceText from "../../../../pnpm-workspace.yaml?raw";
import packageJsonText from "../../package.json?raw";
import vectorIndexSource from "./vectorIndex.ts?raw";

const EDGE_PROC_BROWSER_REVISION =
	"github:hseshadr/edgeproc-browser#0a604bf8293e52fcc973074dcaa2afa1f970016d";
const PUBLIC_IMPORTS = [
	"@edgeproc/browser",
	"@edgeproc/browser/vector",
	"@edgeproc/browser/vector/sqlite",
];

describe("@edgeproc/browser consumer dependency", () => {
	it("pins the standalone package to the reviewed public commit", () => {
		const manifest = JSON.parse(packageJsonText) as {
			dependencies?: Record<string, string>;
		};

		expect(manifest.dependencies?.["@edgeproc/browser"]).toBe(
			EDGE_PROC_BROWSER_REVISION,
		);
		expect(workspaceText).not.toContain('"@edgeproc/browser": "link:');
	});

	it("resolves both public entrypoints from the installed standalone package", () => {
		for (const packageImport of PUBLIC_IMPORTS) {
			const resolved = import.meta.resolve(packageImport);
			expect(resolved).toContain("/node_modules/@edgeproc/browser/dist/");
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
			OpfsCacheStore,
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
		expect(vectorIndexSource).toContain("@edgeproc/browser/vector/sqlite");
		expect(vectorIndexSource).not.toContain("PackedVectorIndex");
	});
});
