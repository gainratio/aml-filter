import { DeviceUnsupportedError } from "@amlfilter/browser";
import {
	type Catalog,
	defineErrors,
	httpStatusOf,
	starterPack,
	type TFunction,
} from "@gainratio/errors";
import i18n from "../i18n";

/**
 * How a raw failure's searchable message is derived — the thrown `Error`'s
 * `.message`, or the stringified value for a non-Error. Kept identical to the
 * pre-@gainratio/errors boot logic so classification stays byte-for-byte
 * unchanged.
 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * A raw failure's `.name`, but only when it is a real `Error` (a plain object
 * carrying `{ name }` deliberately does NOT count — matching the app's typed
 * boot-error guards). Classification is duck-typed on `.name` so it survives the
 * `@amlfilter/browser` Worker/module boundary without `instanceof` coupling.
 */
function nameOf(error: unknown): string {
	return error instanceof Error ? error.name : "";
}

function engineCodeOf(error: unknown): string {
	if (
		error instanceof Error &&
		error.name === "EngineOperationError" &&
		"code" in error &&
		typeof error.code === "string"
	) {
		return error.code;
	}
	return "";
}

const TIMEOUT_TEXT = /timeout|timed out/i;
const NETWORK_TEXT =
	/failed to fetch|load failed|network ?error|network unreachable|unreachable/i;
const MEMORY_TEXT =
	/out of memory|memory\.grow|wasm(?:assembly)?\s+memory|allocation failed/i;

/**
 * Every fail-closed verdict from the bundle-verification path, by `.name`.
 *
 * These are the failures that mean "these bytes could not be trusted", and they
 * all deserve the same user-facing answer — "Screening list verification
 * failed" — not the generic engine-unavailable fallback.
 *
 * `SignatureError` is the one this set was written for. It is the product's
 * central security claim (a bundle whose ed25519 signature does not verify is
 * refused), and it was NOT matched by any branch: a live signature failure fell
 * all the way through to `internal.unknown` and told the visitor to "Close
 * another AML-Filter tab". Two independent defects produced that — the Worker
 * boundary dropped the error's type (see workerErrorEnvelope.ts), and even with the
 * type intact nothing here claimed it.
 *
 * Deliberately NOT in this set: `StoreLockTimeoutError` /
 * `StoreLockUnsupportedError`, which really are "another tab holds the store" —
 * the engine-unavailable fallback is the correct copy for those, and the
 * boundary tests pin that it stays reachable.
 */
const VERIFICATION_FAILURES: ReadonlySet<string> = new Set([
	// ed25519 detached-signature verify failed, or the signature was absent/malformed.
	"SignatureError",
	// A stored object failed its content-address (sha256(plaintext) == name) check.
	"IntegrityError",
	// A signature-valid pointer tried to move the active version BACKWARDS.
	"RollbackError",
	// Fail-closed decode bounds: a chunk declared or expanded past its envelope.
	"DecompressionLimitError",
	"UndeclaredSizeError",
	// A response exceeded the authenticated bundle transport envelope. Unlike an
	// unreachable origin this must never fall back to stale cached data.
	"FetchLimitError",
]);

/**
 * AML-Filter's bundle-load error catalog, expressed in the shared
 * `@gainratio/errors` vocabulary (the portfolio canonical-errors standard,
 * installed from npm). Each code is REUSED from the library's
 * `starterPack`; on top of the starter data we attach the exact detection the
 * app already uses — its typed boot errors (`DeviceUnsupportedError`,
 * `QuotaError`, `IntegrityError`, the transport `NetworkError`) — so
 * `bundleErrorRegistry.classify()` reproduces the app's previous branch logic
 * byte-for-byte.
 *
 * Registration ORDER is the precedence — `classify` returns the first code whose
 * `match` fires — so it mirrors the app's fail-closed model: the specific typed
 * failures first (device / quota / integrity), then the transport signals
 * (timeout before a bare unreachable before a bad-status download), then
 * `internal.unknown` as the last resort.
 *
 * `bundle.device_unsupported` overrides its i18n key to the app's existing
 * `errors:device.unsupported` string, so `describe()` renders the exact copy the
 * unsupported-device screen already showed.
 */
