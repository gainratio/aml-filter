// buildRealBundle — the CI build step: fetch the REAL sanctions lists via the
// existing source adapters, embed their names with the Node MiniLM embedder,
// stage them with stageBundle(), then shell out to `edgeproc publish` to chunk +
// Ed25519-sign the staging tree into the content-addressed
// `origin/{latest, manifest/<hash>, chunk/<hash>}` layout the in-tab sync tier
// consumes. Every list must fetch, parse to a plausible non-zero count, and
// prove freshness — but each list is now refreshed, and therefore fails, on its
// OWN. A list whose upstream is unreachable is re-served from the bundle already
// published (verified end-to-end, marked stale, keeping its real age) so one
// flaky third party cannot age the lists that are healthy. It is still
// fail-closed where it counts: a list that can be neither refreshed nor proven
// from the published bundle aborts the publish rather than quietly vanish.
//
// Run from frontend/ (the publish CI does this) via the thin
// `buildRealBundleMain.ts` entry — this module is the importable library it
// drives (so the unit test can exercise stagedListsFromSources without running
// edge-proc or a live fetch):
//   pnpm --filter @amlfilter/publisher run build-real-bundle -- \
//     --key signing.key --version 2026-06-23 --sequence 123 --out <originDir> [--models <dir>]
//
// `edgeproc` is invoked via publishBundle(), which resolves the edge-proc
// checkout from EDGEPROC_DIR (the CI sets it to the installed edge-proc). The
// --key is the raw 32-byte Ed25519 production seed (decoded from the
// WATCHLIST_SIGNING_KEY secret); the produced /latest signature verifies in-tab
// against the committed public.key.

import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	EMBEDDING_DIM,
	EMBEDDING_MODEL,
	type Embedder,
} from "@amlfilter/browser";
import { carryForwardList } from "./carryForwardList.ts";
import { createNodeEmbedder } from "./nodeEmbedder.ts";
import { publishBundle } from "./publishBundle.ts";
import { toWatchlistEntity } from "./sourceEntity.ts";
import { euSource } from "./sources/euSource.ts";
import { ofacSource } from "./sources/ofacSource.ts";
import {
	type AliasEnrichment,
	applyAliasEnrichment,
	fetchNonLatinAliases,
} from "./sources/sdnAliases.ts";
import type { SourceLine, WatchlistSource } from "./sources/source.ts";
import { ukSource } from "./sources/ukSource.ts";
import { unSource } from "./sources/unSource.ts";
import { type StagedList, stageBundle } from "./stageBundle.ts";
import type { WatchlistEntity } from "./types.ts";
import { packVectors } from "./vectors.ts";
import { httpFetchBytes } from "./verifyPublishedOrigin.ts";

/** One source to attempt: the adapter + the bundle path slug (e.g. "ofac"). */
export interface RealBundleSourceSpec {
	readonly source: WatchlistSource;
	/** The per-list staging subdir, also the bundle's list slug. */
	readonly slug: string;
	readonly health: {
		readonly minimumEntities: number;
		readonly maximumEntities: number;
		readonly maximumAgeMs: number;
	};
	/** Optional extra alias strings for records this list already publishes.
	 * Additive only — it cannot add, drop or alter a record. A failure here
	 * DEGRADES the bundle (published without the extra aliases) rather than
	 * failing it, because the records themselves are unaffected. */
	readonly enrichAliases?: () => Promise<AliasEnrichment>;
}

export interface RealBundleDependencies {
	readonly sources?: readonly RealBundleSourceSpec[];
	readonly now?: () => Date;
	readonly carryForward?: CarryForward;
}

/**
 * Re-serve one list from the ALREADY-PUBLISHED bundle, because this run could
 * not refresh it. Injected rather than imported so the staging glue stays
 * testable without a network — and so a publisher with no live origin to fall
 * back on (a first publish) simply fails closed, exactly as it always did.
 *
 * The returned list must carry its OWN age and `stale: true`; see
 * carryForwardList, which verifies the whole trust chain before handing bytes back.
 */
export type CarryForward = (
	failed: RealBundleSourceSpec,
	reason: string,
) => Promise<StagedList>;

/** One list this run could not refresh, and the age it is being served with. */
interface CarriedListReport {
	readonly listId: string;
	readonly fetchedAt: string;
	readonly reason: string;
}

