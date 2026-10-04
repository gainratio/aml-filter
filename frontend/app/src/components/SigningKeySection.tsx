/**
 * Settings → Receipt signing key. Shows this browser's public key (what a
 * reviewer pins to check receipts), says plainly when the key only lives in
 * this tab, and offers the three key operations:
 *   - export: the key encrypted under a passphrase (never plaintext)
 *   - import: replace this browser's key from such a file
 *   - reset:  delete the key, behind a warning that past receipts then only
 *             verify with the previously exported public key
 */

import {
	type InstallKey,
	InstallKeyImportError,
	type InstallKeyImportRejection,
	MIN_PASSPHRASE_LENGTH,
} from "@amlfilter/browser";
import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type KeyAdmin, useKeyAdmin } from "../lib/installKeysContext";

type KeyState =
	| { readonly status: "loading" }
	| { readonly status: "failed"; readonly message: string }
	| { readonly status: "ready"; readonly key: InstallKey };

type Notice =
	| { readonly kind: "success"; readonly text: string }
	| { readonly kind: "error"; readonly text: string }
	| null;

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The loaded key, refreshed whenever it changes (this tab or another). */
function useKeyState(keys: KeyAdmin): KeyState {
	const [state, setState] = useState<KeyState>({ status: "loading" });
	const [generation, setGeneration] = useState(0);
	useEffect(() => keys.onChange(() => setGeneration((g) => g + 1)), [keys]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: generation is an intentional re-fire trigger (the key changed), not read in the body
	useEffect(() => {
		let active = true;
		keys.load().then(
			(key) => active && setState({ status: "ready", key }),
			(error: unknown) =>
				active && setState({ status: "failed", message: messageOf(error) }),
		);
		return () => {
			active = false;
		};
	}, [keys, generation]);
	return state;
}

const IMPORT_ERROR_KEY: Record<InstallKeyImportRejection, string> = {
	malformed: "signingKey.import.errors.malformed",
	"unsupported-version": "signingKey.import.errors.unsupported",
	"wrong-passphrase-or-tampered": "signingKey.import.errors.wrongPassphrase",
	"key-mismatch": "signingKey.import.errors.mismatch",
};

function importErrorText(error: unknown, t: TFunction): string {
	if (error instanceof InstallKeyImportError) {
		return t(IMPORT_ERROR_KEY[error.reason]);
	}
	return t("signingKey.error", { message: messageOf(error) });
}

function saveFile(text: string, publicKeyHex: string): void {
	const url = URL.createObjectURL(
		new Blob([text], { type: "application/json" }),
	);
	const link = document.createElement("a");
	link.href = url;
	link.download = `amlfilter-signing-key-${publicKeyHex.slice(0, 8)}.json`;
	link.click();
	URL.revokeObjectURL(url);
}

function NoticeLine({ notice }: { readonly notice: Notice }) {
	if (notice === null) {
		return null;
	}
	return notice.kind === "success" ? (
		<div className="alert alert-success" role="status">
			{notice.text}
		</div>
	) : (
		<div className="alert alert-error" role="alert">
			{notice.text}
		</div>
	);
}

interface FormProps {
	readonly keys: KeyAdmin;
	readonly t: TFunction;
}

function exportProblem(
	passphrase: string,
	confirm: string,
	t: TFunction,
): string | null {
	if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
		return t("signingKey.export.tooShort", { min: MIN_PASSPHRASE_LENGTH });
	}
	return passphrase === confirm ? null : t("signingKey.export.mismatch");
}

function ExportForm({ keys, t }: FormProps) {
	const [passphrase, setPassphrase] = useState("");
	const [confirm, setConfirm] = useState("");
	const [notice, setNotice] = useState<Notice>(null);

	async function handleExport(): Promise<void> {
		const problem = exportProblem(passphrase, confirm, t);
		if (problem !== null) {
			setNotice({ kind: "error", text: problem });
			return;
		}
		try {
			const text = await keys.exportEncrypted(passphrase);
			saveFile(text, (await keys.load()).publicKeyHex);
			setPassphrase("");
			setConfirm("");
			setNotice({ kind: "success", text: t("signingKey.export.done") });
		} catch (error) {
			setNotice({
				kind: "error",
				text: t("signingKey.error", { message: messageOf(error) }),
			});
		}
	}

	return (
		<div className="signing-key__form">
			<h3>{t("signingKey.export.title")}</h3>
			<p className="text-muted">
				{t("signingKey.export.description", { min: MIN_PASSPHRASE_LENGTH })}
			</p>
			<label className="form-label" htmlFor="export-passphrase">
				{t("signingKey.export.passphrase")}
			</label>
			<input
				id="export-passphrase"
				type="password"
				autoComplete="new-password"
				className="form-input"
				value={passphrase}
				onChange={(e) => setPassphrase(e.target.value)}
			/>
			<label className="form-label" htmlFor="export-confirm">
				{t("signingKey.export.confirm")}
			</label>
			<input
				id="export-confirm"
				type="password"
				autoComplete="new-password"
				className="form-input"
				value={confirm}
				onChange={(e) => setConfirm(e.target.value)}
			/>
			<button
				type="button"
				className="btn btn-secondary"
				onClick={() => {
					void handleExport();
				}}
			>
				{t("signingKey.export.button")}
			</button>
			<NoticeLine notice={notice} />
		</div>
	);
}

