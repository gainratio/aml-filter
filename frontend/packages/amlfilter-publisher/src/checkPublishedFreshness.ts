// checkPublishedFreshness — the STALENESS gate for the live sanctions bundle.
//
// WHY THIS EXISTS. aml-filter.com tells visitors the bundle is rebuilt daily and
// is at most ~24h stale. Nothing enforced that. The `publish-watchlist` cron
// died on a missing `WATCHLIST_SIGNING_KEY` for 22 CONSECUTIVE DAYS (2026-06-21
// → 2026-07-12) and the site kept serving an ever-older list, because a failed
// scheduled run is a red dot nobody looks at. A screening tool quietly serving a
// three-week-old sanctions list is worse than one that is loudly broken.
//
// So this asks the LIVE origin two independent questions, both fail-closed:
//
//   1. BUNDLE: how long ago did a publish actually succeed? That is
//      `catalog.json`'s `generatedAt`. A mirror-and-redeploy (see
//      mirrorPublishedOrigin.ts) re-serves the same bytes and therefore the same
//      `generatedAt`, so a week of mirrors cannot masquerade as a week of
//      refreshes.
//   2. PER LIST: how old is each list's own data? That is the per-entry
//      `fetchedAt` written by stageBundle.ts. A bundle can republish on time
//      while one feed is carried forward from days ago — the bundle date would
//      look fine and the coverage claim would still be false.
//
// FAIL-CLOSED, deliberately. "Can't tell" is never "fine": a missing or
// unparseable `fetchedAt`/`generatedAt`, a pointer that does not verify against
// the pinned public key, a catalog with no lists at all (which would pass every
// per-list check vacuously), or a dead network all FAIL. Every breaching list is
// reported, not just the first, because the operator needs the whole picture in
// one alert rather than one list per run.
//
// The catalog is read through the CLIENT'S OWN decode path — signed pointer →
// manifest content-address → chunk zstd-decompress → sha256(plaintext) == chunk
// name — so this gate can never grade a bundle the browser would itself reject.
//
// Library + thin CLI runner (mirrors verifyPublishedOrigin / mirrorPublishedOrigin):
//   pnpm --filter @amlfilter/publisher run check-published-freshness -- \
//     --base-url https://aml-filter.com/bundle/origin \
//     --pubkey frontend/app/public/public.key [--max-age-hours 26]

import { readFileSync } from "node:fs";
import { decompressAndVerify } from "@amlfilter/browser/engine";
import {
	hasFetchedAt,
	type ListAgeSource,
	resolveListAge,
} from "@amlfilter/browser/watchlist";
import {
	fetchAndVerifyManifest,
	fetchAndVerifyPointer,
	httpFetchBytes,
	type ManifestWire,
	type OriginFetch,
} from "./verifyPublishedOrigin.ts";

/** The published bundle's freshness could not be established. Always fatal. */
export class FreshnessError extends Error {
	public constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "FreshnessError";
	}
}

/** The published bundle is older than the freshness the product claims. */
export class StaleBundleError extends FreshnessError {
	public readonly breaches: readonly string[];

	public constructor(message: string, breaches: readonly string[]) {
		super(message);
		this.name = "StaleBundleError";
		this.breaches = breaches;
	}
}

/** 24h publish cadence + 2h of headroom for a slow run. */
export const DEFAULT_MAX_AGE_HOURS = 26;

const MS_PER_HOUR = 3_600_000;
const CATALOG_PATH = "catalog.json";
const DECODER = new TextDecoder();
/** Exactly what `Date#toISOString()` emits, plus an explicit-offset variant.
 * Anything looser (a bare date, "last Tuesday") is refused rather than guessed. */
const ISO_INSTANT =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Which instant a list's age was measured from. `generatedAt` means the list
 * predates per-list freshness and was aged from the bundle's own stamp. Aliased
 * to the shared type rather than restated — see `resolveListAge`. */
type AgeSource = ListAgeSource;

