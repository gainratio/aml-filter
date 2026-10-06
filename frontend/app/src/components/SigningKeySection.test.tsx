import {
	InstallKeyExportError,
	InstallKeyImportError,
	InstallKeys,
} from "@amlfilter/browser";
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
import goldenV1 from "../../../packages/amlfilter-browser/src/engine/__fixtures__/install-key-export-v1.golden.json?raw";
import { InstallKeysContext, type KeyAdmin } from "../lib/installKeysContext";
import { SigningKeySection } from "./SigningKeySection";

const PASSPHRASE = "correct horse battery staple";
// The previous release's v1 export (PBKDF2 + AES-GCM), written by its own code.
const GOLDEN_PASSPHRASE = "golden fixture passphrase v1";
const GOLDEN_PUBLIC_KEY =
	"5526f742941711b3bc530ba44ff6f6dab0f0ab71af832f41a7fe3b9fdaed9c60";
// scrypt (128 MiB) and PBKDF2 (600,000 iterations) take a second or more on a loaded runner.
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

/** The service, with one operation replaced. */
function withOverride(override: Partial<KeyAdmin>): KeyAdmin {
	return {
		load: () => keys.load(),
		onChange: (listener) => keys.onChange(listener),
		reset: () => keys.reset(),
		exportEncrypted: (p) => keys.exportEncrypted(p),
		importEncrypted: (f, p) => keys.importEncrypted(f, p),
		...override,
	};
}

function chooseFile(file: File): void {
	fireEvent.change(screen.getByLabelText("Key file"), {
		target: { files: [file] },
	});
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
			importEncrypted: (f, p) => keys.importEncrypted(f, p),
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
		const blob = blobs[0];
		expect(blob?.type).toBe("application/octet-stream");
		const bytes = new Uint8Array(
			(await blob?.arrayBuffer()) ?? new ArrayBuffer(0),
		);
		const text = new TextDecoder().decode(bytes);
		expect(text.startsWith("age-encryption.org/v1\n")).toBe(true);
		expect(text).not.toContain((await keys.load()).seedHex);
		const other = serviceOver(await memoryInstallKeySql());
		const imported = await other.importEncrypted(bytes, PASSPHRASE);
		expect(imported.publicKeyHex).toBe(publicKey);
	});

	it("says inline, as you type, when the passphrases don't match", async () => {
		renderSection();
		await shownPublicKey();

		type("Passphrase", PASSPHRASE);
		type("Repeat passphrase", `${PASSPHRASE}!`);

		const message = await screen.findByText("Passwords don't match.");
		expect(message).toHaveAttribute("role", "alert");
		const confirm = screen.getByLabelText("Repeat passphrase");
		expect(confirm).toHaveAttribute("aria-describedby", message.id);
		expect(confirm).toHaveAttribute("aria-invalid", "true");

		type("Repeat passphrase", PASSPHRASE);
		expect(screen.queryByText("Passwords don't match.")).toBeNull();
		expect(confirm).not.toHaveAttribute("aria-invalid", "true");
	});

	it("refuses mismatched passphrases and saves nothing", async () => {
		const blobs = captureDownloads();
		renderSection();
		await shownPublicKey();

		type("Passphrase", PASSPHRASE);
		fireEvent.click(
			screen.getByRole("button", { name: "Export encrypted key" }),
		);

		expect(
			await screen.findByText("Passwords don't match."),
		).toBeInTheDocument();
		expect(blobs).toHaveLength(0);
	});

	it("asks for a passphrase when there is none", async () => {
		const blobs = captureDownloads();
		renderSection();
		await shownPublicKey();

		fireEvent.click(
			screen.getByRole("button", { name: "Export encrypted key" }),
		);

		const message = await screen.findByText("Enter a passphrase.");
		expect(screen.getByLabelText("Passphrase")).toHaveAttribute(
			"aria-describedby",
			message.id,
		);
		expect(blobs).toHaveLength(0);
	});

	it("says plainly when the device runs out of memory", async () => {
		const blobs = captureDownloads();
		renderSection(
			withOverride({
				exportEncrypted: () =>
					Promise.reject(new InstallKeyExportError("out-of-memory", "oom")),
			}),
		);
		await shownPublicKey();

		type("Passphrase", PASSPHRASE);
		type("Repeat passphrase", PASSPHRASE);
		fireEvent.click(
			screen.getByRole("button", { name: "Export encrypted key" }),
		);

		expect(
			await screen.findByText(/ran out of memory while encrypting/),
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
		const bytes = await source.exportEncrypted(PASSPHRASE);
		return {
			file: new File([bytes], "key.age", {
				type: "application/octet-stream",
			}),
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

	it("still imports a key file from the previous release", async () => {
		renderSection();
		await shownPublicKey();

		chooseFile(
			new File([goldenV1], "old-key.json", { type: "application/json" }),
		);
		type("Import passphrase", GOLDEN_PASSPHRASE);
		fireEvent.click(screen.getByRole("button", { name: "Import key" }));

		await screen.findByText(/Key imported/, undefined, CRYPTO_WAIT);
		expect(await shownPublicKey()).toBe(GOLDEN_PUBLIC_KEY);
	});

	it.each([
		[
			"out-of-memory",
			/ran out of memory while unlocking.*passphrase was not checked/,
		],
		["unavailable", /didn't load.*passphrase was not checked/],
		["unsupported", /encryption settings this app can't open/],
	] as const)("explains a %s refusal honestly", async (reason, text) => {
		const { file } = await exportFile();
		renderSection(
			withOverride({
				importEncrypted: () =>
					Promise.reject(new InstallKeyImportError(reason, reason)),
			}),
		);
		const before = await shownPublicKey();

		chooseFile(file);
		type("Import passphrase", PASSPHRASE);
		fireEvent.click(screen.getByRole("button", { name: "Import key" }));

		expect(await screen.findByText(text)).toBeInTheDocument();
		expect((await keys.load()).publicKeyHex).toBe(before);
	});

	it("says how much memory a too-costly file asks for", async () => {
		const { file } = await exportFile();
		renderSection(
			withOverride({
				importEncrypted: () =>
					Promise.reject(
						new InstallKeyImportError("too-costly", "too costly", 20),
					),
			}),
		);
		await shownPublicKey();

		chooseFile(file);
		type("Import passphrase", PASSPHRASE);
		fireEvent.click(screen.getByRole("button", { name: "Import key" }));

		expect(await screen.findByText(/1024 MiB/)).toBeInTheDocument();
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
