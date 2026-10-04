import { InstallKeys } from "@amlfilter/browser";
import {
	type MemoryInstallKeySql,
	memoryInstallKeySql,
} from "@amlfilter/browser/testing";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstallKeysContext, type KeyAdmin } from "../lib/installKeysContext";
import { SigningKeySection } from "./SigningKeySection";

const PASSPHRASE = "correct horse battery staple";
// PBKDF2 at 600,000 iterations takes a second or more on a loaded runner.
const CRYPTO_WAIT = { timeout: 15_000 };

let sql: MemoryInstallKeySql;
let keys: InstallKeys;

function serviceOver(store: MemoryInstallKeySql): InstallKeys {
	return new InstallKeys({ openSql: store.open, legacy: null, channel: null });
}

function renderSection(service: KeyAdmin = keys) {
	return render(
		<InstallKeysContext.Provider value={service}>
			<SigningKeySection />
		</InstallKeysContext.Provider>,
	);
}

async function shownPublicKey(): Promise<string> {
	const shown = await screen.findByTestId("signing-public-key");
	return shown.textContent ?? "";
}

/** Capture what the export download would save. */
function captureDownloads(): Blob[] {
	const blobs: Blob[] = [];
	vi.stubGlobal("URL", {
		...URL,
		createObjectURL: (blob: Blob) => {
			blobs.push(blob);
			return "blob:test";
		},
		revokeObjectURL: () => undefined,
	});
	return blobs;
}

