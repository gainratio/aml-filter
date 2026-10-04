// The recall report: the shape measured, printed, and committed as the baseline.
//
// Everything here is a plain typed record so the committed baseline is a
// reviewable diff — a recall change shows up in a pull request as a number
// moving, with the corpus and sampling provenance that produced it sitting
// beside it.

import { type AuditProbeResult, formatAuditProbes } from "./auditQueries.ts";
import type { QueryKind } from "./labels.ts";

/** Hit count and recall at one cut-off. */
export interface RecallAtK {
	readonly k: number;
	readonly hits: number;
	/** hits / queries, in [0, 1]. */
	readonly recall: number;
}

/** One segment's result. Segments are reported side by side, never averaged. */
export interface SegmentReport {
	readonly kind: QueryKind;
	/** How many labelled queries were screened in this segment. */
	readonly queries: number;
	readonly at: readonly RecallAtK[];
	/**
	 * Queries whose expected entity appeared NOWHERE in the returned results —
	 * the user saw a screen that did not contain the sanctioned entity at all.
	 */
	readonly absent: number;
	/** absent / queries, in [0, 1]. */
	readonly absentRate: number;
}

/** What the corpus under measurement was. */
interface CorpusProvenance {
	readonly listId: string;
	readonly entities: number;
	/** The frozen fixture file the corpus was rebuilt from. */
	readonly fixture: string;
	/** SHA-256 of the fixture bytes — the corpus identity the number belongs to. */
	readonly fixtureSha256: string;
}

/** How the measured queries were chosen. */
interface SampleProvenance {
	readonly seed: number;
	/** Queries screened per segment; `null` means "every labelled query". */
	readonly perSegment: number | null;
	/** Labelled queries available before sampling, per segment. */
	readonly availableAlias: number;
	readonly availableCanonical: number;
}

/**
 * A full measurement run.
 *
 * Schema 2 added `audit`: the four named spelling-variant probes, reported
 * beside the sampled segments because an aggregate cannot say whether one
 * specific fixed case is still fixed.
 */
export interface RecallReport {
	readonly schemaVersion: 2;
	readonly measuredAt: string;
	readonly corpus: CorpusProvenance;
	readonly screen: { readonly threshold: number; readonly k: number };
	readonly sample: SampleProvenance;
	readonly segments: readonly SegmentReport[];
	/** The pinned probes and where each one's expected entity ranked. */
	readonly audit: readonly AuditProbeResult[];
}

/** Look up one segment, or throw — a missing segment is a broken report. */
export function segmentOf(
	report: RecallReport,
	kind: QueryKind,
): SegmentReport {
	const found = report.segments.find((s) => s.kind === kind);
	if (found === undefined) {
		throw new Error(`recall report has no "${kind}" segment`);
	}
	return found;
}

/** Recall at one cut-off within a segment, or throw if it was not measured. */
export function recallAt(segment: SegmentReport, k: number): number {
	const found = segment.at.find((a) => a.k === k);
	if (found === undefined) {
		throw new Error(`segment "${segment.kind}" has no recall@${k}`);
	}
	return found.recall;
}

function formatSegment(segment: SegmentReport): string {
	const cells = segment.at
		.map((a) => `@${a.k}=${a.recall.toFixed(4)}`)
		.join("  ");
	const absent = `absent=${segment.absent} (${segment.absentRate.toFixed(4)})`;
	return `  ${segment.kind.padEnd(9)} n=${String(segment.queries).padStart(6)}  ${cells}  ${absent}`;
}

/** Human-readable rendering for the gate log — one line per segment. */
export function formatReport(report: RecallReport): string {
	const head = [
		`corpus: ${report.corpus.listId} ${report.corpus.entities} entities (${report.corpus.fixture})`,
		`screen: threshold=${report.screen.threshold} k=${report.screen.k}`,
		`sample: seed=${report.sample.seed} perSegment=${report.sample.perSegment ?? "all"}`,
	];
	return [
		...head,
		...report.segments.map(formatSegment),
		"audit probes (named spelling variants, each must be retrieved):",
		formatAuditProbes(report.audit),
	].join("\n");
}
