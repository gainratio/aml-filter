// Policy guard: SQLite (OPFS) is the ONLY store for app data. No shipped
// source may write to localStorage, sessionStorage or IndexedDB — not as the
// system of record, not as a mirror, not as a fallback when OPFS is refused.
//
// Every non-test source file in the app and the workspace packages is scanned.
// A file may NAME one of those APIs only if it is listed below with its
// reason, and even then it may not call a write method.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const FRONTEND = join(__dirname, "..", "..");
const ROOTS = [
	join(FRONTEND, "app", "src"),
	...readdirSync(join(FRONTEND, "packages")).map((pkg) =>
		join(FRONTEND, "packages", pkg, "src"),
	),
];

const BROWSER_STORAGE = /\b(localStorage|sessionStorage|indexedDB)\b/;

/**
 * Calls that only exist to write Web Storage or reach IndexedDB data. Every
 * IndexedDB write starts with indexedDB.open, so forbidding it forbids them all.
 */
const WRITES =
	/\b(setItem\s*\(|indexedDB\s*\.\s*open\s*\(|deleteDatabase\s*\(|createObjectStore\s*\(|objectStore\s*\()/;

/** Files allowed to NAME a browser store, and why. */
const ALLOWED: Readonly<Record<string, string>> = {
	"packages/amlfilter-browser/src/engine/installKey.ts":
		"reads + retires the pre-SQLite signing seed during migration",
	"packages/amlfilter-browser/src/engine/deviceSupport.ts":
		"capability probe: checks the API exists, never opens it",
};

function isTestFile(path: string): boolean {
	return (
		/\.test\.tsx?$/.test(path) ||
		path.includes(`${sep}test${sep}`) ||
		path.includes(`${sep}testing${sep}`)
	);
}

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			return name === "node_modules" ? [] : sourceFiles(path);
		}
		return /\.tsx?$/.test(name) && !isTestFile(path) ? [path] : [];
	});
}

/** Source without line and block comments, so prose can mention the APIs. */
function code(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function scan(): { readonly named: string[]; readonly writes: string[] } {
	const named: string[] = [];
	const writes: string[] = [];
	for (const file of ROOTS.flatMap(sourceFiles)) {
		const path = relative(FRONTEND, file).split(sep).join("/");
		const source = code(readFileSync(file, "utf8"));
		if (!BROWSER_STORAGE.test(source)) {
			continue;
		}
		named.push(path);
		if (WRITES.test(source)) {
			writes.push(path);
		}
	}
	return { named, writes };
}

describe("app data lives only in SQLite", () => {
	it("scans real source (the guard is not vacuous)", () => {
		expect(ROOTS.flatMap(sourceFiles).length).toBeGreaterThan(100);
		expect(scan().named).toContain(
			"packages/amlfilter-browser/src/engine/installKey.ts",
		);
	});

	it("names localStorage / sessionStorage / IndexedDB only in allow-listed files", () => {
		const unexpected = scan().named.filter((path) => !(path in ALLOWED));

		expect(unexpected).toEqual([]);
	});

	it("never writes to localStorage / sessionStorage / IndexedDB", () => {
		expect(scan().writes).toEqual([]);
	});
});
