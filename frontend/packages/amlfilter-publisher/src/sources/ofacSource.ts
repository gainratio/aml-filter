// OFAC SDN adapter — reads the US Government's Consolidated Screening List.
//
// The list IDENTITY is unchanged: this adapter still publishes `OFAC_SDN` /
// "OFAC SDN", and still exactly the OFAC SDN designations. Only the transport
// moved, because Treasury's own SDN.CSV endpoint is no longer machine-readable
// (AWS WAF: 403 without a browser User-Agent, 202 + an unsolvable JS challenge
// with one).
//
// fetchRaw: REAL — pulls data.trade.gov's consolidated.csv (CSL_BASE,
//           overridable via env). Goes through the shared fetchWithTimeout seam,
//           so it inherits the identifying User-Agent, the retry budget and the
//           WAF diagnostics.
// parse:    REAL — delegates to parseCslSdn, which keeps ONLY the OFAC SDN rows
//           (fixture-tested in csl.test.ts against real published rows).
//           entity_id stays namespaced "OFAC_SDN:<entity_number>".
//
// See csl.ts for the provenance rationale and the field-level notes.

import { parseCslSdn } from "./csl.ts";
import {
	cancelResponse,
	fetchWithTimeout,
	readResponseText,
} from "./fetchWithTimeout.ts";
import {
	canonicalSourceTimestamp,
	OFAC_LIST_ID,
	type RawListBytes,
	SOURCE_UPDATED_AT_KEY,
	type SourceLine,
	type SourceSnapshot,
	sourceSnapshot,
	type WatchlistSource,
} from "./source.ts";

/** The CSL download host. Overridable (proactive config, no host lock-in). */
export const CSL_BASE =
	process.env.CSL_BASE ??
	"https://data.trade.gov/downloadable_consolidated_screening_list/v1";

/** The consolidated file, keyed into RawListBytes under this logical name. */
export const CSL_FILE = "consolidated.csv";

/** ~17 MB, so it gets a longer deadline than a few-hundred-KB feed. */
const CSL_TIMEOUT_MS = 90_000;
const CSL_BODY_LIMITS = {
	maxBytes: 64 * 1024 * 1024,
	elapsedMs: CSL_TIMEOUT_MS,
	idleMs: 15_000,
} as const;

/** Where an operator gets a key if trade.gov ever starts requiring one. */
const KEY_HELP =
	"set the TRADE_GOV_API_KEY repository secret (free key: https://api.trade.gov/console)";

/** trade.gov's documented API-key header, sent only when a key is configured.
 *
 * The bulk download currently needs NO key — measured 2026-07-30: HTTP 200,
 * 16,640,630 bytes, with no key AND no User-Agent — so a missing key is NOT
 * treated as a build error. Failing closed on a credential this endpoint does
 * not ask for would recreate exactly the "one missing input freezes the whole
 * site" problem the deploy-resilience work just removed. If trade.gov ever does
 * start rejecting anonymous reads, the 401/403 hint below says what to do. */
function authHeaders(): Readonly<Record<string, string>> {
	const key = process.env.TRADE_GOV_API_KEY?.trim();
	return key === undefined || key === "" ? {} : { "subscription-key": key };
}

/** Turn an upstream auth rejection into an actionable instruction. */
export function withKeyHint(message: string, hasKey: boolean): string {
	if (!/\b(401|403)\b/.test(message)) {
		return message;
	}
	return hasKey
		? `${message} — TRADE_GOV_API_KEY is set but was rejected; check it is current (${KEY_HELP})`
		: `${message} — the CSL download now requires credentials: ${KEY_HELP}`;
}

interface FetchedText {
	readonly text: string;
	readonly updatedAt: string;
	readonly response: Response;
	readonly url: string;
}

async function fetchCsl(): Promise<FetchedText> {
	const url = `${CSL_BASE}/${CSL_FILE}`;
	const headers = authHeaders();
	let res: Response;
	try {
		res = await fetchWithTimeout(url, "OFAC SDN (via CSL)", CSL_TIMEOUT_MS, {
			headers,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(withKeyHint(message, Object.keys(headers).length > 0), {
			cause: error,
		});
	}
	const updatedAt = res.headers.get("last-modified");
	if (updatedAt === null) {
		const failure = new Error(`fetch ${url} omitted Last-Modified`);
		await cancelResponse(res, failure);
		throw failure;
	}
	return {
		text: await readResponseText(res, "OFAC SDN (via CSL)", CSL_BODY_LIMITS),
		updatedAt,
		response: res,
		url,
	};
}

async function fetchCslSnapshot(): Promise<SourceSnapshot> {
	const csl = await fetchCsl();
	const updatedAt = canonicalSourceTimestamp(OFAC_LIST_ID, csl.updatedAt);
	const raw = { [CSL_FILE]: csl.text, [SOURCE_UPDATED_AT_KEY]: updatedAt };
	return sourceSnapshot(raw, csl.response, csl.url, updatedAt);
}

export const ofacSource: WatchlistSource = {
	id: OFAC_LIST_ID,
	title: "OFAC SDN",
	async fetchRaw(): Promise<RawListBytes> {
		return (await fetchCslSnapshot()).raw;
	},
	fetchSnapshot: fetchCslSnapshot,
	sourceUpdatedAt(raw: RawListBytes): string | undefined {
		return raw[SOURCE_UPDATED_AT_KEY];
	},
	parse(raw: RawListBytes, listVersion: string): SourceLine[] {
		return parseCslSdn(raw[CSL_FILE] ?? "", listVersion);
	},
};
