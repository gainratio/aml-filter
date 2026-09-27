import {
	defaultKeyStorage,
	EMPTY_IDENTIFIERS,
	type Entity,
	type EntityType,
	type Identifiers,
	loadInstallKey,
	type Match,
	type MatchReason,
	type MatchScoreSubject,
	type RetrievalChannel,
	type RiskCategory,
	verifyMatchReceipt,
} from "@amlfilter/browser";
import {
	ReceiptPanel,
	type ReceiptStatus,
	useReceiptVerification,
} from "@edgeproc/receipt-ui";
import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	listName,
	reasonLabel,
	riskLabel,
	tierLabel,
} from "../lib/plainLabels";
import { plainExplanation } from "./plainExplanation";

/** The unified view model rendered for a directory entity or scored match. */
export interface Dossier {
	readonly entity_id: string;
	readonly primary_name: string;
	readonly entity_type?: EntityType;
	readonly risk_category: RiskCategory;
	/** The list this entity is on (a stored code such as `UK_OFSI`). */
	readonly source_list: string;
	readonly aliases: ReadonlyArray<string>;
	readonly dob: ReadonlyArray<string>;
	readonly countries: ReadonlyArray<string>;
	readonly nationalities: ReadonlyArray<string>;
	readonly addresses: ReadonlyArray<string>;
	readonly identifiers: Identifiers;
	readonly score?: number;
	readonly explanation?: string;
	readonly reasons?: ReadonlyArray<MatchReason>;
	/** Signed receipt sealing the score and Assay evidence (absent on directory rows). */
	readonly score_receipt?: ScoreReceipt;
	/** Retrieval channels that reached a scored match — context, never a score term. */
	readonly retrieved_via?: ReadonlyArray<RetrievalChannel>;
}

/** The signed receipt a scored match carries. */
type ScoreReceipt = NonNullable<Match["score_receipt"]>;

export function dossierFromEntity(entity: Entity): Dossier {
	return {
		entity_id: entity.entity_id,
		primary_name: entity.primary_name,
		// The signed watchlist wire has no entity type. The engine's PERSON value is
		// a compatibility placeholder, so omitting it avoids mislabelling banks,
		// vessels, and aircraft as people.
		risk_category: entity.risk_category,
		source_list: entity.source_list,
		aliases: entity.aliases.map((alias) => alias.name),
		dob: entity.dob,
		countries: entity.countries,
		nationalities: entity.nationalities ?? [],
		addresses: entity.addresses ?? [],
		identifiers: entity.identifiers ?? EMPTY_IDENTIFIERS,
	};
}

export function dossierFromMatch(match: Match): Dossier {
	return {
		entity_id: match.entity_id,
		primary_name: match.primary_name,
		risk_category: match.risk_category,
		source_list: match.source_list,
		aliases: match.aliases,
		dob: match.dob,
		countries: match.countries,
		nationalities: match.nationalities,
		addresses: match.addresses,
		identifiers: match.identifiers,
		score: match.score,
		explanation: match.explanation,
		reasons: match.reasons,
		// Conditional spread, not `score_receipt: undefined`: under
		// exactOptionalPropertyTypes an absent receipt stays ABSENT.
		...(match.score_receipt !== undefined
			? { score_receipt: match.score_receipt }
			: {}),
		...(match.retrieved_via !== undefined
			? { retrieved_via: match.retrieved_via }
			: {}),
	};
}

function identifierLines(
	identifiers: Identifiers,
	t: TFunction,
): ReadonlyArray<string> {
	const lines = identifiers.passport.map((value) =>
		t("dossier.ids.passport", { value }),
	);
	lines.push(
		...identifiers.national_id.map((value) =>
			t("dossier.ids.nationalId", { value }),
		),
	);
	for (const [label, values] of Object.entries(identifiers.other)) {
		lines.push(...values.map((value) => `${label} ${value}`));
	}
	return lines;
}

