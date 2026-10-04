/**
 * The composite stamp of the watchlists the engine has loaded right now — the
 * value a customer's screening proof must equal before the row may say "No
 * matches". Null until the engine has booted; the hook waits for that boot
 * (shared and memoized with the workstation gate) and then reads it.
 */
import { useCallback, useEffect, useState } from "react";
import { workstation } from "./workstation";

export interface LoadedListVersion {
	/** The loaded lists' stamp; null while they are still loading. */
	readonly version: string | null;
	/** The engine failed to boot, so no customer can be proven screened. */
	readonly failed: boolean;
	/** Re-read the stamp (after a reload, a list change, or a re-screen). */
	readonly refresh: () => Promise<void>;
}

export function useLoadedListVersion(): LoadedListVersion {
	const [version, setVersion] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);

	const refresh = useCallback(async () => {
		try {
			setVersion((await workstation()).watchlistVersion());
		} catch {
			setFailed(true);
		}
	}, []);

	useEffect(() => {
		let alive = true;
		workstation()
			.then(async (handle) => {
				if (alive) setVersion(handle.watchlistVersion());
				await handle.engineBoot();
				if (alive) setVersion(handle.watchlistVersion());
			})
			.catch(() => {
				if (alive) setFailed(true);
			});
		return () => {
			alive = false;
		};
	}, []);

	return { version, failed, refresh };
}
