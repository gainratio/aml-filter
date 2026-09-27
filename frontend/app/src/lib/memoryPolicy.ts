/**
 * Browser memory policy for the workstation engine.
 *
 * The signed catalog can contain several large vector matrices. Keeping every
 * matrix resident while the ONNX/WASM model is compiled exceeds mobile Safari's
 * tab budget. Mobile-capable browsers therefore use the engine's bounded
 * streaming residency. Eager residency is reserved for desktops that explicitly
 * report a high memory budget; an unknown budget is never permission to allocate
 * every list.
 * The policy is conservative and only changes residency, never the persisted
 * watchlist selection or scoring thresholds.
 */

export type EngineResidency = "eager" | "streaming";

export interface BrowserMemorySignals {
	readonly userAgent: string;
	readonly deviceMemory?: number;
	readonly maxTouchPoints?: number;
}

/** A device-memory value at or below this budget uses one-list-at-a-time loads. */
export const STREAMING_DEVICE_MEMORY_GB = 8;

/** Read only the browser signals needed by the deterministic policy. */
export function browserMemorySignals(): BrowserMemorySignals {
	if (typeof navigator === "undefined") {
		return { userAgent: "" };
	}
	const candidate = navigator as Navigator & { readonly deviceMemory?: number };
	return {
		userAgent: navigator.userAgent,
		...(candidate.deviceMemory !== undefined
			? { deviceMemory: candidate.deviceMemory }
			: {}),
		maxTouchPoints: navigator.maxTouchPoints,
	};
}

/**
 * A phone or tablet browser. iPadOS desktop-mode Safari identifies itself as
 * Macintosh, so touch points are part of the check. Memory is deliberately NOT a
 * signal here: Chrome caps `navigator.deviceMemory` at 8, so it cannot tell a
 * big desktop from a small one.
 */
export function isMobileBrowser(
	signals: BrowserMemorySignals = browserMemorySignals(),
): boolean {
	const ua = signals.userAgent;
	const mobileUserAgent = /Android|iPhone|iPod|Mobile/i.test(ua);
	const ipadDesktopMode =
		/Macintosh/i.test(ua) && (signals.maxTouchPoints ?? 0) > 1;
	return mobileUserAgent || ipadDesktopMode;
}

/**
 * Select bounded residency for mobile-capable or explicitly low-memory browsers.
 * iPadOS desktop-mode Safari identifies itself as Macintosh, so touch points are
 * part of the check. Unknown desktop environments stream conservatively because
 * the browser has not established a safe budget for eager vector residency.
 */
export function residencyForBrowser(
	signals: BrowserMemorySignals = browserMemorySignals(),
): EngineResidency {
	const memory = signals.deviceMemory;
	const lowMemory =
		memory !== undefined &&
		Number.isFinite(memory) &&
		memory > 0 &&
		memory <= STREAMING_DEVICE_MEMORY_GB;
	const highMemoryDesktop =
		memory !== undefined &&
		Number.isFinite(memory) &&
		memory > STREAMING_DEVICE_MEMORY_GB;
	return isMobileBrowser(signals) || lowMemory || !highMemoryDesktop
		? "streaming"
		: "eager";
}
