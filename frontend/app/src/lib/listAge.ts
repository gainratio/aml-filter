/**
 * How old a watchlist's data is, in words a person can act on.
 *
 * WHY THIS EXISTS: the bundle refreshes each list independently. When an
 * upstream feed is down the publisher re-serves that list's last good copy and
 * marks it stale, keeping the instant it was ORIGINALLY fetched. So "the bundle
 * was built today" says nothing about how old any one list is, and an analyst
 * screening against a three-day-old EU list has to be able to see that number.
 *
 * Formatting goes through `Intl`, so the wording follows the viewer's locale
 * without a translation key per unit. The surrounding sentence ("updated {{age}}",
 * "Not updated for {{age}}") stays in the i18n catalogue.
 */

/** The coarsest unit that still reads honestly at a given age. */
type AgeUnit = "second" | "minute" | "hour" | "day";

/** A list's age, both as a phrase and as a bare duration. */
export interface ListAge {
	/** Whole units elapsed, truncated — a 3-day-23-hour list is 3 days old. */
	readonly value: number;
	readonly unit: AgeUnit;
	/** Relative phrase: "4 hours ago", "now". For "updated {{age}}". */
	readonly phrase: string;
	/** Bare duration: "3 days", "1 day". For "Not updated for {{age}}". */
	readonly duration: string;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The coarsest unit that does not exaggerate, plus how many of them elapsed. */
function bucket(elapsedMs: number): { value: number; unit: AgeUnit } {
	if (elapsedMs < MINUTE) {
		return { value: Math.floor(elapsedMs / SECOND), unit: "second" };
	}
	if (elapsedMs < HOUR) {
		return { value: Math.floor(elapsedMs / MINUTE), unit: "minute" };
	}
	if (elapsedMs < DAY) {
		return { value: Math.floor(elapsedMs / HOUR), unit: "hour" };
	}
	return { value: Math.floor(elapsedMs / DAY), unit: "day" };
}

/**
 * The age of `fetchedAt` as of `now`, or `null` when the input cannot be aged.
 *
 * `null` is the whole point of the return type: a missing or unparseable
 * instant must render as "age unknown", never silently as "fresh". The engine's
 * fail-closed bundle guard should make that unreachable for a verified bundle —
 * this is the same rule enforced again at the render boundary.
 *
 * A `fetchedAt` in the future (clock skew) is clamped to zero rather than
 * reported as a negative age.
 */
export function listAge(
	fetchedAt: string | null | undefined,
	now: Date = new Date(),
	locale = "en",
): ListAge | null {
	if (typeof fetchedAt !== "string") {
		return null;
	}
	const fetchedMs = Date.parse(fetchedAt);
	if (!Number.isFinite(fetchedMs)) {
		return null;
	}
	const { value, unit } = bucket(Math.max(0, now.getTime() - fetchedMs));
	return {
		value,
		unit,
		phrase: new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
			-value,
			unit,
		),
		duration: new Intl.NumberFormat(locale, {
			style: "unit",
			unit,
			unitDisplay: "long",
		}).format(value),
	};
}
