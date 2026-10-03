import {
	DeviceUnsupportedError,
	EngineOperationError,
	QuotaError,
} from "@amlfilter/browser";
import { IntegrityError } from "@amlfilter/browser/engine";
import { starterPack } from "@gainratio/errors";
import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import {
	type BundleErrorKind,
	bootErrorMessage,
	bundleCacheRecovery,
	bundleErrorRegistry,
	classifyBundleError,
	deviceUnsupportedMessage,
	userFacingBootError,
} from "./bootErrorMessage";

/** A raw failure carrying a specific `.name` (e.g. the transport `NetworkError`),
 * without importing every internal error class — classification is duck-typed on
 * `.name`, exactly like the app's own typed-error guards. */
function named(name: string, message: string): Error {
	const error = new Error(message);
	error.name = name;
	return error;
}

describe("bootErrorMessage", () => {
	it("keeps technical causes out of the primary error copy", () => {
		const result = userFacingBootError(
			new Error("RangeError: WebAssembly.Memory.grow: out of memory"),
		);

		expect(result.title).toBe("Browser memory limit reached");
		expect(result.recovery).toMatch(/close other tabs/i);
		expect(result.recovery).toMatch(/reload/i);
		expect(result.technicalDetail).toContain("WebAssembly.Memory.grow");
	});

	it("keeps unrelated unknown failures on the generic recovery path", () => {
		const result = userFacingBootError(new Error("unexpected worker failure"));

		expect(result.title).toBe("Local screening engine unavailable");
		expect(result.recovery).toMatch(/close another AML-Filter tab/i);
		expect(classifyBundleError(new Error("unexpected worker failure"))).toBe(
			"unknown",
		);
	});

	it("classifies WebAssembly allocation failures as memory exhaustion", () => {
		expect(
			classifyBundleError(
				new RangeError("WebAssembly.Memory.grow(): Out of memory"),
			),
		).toBe("memory_exhausted");
	});

	it("surfaces the underlying fail-closed cause", () => {
		const msg = bootErrorMessage(new Error("signature verification failed"));
		expect(msg).toBe(
			"Could not load the screening bundle: signature verification failed",
		);
	});

	it("keeps the substring the C1 alert assertion matches", () => {
		const msg = bootErrorMessage(new Error("boom"));
		expect(msg.toLowerCase()).toContain("could not load the screening bundle");
	});

	it("coerces a non-Error rejection to a string detail", () => {
		const msg = bootErrorMessage("raw string failure");
		expect(msg).toBe("Could not load the screening bundle: raw string failure");
	});
});

describe("deviceUnsupportedMessage", () => {
	it("tells the visitor to use a recent desktop browser", () => {
		const msg = deviceUnsupportedMessage([]);
		expect(msg.toLowerCase()).toContain("can’t run the local engine");
		expect(msg.toLowerCase()).toContain("desktop browser");
	});

	it("names the missing capabilities when any are supplied", () => {
		const msg = deviceUnsupportedMessage(["Web Workers", "OPFS"]);
		expect(msg).toContain("Web Workers");
		expect(msg).toContain("OPFS");
	});

	it("omits the missing-features clause when none are named", () => {
		const msg = deviceUnsupportedMessage([]);
		expect(msg.toLowerCase()).not.toContain("missing:");
	});
});

