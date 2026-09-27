import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// README contract, enforced inside `pnpm gate`.
//
// The README is written for a compliance person at a small company, not an
// engineer: what it is, the problem, a live "Try it" with a real sanctioned name,
// how it works in plain words, which lists, what it does not do, then how to run
// it. It drifts the moment nobody checks it: a tagline edited in the README but
// not in package.json, a section reordered, internal jargon creeping back in, a
// relative link to a file that moved. Deliberately dumb: string and regex checks
// only, no markdown parser. It guards shape and a few load-bearing facts, not prose.

const repoRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"..",
);
const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");

/** The workspace root and the app both publish the tagline as their description. */
const PACKAGE_JSONS = ["frontend/package.json", "frontend/app/package.json"];

const TRY_IT = "## Try it";
const HOW_IT_WORKS = "## How it works";
const LISTS = "## Which lists, and how fresh";
const LIMITS = "## What it does not do";
const RUN_IT = "## Run it yourself";
const DEVELOP = "## Develop";
const MORE_DETAIL = "## More detail";
const SECTION_ORDER = [
	TRY_IT,
	HOW_IT_WORKS,
	LISTS,
	LIMITS,
	RUN_IT,
	DEVELOP,
	MORE_DETAIL,
];

/** The prominent docs line under the intro, pinned verbatim. */
const TECH_DOCS_LINE =
	"**Technical docs:** [Getting started for developers](docs/GETTING_STARTED.md) · " +
	"[Architecture](docs/ARCHITECTURE.md) · " +
	"[How matching works](docs/ARCHITECTURE.md#retrieval-and-scoring-in-one-paragraph) · " +
	"[Watchlist format](docs/WATCHLIST_FORMAT.md) · [Deploy](docs/DEPLOY.md)";

/** Every technical doc must be reachable from "More detail". */
const MORE_DETAIL_TARGETS = [
	"docs/GETTING_STARTED.md",
	"docs/QUICKSTART.md",
	"docs/ARCHITECTURE.md",
	"docs/WATCHLIST_FORMAT.md",
	"docs/RECALL.md",
	"docs/MEMORY-ARCHITECTURE.md",
	"docs/DEPLOY.md",
	"docs/OPERATIONS.md",
	"SECURITY.md",
	"CONTRIBUTING.md",
	"CHANGELOG.md",
];

/** Internal vocabulary and hype that make a README hard to read. */
const BANNED =
	/northstar|\bseams?\b|\blego\b|trust envelope|fail[- ]closed|\bgate\b|\bfleet\b|portfolio|production[- ]ready|blazing|\brobust\b|enterprise[- ]grade|seamless|receipt/i;

/** README prose with fenced and inline code removed (commands may say `pnpm gate`). */
const prose = (): string =>
	readme.replace(/^```[\s\S]*?^```/gm, "").replace(/`[^`\n]*`/g, "");

const at = (needle: string): number => readme.indexOf(needle);

function description(path: string): string {
	const pkg = JSON.parse(readFileSync(resolve(repoRoot, path), "utf8")) as {
		description?: string;
	};
	return pkg.description ?? "";
}

/** The first non-empty line after the title that is not a badge or a comment. */
function tagline(): string | undefined {
	return readme
		.split("\n")
		.slice(1)
		.map((line) => line.trim())
		.find((l) => l !== "" && !l.startsWith("[![") && !l.startsWith("<!--"));
}

/** Every `](target)` link outside fenced code blocks. */
function linkTargets(): string[] {
	const prose = readme.replace(/^```[\s\S]*?^```/gm, "");
	return [...prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map(
		(m) => m[1] ?? "",
	);
}

const isExternal = (target: string): boolean =>
	/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#");

describe("README contract", () => {
	it("opens with '# <Name>' and a tagline equal to every package description", () => {
		expect(readme.split("\n")[0]).toMatch(/^# \S/);
		const line = tagline();
		expect(line?.length ?? 0).toBeGreaterThan(0);
		expect(line?.length ?? 0).toBeLessThanOrEqual(120);
		for (const path of PACKAGE_JSONS) {
			expect(description(path), path).toBe(line);
		}
	});

	it("shows at most two badges before 'Try it'", () => {
		expect(at(TRY_IT)).toBeGreaterThan(0);
		const badges = readme.slice(0, at(TRY_IT)).split("[![").length - 1;
		expect(badges).toBeLessThanOrEqual(2);
	});

	it("orders Try it, How it works, lists, limits, then Run it yourself", () => {
		const positions = SECTION_ORDER.map((heading) => at(heading));
		expect(positions.every((p) => p > 0)).toBe(true);
		expect([...positions].sort((x, y) => x - y)).toEqual(positions);
	});

	it("puts the technical docs line directly under the intro, before 'Try it'", () => {
		const line = at(TECH_DOCS_LINE);
		expect(line).toBeGreaterThan(0);
		expect(readme.slice(line + TECH_DOCS_LINE.length, at(TRY_IT)).trim()).toBe(
			"",
		);
	});

	it("links the developer guide from 'Develop'", () => {
		const develop = readme.slice(at(DEVELOP), at(MORE_DETAIL));
		expect(develop).toContain("](docs/GETTING_STARTED.md)");
	});

	it("links every technical doc from 'More detail'", () => {
		const more = readme.slice(at(MORE_DETAIL));
		const missing = MORE_DETAIL_TARGETS.filter(
			(t) => !more.includes(`](${t})`),
		);
		expect(missing).toEqual([]);
	});

	it("puts the live site and a real sanctioned name with its screenshot in 'Try it'", () => {
		const tryIt = readme.slice(at(TRY_IT), at(HOW_IT_WORKS));
		expect(tryIt).toContain("https://aml-filter.com/screen");
		expect(tryIt).toContain("`Vladimir Putin`");
		expect(tryIt).toContain("](docs/assets/screen-putin.png)");
	});

	// CONTRACT CHANGE: this pinned "The search page checks only the US list
	// (OFAC)." The search page now covers every list on a computer and starts a
	// phone on OFAC with a one-tap switch (pages/screenScope.ts).
	it("says the search page checks all four lists, and what a phone does", () => {
		expect(readme).toContain(
			"On a computer the search page checks all four lists, and each result names its list.",
		);
		expect(readme).toContain(
			"On a phone it starts with the US list (OFAC) to save memory; tap **Search all 4 lists** to add the rest.",
		);
		expect(readme).not.toContain("checks only the US list");
	});

	it("never claims the app works with no network", () => {
		// There is no service worker: list caching is not offline support.
		const limits = readme.slice(at(LIMITS), at(RUN_IT));
		expect(limits).toContain("There is no offline mode.");
		expect(readme).not.toMatch(/works offline|offline-capable|offline first/i);
	});

	it("keeps internal jargon and hype out of the README", () => {
		expect(prose()).not.toMatch(BANNED);
	});

	it("links the interactive architecture map, whose source exists", () => {
		expect(readme).toMatch(
			/\[\*{0,2}Explore the interactive architecture map[^\]]*\]\(docs\/architecture\/index\.html\)/,
		);
		expect(
			existsSync(
				resolve(repoRoot, "docs/architecture/runtime.architecture.json"),
			),
		).toBe(true);
	});

	it("resolves every relative link to a path in the repo", () => {
		const relative = linkTargets().filter((t) => !isExternal(t));
		expect(relative.length).toBeGreaterThan(0);
		const missing = relative.filter((target) => {
			const path = decodeURIComponent(target.split("#")[0] ?? "");
			return !existsSync(resolve(repoRoot, path));
		});
		expect(missing).toEqual([]);
	});
});