/** Everything `edgeproc publish` leaves in an origin dir that is NOT part of the
 * served contract: the producer-side CAS mirror and its mutation lock. The sync
 * tier reads only `latest`, `manifest/<hash>` and `chunk/<hash>`; anything else
 * is build residue that must not reach the CDN or a commit. */
const PRODUCER_RESIDUE = ["chunks", "manifests", ".mutation.lock"] as const;

/** Reduce a freshly published origin to exactly the served contract. */
export async function removeProducerResidue(originDir: string): Promise<void> {
	for (const entry of PRODUCER_RESIDUE) {
		await rm(resolve(originDir, entry), { recursive: true, force: true });
	}
}

/** Which alias coverage the produced bundle actually has. `records-only` means
 * a source's enrichment was unreachable and only the record feed's own (Latin)
 * names are present — it must never be reported as full coverage. */
interface AliasEnrichmentReport {
	readonly mode: "enriched" | "records-only";
	readonly aliasesAdded: number;
	readonly entitiesEnriched: number;
	readonly reason: string | null;
}

/** Staged lists plus the alias-coverage mode that produced them. */
export interface StagedLists {
	readonly lists: readonly StagedList[];
	readonly aliases: AliasEnrichmentReport;
	/** Lists re-served from the published bundle because their feed was down.
	 * Empty on a fully refreshed run. */
	readonly carried: readonly CarriedListReport[];
}

/** The bundle id stamped into the signed pointer (matches the demo bundle). */
const BUNDLE_ID = "amlfilter-watchlists";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Default model mirror: repo frontend/app/public/models. */
const DEFAULT_MODELS = resolve(HERE, "../../../app/public/models");

const MAX_FEED_AGE_MS = 90 * 24 * 60 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1_000;

/** Required sources with deliberately broad anomaly bounds. */
export const BUNDLE_SOURCES: readonly RealBundleSourceSpec[] = [
	{
		source: ofacSource,
		slug: "ofac",
		// CROSS-VALIDATED BAND. The OFAC SDN population was counted twice, from
		// two independent publications, on 2026-07-30: 19,181 rows in Commerce's
		// Consolidated Screening List (the feed this adapter reads) and 19,181
		// <DistinctParty> elements in Treasury's own SDN_ADVANCED.XML, with the
		// entity-id spaces agreeing 19,181/19,181. A 15k..30k band turns that
		// agreement into a gate: a filter that silently stops matching (upstream
		// renames the `source` value) or a truncated download can no longer pass
		// as a smaller-but-plausible list. The previous 5k floor would have
		// published a two-thirds-empty sanctions list without complaint.
		health: {
			minimumEntities: 15_000,
			maximumEntities: 30_000,
			maximumAgeMs: MAX_FEED_AGE_MS,
		},
		// CSL publishes names in Latin script only; Treasury's own XML also
		// carries each designation in its ORIGINAL script. Without these a
		// Cyrillic/Arabic/CJK query can never match. Additive and fail-soft.
		enrichAliases: fetchNonLatinAliases,
	},
	{
		source: unSource,
		slug: "un",
		health: {
			minimumEntities: 100,
			maximumEntities: 10_000,
			maximumAgeMs: MAX_FEED_AGE_MS,
		},
	},
	{
		source: euSource,
		slug: "eu",
		health: {
			minimumEntities: 500,
			maximumEntities: 50_000,
			maximumAgeMs: MAX_FEED_AGE_MS,
		},
	},
	{
		source: ukSource,
		slug: "uk",
		health: {
			minimumEntities: 500,
			maximumEntities: 50_000,
			maximumAgeMs: MAX_FEED_AGE_MS,
		},
	},
];

function requirePlausibleCount(
	spec: RealBundleSourceSpec,
	count: number,
): void {
	const { minimumEntities, maximumEntities } = spec.health;
	if (count < minimumEntities || count > maximumEntities) {
		throw new Error(
			`${spec.source.id}: entity count ${count} is outside plausible range ${minimumEntities}..${maximumEntities}`,
		);
	}
}

/** Validate the upstream's own publication instant and RETURN it, so the staged
 * list can publish the age it actually has instead of discarding the evidence. */