/** One list's proven age, and every way it breaches the freshness claim. */
interface ListAge {
	readonly id: string;
	readonly title: string;
	readonly slug: string;
	readonly version: string;
	/** Null when the catalog did not publish a number — never a -1 sentinel. */
	readonly entitiesCount: number | null;
	/** The instant the age was measured from; null when none could be proven. */
	readonly fetchedAt: string | null;
	/** Where that instant came from; null when the age is unprovable. */
	readonly agedFrom: AgeSource | null;
	/** Null when no anchor could be proven — never a guessed zero. */
	readonly ageHours: number | null;
	readonly stale: boolean;
	readonly staleReason: string | null;
	readonly breaches: readonly string[];
}

export interface FreshnessReport {
	readonly version: string;
	readonly sequence: number;
	readonly generatedAt: string | null;
	/** Hours since the last SUCCESSFUL publish; NaN when it cannot be proven. */
	readonly bundleAgeHours: number;
	readonly maxAgeHours: number;
	readonly lists: readonly ListAge[];
	/** Compact per-list ages, printed on a green run as well as a red one. */
	readonly table: string;
}

export interface FreshnessInput {
	readonly baseUrl: string;
	readonly fetchBytes: OriginFetch;
	readonly pubkey: Uint8Array;
	readonly maxAgeHours: number;
	readonly now?: () => Date;
	/**
	 * Post-deploy smoke mode. When set, a list the publisher DECLARED carried
	 * forward (`stale: true`) passes while its age is within this many days —
	 * the same ceiling the publisher enforces (CARRIED_LIST_CEILING_DAYS).
	 * Unset keeps the strict gate: any `stale: true` is a breach.
	 */
	readonly carryCeilingDays?: number;
	/** Post-deploy smoke mode: list ids that must be present with entities. */
	readonly expectLists?: readonly string[];
}

/** The grading limits one run applies to every list. */
interface Limits {
	readonly maxAgeHours: number;
	readonly carryCeilingDays: number | undefined;
}

interface CatalogWire {
	readonly generatedAt: unknown;
	readonly lists: ReadonlyArray<Record<string, unknown>>;
}

function hoursLabel(value: number): string {
	return `${value.toFixed(1)}h`;
}