const BUNDLE_ERROR_CATALOG = {
	"bundle.device_unsupported": {
		...starterPack["bundle.device_unsupported"],
		i18nKey: "errors:device.unsupported",
		match: (raw: unknown) => nameOf(raw) === "DeviceUnsupportedError",
	},
	"bundle.quota_exceeded": {
		...starterPack["bundle.quota_exceeded"],
		match: (raw: unknown) =>
			engineCodeOf(raw) === "storage" || nameOf(raw) === "QuotaError",
	},
	"bundle.integrity_failed": {
		...starterPack["bundle.integrity_failed"],
		match: (raw: unknown) =>
			engineCodeOf(raw) === "integrity" ||
			engineCodeOf(raw) === "rollback" ||
			VERIFICATION_FAILURES.has(nameOf(raw)),
	},
	"bundle.timeout": {
		...starterPack["bundle.timeout"],
		match: (raw: unknown) => {
			const name = nameOf(raw);
			return (
				name === "AbortError" ||
				name === "TimeoutError" ||
				TIMEOUT_TEXT.test(messageOf(raw))
			);
		},
	},
	"net.unreachable": {
		...starterPack["net.unreachable"],
		match: (raw: unknown) =>
			httpStatusOf(raw) === undefined && NETWORK_TEXT.test(messageOf(raw)),
	},
	"bundle.download_failed": {
		...starterPack["bundle.download_failed"],
		match: (raw: unknown) =>
			engineCodeOf(raw) === "network" || nameOf(raw) === "NetworkError",
	},
	"internal.unknown": starterPack["internal.unknown"],
} satisfies Catalog;

/**
 * The AML-Filter bundle-load error registry — the single place a raw cold-boot
 * failure is classified into a canonical `@gainratio/errors` code, built with the
 * shared library. Exported so the classification is inspectable and testable as
 * the library's own `Registry` (and so a server surface can later reuse the same
 * codes for RFC 9457 Problem Details without re-deriving them).
 */
export const bundleErrorRegistry = defineErrors(BUNDLE_ERROR_CATALOG);

/** The distinct ways loading the screening bundle can fail. Kept as the public
 * type at the boot call sites so this adoption is a zero-churn internal swap. */
export type BundleErrorKind =
	| "device_unsupported"
	| "quota_exceeded"
	| "integrity_failed"
	| "lock"
	| "timeout"
	| "network"
	| "download_failed"
	| "memory_exhausted"
	| "unknown";

/**
 * Map a canonical `@gainratio/errors` code back to the local `BundleErrorKind` the
 * boot path switches on. Keeping `BundleErrorKind` as the public shape means the
 * registry replaces the classification without touching how the UI branches.
 */
const CODE_TO_KIND: Readonly<Record<string, BundleErrorKind>> = {
	"bundle.device_unsupported": "device_unsupported",
	"bundle.quota_exceeded": "quota_exceeded",
	"bundle.integrity_failed": "integrity_failed",
	"bundle.timeout": "timeout",
	"net.unreachable": "network",
	"bundle.download_failed": "download_failed",
	"internal.unknown": "unknown",
};

/**
 * Classify a caught cold-boot failure into one bundle-error kind via the shared
 * `@gainratio/errors` registry (`bundleErrorRegistry`) — the same coded behavior
 * as the app's previous typed-error branches, now expressed in the portfolio's
 * canonical-errors vocabulary — then map the canonical code back to the local
 * `BundleErrorKind`.
 */
export function classifyBundleError(error: unknown): BundleErrorKind {
	if (MEMORY_TEXT.test(messageOf(error))) {
		return "memory_exhausted";
	}
	if (engineCodeOf(error) === "lock") {
		return "lock";
	}
	return CODE_TO_KIND[bundleErrorRegistry.classify(error)] ?? "unknown";
}

/** i18next adapter passed to the registry's `describe()`, so a canonical code
 * resolves through the app's offline `errors` catalog (localized), falling back
 * to the library's default English when a key is absent. */
const translate: TFunction = (key, params) => i18n.t(key, params ?? {});

/**
 * The /screen unsupported-device string. Shown when the up-front capability
 * preflight (engineSupport) finds this browser can't run the local engine —
 * an older iOS Safari / locked-down WebView missing durable storage, module Workers, Web
 * Locks, or synchronous file access. This is a graceful dead-end, not a hang: no Retry,
 * because retrying can't add a missing browser capability. Names the missing
 * features when known so a technical visitor can see why.
 *
 * The base sentence is resolved through the shared `@gainratio/errors` registry
 * (the canonical `bundle.device_unsupported` code, whose i18n key is this app's
 * existing `errors:device.unsupported`) — same rendered bytes, now behind a
 * portfolio-standard code.
 */
export function deviceUnsupportedMessage(
	missing: ReadonlyArray<string>,
): string {
	const base = bundleErrorRegistry.describe(
		"bundle.device_unsupported",
		{},
		translate,
	);
	if (missing.length === 0) {
		return base;
	}
	return i18n.t("errors:device.missingSuffix", {
		base,
		missing: missing.join(", "),
	});
}

