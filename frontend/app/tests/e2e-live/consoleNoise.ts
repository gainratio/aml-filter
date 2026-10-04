/**
 * Which console errors the live smoke may ignore. Kept free of Playwright so a
 * Vitest contract can pin it (src/__tests__/liveSmokeConsoleNoise.contract.test.ts).
 *
 * A failed live smoke rolls production back, so every console error fails it,
 * with exactly one known false alarm: WebKit logs
 *   Cannot load blob:<origin>/<uuid> due to access control checks.
 * when a hard navigation tears the document down while the edgeproc Worker is
 * reading a cached chunk with OPFS `getFile().arrayBuffer()` (an OPFS File is
 * blob-backed in WebKit, so the cancelled read surfaces as a blob load). The
 * app creates no blob: URL and the CSP plays no part; Chromium and Firefox
 * are silent. It rolled the local WebKit @returning pass red on 2026-10-04.
 *
 * The excuse needs the exact WebKit wording, a blob on the page's own origin
 * with a UUID path, and a main-frame navigation in flight. The same line on a
 * settled page, or any other wording (a CSP refusal included), still fails.
 */

/** What the smoke knows about one console error, reduced to plain values. */
export interface ConsoleErrorFacts {
	readonly text: string;
	/** `new URL(page.url()).origin` when the error arrived. */
	readonly pageOrigin: string;
	/** True between a main-frame navigation request and the new document's
	 * DOMContentLoaded. */
	readonly duringNavigation: boolean;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isCancelledOwnBlobRead(text: string, origin: string): boolean {
	if (!/^https?:\/\/[^/]+$/.test(origin)) return false;
	const pattern = new RegExp(
		`^Cannot load blob:${escapeRegExp(origin)}/${UUID} due to access control checks\\.$`,
	);
	return pattern.test(text);
}

/** True only for WebKit's cancelled same-origin blob read during a navigation. */
export function isExcusedConsoleError(facts: ConsoleErrorFacts): boolean {
	return (
		facts.duringNavigation &&
		isCancelledOwnBlobRead(facts.text, facts.pageOrigin)
	);
}