function text(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

/**
 * An ISO-8601 instant as epoch ms, or null when it is absent or not provably an
 * instant. Never a guess — a list whose age cannot be proven is not fresh.
 */
function instantMs(value: unknown): number | null {
	if (typeof value !== "string" || !ISO_INSTANT.test(value)) {
		return null;
	}
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

// --- reading the catalog through the client's decode path -------------------

/** Every chunk of the manifest's `catalog.json`, in file order. */
function catalogChunkHashes(manifest: ManifestWire): readonly string[] {
	const file = manifest.files.find((entry) => entry.path === CATALOG_PATH);
	if (file === undefined) {
		throw new FreshnessError(
			`published manifest has no ${CATALOG_PATH} — the per-list registry that carries every list's freshness is not in this bundle`,
		);
	}
	return file.chunks.map((chunk) => chunk.hash);
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.byteLength;
	}
	return out;
}

function decodeCatalogJson(bytes: Uint8Array): unknown {
	try {
		return JSON.parse(DECODER.decode(bytes));
	} catch (cause) {
		throw new FreshnessError(`published ${CATALOG_PATH} is not valid JSON`, {
			cause,
		});
	}
}

function assertCatalog(value: unknown): CatalogWire {
	const wire = value as { generatedAt?: unknown; lists?: unknown } | null;
	if (wire === null || typeof wire !== "object" || !Array.isArray(wire.lists)) {
		throw new FreshnessError(`published ${CATALOG_PATH} has no lists[] array`);
	}
	if (wire.lists.length === 0) {
		throw new FreshnessError(
			`published ${CATALOG_PATH} declares no lists — a bundle with nothing in it would pass every per-list freshness check vacuously`,
		);
	}
	return {
		generatedAt: wire.generatedAt,
		lists: wire.lists as ReadonlyArray<Record<string, unknown>>,
	};
}

/** Fetch + content-address-verify every catalog chunk, then parse it. */
async function fetchCatalog(
	baseUrl: string,
	fetchBytes: OriginFetch,
	manifest: ManifestWire,
): Promise<CatalogWire> {
	const parts: Uint8Array[] = [];
	for (const hash of catalogChunkHashes(manifest)) {
		const compressed = await fetchBytes(`${baseUrl}/chunk/${hash}`);
		// THE client rule: zstd-decompress, then sha256(plaintext) == its name.
		parts.push(await decompressAndVerify(hash, compressed));
	}
	return assertCatalog(decodeCatalogJson(concatBytes(parts)));
}

// --- grading ----------------------------------------------------------------

/** Which instant a list's age was measured from, and whether it was provable. */
interface AgeAnchor {
	readonly ms: number | null;
	readonly at: string | null;
	readonly from: AgeSource | null;
	/** `fetchedAt` was PRESENT but malformed — corruption, not migration. */
	readonly malformed: boolean;
}

/**
 * Anchor one list's age.
 *
 * The rule itself is NOT here — it is `resolveListAge` in
 * `@amlfilter/browser/watchlist`, the one predicate the browser's bundle-open
 * path reads too. This used to be a third copy of it (after
 * carryForwardList.ts's), and copies of a rule diverge: this gate happily aged a
 * pre-freshness list from `generatedAt` while the browser rejected the identical
 * bytes and stopped loading the watchlist entirely.
 *
 * All this adds is the DIAGNOSIS the operator needs: a `fetchedAt` that is
 * present but unusable is corruption (and gets no fallback), whereas an absent
 * one is migration.
 */
function ageAnchor(
	wire: Record<string, unknown>,
	generatedAt: unknown,
): AgeAnchor {
	const age = resolveListAge(wire, generatedAt);
	if (age === null) {
		return { ms: null, at: null, from: null, malformed: hasFetchedAt(wire) };
	}
	return {
		ms: Date.parse(age.at),
		at: age.at,
		from: age.from,
		malformed: false,
	};
}

/** The one age-related complaint about a list, or null when its age is fine. */
function ageBreach(
	who: string,
	ageHours: number | null,
	anchor: AgeAnchor,
	maxAgeHours: number,
): string | null {
	if (ageHours === null) {
		return anchor.malformed
			? `${who}: fetchedAt is present but unparseable — this list's freshness cannot be proven, so it is not fresh`
			: `${who}: has no fetchedAt, and the catalog has no parseable generatedAt to age it from — this list's freshness cannot be proven`;
	}
	if (ageHours <= maxAgeHours) {
		return null;
	}
	const provenance =
		anchor.from === "generatedAt"
			? " (aged from the bundle's generatedAt — pre-per-list-freshness bundle)"
			: "";
	return `${who}: last refreshed ${hoursLabel(ageHours)} ago${provenance}, past the ${maxAgeHours}h ceiling`;
}

function typeName(value: unknown): string {
	if (value === null) {
		return "null";
	}
	if (value === undefined) {
		return "nothing";
	}
	return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}

function malformed(
	who: string,
	field: string,
	got: unknown,
	want: string,
): string {
	return `${who}: ${field} must be ${want}, got ${typeName(got)} — this catalog entry is malformed, so its freshness cannot be trusted`;
}

/**
 * A NEW-format entry — one that carries `fetchedAt` — must also carry the
 * fields that prove its freshness.
 *
 * Reading a MISSING `stale` as "not stale" (`wire.stale === true`) would mean a
 * dropped or corrupted field reports the list HEALTHY: shape checked, property
 * not. The only way to be graded fresh must be to actually carry the proof.
 *
 * A LEGACY entry (no `fetchedAt`) predates per-list staleness entirely, so none
 * of this is required of it — demanding it there would reintroduce the day-one
 * false alarm the `generatedAt` fallback exists to prevent.
 */
function shapeBreaches(
	who: string,
	wire: Record<string, unknown>,
): readonly string[] {
	if (!hasFetchedAt(wire)) {
		return [];
	}
	const out: string[] = [];
	if (typeof wire.stale !== "boolean") {
		out.push(malformed(who, "stale", wire.stale, "a boolean"));
	}
	if (!(wire.staleReason === null || typeof wire.staleReason === "string")) {
		out.push(
			malformed(who, "staleReason", wire.staleReason, "a string or null"),
		);
	}
	if (typeof wire.entitiesCount !== "number") {
		out.push(malformed(who, "entitiesCount", wire.entitiesCount, "a number"));
	}
	return out;
}

/**
 * A list the publisher declared carried forward, graded against the documented
 * carry ceiling instead of the daily one. Past the ceiling (or unprovably old)
 * it is a breach that says which ceiling and why the list was carried.
 */
function carryBreach(
	who: string,
	entry: ListAge,
	ceilingDays: number,
): string | null {
	if (entry.ageHours !== null && entry.ageHours <= ceilingDays * 24) {
		return null;
	}
	const age =
		entry.ageHours === null ? "an unprovable time" : hoursLabel(entry.ageHours);
	return `${who}: carried forward for ${age}, past the ${ceilingDays}-day carry ceiling — ${entry.staleReason ?? "no reason recorded"}`;
}

/** The age/staleness complaints about one list under this run's limits. */
function freshnessBreaches(
	who: string,
	entry: ListAge,
	anchor: AgeAnchor,
	limits: Limits,
): readonly string[] {
	if (entry.stale && limits.carryCeilingDays !== undefined) {
		const carried = carryBreach(who, entry, limits.carryCeilingDays);
		return carried === null ? [] : [carried];
	}
	const age = ageBreach(who, entry.ageHours, anchor, limits.maxAgeHours);
	const out: string[] = age === null ? [] : [age];
	if (entry.stale) {
		out.push(
			`${who}: the publisher could not refresh it and re-served the last good copy — ${entry.staleReason ?? "no reason recorded"}`,
		);
	}
	return out;
}

/** Everything wrong with one list, so one alert carries the whole picture. */
function listBreaches(
	entry: ListAge,
	wire: Record<string, unknown>,
	anchor: AgeAnchor,
	limits: Limits,
): readonly string[] {
	const who = `${entry.id} (${entry.slug})`;
	return [
		...freshnessBreaches(who, entry, anchor, limits),
		...shapeBreaches(who, wire),
	];
}

/** Every expected list must be present and non-empty; a gap screens nothing. */
function coverageBreaches(
	lists: readonly ListAge[],
	expected: readonly string[] | undefined,
): readonly string[] {
	return (expected ?? []).flatMap((id) => {
		const entry = lists.find((candidate) => candidate.id === id);
		if (entry === undefined) {
			return [
				`${id}: expected in the live catalog but missing — screening would silently skip it`,
			];
		}
		if (entry.entitiesCount === null) {
			return [
				`${id} (${entry.slug}): publishes no entity count — its coverage cannot be proven`,
			];
		}
		return entry.entitiesCount > 0
			? []
			: [
					`${id} (${entry.slug}): publishes 0 entities — an empty sanctions list screens nothing`,
				];
	});
}

function listAge(
	wire: Record<string, unknown>,
	generatedAt: unknown,
	nowMs: number,
	limits: Limits,
): ListAge {
	const anchor = ageAnchor(wire, generatedAt);
	const partial = {
		id: text(wire.id) ?? "(unnamed list)",
		title: text(wire.title) ?? "",
		slug: text(wire.slug) ?? "?",
		version: text(wire.version) ?? "?",
		// Null, never a -1 sentinel: a sentinel printed in the table is a quiet lie.
		entitiesCount:
			typeof wire.entitiesCount === "number" ? wire.entitiesCount : null,
		fetchedAt: anchor.at,
		agedFrom: anchor.from,
		ageHours: anchor.ms === null ? null : (nowMs - anchor.ms) / MS_PER_HOUR,
		stale: wire.stale === true,
		staleReason: text(wire.staleReason),
	};
	return {
		...partial,
		breaches: listBreaches({ ...partial, breaches: [] }, wire, anchor, limits),
	};
}

/** How long ago a publish last actually succeeded, and whether that is a breach. */
function bundleAge(
	generatedAt: unknown,
	nowMs: number,
	maxAgeHours: number,
): { readonly ageHours: number; readonly breach: string | null } {
	const ms = instantMs(generatedAt);
	if (ms === null) {
		return {
			ageHours: Number.NaN,
			breach: `published ${CATALOG_PATH} has no parseable generatedAt — the time of the last successful refresh cannot be proven, so it is not fresh`,
		};
	}
	const ageHours = (nowMs - ms) / MS_PER_HOUR;
	const breach =
		ageHours > maxAgeHours
			? `the last successful refresh was ${hoursLabel(ageHours)} ago (generatedAt ${String(generatedAt)}), past the ${maxAgeHours}h ceiling — the daily rebuild is not running`
			: null;
	return { ageHours, breach };
}

// --- rendering --------------------------------------------------------------

const COLUMNS = [
	"list",
	"slug",
	"version",
	"entities",
	"refreshed",
	"source",
	"age",
	"stale",
];

/** The `source` column exists so a reader is never misled about where an age
 * came from: `generatedAt` means it was inferred from the bundle stamp. */
function row(entry: ListAge): readonly string[] {
	return [
		entry.id,
		entry.slug,
		entry.version,
		entry.entitiesCount === null ? "unknown" : String(entry.entitiesCount),
		entry.fetchedAt ?? "(none)",
		entry.agedFrom ?? "(none)",
		entry.ageHours === null ? "(unprovable)" : hoursLabel(entry.ageHours),
		entry.stale ? "STALE" : "no",
	];
}

const LEGACY_NOTE =
	"note: lists sourced from `generatedAt` predate per-list freshness — they are aged from the bundle's own stamp, which is truthful for a bundle whose lists were all refreshed in one run. Per-list ages appear after the next publish.";

function renderTable(lists: readonly ListAge[]): string {
	const rows = [COLUMNS, ...lists.map(row)];
	const widths = COLUMNS.map((_, column) =>
		Math.max(...rows.map((cells) => (cells[column] ?? "").length)),
	);
	const table = rows
		.map((cells) =>
			cells
				.map((cell, column) => cell.padEnd(widths[column] ?? 0))
				.join("  ")
				.trimEnd(),
		)
		.join("\n");
	return lists.some((entry) => entry.agedFrom === "generatedAt")
		? `${table}\n${LEGACY_NOTE}`
		: table;
}

function assertFresh(
	report: FreshnessReport,
	bundleBreach: string | null,
	coverage: readonly string[],
): void {
	const breaches = [
		...(bundleBreach === null ? [] : [bundleBreach]),
		...report.lists.flatMap((entry) => entry.breaches),
		...coverage,
	];
	if (breaches.length === 0) {
		return;
	}
	throw new StaleBundleError(
		`published bundle is STALE — aml-filter.com promises a daily rebuild at most ${report.maxAgeHours}h old, and the LIVE origin (version ${report.version}, sequence ${report.sequence}) breaches that:\n${breaches
			.map((line) => `  - ${line}`)
			.join("\n")}`,
		breaches,
	);
}

// --- the gate ---------------------------------------------------------------

/** Grade the LIVE published origin against the freshness the product claims. */
export async function checkPublishedFreshness(
	input: FreshnessInput,
): Promise<FreshnessReport> {
	const { baseUrl, fetchBytes, pubkey, maxAgeHours } = input;
	const nowMs = (input.now ?? (() => new Date()))().getTime();
	// Fail-closed: an unverified pointer is never read for freshness.
	const pointer = await fetchAndVerifyPointer(baseUrl, fetchBytes, pubkey);
	const { manifest } = await fetchAndVerifyManifest(
		baseUrl,
		fetchBytes,
		pointer,
	);
	const catalog = await fetchCatalog(baseUrl, fetchBytes, manifest);
	const bundle = bundleAge(catalog.generatedAt, nowMs, maxAgeHours);
	const limits = { maxAgeHours, carryCeilingDays: input.carryCeilingDays };
	const lists = catalog.lists.map((wire) =>
		listAge(wire, catalog.generatedAt, nowMs, limits),
	);
	const report: FreshnessReport = {
		version: pointer.version,
		sequence: pointer.sequence ?? 0,
		generatedAt: text(catalog.generatedAt),
		bundleAgeHours: bundle.ageHours,
		maxAgeHours,
		lists,
		table: renderTable(lists),
	};
	assertFresh(
		report,
		bundle.breach,
		coverageBreaches(lists, input.expectLists),
	);
	return report;
}

// --- CLI runner -------------------------------------------------------------

export interface FreshnessCliArgs {
	readonly baseUrl: string;
	readonly pubkeyPath: string;
	readonly maxAgeHours: number;
	readonly carryCeilingDays?: number;
	readonly expectLists?: readonly string[];
}

function positiveNumber(raw: string, flag: string): number {
	const value = Number(raw);
	if (raw.trim() === "" || !Number.isFinite(value) || value <= 0) {
		throw new FreshnessError(`--${flag} must be a positive number`);
	}
	return value;
}

function listIds(raw: string): readonly string[] {
	const ids = raw.split(",").map((id) => id.trim());
	if (ids.some((id) => id.length === 0)) {
		throw new FreshnessError(
			"--expect-lists must be a comma-separated list of non-empty list ids",
		);
	}
	return ids;
}

/** The optional post-deploy smoke-mode flags; absent keeps the strict gate. */
function smokeArgs(
	values: ReadonlyMap<string, string>,
): Pick<FreshnessCliArgs, "carryCeilingDays" | "expectLists"> {
	const ceiling = values.get("carry-ceiling-days");
	const lists = values.get("expect-lists");
	return {
		...(ceiling === undefined
			? {}
			: { carryCeilingDays: positiveNumber(ceiling, "carry-ceiling-days") }),
		...(lists === undefined ? {} : { expectLists: listIds(lists) }),
	};
}

function flagPairs(argv: ReadonlyArray<string>): Map<string, string> {
	const values = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 2) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (flag === undefined || !flag.startsWith("--") || value === undefined) {
			throw new FreshnessError(
				`expected --flag value pairs, got "${String(flag)}"`,
			);
		}
		values.set(flag.slice(2), value);
	}
	return values;
}