function ImportForm({ keys, t }: FormProps) {
	const [file, setFile] = useState<File | null>(null);
	const [passphrase, setPassphrase] = useState("");
	const [notice, setNotice] = useState<Notice>(null);

	async function handleImport(): Promise<void> {
		if (file === null) {
			setNotice({ kind: "error", text: t("signingKey.import.noFile") });
			return;
		}
		try {
			const key = await keys.importEncrypted(await file.text(), passphrase);
			setPassphrase("");
			setNotice({
				kind: "success",
				text: t("signingKey.import.done", { publicKey: key.publicKeyHex }),
			});
		} catch (error) {
			setNotice({ kind: "error", text: importErrorText(error, t) });
		}
	}

	return (
		<div className="signing-key__form">
			<h3>{t("signingKey.import.title")}</h3>
			<p className="text-muted">{t("signingKey.import.description")}</p>
			<label className="form-label" htmlFor="import-file">
				{t("signingKey.import.file")}
			</label>
			<input
				id="import-file"
				type="file"
				accept="application/json,.json"
				className="form-input"
				onChange={(e) => setFile(e.target.files?.[0] ?? null)}
			/>
			<label className="form-label" htmlFor="import-passphrase">
				{t("signingKey.import.passphrase")}
			</label>
			<input
				id="import-passphrase"
				type="password"
				autoComplete="current-password"
				className="form-input"
				value={passphrase}
				onChange={(e) => setPassphrase(e.target.value)}
			/>
			<button
				type="button"
				className="btn btn-secondary"
				onClick={() => {
					void handleImport();
				}}
			>
				{t("signingKey.import.button")}
			</button>
			<NoticeLine notice={notice} />
		</div>
	);
}

function ResetControl({ keys, t }: FormProps) {
	const [confirming, setConfirming] = useState(false);
	const [notice, setNotice] = useState<Notice>(null);

	async function handleReset(): Promise<void> {
		try {
			await keys.reset();
			const key = await keys.load();
			setNotice({
				kind: "success",
				text: t("signingKey.reset.done", { publicKey: key.publicKeyHex }),
			});
		} catch (error) {
			setNotice({
				kind: "error",
				text: t("signingKey.error", { message: messageOf(error) }),
			});
		} finally {
			setConfirming(false);
		}
	}

	return (
		<div className="signing-key__form">
			{confirming ? (
				<div className="alert alert-warning" role="alert">
					<p>{t("signingKey.reset.warning")}</p>
					<button
						type="button"
						className="btn btn-danger"
						onClick={() => {
							void handleReset();
						}}
					>
						{t("signingKey.reset.confirm")}
					</button>
					<button
						type="button"
						className="btn btn-secondary"
						onClick={() => setConfirming(false)}
					>
						{t("signingKey.reset.cancel")}
					</button>
				</div>
			) : (
				<button
					type="button"
					className="btn btn-secondary"
					onClick={() => setConfirming(true)}
				>
					{t("signingKey.reset.button")}
				</button>
			)}
			<NoticeLine notice={notice} />
		</div>
	);
}

function KeyStatus({
	state,
	t,
}: {
	readonly state: KeyState;
	readonly t: TFunction;
}) {
	if (state.status === "loading") {
		return (
			<p className="text-muted" role="status">
				{t("signingKey.loading")}
			</p>
		);
	}
	if (state.status === "failed") {
		return (
			<div className="alert alert-error" role="alert">
				{t("signingKey.unavailable", { reason: state.message })}
			</div>
		);
	}
	return (
		<>
			<p className="form-label">{t("signingKey.publicKeyLabel")}</p>
			<code className="signing-key__public" data-testid="signing-public-key">
				{state.key.publicKeyHex}
			</code>
			{state.key.persistence.kind === "memory" && (
				<div className="alert alert-warning" role="alert">
					{t("signingKey.memoryNotice")}
				</div>
			)}
		</>
	);
}

/** The Settings card for the receipt signing key. */
export function SigningKeySection() {
	const { t } = useTranslation("settings");
	const keys = useKeyAdmin();
	const state = useKeyState(keys);
	return (
		<section className="card signing-key">
			<h2>{t("signingKey.title")}</h2>
			<p className="text-muted">{t("signingKey.description")}</p>
			<KeyStatus state={state} t={t} />
			<ExportForm keys={keys} t={t} />
			<ImportForm keys={keys} t={t} />
			<ResetControl keys={keys} t={t} />
		</section>
	);
}