function type(label: string, value: string): void {
	fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(async () => {
	sql = await memoryInstallKeySql();
	keys = serviceOver(sql);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("SigningKeySection", () => {
	it("shows this browser's public key", async () => {
		renderSection();

		expect(await shownPublicKey()).toBe((await keys.load()).publicKeyHex);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("says plainly when the key will not survive the tab", async () => {
		renderSection(
			serviceOver(
				await memoryInstallKeySql({
					persistence: "memory",
					reason: "opfs-unavailable",
				}),
			),
		);

		expect(
			await screen.findByText(/lives only in this tab/),
		).toBeInTheDocument();
	});

	it("explains when the key cannot be loaded", async () => {
		const failing: KeyAdmin = {
			...keys,
			load: () => Promise.reject(new Error("in use by another tab")),
			onChange: () => () => undefined,
			reset: () => keys.reset(),
			exportEncrypted: (p) => keys.exportEncrypted(p),
			importEncrypted: (t, p) => keys.importEncrypted(t, p),
		};

		renderSection(failing);

		expect(
			await screen.findByText(/in use by another tab/),
		).toBeInTheDocument();
	});
});

describe("resetting the key", () => {
	it("warns that past receipts then need the exported public key, and only resets on confirm", async () => {
		renderSection();
		const before = await shownPublicKey();

		fireEvent.click(screen.getByRole("button", { name: "Reset signing key…" }));

		expect(
			screen.getByText(
				/can then only be verified with the public key you exported/,
			),
		).toBeInTheDocument();
		expect((await keys.load()).publicKeyHex).toBe(before);

		fireEvent.click(
			screen.getByRole("button", { name: "Delete the key and make a new one" }),
		);

		await screen.findByText(/Signing key reset/);
		const after = await shownPublicKey();
		expect(after).not.toBe(before);
		expect((await keys.load()).publicKeyHex).toBe(after);
	});

	it("does nothing when the warning is cancelled", async () => {
		renderSection();
		const before = await shownPublicKey();

		fireEvent.click(screen.getByRole("button", { name: "Reset signing key…" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(screen.queryByText(/can then only be verified/)).toBeNull();
		expect((await keys.load()).publicKeyHex).toBe(before);
	});
});

describe("exporting the key", { timeout: 30_000 }, () => {
	it("downloads an encrypted file another browser can import", async () => {
		const blobs = captureDownloads();
		renderSection();
		const publicKey = await shownPublicKey();

		type("Passphrase", PASSPHRASE);
		type("Repeat passphrase", PASSPHRASE);
		fireEvent.click(
			screen.getByRole("button", { name: "Export encrypted key" }),
		);

		await screen.findByText("Key exported.", undefined, CRYPTO_WAIT);
		const text = await blobs[0]?.text();
		expect(text).toBeDefined();
		expect(text).not.toContain((await keys.load()).seedHex);
		const other = serviceOver(await memoryInstallKeySql());
		const imported = await other.importEncrypted(text ?? "", PASSPHRASE);
		expect(imported.publicKeyHex).toBe(publicKey);
	});

	it("refuses mismatched passphrases", async () => {
		const blobs = captureDownloads();
		renderSection();
		await shownPublicKey();

		type("Passphrase", PASSPHRASE);
		type("Repeat passphrase", `${PASSPHRASE}!`);
		fireEvent.click(
			screen.getByRole("button", { name: "Export encrypted key" }),
		);

		expect(
			await screen.findByText("The two passphrases don't match."),
		).toBeInTheDocument();
		expect(blobs).toHaveLength(0);
	});

	it("refuses a short passphrase", async () => {
		captureDownloads();
		renderSection();
		await shownPublicKey();

		type("Passphrase", "short");
		type("Repeat passphrase", "short");
		fireEvent.click(
			screen.getByRole("button", { name: "Export encrypted key" }),
		);

		expect(
			await screen.findByText("Use at least 12 characters."),
		).toBeInTheDocument();
	});
});

describe("importing a key", { timeout: 30_000 }, () => {
	async function exportFile(): Promise<{ file: File; publicKey: string }> {
		const source = serviceOver(await memoryInstallKeySql());
		const text = await source.exportEncrypted(PASSPHRASE);
		return {
			file: new File([text], "key.json", { type: "application/json" }),
			publicKey: (await source.load()).publicKeyHex,
		};
	}

	it("replaces this browser's key with the file's", async () => {
		const { file, publicKey } = await exportFile();
		renderSection();
		await shownPublicKey();

		fireEvent.change(screen.getByLabelText("Key file"), {
			target: { files: [file] },
		});
		type("Import passphrase", PASSPHRASE);
		fireEvent.click(screen.getByRole("button", { name: "Import key" }));

		await screen.findByText(/Key imported/, undefined, CRYPTO_WAIT);
		expect(await shownPublicKey()).toBe(publicKey);
		expect((await keys.load()).publicKeyHex).toBe(publicKey);
	});

	it("changes nothing on a wrong passphrase", async () => {
		const { file } = await exportFile();
		renderSection();
		const before = await shownPublicKey();

		fireEvent.change(screen.getByLabelText("Key file"), {
			target: { files: [file] },
		});
		type("Import passphrase", "the wrong passphrase");
		fireEvent.click(screen.getByRole("button", { name: "Import key" }));

		expect(
			await screen.findByText(
				/Wrong passphrase, or the file was changed/,
				undefined,
				CRYPTO_WAIT,
			),
		).toBeInTheDocument();
		expect((await keys.load()).publicKeyHex).toBe(before);
	});

	it("rejects a file that is not a key file", async () => {
		renderSection();
		await shownPublicKey();

		fireEvent.change(screen.getByLabelText("Key file"), {
			target: { files: [new File(["hello"], "notes.txt")] },
		});
		type("Import passphrase", PASSPHRASE);
		fireEvent.click(screen.getByRole("button", { name: "Import key" }));

		expect(
			await screen.findByText(/not a signing-key file/),
		).toBeInTheDocument();
	});

	it("asks for a file first", async () => {
		renderSection();
		await shownPublicKey();

		fireEvent.click(screen.getByRole("button", { name: "Import key" }));

		expect(
			await screen.findByText("Choose a key file first."),
		).toBeInTheDocument();
	});

	it("updates when another tab changes the key", async () => {
		renderSection();
		const before = await shownPublicKey();

		await keys.reset();

		await waitFor(async () => {
			expect(await shownPublicKey()).not.toBe(before);
		});
	});
});
