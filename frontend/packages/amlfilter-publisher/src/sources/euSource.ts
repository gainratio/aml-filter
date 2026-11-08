// EU consolidated sanctions adapter.
//
// fetchRaw: LIVE — the EU FSD public feed (xmlFullSanctionsList_1_1) is served
//   with a static public access token (see EU_URL); no secret/token plumbing is
//   needed. parse() below is the real, fixture-tested part.
// parse:    REAL — maps <sanctionEntity> (logicalId, subjectType, nameAlias,
//   birthdate, citizenship/address country) into namespaced SourceLines.

import {
	fetchWithTimeout,
	readResponseText,
	SOURCE_FETCH_TIMEOUT_MS,
} from "./fetchWithTimeout.ts";
import {
	canonicalSourceTimestamp,
	EU_LIST_ID,
	namespacedId,
	type RawListBytes,
	type SourceLine,
	type SourceSnapshot,
	sourceSnapshot,
	type WatchlistSource,
} from "./source.ts";
import { elements } from "./xml.ts";

/** The logical raw-file key for the single EU XML document. */
export const EU_RAW_FILE = "eu_consolidated.xml";

/**
 * The EU consolidated sanctions download URL.
 *
 * The `token=dG9rZW4tMjAxNw` param is the EU webgate's static public access
 * token (base64 of "token-2017"): required by the endpoint but NOT a secret and
 * NOT rotating, so it is simply hard-coded. This is distinct from the
 * registered/rotating FSD token used by the authenticated feed.
 */
export const EU_URL =
	"https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw";

/**
 * Fallback EU consolidated sanctions XML endpoints tried in order when the
 * primary EU webgate 1.1 endpoint returns transient 5xx/network failures:
 *   1. The EU webgate 1.0 full XML endpoint (same static public token).
 *   2. OpenSanctions' verbatim daily mirror of the EU FSF XML feed (carries
 *      the upstream `<export generationDate="...">` and `<sanctionEntity>`).
 */
export const EU_FALLBACK_URLS: readonly string[] = [
	"https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList/content?token=dG9rZW4tMjAxNw",
	"https://data.opensanctions.org/datasets/latest/eu_fsf/source.xml",
];

const EU_BODY_LIMITS = {
	maxBytes: 32 * 1024 * 1024,
	elapsedMs: SOURCE_FETCH_TIMEOUT_MS,
	idleMs: 15_000,
} as const;

function entityType(code: string): "PERSON" | "ORGANIZATION" {
	return code.toLowerCase() === "person" ? "PERSON" : "ORGANIZATION";
}

/** Collect sorted, de-duplicated ISO2 country codes from citizenship+address. */
function countriesOf(inner: string): string[] {
	const codes = new Set<string>();
	for (const tag of ["citizenship", "address"]) {
		for (const el of elements(inner, tag)) {
			const code = el.attrs.countryIso2Code;
			if (code !== undefined && code !== "") {
				codes.add(code);
			}
		}
	}
	return [...codes].sort();
}

function dobOf(inner: string): string[] {
	const el = elements(inner, "birthdate")[0];
	const date = el?.attrs.birthdate ?? el?.attrs.year;
	return date !== undefined && date !== "" ? [date] : [];
}

/** wholeName of each alias, primary = first; fall back to first/last join. */
function namesOf(inner: string): { primary: string; aliases: string[] } {
	const names = elements(inner, "nameAlias")
		.map((a) => {
			const whole = a.attrs.wholeName?.trim();
			if (whole !== undefined && whole !== "") {
				return whole;
			}
			return [a.attrs.firstName, a.attrs.lastName]
				.filter((p): p is string => p !== undefined && p !== "")
				.join(" ")
				.trim();
		})
		.filter((n) => n !== "");
	const [primary, ...aliases] = names;
	return { primary: primary ?? "", aliases };
}

function toLine(inner: string, attrs: Record<string, string>): SourceLine {
	const { primary, aliases } = namesOf(inner);
	const code = elements(inner, "subjectType")[0]?.attrs.code ?? "";
	return {
		entity_id: namespacedId(EU_LIST_ID, attrs.logicalId ?? ""),
		primary_name: primary,
		entity_type: entityType(code),
		aliases: aliases.map((name) => ({ name })),
		dob: dobOf(inner),
		countries: countriesOf(inner),
		risk_category: "SANCTION",
		source_list: EU_LIST_ID,
		list_version: "",
	};
}

function updatedAt(raw: RawListBytes): string | undefined {
	return elements(raw[EU_RAW_FILE] ?? "", "export")[0]?.attrs.generationDate;
}

async function fetchEuSnapshot(): Promise<SourceSnapshot> {
	const { raw, response, url } = await fetchEuRaw();
	const sourceUpdatedAt = updatedAt(raw);
	if (sourceUpdatedAt === undefined) {
		throw new Error("EU_CONSOLIDATED: freshness timestamp is missing");
	}
	return sourceSnapshot(
		raw,
		response,
		url,
		canonicalSourceTimestamp(EU_LIST_ID, sourceUpdatedAt),
	);
}

async function fetchEuRaw(): Promise<{
	readonly raw: RawListBytes;
	readonly response: Response;
	readonly url: string;
}> {
	let lastError: unknown;
	for (const url of [EU_URL, ...EU_FALLBACK_URLS]) {
		try {
			const response = await fetchWithTimeout(url, "EU");
			return {
				raw: {
					[EU_RAW_FILE]: await readResponseText(response, "EU", EU_BODY_LIMITS),
				},
				response,
				url,
			};
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError;
}

export const euSource: WatchlistSource = {
	id: EU_LIST_ID,
	title: "EU Consolidated",
	async fetchRaw(): Promise<RawListBytes> {
		return (await fetchEuRaw()).raw;
	},
	fetchSnapshot: fetchEuSnapshot,
	sourceUpdatedAt(raw: RawListBytes): string | undefined {
		return updatedAt(raw);
	},
	parse(raw: RawListBytes, listVersion: string): SourceLine[] {
		const xml = raw[EU_RAW_FILE] ?? "";
		return elements(xml, "sanctionEntity").map((el) => ({
			...toLine(el.inner, el.attrs),
			list_version: listVersion,
		}));
	},
};
