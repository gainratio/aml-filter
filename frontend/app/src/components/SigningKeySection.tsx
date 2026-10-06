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
	checkNewInstallKeyPassphrase,
	type InstallKey,
	InstallKeyExportError,
	type InstallKeyExportRejection,
	InstallKeyImportError,
	type InstallKeyImportRejection,
	MIN_PASSPHRASE_LENGTH,
	type NewPassphraseCheck,
} from "@amlfilter/browser";
import type { TFunction } from "i18next";
import { type ReactElement, useEffect, useState } from "react";
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
	unsupported: "signingKey.import.errors.unsupportedSettings",
	"wrong-passphrase-or-tampered": "signingKey.import.errors.wrongPassphrase",
	"key-mismatch": "signingKey.import.errors.mismatch",
	"too-costly": "signingKey.import.errors.tooCostly",
	"out-of-memory": "signingKey.import.errors.outOfMemory",
	"timed-out": "signingKey.import.errors.timedOut",
	unavailable: "signingKey.import.errors.unavailable",
};

const EXPORT_ERROR_KEY: Record<InstallKeyExportRejection, string> = {
	empty: "signingKey.export.empty",
	"too-short": "signingKey.export.tooShort",
	"out-of-memory": "signingKey.export.errors.outOfMemory",
	"timed-out": "signingKey.export.errors.timedOut",
	unavailable: "signingKey.export.errors.unavailable",
};

/** scrypt with r = 8 holds 2^(workFactor + 10) bytes. */
function scryptMiB(workFactor: number | undefined): number {
	return 2 ** ((workFactor ?? 20) - 10);
}

function importErrorText(error: unknown, t: TFunction): string {
	if (error instanceof InstallKeyImportError) {
		return t(IMPORT_ERROR_KEY[error.reason], {
			mib: scryptMiB(error.workFactor),
		});
	}
	return t("signingKey.error", { message: messageOf(error) });
}

function exportErrorText(error: unknown, t: TFunction): string {
	if (error instanceof InstallKeyExportError) {
		return t(EXPORT_ERROR_KEY[error.reason], { min: MIN_PASSPHRASE_LENGTH });
	}
	return t("signingKey.error", { message: messageOf(error) });
}

function saveFile(bytes: Uint8Array<ArrayBuffer>, publicKeyHex: string): void {
	const url = URL.createObjectURL(
		new Blob([bytes], { type: "application/octet-stream" }),
	);
	const link = document.createElement("a");
	link.href = url;
	link.download = `amlfilter-signing-key-${publicKeyHex.slice(0, 8)}.age`;
	link.click();
	URL.revokeObjectURL(url);
}

interface NoticeLineProps {
	readonly notice: Notice;
}