/** Parse `--flag value` pairs; unknown flags and missing values fail loudly. */
export function parseFreshnessArgs(
	argv: ReadonlyArray<string>,
): FreshnessCliArgs {
	const values = flagPairs(argv);
	const known = new Set([
		"base-url",
		"pubkey",
		"max-age-hours",
		"carry-ceiling-days",
		"expect-lists",
	]);
	for (const flag of values.keys()) {
		if (!known.has(flag)) {
			throw new FreshnessError(`unknown flag --${flag}`);
		}
	}
	const baseUrl = values.get("base-url");
	const pubkeyPath = values.get("pubkey");
	if (baseUrl === undefined || pubkeyPath === undefined) {
		throw new FreshnessError("--base-url and --pubkey are required");
	}
	const maxAgeHours = Number(
		values.get("max-age-hours") ?? String(DEFAULT_MAX_AGE_HOURS),
	);
	if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
		throw new FreshnessError("--max-age-hours must be a positive number");
	}
	return {
		baseUrl: baseUrl.replace(/\/$/, ""),
		pubkeyPath,
		maxAgeHours,
		...smokeArgs(values),
	};
}

interface FreshnessRunDeps {
	readonly fetchBytes?: OriginFetch;
	readonly readFile?: (path: string) => Uint8Array;
	readonly log?: (line: string) => void;
	readonly now?: () => Date;
}