describe("@gainratio/errors adoption (canonical-errors standard)", () => {
	// The bundle-load error path now classifies raw boot failures through the
	// PUBLISHED @gainratio/errors registry (the npm package) instead of an
	// ad-hoc if-chain. These tests prove two things: (1) the published library is
	// really what does the work — `bundleErrorRegistry` is a genuine
	// @gainratio/errors Registry built from its `starterPack` codes; and (2) the
	// coded classification is BEHAVIOR-IDENTICAL — each failure still renders the
	// exact same existing `errors:*` string, so no user-visible copy or i18n key
	// moved.

	it("exposes a genuine @gainratio/errors Registry built from the published starterPack", () => {
		for (const method of [
			"has",
			"get",
			"classify",
			"describe",
			"toProblemDetails",
			"create",
		] as const) {
			expect(typeof bundleErrorRegistry[method]).toBe("function");
		}
		// The bundle codes are REUSED from the library's starterPack, not
		// re-declared: the registered entry carries the starter data verbatim.
		expect(bundleErrorRegistry.get("bundle.quota_exceeded")?.category).toBe(
			starterPack["bundle.quota_exceeded"].category,
		);
		expect(bundleErrorRegistry.get("net.unreachable")?.category).toBe(
			starterPack["net.unreachable"].category,
		);
		expect(bundleErrorRegistry.codes).toContain("internal.unknown");
	});

	it("classifies each typed boot failure into its canonical starterPack code", () => {
		expect(
			bundleErrorRegistry.classify(new DeviceUnsupportedError(["Web Workers"])),
		).toBe("bundle.device_unsupported");
		expect(bundleErrorRegistry.classify(new QuotaError("no room"))).toBe(
			"bundle.quota_exceeded",
		);
		expect(
			bundleErrorRegistry.classify(
				new EngineOperationError({ code: "storage", message: "no room" }),
			),
		).toBe("bundle.quota_exceeded");
		expect(
			bundleErrorRegistry.classify(
				new IntegrityError("chunk abc failed content-address check"),
			),
		).toBe("bundle.integrity_failed");
		expect(
			bundleErrorRegistry.classify(
				new EngineOperationError({
					code: "integrity",
					message: "chunk abc failed content-address check",
				}),
			),
		).toBe("bundle.integrity_failed");
		expect(
			bundleErrorRegistry.classify(
				named("AbortError", "the operation was aborted"),
			),
		).toBe("bundle.timeout");
		expect(
			bundleErrorRegistry.classify(
				named("NetworkError", "fetch /x failed: timed out after 15000ms"),
			),
		).toBe("bundle.timeout");
		expect(
			bundleErrorRegistry.classify(
				named("NetworkError", "fetch /x failed: network unreachable"),
			),
		).toBe("net.unreachable");
		expect(
			bundleErrorRegistry.classify(
				named("NetworkError", "fetch /x failed: 404 Not Found"),
			),
		).toBe("bundle.download_failed");
		expect(
			bundleErrorRegistry.classify(new Error("signature verification failed")),
		).toBe("internal.unknown");
	});

	it("maps each canonical code to the public BundleErrorKind", () => {
		const cases: ReadonlyArray<readonly [unknown, BundleErrorKind]> = [
			[new DeviceUnsupportedError([]), "device_unsupported"],
			[new QuotaError("no room"), "quota_exceeded"],
			[
				new IntegrityError("chunk abc failed content-address check"),
				"integrity_failed",
			],
			[named("TimeoutError", "timed out"), "timeout"],
			[
				named("NetworkError", "fetch /x failed: network unreachable"),
				"network",
			],
			[
				named("NetworkError", "fetch /x failed: 500 Server Error"),
				"download_failed",
			],
			[new Error("signature verification failed"), "unknown"],
		];
		for (const [raw, kind] of cases) {
			expect(classifyBundleError(raw)).toBe(kind);
		}
	});

	it("renders the SAME 'could not load' wrapper for every retryable boot cause (behavior-identical)", () => {
		// Quota, integrity, and transport failures all still surface through the one
		// wrapper — the specific cause rides in {detail}, exactly as before the
		// registry was introduced.
		expect(bootErrorMessage(new QuotaError("Not enough free storage"))).toBe(
			"Could not load the screening bundle: Not enough free storage",
		);
		expect(
			bootErrorMessage(
				new IntegrityError("chunk abc failed content-address check"),
			),
		).toBe(
			"Could not load the screening bundle: chunk abc failed content-address check",
		);
		expect(
			bootErrorMessage(
				named("NetworkError", "fetch /x failed: timed out after 15000ms"),
			),
		).toBe(
			"Could not load the screening bundle: fetch /x failed: timed out after 15000ms",
		);
	});

	it("routes a device-capability failure to the unsupported-device copy, not the wrapper", () => {
		const typed = new DeviceUnsupportedError(["Web Workers"]);
		expect(bootErrorMessage(typed)).toBe(
			deviceUnsupportedMessage(["Web Workers"]),
		);
		expect(bootErrorMessage(typed)).not.toContain("Could not load");
		// A duck-typed device failure (name set, not a real instance) still routes to
		// the dead-end copy, with no missing-capability clause it can't read.
		expect(bootErrorMessage(named("DeviceUnsupportedError", "x"))).toBe(
			deviceUnsupportedMessage([]),
		);
	});

	it("resolves the unsupported-device base copy through the registry's describe()", () => {
		// The base sentence is the app's existing errors:device.unsupported string,
		// now rendered via the vendored registry (bundle.device_unsupported) — same
		// bytes, so behavior is identical.
		expect(deviceUnsupportedMessage([])).toBe(
			i18n.t("errors:device.unsupported"),
		);
		expect(
			bundleErrorRegistry.describe(
				"bundle.device_unsupported",
				{},
				(key, params) => i18n.t(key, params ?? {}),
			),
		).toBe(i18n.t("errors:device.unsupported"));
	});

	it("serializes a canonical code to an RFC 9457 Problem Details shape", () => {
		const problem = bundleErrorRegistry.toProblemDetails(
			"bundle.quota_exceeded",
			{
				requiredBytes: 10,
				availableBytes: 2,
			},
		);
		expect(problem.type).toBe("bundle.quota_exceeded");
		expect(typeof problem.title).toBe("string");
		expect(problem.requiredBytes).toBe(10);
		expect(problem.availableBytes).toBe(2);
	});

	it("keeps only own string / finite-number params on the Problem Details wire (@gainratio/errors >= 0.1.2)", () => {
		// 0.1.2 filters extension members: objects, booleans, null and non-finite
		// numbers are outside the ParamValue contract and never reach the wire, and
		// toJSON / __proto__ / constructor / prototype can never be member names.
		// No app caller passes such values today; this pins the upgraded boundary so
		// a future caller cannot smuggle structure into a serialized problem.
		const hostile = JSON.parse(
			'{"__proto__": "p", "constructor": "c", "prototype": "q"}',
		) as Record<string, unknown>;
		Object.assign(hostile, {
			requiredBytes: 10,
			label: "ok",
			nested: { a: 1 },
			flag: true,
			nothing: null,
			notANumber: Number.NaN,
			infinite: Number.POSITIVE_INFINITY,
			toJSON: "replace-the-body",
		});
		const problem = bundleErrorRegistry.toProblemDetails(
			"bundle.quota_exceeded",
			hostile as Record<string, string | number>,
		);
		expect(problem.requiredBytes).toBe(10);
		expect(problem.label).toBe("ok");
		for (const dropped of [
			"nested",
			"flag",
			"nothing",
			"notANumber",
			"infinite",
			"toJSON",
			"__proto__",
			"constructor",
			"prototype",
		]) {
			expect(Object.hasOwn(problem, dropped)).toBe(false);
		}
		expect(JSON.parse(JSON.stringify(problem)).type).toBe(
			"bundle.quota_exceeded",
		);
	});
});