/**
 * The trust-anchor lifecycle around receipt verification. Every state is
 * RENDERED — a receipt-bearing match must never appear badge-less, because a
 * silent badge gap reads as "this match was never sealed".
 */
type InstallKeyState =
	| { readonly status: "loading" }
	| { readonly status: "unavailable" }
	| { readonly status: "ready"; readonly publicKey: string };

/**
 * The ONLY signer this card trusts: this install's own key, read from the
 * same storage the engine's sealer signs with. Re-resolved whenever a new
 * receipt arrives, and reset to `loading` — the fail-closed default — while
 * resolving, so a receipt is never judged against a stale key. Blocked storage
 * and a failed load both land on `unavailable` (rendered, audit-logged), never
 * on a silently missing badge.
 */
function useInstallKeyState(
	receipt: ScoreReceipt | undefined,
): InstallKeyState {
	const [state, setState] = useState<InstallKeyState>({ status: "loading" });
	useEffect(() => {
		setState({ status: "loading" });
		if (receipt === undefined) {
			return;
		}
		// No usable storage means no stable install key (matchReceipts.ts never
		// seals there either): say so on screen rather than invent a signer.
		const storage = defaultKeyStorage();
		if (storage === null) {
			setState({ status: "unavailable" });
			return;
		}
		let active = true;
		loadInstallKey(storage)
			.then((key) => {
				if (active) {
					setState({ status: "ready", publicKey: key.publicKeyHex });
				}
			})
			.catch((error: unknown) => {
				console.warn("amlfilter.receipt.trust_anchor_load_failed", {
					error: error instanceof Error ? error.message : String(error),
				});
				if (active) {
					setState({ status: "unavailable" });
				}
			});
		return () => {
			active = false;
		};
	}, [receipt]);
	return state;
}

/**
 * Everything the head badge can say: the library's four verify verdicts plus
 * the two app-owned trust-anchor states.
 */
type BadgeStatus = ReceiptStatus | "pending" | "unavailable";

const BADGE_ICON: Record<BadgeStatus, string> = {
	pending: "…",
	unavailable: "?",
	checking: "…",
	verified: "✓",
	invalid: "✕",
	"wrong-key": "⚠",
};

const BADGE_LABEL_KEY: Record<BadgeStatus, string> = {
	pending: "dossier.receipt.status.pending",
	unavailable: "dossier.receipt.status.unavailable",
	checking: "dossier.receipt.status.checking",
	verified: "dossier.receipt.status.verified",
	invalid: "dossier.receipt.status.invalid",
	"wrong-key": "dossier.receipt.status.wrongKey",
};

interface ReceiptStatusChipProps {
	readonly status: BadgeStatus;
	readonly t: TFunction;
}

/**
 * App-rendered status chip: the same accessible markup contract as
 * receipt-ui's StatusPill (live status region, aria-hidden icon + word label —
 * WCAG 1.4.1), but with the label routed through i18next. Composed over the
 * library's public `useReceiptVerification` hook instead of `ReceiptBadge` so
 * every app-rendered string stays translatable; receipt-ui 0.1.0 has no
 * label-injection API (0.2.0 adoption is tracked in docs/ARCHITECTURE.md).
 */
function ReceiptStatusChip({ status, t }: ReceiptStatusChipProps) {
	return (
		<span className="receipt-status" data-status={status} role="status">
			<span aria-hidden="true" className="receipt-status__icon">
				{BADGE_ICON[status]}
			</span>
			<span className="receipt-status__text">{t(BADGE_LABEL_KEY[status])}</span>
		</span>
	);
}

interface VerifyVerdictChipProps {
	readonly receipt: ScoreReceipt;
	readonly publicKey: string;
	readonly t: TFunction;
}

/** The verify verdict once the trust anchor is ready. A separate component so
 * the verification hook runs unconditionally (rules of hooks). */