/**
 * CLI entry. Prints the per-list ages on a GREEN run too — an operator should
 * be able to read the real numbers off a passing run, not just infer them from
 * the absence of an error.
 */
export async function runCheckPublishedFreshness(
	argv: ReadonlyArray<string>,
	deps: FreshnessRunDeps = {},
): Promise<FreshnessReport> {
	const args = parseFreshnessArgs(argv);
	const readFile =
		deps.readFile ?? ((path: string) => new Uint8Array(readFileSync(path)));
	const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
	const report = await checkPublishedFreshness({
		baseUrl: args.baseUrl,
		fetchBytes: deps.fetchBytes ?? httpFetchBytes,
		pubkey: readFile(args.pubkeyPath),
		maxAgeHours: args.maxAgeHours,
		...(deps.now === undefined ? {} : { now: deps.now }),
		...(args.carryCeilingDays === undefined
			? {}
			: { carryCeilingDays: args.carryCeilingDays }),
		...(args.expectLists === undefined
			? {}
			: { expectLists: args.expectLists }),
	});
	log(
		`published origin is FRESH: version=${report.version} sequence=${report.sequence} ` +
			`lastRefresh=${hoursLabel(report.bundleAgeHours)} ago (ceiling ${report.maxAgeHours}h)` +
			(args.carryCeilingDays === undefined
				? ""
				: `, carry ceiling ${args.carryCeilingDays}d`),
	);
	log(report.table);
	return report;
}
