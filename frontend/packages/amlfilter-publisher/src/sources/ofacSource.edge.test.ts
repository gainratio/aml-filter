// ofacSource network + degenerate-input behavior, offline: fetchRaw pulls the
// CSL consolidated.csv off a stubbed fetch and keys it by file name; a non-OK
// response fails loud with the status; a 401/403 says how to fix it; a response
// that cannot prove upstream freshness is refused.

import { afterEach, describe, expect, test, vi } from "vitest";
import { rejectionAfterBackoff } from "./backoffTestClock.ts";
import { CSL_FILE, ofacSource, withKeyHint } from "./ofacSource.ts";
import { SOURCE_UPDATED_AT_KEY } from "./source.ts";

const HEADER =
	"source,entity_number,type,name,alt_names,dates_of_birth,citizenships,nationalities\n";

describe("ofacSource identity", () => {
	test("still publishes the OFAC SDN list under its unchanged id", () => {
		// The transport moved to CSL; the list identity must NOT drift.
		expect(ofacSource.id).toBe("OFAC_SDN");
		expect(ofacSource.title).toBe("OFAC SDN");
	});
});

describe("ofacSource.fetchRaw", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	test("returns the consolidated file keyed by name, with upstream freshness", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async (): Promise<Response> =>
					new Response(HEADER, {
						headers: { "Last-Modified": "Wed, 01 Jul 2026 00:00:00 GMT" },
					}),
			),
		);
		await expect(ofacSource.fetchRaw()).resolves.toEqual({
			[CSL_FILE]: HEADER,
			[SOURCE_UPDATED_AT_KEY]: "2026-07-01T00:00:00.000Z",
		});
	});

	test("omits the trade.gov API key header when no key is configured", async () => {
		const fetchMock = vi.fn(
			async (
				_input: string | URL | Request,
				_init?: RequestInit,
			): Promise<Response> =>
				new Response(HEADER, {
					headers: { "Last-Modified": "Wed, 01 Jul 2026 00:00:00 GMT" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		vi.stubEnv("TRADE_GOV_API_KEY", "");

		await ofacSource.fetchRaw();

		const sent = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
		expect(sent.has("subscription-key")).toBe(false);
		// …but it still identifies itself.
		expect(sent.get("user-agent")).toMatch(/aml-filter/i);
	});

	test("rejects a response that cannot prove upstream freshness", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (): Promise<Response> => new Response(HEADER)),
		);
		await expect(ofacSource.fetchRaw()).rejects.toThrow(
			/omitted Last-Modified/i,
		);
	});

	test("rejects with the status on a non-OK response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async (): Promise<Response> =>
					new Response("nope", {
						status: 503,
						statusText: "Service Unavailable",
					}),
			),
		);
		// 503 is retried with real backoff pauses; fast-forward them.
		const error = await rejectionAfterBackoff(() => ofacSource.fetchRaw());
		expect(error.message).toContain("failed: 503 Service Unavailable");
	});
});

// A credential problem must READ as a credential problem. Without this an
// operator sees a bare 403 and cannot tell that a secret is what fixes it.
describe("withKeyHint", () => {
	test("tells an operator to create the secret when no key is set", () => {
		const hinted = withKeyHint(
			"OFAC SDN (via CSL) request failed: 403 ",
			false,
		);
		expect(hinted).toMatch(/TRADE_GOV_API_KEY/);
		expect(hinted).toMatch(/api\.trade\.gov\/console/);
	});

	test("says the key is stale when one IS set", () => {
		expect(withKeyHint("... 401 ...", true)).toMatch(/set but was rejected/);
	});

	test("leaves an unrelated failure untouched", () => {
		expect(withKeyHint("request timed out after 90000ms", false)).toBe(
			"request timed out after 90000ms",
		);
		// A 4030-byte payload must not be mistaken for a 403.
		expect(withKeyHint("read 4030 bytes", false)).toBe("read 4030 bytes");
	});
});

describe("ofacSource.parse", () => {
	test("a header-only file parses to an empty list", () => {
		expect(ofacSource.parse({ [CSL_FILE]: HEADER }, "v1")).toEqual([]);
	});
});