function VerifyVerdictChip({ receipt, publicKey, t }: VerifyVerdictChipProps) {
	const status = useReceiptVerification(receipt, publicKey, verifyMatchReceipt);
	return <ReceiptStatusChip status={status} t={t} />;
}

interface ReceiptVerdictProps {
	readonly receipt: ScoreReceipt;
	readonly keyState: InstallKeyState;
	readonly t: TFunction;
}

/** One rendered state for every trust-anchor + verification combination. */
function ReceiptVerdict({ receipt, keyState, t }: ReceiptVerdictProps) {
	if (keyState.status === "ready") {
		return (
			<VerifyVerdictChip
				publicKey={keyState.publicKey}
				receipt={receipt}
				t={t}
			/>
		);
	}
	return (
		<ReceiptStatusChip
			status={keyState.status === "loading" ? "pending" : "unavailable"}
			t={t}
		/>
	);
}

interface ReceiptSubjectProps {
	readonly payload: MatchScoreSubject;
	readonly t: TFunction;
}

/** The sealed subject rows shown inside the receipt panel's payload section. */
function ReceiptSubject({ payload, t }: ReceiptSubjectProps) {
	return (
		<dl className="match-card__signals">
			<div className="match-card__signal">
				<dt>{t("dossier.receipt.sealedScore")}</dt>
				<dd>{`${payload.score.toFixed(3)} (${tierLabel(payload.tier, t)})`}</dd>
			</div>
			<div className="match-card__signal">
				<dt>{t("dossier.receipt.engine")}</dt>
				<dd>{payload.engine_version}</dd>
			</div>
			<div className="match-card__signal">
				<dt>{t("dossier.receipt.watchlist")}</dt>
				<dd>{payload.watchlist_version}</dd>
			</div>
			<div className="match-card__signal">
				<dt>{t("dossier.receipt.inputs")}</dt>
				<dd>
					<code>{payload.inputs_hash}</code>
				</dd>
			</div>
			{payload.assay !== undefined && (
				<>
					<div className="match-card__signal">
						<dt>{t("dossier.receipt.assayMethod")}</dt>
						<dd>{`Assay ${payload.assay.method.version}`}</dd>
					</div>
					<div className="match-card__signal">
						<dt>{t("dossier.receipt.assayInputs")}</dt>
						<dd>
							<code>{payload.assay.inputs_hash}</code>
						</dd>
					</div>
					{payload.assay.components.map((component) => (
						<div className="match-card__signal" key={component.id}>
							<dt>{reasonLabel(component.id, t)}</dt>
							<dd>
								{`${component.raw} × ${component.coefficient ?? 1} = ${component.contribution}`}
							</dd>
						</div>
					))}
				</>
			)}
		</dl>
	);
}

interface FactProps {
	readonly label: string;
	readonly value: string;
}

function Fact({ label, value }: FactProps) {
	return (
		<div className="match-card__fact">
			<dt>{label}</dt>
			<dd>{value}</dd>
		</div>
	);
}

/** Signals whose value is a 0–1 likeness; shown as "N% alike", not a raw float. */
const SIMILARITY_SIGNALS: ReadonlySet<string> = new Set([
	"name_vector",
	"name_sequence",
]);

/** One reason's value in plain words. Similarity signals become a percentage;
 * the rest keep the engine's own sentence (e.g. "Alias match: Vanya Fakovich"). */
function reasonValue(reason: MatchReason, t: TFunction): string {
	if (
		SIMILARITY_SIGNALS.has(reason.signal) &&
		typeof reason.value === "number"
	) {
		return t("dossier.similarity", { pct: Math.round(reason.value * 100) });
	}
	return reason.description ?? String(reason.value);
}

interface FoundViaProps {
	readonly channels: ReadonlyArray<RetrievalChannel> | undefined;
	readonly t: TFunction<"screen">;
}

