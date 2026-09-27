/**
 * Plain words for the codes the engine and the workstation store.
 *
 * The codes (`UK_OFSI`, `FALSE_POSITIVE`, `name_vector`, …) stay the data
 * contract: the SQLite rows, the CSV/JSON exports, the signed score receipts and
 * the persisted list selection all keep them. What a visitor READS goes through
 * here, so no raw code leaks onto a screen. An unknown code (a list or status
 * added later) falls back to something printable, never to a blank.
 */
import type { TFunction } from "i18next";

/** A translator bound to the `common` namespace (or any t that can reach it). */
type Translate = TFunction<"common"> | TFunction;

function lookup(
	t: Translate,
	group: string,
	code: string,
	fallback: string,
): string {
	const key = `common:labels.${group}.${code}`;
	const text = (t as TFunction)(key, { defaultValue: "" });
	return text.length > 0 && text !== key ? text : fallback;
}

/** A list's plain name; the catalog title, then the id, for a list we don't know. */
export function listName(id: string, t: Translate, title?: string): string {
	return lookup(t, "lists", id, title ?? id);
}

/** A review status or disposition (`PENDING`, `FALSE_POSITIVE`, …) in words. */
export function resolutionLabel(code: string, t: Translate): string {
	return lookup(t, "status", code, code);
}

/** A match strength (`STRONG` / `POSSIBLE` / `WEAK`) in words. */
export function tierLabel(code: string, t: Translate): string {
	return lookup(t, "tier", code, code);
}

/** An audit-trail event (`DETECTED`, `CHANGED`, …) in words. */
export function matchEventLabel(code: string, t: Translate): string {
	return lookup(t, "event", code, code);
}

/** A score signal (`name_vector`, `alias_match`, …) in words. */
export function reasonLabel(signal: string, t: Translate): string {
	return lookup(t, "reason", signal, signal);
}

/** A risk category (`SANCTION`, `PEP`, …) in words. */
export function riskLabel(code: string, t: Translate): string {
	return lookup(t, "risk", code, code);
}