function NoticeLine({ notice }: NoticeLineProps): ReactElement | null {
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

interface PassphraseInputProps {
	readonly id: string;
	readonly label: string;
	readonly autoComplete: "new-password" | "current-password";
	readonly value: string;
	readonly onChange: (value: string) => void;
	/** An inline problem with this field, announced and linked to it. */
	readonly problem?: string | null;
}

function PassphraseInput(props: PassphraseInputProps): ReactElement {
	const problemId = `${props.id}-problem`;
	const problem = props.problem ?? null;
	return (
		<>
			<label className="form-label" htmlFor={props.id}>
				{props.label}
			</label>
			<input
				id={props.id}
				type="password"
				autoComplete={props.autoComplete}
				className="form-input"
				value={props.value}
				aria-invalid={problem === null ? undefined : true}
				aria-describedby={problem === null ? undefined : problemId}
				onChange={(e) => props.onChange(e.target.value)}
			/>
			{problem !== null && (
				<p id={problemId} className="form-error" role="alert">
					{problem}
				</p>
			)}
		</>
	);
}

interface ActionButtonProps {
	readonly label: string;
	readonly onAction: () => Promise<void>;
}

function ActionButton({ label, onAction }: ActionButtonProps): ReactElement {
	return (
		<button
			type="button"
			className="btn btn-secondary"
			onClick={() => {
				void onAction();
			}}
		>
			{label}
		</button>
	);
}

interface FieldProblems {
	readonly passphrase: string | null;
	readonly confirm: string | null;
}

/**
 * Inline problems for the two fields. A mismatch shows as soon as the user
 * types a confirmation; empty / too short only after they try to export.
 */
function fieldProblems(
	check: NewPassphraseCheck,
	confirm: string,
	attempted: boolean,
	t: TFunction,
): FieldProblems {
	if (check.ok) {
		return { passphrase: null, confirm: null };
	}
	if (check.reason === "mismatch") {
		const show = attempted || confirm !== "";
		return {
			passphrase: null,
			confirm: show ? t("signingKey.export.mismatch") : null,
		};
	}
	const key =
		check.reason === "empty"
			? "signingKey.export.empty"
			: "signingKey.export.tooShort";
	return {
		passphrase: attempted ? t(key, { min: MIN_PASSPHRASE_LENGTH }) : null,
		confirm: null,
	};
}

function ExportForm({ keys, t }: FormProps): ReactElement {
	const [passphrase, setPassphrase] = useState("");
	const [confirm, setConfirm] = useState("");
	const [attempted, setAttempted] = useState(false);
	const [notice, setNotice] = useState<Notice>(null);
	const check = checkNewInstallKeyPassphrase(passphrase, confirm);
	const problems = fieldProblems(check, confirm, attempted, t);

	async function handleExport(): Promise<void> {
		setAttempted(true);
		setNotice(null);
		if (!check.ok) {
			return;
		}
		try {
			const bytes = await keys.exportEncrypted(passphrase);
			saveFile(bytes, (await keys.load()).publicKeyHex);
			setPassphrase("");
			setConfirm("");
			setAttempted(false);
			setNotice({ kind: "success", text: t("signingKey.export.done") });
		} catch (error) {
			setNotice({ kind: "error", text: exportErrorText(error, t) });
		}
	}

	return (
		<div className="signing-key__form">
			<h3>{t("signingKey.export.title")}</h3>
			<p className="text-muted">
				{t("signingKey.export.description", { min: MIN_PASSPHRASE_LENGTH })}
			</p>
			<PassphraseInput
				id="export-passphrase"
				label={t("signingKey.export.passphrase")}
				autoComplete="new-password"
				value={passphrase}
				onChange={setPassphrase}
				problem={problems.passphrase}
			/>
			<PassphraseInput
				id="export-confirm"
				label={t("signingKey.export.confirm")}
				autoComplete="new-password"
				value={confirm}
				onChange={setConfirm}
				problem={problems.confirm}
			/>
			<ActionButton
				label={t("signingKey.export.button")}
				onAction={handleExport}
			/>
			<NoticeLine notice={notice} />
		</div>
	);
}

function ImportForm({ keys, t }: FormProps): ReactElement {
	const [file, setFile] = useState<File | null>(null);
	const [passphrase, setPassphrase] = useState("");
	const [notice, setNotice] = useState<Notice>(null);

	async function handleImport(): Promise<void> {
		if (file === null) {
			setNotice({ kind: "error", text: t("signingKey.import.noFile") });
			return;
		}
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			const key = await keys.importEncrypted(bytes, passphrase);
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
				accept=".age,.json,application/octet-stream,application/json"
				className="form-input"
				onChange={(e) => setFile(e.target.files?.[0] ?? null)}
			/>
			<PassphraseInput
				id="import-passphrase"
				label={t("signingKey.import.passphrase")}
				autoComplete="current-password"
				value={passphrase}
				onChange={setPassphrase}
			/>
			<ActionButton
				label={t("signingKey.import.button")}
				onAction={handleImport}
			/>
			<NoticeLine notice={notice} />
		</div>
	);
}

function ResetControl({ keys, t }: FormProps): ReactElement {
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

interface KeyStatusProps {
	readonly state: KeyState;
	readonly t: TFunction;
}

function KeyStatus({ state, t }: KeyStatusProps): ReactElement {
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
export function SigningKeySection(): ReactElement {
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