/**
 * Which retrieval channels reached this match. Provenance only: phonetic keys
 * widen who gets SCORED, never the score itself — so when pronunciation was
 * the only way in, say so plainly. Stored rows carry no provenance; render
 * nothing rather than guess.
 */
function FoundVia({ channels, t }: FoundViaProps) {
	if (channels === undefined || channels.length === 0) return null;
	const phoneticOnly = channels.length === 1 && channels[0] === "phonetic";
	return (
		<>
			<p className="match-card__via">
				{t("dossier.foundVia.line", {
					channels: channels
						.map((channel) => t(`dossier.foundVia.channels.${channel}`))
						.join(" · "),
				})}
			</p>
			{phoneticOnly && (
				<p className="match-card__via-note">
					{t("dossier.foundVia.phoneticOnly")}
				</p>
			)}
		</>
	);
}

interface DossierCardProps {
	readonly dossier: Dossier;
}

export function DossierCard({ dossier }: DossierCardProps) {
	const { t } = useTranslation("screen");
	const identifiers = identifierLines(dossier.identifiers, t);
	const places = [...new Set([...dossier.nationalities, ...dossier.countries])];
	const receiptKeyState = useInstallKeyState(dossier.score_receipt);
	return (
		<li className="match-card">
			<div className="match-card__head">
				<span className="match-card__name">{dossier.primary_name}</span>
				{dossier.entity_type !== undefined && (
					<span className="match-card__type">{dossier.entity_type}</span>
				)}
				{dossier.score !== undefined && (
					<span className="match-card__score">{dossier.score.toFixed(3)}</span>
				)}
				{dossier.score_receipt !== undefined && (
					<ReceiptVerdict
						keyState={receiptKeyState}
						receipt={dossier.score_receipt}
						t={t}
					/>
				)}
				<span className="match-card__list">
					{listName(dossier.source_list, t)}
				</span>
				<span className="match-card__badge">
					{riskLabel(dossier.risk_category, t)}
				</span>
			</div>

			<dl className="match-card__facts">
				{dossier.aliases.length > 0 && (
					<Fact
						label={t("dossier.facts.aka")}
						value={dossier.aliases.join(", ")}
					/>
				)}
				{dossier.dob.length > 0 && (
					<Fact label={t("dossier.facts.dob")} value={dossier.dob.join(", ")} />
				)}
				{places.length > 0 && (
					<Fact label={t("dossier.facts.country")} value={places.join(", ")} />
				)}
				{dossier.addresses.length > 0 && (
					<Fact
						label={t("dossier.facts.address")}
						value={dossier.addresses.join("; ")}
					/>
				)}
				{identifiers.length > 0 && (
					<Fact label={t("dossier.facts.id")} value={identifiers.join(", ")} />
				)}
			</dl>

			{dossier.explanation !== undefined && (
				<p className="match-card__why">
					{plainExplanation(dossier.explanation, t)}
				</p>
			)}
			{dossier.reasons !== undefined && dossier.reasons.length > 0 && (
				<details className="match-card__details">
					<summary>{t("dossier.whyScore")}</summary>
					<dl className="match-card__signals">
						{dossier.reasons.map((reason) => (
							<div className="match-card__signal" key={reason.signal}>
								<dt>{reasonLabel(reason.signal, t)}</dt>
								<dd>{reasonValue(reason, t)}</dd>
							</div>
						))}
					</dl>
					<FoundVia channels={dossier.retrieved_via} t={t} />
				</details>
			)}
			{dossier.score_receipt !== undefined &&
				receiptKeyState.status === "ready" && (
					<details className="match-card__details match-card__receipt">
						<summary>{t("dossier.receipt.summary")}</summary>
						<ReceiptPanel
							expectedPublicKey={receiptKeyState.publicKey}
							receipt={dossier.score_receipt}
							renderPayload={(payload) => (
								<ReceiptSubject payload={payload} t={t} />
							)}
							verify={verifyMatchReceipt}
						/>
					</details>
				)}
		</li>
	);
}
