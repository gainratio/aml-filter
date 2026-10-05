import { describe, expect, it } from "vitest";
import { isRecoveredPoolContention } from "../../tests/e2e-kyc/consoleNoise";

// The KYC journey fails on any console error. On origin/main it failed 3 of 10
// local repeats (and once in the release gate) with ONLY these two lines, logged
// by sqlite-wasm's opfs-sahpool through @gainratio/browser's vector worker
// (`printErr: console.error`) while `acquirePersistentPool` retries pool
// contention after a reload: the previous document's worker still holds the
// access handles until it dies. The worker retries up to 8 times and opens the
// index; the journey separately asserts the in-memory fallback never showed.
//
// Contract: excuse exactly those two lines for an `edgeproc-vector-<32 hex>`
// pool. Any other pool, wording, or failure (including the worker's final
// "could not open the local vector database") still fails the journey.

const POOL = "edgeproc-vector-2cfceeb45a06475e4bb016a541d7fac6";
const ACQUIRE = `${POOL}: NoModificationAllowedError: Failed to execute 'createSyncAccessHandle' on 'FileSystemFileHandle': Access Handles cannot be created if there is another open Access Handle or Writable stream associated with the same file.`;
const REMOVE_VFS = `${POOL} removeVfs() failed with no recovery strategy: NoModificationAllowedError: Failed to execute 'removeEntry' on 'FileSystemDirectoryHandle': An attempt was made to modify an object where modifications are not allowed.`;

describe("KYC journey console noise", () => {
	it("excuses the two vector-pool contention lines logged during a retried open", () => {
		expect(isRecoveredPoolContention(ACQUIRE)).toBe(true);
		expect(isRecoveredPoolContention(REMOVE_VFS)).toBe(true);
	});

	it("does not excuse the same lines for another pool or a bad pool id", () => {
		expect(
			isRecoveredPoolContention(ACQUIRE.replace("edgeproc-vector", "kyc-db")),
		).toBe(false);
		expect(
			isRecoveredPoolContention(ACQUIRE.replace(POOL, "edgeproc-vector-xyz")),
		).toBe(false);
	});

	it("does not excuse a final open failure or any other wording", () => {
		expect(
			isRecoveredPoolContention(
				"could not open the local vector database — this index may already be open in another tab (NoModificationAllowedError)",
			),
		).toBe(false);
		expect(
			isRecoveredPoolContention(
				`${POOL}: NoModificationAllowedError: something else entirely`,
			),
		).toBe(false);
		expect(isRecoveredPoolContention(`prefix ${ACQUIRE}`)).toBe(false);
		expect(isRecoveredPoolContention(`${ACQUIRE} trailing`)).toBe(false);
	});
});