describe("bundleCacheRecovery — which boot failures get an in-app clear", () => {
	it("flags a Worker rollback refusal as a rollback (the warn-first path)", () => {
		expect(
			bundleCacheRecovery(
				new EngineOperationError({
					code: "rollback",
					message: "refusing rollback: sequence is not fresher",
				}),
			),
		).toBe("rollback");
		expect(bundleCacheRecovery(named("RollbackError", "refusing"))).toBe(
			"rollback",
		);
	});

	it("flags every other fail-closed verification verdict as integrity", () => {
		expect(
			bundleCacheRecovery(
				new EngineOperationError({
					code: "integrity",
					message: "signature verification failed",
				}),
			),
		).toBe("integrity");
		expect(bundleCacheRecovery(named("SignatureError", "bad sig"))).toBe(
			"integrity",
		);
		expect(
			bundleCacheRecovery(new IntegrityError("chunk failed content-address")),
		).toBe("integrity");
	});

	it("tells a rollback visitor that retrying will not help", () => {
		const copy = userFacingBootError(
			new EngineOperationError({ code: "rollback", message: "refusing" }),
		);
		expect(copy.title).toBe("Screening list verification failed");
		expect(copy.recovery).toMatch(/retrying will not fix this/i);
		// A plain integrity failure keeps its retry advice.
		expect(
			userFacingBootError(
				new EngineOperationError({ code: "integrity", message: "bad sig" }),
			).recovery,
		).toMatch(/^Retry once/);
	});

	it("offers nothing for failures a cache clear cannot fix", () => {
		expect(
			bundleCacheRecovery(named("NetworkError", "network unreachable")),
		).toBeNull();
		expect(
			bundleCacheRecovery(
				new EngineOperationError({ code: "lock", message: "held" }),
			),
		).toBeNull();
		expect(bundleCacheRecovery(new QuotaError("no room"))).toBeNull();
		// A flattened string has lost its type: never guess a recovery from text.
		expect(bundleCacheRecovery("refusing rollback")).toBeNull();
	});
});