/**
 * The user-facing /screen boot-failure string. The watchlist now loads
 * same-origin (no separate bundle origin to name), so this surfaces only the
 * underlying cause — a fail-closed signature/format failure or a stalled model:
 *
 *   "Could not load the screening bundle: signature verification failed"
 *
 * Keeps the "could not load the screening bundle" substring the C1 cold-boot
 * alert assertion (screen-cold-blocked.spec.ts) matches.
 *
 * The caught failure is classified through the shared `@gainratio/errors` registry
 * (`classifyBundleError`) so each cause carries a stable canonical code. Every
 * reachable retryable cause — a failed download, a timed-out or unreachable
 * fetch, a storage-quota refusal, or a fail-closed integrity/signature error —
 * still surfaces through the ONE "could not load" wrapper (the specific cause
 * rides in `{detail}`), so no user-visible copy moved. A device-capability
 * failure that reaches here (normally caught up-front by the preflight) shows the
 * same dead-end copy the unsupported-device screen uses, since no Retry can add a
 * missing capability.
 */
export function bootErrorMessage(error: unknown): string {
	if (classifyBundleError(error) === "device_unsupported") {
		return deviceUnsupportedMessage(
			error instanceof DeviceUnsupportedError ? error.missing : [],
		);
	}
	const detail = messageOf(error);
	return i18n.t("errors:boot.couldNotLoad", { detail });
}

/** Which in-app recovery a boot failure gets: `rollback` (the served pointer is
 * older than the one this device already trusts — warn before clearing),
 * `integrity` (any other fail-closed verification verdict), or none. */
export type BundleCacheRecovery = "rollback" | "integrity";

/**
 * Whether clearing the cached lists is a sensible way out of this boot failure.
 *
 * Only the fail-closed verification verdicts qualify. Since edgeproc-browser #13
 * the stored pointer stays the anti-rollback floor even across a key change, so a
 * returning visitor whose floor refuses the served pointer is stuck until the
 * cache is cleared; without an in-app path, the error card is a dead end.
 *
 * Classified from the LIVE error (the Worker's `EngineOperationError.code`, or the
 * in-process error's `.name`) — never from a flattened message string, which
 * cannot be told apart from attacker-influenced text.
 */
export function bundleCacheRecovery(
	error: unknown,
): BundleCacheRecovery | null {
	if (engineCodeOf(error) === "rollback" || nameOf(error) === "RollbackError") {
		return "rollback";
	}
	if (
		engineCodeOf(error) === "integrity" ||
		VERIFICATION_FAILURES.has(nameOf(error))
	) {
		return "integrity";
	}
	return null;
}

export interface UserFacingBootError {
	readonly title: string;
	readonly recovery: string;
	readonly technicalDetail: string;
}

/** Keep implementation details available to an operator without making them
 * the first thing a customer sees when a browser/WASM boot fails. */
export function userFacingBootError(error: unknown): UserFacingBootError {
	const kind = classifyBundleError(error);
	const technicalDetail = messageOf(error);
	if (kind === "quota_exceeded") {
		return {
			title: "Device storage is full",
			recovery: "Clear cached lists in Settings, then try again.",
			technicalDetail,
		};
	}
	if (kind === "device_unsupported") {
		return {
			title: "This browser cannot run the local engine",
			recovery: "Open AML-Filter in a recent Safari, Chrome, Edge, or Firefox.",
			technicalDetail,
		};
	}
	if (
		kind === "integrity_failed" &&
		bundleCacheRecovery(error) === "rollback"
	) {
		return {
			title: "Screening list verification failed",
			recovery:
				"Retrying will not fix this: this device already holds a newer signed version of the lists.",
			technicalDetail,
		};
	}
	if (kind === "integrity_failed") {
		return {
			title: "Screening list verification failed",
			recovery:
				"Retry once. If it persists, reload AML-Filter before continuing.",
			technicalDetail,
		};
	}
	if (kind === "timeout" || kind === "network" || kind === "download_failed") {
		return {
			title: "Screening list could not be loaded",
			recovery: "Check your connection, then retry the local download.",
			technicalDetail,
		};
	}
	if (kind === "memory_exhausted") {
		return {
			title: "Browser memory limit reached",
			recovery:
				"Close other tabs, reload AML-Filter, and retry. On mobile, keep one screening tab open.",
			technicalDetail,
		};
	}
	return {
		title: "Local screening engine unavailable",
		recovery: "Close another AML-Filter tab, then retry.",
		technicalDetail,
	};
}

export interface UserFacingStorageError {
	readonly title: string;
	readonly recovery: string;
	readonly technicalDetail: string;
}

export function userFacingStorageError(error: unknown): UserFacingStorageError {
	const technicalDetail = messageOf(error);
	const memoryOrLockIssue =
		/out of memory|sqlite|opfs|local kyc|database/i.test(technicalDetail);
	return {
		title: memoryOrLockIssue
			? "Local workspace unavailable"
			: "Could not open the local workspace",
		recovery: memoryOrLockIssue
			? "Close another AML-Filter tab, then retry."
			: "Reload AML-Filter and retry before continuing.",
		technicalDetail,
	};
}