function requireFreshSource(
	spec: RealBundleSourceSpec,
	raw: Awaited<ReturnType<WatchlistSource["fetchRaw"]>>,
	now: Date,
): string {
	const updatedAt = spec.source.sourceUpdatedAt?.(raw)?.trim();
	if (updatedAt === undefined || updatedAt === "") {
		throw new Error(`${spec.source.id}: freshness timestamp is missing`);
	}
	const updatedAtMs = Date.parse(updatedAt);
	if (!Number.isFinite(updatedAtMs)) {
		throw new Error(`${spec.source.id}: freshness timestamp is invalid`);
	}
	const ageMs = now.getTime() - updatedAtMs;
	if (ageMs < -MAX_FUTURE_SKEW_MS) {
		throw new Error(`${spec.source.id}: freshness timestamp is in the future`);
	}
	if (ageMs > spec.health.maximumAgeMs) {
		const maximumDays = spec.health.maximumAgeMs / (24 * 60 * 60 * 1_000);
		throw new Error(
			`${spec.source.id}: freshness age exceeds ${maximumDays} days`,
		);
	}
	return updatedAt;
}

/** Run a source's optional alias enrichment. A failure DEGRADES, never throws:
 * the records are already complete and correct without it. */
async function enrichOrDegrade(
	spec: RealBundleSourceSpec,
	lines: readonly SourceLine[],
	collect: (report: AliasEnrichmentReport) => void,
): Promise<readonly SourceLine[]> {
	if (spec.enrichAliases === undefined) {
		return lines;
	}
	try {
		const applied = applyAliasEnrichment(lines, await spec.enrichAliases());
		collect({
			mode: "enriched",
			aliasesAdded: applied.aliasesAdded,
			entitiesEnriched: applied.entitiesEnriched,
			reason: null,
		});
		return applied.lines;
	} catch (error) {
		collect({
			mode: "records-only",
			aliasesAdded: 0,
			entitiesEnriched: 0,
			reason: error instanceof Error ? error.message : String(error),
		});
		return lines;
	}
}

/** Fetch, validate, parse, and embed one required source. */
async function stageOneSource(
	spec: RealBundleSourceSpec,
	embedder: Embedder,
	version: string,
	now: Date,
	collect: (report: AliasEnrichmentReport) => void,
): Promise<StagedList> {
	let raw: Awaited<ReturnType<WatchlistSource["fetchRaw"]>>;
	try {
		raw = await spec.source.fetchRaw();
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(
			`${spec.source.id}: required feed fetch failed: ${reason}`,
			{ cause: error },
		);
	}
	const sourceUpdatedAt = requireFreshSource(spec, raw, now);
	const parsed = spec.source.parse(raw, version);
	// Count the RECORDS the feed published, before any alias enrichment — the
	// health band is about population, and enrichment cannot change it.
	requirePlausibleCount(spec, parsed.length);
	const lines = await enrichOrDegrade(spec, parsed, collect);
	const entities: WatchlistEntity[] = lines.map((line, i) =>
		toWatchlistEntity(line, i + 1),
	);
	const vectors = await packVectors(
		embedder,
		entities.map((e) => e.name_canonical),
	);
	return {
		listId: spec.source.id,
		slug: spec.slug,
		title: spec.source.title,
		version,
		model: EMBEDDING_MODEL,
		dim: EMBEDDING_DIM,
		entities,
		vectors,
		freshness: {
			fetchedAt: now.toISOString(),
			sourceUpdatedAt,
			stale: false,
			staleReason: null,
		},
	};
}

/**
 * Stage every required source, preserving configured order.
 *
 * PER-LIST INDEPENDENCE. Each list is refreshed — and therefore fails — on its
 * own. When one cannot be refreshed, `carryForward` re-serves the copy already
 * published (verified end-to-end, marked stale, keeping its own age) and the
 * remaining lists still refresh normally. Before this, one 500 from the EU
 * webgate aged OFAC too, which is the list every visitor screens against.
 *
 * Still fail-closed, at the point where it matters: with no `carryForward`
 * configured, or when the published copy cannot be proven either, the whole
 * publish aborts rather than emit a bundle missing a list it claims to carry.
 */
