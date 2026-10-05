/**
 * Which install-key service the UI talks to. Production uses the tab's one
 * service over the SQLite seam (`installKeys()`); tests provide their own
 * through the context.
 */

import {
	type InstallKeySource,
	type InstallKeys,
	installKeys,
} from "@amlfilter/browser";
import { createContext, useContext } from "react";

/** What the receipt badge needs: the key, and word when it changes. */
export interface KeyService extends InstallKeySource {
	onChange(listener: () => void): () => void;
}

/** What the Settings signing-key section needs on top. */
export type KeyAdmin = Pick<
	InstallKeys,
	"load" | "onChange" | "reset" | "exportEncrypted" | "importEncrypted"
>;

export const InstallKeysContext = createContext<KeyAdmin | KeyService | null>(
	null,
);

/** The key service for read-only users (the receipt badge). */
export function useKeyService(): KeyService {
	return useContext(InstallKeysContext) ?? installKeys();
}

/** The key service for the Settings section (reset, export, import). */
export function useKeyAdmin(): KeyAdmin {
	const provided = useContext(InstallKeysContext);
	if (provided !== null && "reset" in provided) {
		return provided;
	}
	return installKeys();
}
