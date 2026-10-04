// The recall gate: compare a fresh measurement against the committed floors.
//
// The floors live in the committed baseline file, so raising them is a visible
// diff and lowering them is a visible diff. They ratchet UP only — a change that
// improves recall is expected to move the floor with it; a change that lowers
// recall fails here instead of shipping.
//
// TOLERANCE, and why it is not a fudge factor: the corpus vectors are produced
// by a quantized ONNX model, and its last-bit arithmetic is not identical across
// CPU architectures. Two entities whose scores differ in the fourth decimal can
// swap rank between an arm64 laptop and an x86_64 CI runner, so a floor pinned
// to the exact measured value would fail on a green tree. The tolerance is the
// width of that platform noise and nothing else; it is subtracted ONCE, when the
// floor is written, and the comparison here is exact.

import { absentProbes } from "./auditQueries.ts";
import type { QueryKind } from "./labels.ts";
import { type RecallReport, recallAt, segmentOf } from "./report.ts";

/** The segment label used for probe failures — they belong to no sampled segment. */
const AUDIT_SEGMENT = "audit";

/** The minimum a segment must clear. Written from a measured run, never guessed. */
interface SegmentFloor {
	readonly kind: QueryKind;
	readonly minRecallAt1: number;
	readonly minRecallAt10: number;
	readonly minRecallAt25: number;
	readonly maxAbsentRate: number;
}

/** The committed floors for every segment. */
export interface RecallFloors {
	readonly segments: readonly SegmentFloor[];
}

/** One breached floor, or one audit probe that returned nothing. */
export interface GateFailure {
	readonly segment: QueryKind | typeof AUDIT_SEGMENT;
	readonly metric: string;
	readonly measured: number;
	readonly floor: number;
}

/** The gate's verdict. `ok` false means the caller must exit non-zero. */
export interface GateVerdict {
	readonly ok: boolean;
	readonly failures: readonly GateFailure[];
}

function checkMinimum(
	segment: QueryKind,
	metric: string,
	measured: number,
	floor: number,
): GateFailure | null {
	return measured >= floor ? null : { segment, metric, measured, floor };
}

function checkMaximum(
	segment: QueryKind,
	metric: string,
	measured: number,
	ceiling: number,
): GateFailure | null {
	return measured <= ceiling
		? null
		: { segment, metric, measured, floor: ceiling };
}

function checkSegment(
	report: RecallReport,
	floor: SegmentFloor,
): readonly GateFailure[] {
	const segment = segmentOf(report, floor.kind);
	const checks = [
		checkMinimum(
			floor.kind,
			"recall@1",
			recallAt(segment, 1),
			floor.minRecallAt1,
		),
		checkMinimum(
			floor.kind,
			"recall@10",
			recallAt(segment, 10),
			floor.minRecallAt10,
		),
		checkMinimum(
			floor.kind,
			"recall@25",
			recallAt(segment, 25),
			floor.minRecallAt25,
		),
		checkMaximum(
			floor.kind,
			"absentRate",
			segment.absentRate,
			floor.maxAbsentRate,
		),
	];
	return checks.filter((c): c is GateFailure => c !== null);
}

/**
 * The audit probes are pass/fail, not a floor: a named case either came back or
 * it did not. There is no tolerance to subtract because rank churn cannot turn
 * "present somewhere in 25" into "absent" — a probe that flips has genuinely
 * stopped being retrieved.
 */
function checkAuditProbes(report: RecallReport): readonly GateFailure[] {
	return absentProbes(report.audit).map((probe) => ({
		segment: AUDIT_SEGMENT,
		metric: `${probe.query} -> ${probe.expected}`,
		measured: 0,
		floor: 1,
	}));
}

/** Grade a measurement against the committed floors and the audit probes. */
export function checkRecall(
	report: RecallReport,
	floors: RecallFloors,
): GateVerdict {
	const failures = [
		...floors.segments.flatMap((floor) => checkSegment(report, floor)),
		...checkAuditProbes(report),
	];
	return { ok: failures.length === 0, failures };
}

/** Render the failures for a CI log, one breach per line. */
export function formatFailures(failures: readonly GateFailure[]): string {
	return failures
		.map((f) =>
			f.segment === AUDIT_SEGMENT
				? `  audit probe never retrieved its entity: ${f.metric}`
				: `  ${f.segment} ${f.metric}: measured ${f.measured.toFixed(4)}, floor ${f.floor.toFixed(4)}`,
		)
		.join("\n");
}

/**
 * Derive floors from a measured report by subtracting the platform tolerance.
 * Used when writing a NEW baseline; never called by the gate itself.
 */
export function floorsFromReport(
	report: RecallReport,
	tolerance: number,
): RecallFloors {
	const down = (value: number): number =>
		Math.max(0, Number((value - tolerance).toFixed(4)));
	const up = (value: number): number =>
		Math.min(1, Number((value + tolerance).toFixed(4)));
	return {
		segments: report.segments.map((segment) => ({
			kind: segment.kind,
			minRecallAt1: down(recallAt(segment, 1)),
			minRecallAt10: down(recallAt(segment, 10)),
			minRecallAt25: down(recallAt(segment, 25)),
			maxAbsentRate: up(segment.absentRate),
		})),
	};
}

function ratchetSegment(
	next: SegmentFloor,
	previous: SegmentFloor | undefined,
): SegmentFloor {
	if (previous === undefined) {
		return next;
	}
	return {
		kind: next.kind,
		minRecallAt1: Math.max(next.minRecallAt1, previous.minRecallAt1),
		minRecallAt10: Math.max(next.minRecallAt10, previous.minRecallAt10),
		minRecallAt25: Math.max(next.minRecallAt25, previous.minRecallAt25),
		maxAbsentRate: Math.min(next.maxAbsentRate, previous.maxAbsentRate),
	};
}

/**
 * The ratchet, enforced rather than remembered.
 *
 * `--write` is how a baseline is refreshed after a change moves recall, and the
 * rule has always been that floors only go UP. Nothing checked it: a run that
 * improved one number and quietly lost a tenth of a point on another wrote both
 * new values, and the lost tenth became the new permission. This keeps whichever
 * bound is stricter, so a floor can never be lowered by re-running the tool. If
 * a floor genuinely has to come down, it takes a hand edit to the committed
 * baseline — which is a visible, arguable diff, exactly as it should be.
 */
export function ratchetFloors(
	next: RecallFloors,
	previous: RecallFloors | null,
): RecallFloors {
	if (previous === null) {
		return next;
	}
	return {
		segments: next.segments.map((segment) =>
			ratchetSegment(
				segment,
				previous.segments.find((p) => p.kind === segment.kind),
			),
		),
	};
}