export async function stagedListsFromSources(
	specs: readonly RealBundleSourceSpec[],
	embedder: Embedder,
	version: string,
	_log?: (message: string) => void,
	now: () => Date = () => new Date(),
	carryForward?: CarryForward,
): Promise<StagedLists> {
	const staged: StagedList[] = [];
	const reports: AliasEnrichmentReport[] = [];
	const carried: CarriedListReport[] = [];
	for (const spec of specs) {
		const collect = (r: AliasEnrichmentReport) => reports.push(r);
		try {
			staged.push(
				await stageOneSource(spec, embedder, version, now(), collect),
			);
		} catch (error) {
			if (carryForward === undefined) {
				throw error;
			}
			const list = await carryOrAbort(spec, error, carryForward);
			staged.push(list);
			carried.push({
				listId: list.listId,
				fetchedAt: list.freshness.fetchedAt,
				reason: list.freshness.staleReason ?? messageOf(error),
			});
		}
	}
	return { lists: staged, aliases: mergeAliasReports(reports), carried };
}

/** Re-serve the published copy, or abort: a list we can neither refresh nor
 * prove is a coverage claim with nothing behind it. */
async function carryOrAbort(
	spec: RealBundleSourceSpec,
	failure: unknown,
	carryForward: CarryForward,
): Promise<StagedList> {
	const reason = messageOf(failure);
	try {
		return await carryForward(spec, reason);
	} catch (cause) {
		throw new Error(
			`${spec.source.id}: could not refresh (${reason}) and could not re-serve the published copy (${messageOf(cause)})`,
			{ cause },
		);
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** One bundle-wide verdict: any degraded source degrades the whole bundle, so a
 * partial run can never be described as fully enriched. */
function mergeAliasReports(
	reports: readonly AliasEnrichmentReport[],
): AliasEnrichmentReport {
	if (reports.length === 0) {
		return {
			mode: "records-only",
			aliasesAdded: 0,
			entitiesEnriched: 0,
			reason: "no source declared alias enrichment",
		};
	}
	const degraded = reports.find((r) => r.mode === "records-only");
	return {
		mode: degraded === undefined ? "enriched" : "records-only",
		aliasesAdded: reports.reduce((n, r) => n + r.aliasesAdded, 0),
		entitiesEnriched: reports.reduce((n, r) => n + r.entitiesEnriched, 0),
		reason: degraded?.reason ?? null,
	};
}

/** One CLI run: stage the real lists then publish the signed bundle to outDir. */
interface RealBundleArgs {
	readonly version: string;
	readonly sequence: number;
	readonly keyPath: string;
	readonly outDir: string;
	readonly models: string;
	/** The live origin to re-serve an unrefreshable list from. Optional: without
	 * it (a first publish, or a local build) the run fails closed as before. */
	readonly liveBaseUrl?: string;
	/** The pinned public key the live origin's pointer must verify against. */
	readonly pubkeyPath?: string;
	/** Days a list may be carried forward before the publish refuses. Unset = no
	 * cap, which is how UK_OFSI was re-served daily from 2026-09-01 under a green
	 * pipeline. Set it in CI so a frozen upstream goes red instead of quiet. */
	readonly maxCarriedAgeDays?: number;
}

/** A ceiling must be a non-negative whole number of days, or absent. A typo
 * must not silently disable the cap the flag exists to impose. */
function parseCarriedCeiling(raw: string | undefined): number | undefined {
	if (raw === undefined) {
		return undefined;
	}
	const days = Number(raw);
	if (!Number.isSafeInteger(days) || days < 0) {
		throw new Error("--max-carried-age-days must be a non-negative integer");
	}
	return days;
}

export function parseRealBundleArgs(argv: readonly string[]): RealBundleArgs {
	const map = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 2) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (flag === undefined || !flag.startsWith("--") || value === undefined) {
			throw new Error(`malformed argument near "${flag ?? ""}"`);
		}
		map.set(flag.slice(2), value);
	}
	for (const k of ["version", "sequence", "key", "out"]) {
		if (!map.has(k)) {
			throw new Error(`missing required --${k}`);
		}
	}
	const sequence = Number(map.get("sequence"));
	if (!Number.isSafeInteger(sequence) || sequence < 0) {
		throw new Error("--sequence must be a non-negative safe integer");
	}
	const liveBaseUrl = map.get("live-base-url");
	const pubkeyPath = map.get("pubkey");
	const maxCarriedAgeDays = parseCarriedCeiling(
		map.get("max-carried-age-days"),
	);
	// Both or neither: a base URL with no key to verify it against would invite
	// re-serving bytes nobody signed.
	if ((liveBaseUrl === undefined) !== (pubkeyPath === undefined)) {
		throw new Error("--live-base-url and --pubkey must be given together");
	}
	return {
		version: map.get("version") as string,
		sequence,
		keyPath: resolve(map.get("key") as string),
		outDir: resolve(map.get("out") as string),
		models: map.get("models") ?? DEFAULT_MODELS,
		...(maxCarriedAgeDays === undefined ? {} : { maxCarriedAgeDays }),
		...(liveBaseUrl === undefined
			? {}
			: {
					liveBaseUrl: liveBaseUrl.replace(/\/$/, ""),
					pubkeyPath: resolve(pubkeyPath as string),
				}),
	};
}

