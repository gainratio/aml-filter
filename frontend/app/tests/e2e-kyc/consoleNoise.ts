/**
 * Which console errors the KYC journey may ignore. Kept free of Playwright so a
 * Vitest contract can pin it (src/__tests__/kycConsoleNoise.contract.test.ts).
 *
 * After a reload, the new document's @gainratio/browser vector worker can try to
 * open its opfs-sahpool before the previous document's worker has released the
 * access handles. The worker retries that contention (up to 8 attempts) and opens
 * the index, but sqlite-wasm logs each failed attempt through `printErr`, which
 * the worker routes to console.error. Those two lines are excused for an
 * `edgeproc-vector-<32 hex>` pool only; the journey separately asserts the
 * in-memory fallback notice never appeared, so a pool that really failed to open
 * still fails the test. The real fix (don't log retried contention) belongs in
 * @gainratio/browser.
 */

const POOL = "edgeproc-vector-[0-9a-f]{32}";

const RECOVERED_POOL_CONTENTION: ReadonlyArray<RegExp> = [
	new RegExp(
		`^${POOL}: NoModificationAllowedError: Failed to execute 'createSyncAccessHandle' on 'FileSystemFileHandle': Access Handles cannot be created if there is another open Access Handle or Writable stream associated with the same file\\.$`,
	),
	new RegExp(
		`^${POOL} removeVfs\\(\\) failed with no recovery strategy: NoModificationAllowedError: Failed to execute 'removeEntry' on 'FileSystemDirectoryHandle': An attempt was made to modify an object where modifications are not allowed\\.$`,
	),
];

/** True only for the vector pool's retried-contention log lines. */
export function isRecoveredPoolContention(text: string): boolean {
	return RECOVERED_POOL_CONTENTION.some((pattern) => pattern.test(text));
}