/** Build the production carry-forward: re-serve a list from the live origin,
 * with the full trust chain re-proven against the pinned public key. */
function liveOriginCarryForward(
	args: RealBundleArgs,
): CarryForward | undefined {
	if (args.liveBaseUrl === undefined || args.pubkeyPath === undefined) {
		return undefined;
	}
	const baseUrl = args.liveBaseUrl;
	const pubkey = new Uint8Array(readFileSync(args.pubkeyPath));
	return (spec, reason) =>
		carryForwardList({
			baseUrl,
			fetchBytes: httpFetchBytes,
			pubkey,
			slug: spec.slug,
			reason,
			...(args.maxCarriedAgeDays === undefined
				? {}
				: { maxCarriedAgeDays: args.maxCarriedAgeDays }),
		});
}

/** Stage the real lists then publish the signed bundle to outDir. Drives the
 * real Node embedder + the real adapters; the thin entry script passes argv. */
export async function runRealBundle(
	argv: readonly string[],
	dependencies: RealBundleDependencies = {},
): Promise<void> {
	const args = parseRealBundleArgs(argv);
	const {
		lists: staged,
		aliases,
		carried,
	} = await stagedListsFromSources(
		dependencies.sources ?? BUNDLE_SOURCES,
		createNodeEmbedder(args.models),
		args.version,
		undefined,
		dependencies.now,
		dependencies.carryForward ?? liveOriginCarryForward(args),
	);
	const staging = await mkdtemp(join(tmpdir(), "aml-real-bundle-"));
	try {
		await stageBundle(staging, staged, new Date().toISOString());
		await publishBundle({
			srcDir: staging,
			originDir: args.outDir,
			keyPath: args.keyPath,
			bundleId: BUNDLE_ID,
			version: args.version,
			sequence: args.sequence,
		});
		// edge-proc also writes a producer-side CAS mirror (chunks/<aa>/<hash>,
		// manifests/<hash>) and a .mutation.lock next to the served contract. The
		// sync tier consumes ONLY chunk/<hash>, manifest/<hash>, latest — drop the
		// rest so the uploaded tree is exactly the served contract and no build
		// residue is published to the CDN.
		await removeProducerResidue(args.outDir);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
	const lists = staged.map((l) => l.listId).join(", ");
	process.stdout.write(
		`real bundle (${staged.length} lists: ${lists}, v${args.version}) -> ${args.outDir}\n`,
	);
	// The deploy captures these into $GITHUB_ENV so the bundle's alias coverage
	// is stated, not assumed. A degraded run must be visible, not inferred.
	process.stdout.write(`ALIAS_MODE=${aliases.mode}\n`);
	process.stdout.write(`ALIAS_ADDED=${aliases.aliasesAdded}\n`);
	// Same rule for staleness: a run that could not refresh a list says so on
	// stdout (for the workflow summary) and on stderr (for the log), because
	// "the bundle published" and "the bundle is current" are different claims.
	process.stdout.write(
		`STALE_LISTS=${carried.map((c) => c.listId).join(",")}\n`,
	);
	for (const entry of carried) {
		process.stderr.write(
			`${entry.listId} was NOT refreshed — re-serving the copy fetched at ${entry.fetchedAt}, marked stale in the bundle. Reason: ${entry.reason}\n`,
		);
	}
	if (aliases.mode === "records-only") {
		process.stderr.write(
			`alias enrichment UNAVAILABLE — publishing record-feed names only (Latin script). Non-Latin queries will not match. Reason: ${aliases.reason ?? "unknown"}\n`,
		);
	}
}
