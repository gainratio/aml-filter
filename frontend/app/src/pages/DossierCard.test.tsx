import {
	calculateAssayScore,
	loadInstallKey,
	type Match,
	type MatchScoreSubject,
	matchScoreSubject,
	signMatchReceipt,
} from "@amlfilter/browser";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DossierCard, dossierFromMatch } from "./DossierCard";

// A valid Ed25519 seed that is NOT this jsdom install's key — receipts signed
// with it must render the distinct untrusted-signer failure, never verified.
const FOREIGN_SEED_HEX = "ab".repeat(32);

function baseMatch(): Match {
	return {
		entity_id: "OFAC_SDN:0001",
		score: 0.914,
		entity_type: "PERSON",
		risk_category: "SANCTION",
		source_list: "OFAC_SDN",
		list_version: "2026-07-15",
		primary_name: "Ivan Fakovich",
		aliases: [],
		countries: [],
		nationalities: [],
		dob: ["1971-03-14"],
		addresses: [],
		identifiers: { passport: [], national_id: [], other: {} },
		reasons: [
			{
				signal: "name_similarity",
				value: 0.914,
				weight: 1,
				contribution: 0.914,
				description: "Name similarity 0.914",
			},
		],
		explanation: "Name similarity 0.914",
	};
}

/** Sign a real receipt for the base match — by default with THIS install's key. */
async function signedMatch(seedHex?: string): Promise<Match> {
	const assay = calculateAssayScore(
		{
			name_vector: 0.8,
			name_sequence: 0.62,
			alias_match: 1,
			dob_match: 0,
			country_match: 0,
		},
		{
			name_vector: 0.6,
			name_sequence: 0.25,
			alias_match: 0.2,
			dob_match: 0.05,
			country_match: 0.05,
		},
	);
	const subject = matchScoreSubject(
		{
			score: assay.score,
			tier: "STRONG",
			possibleThreshold: 0.75,
			assay,
		},
		{
			engineVersion: "engine-test-1",
			watchlistVersion: "watchlist-test-1",
			inputsHash: `sha256:${"0".repeat(64)}`,
		},
	);
	const seed = seedHex ?? (await loadInstallKey(window.localStorage)).seedHex;
	return {
		...baseMatch(),
		score_receipt: await signMatchReceipt(subject, seed),
	};
}

function renderCard(match: Match) {
	return render(
		<ul>
			<DossierCard dossier={dossierFromMatch(match)} />
		</ul>,
	);
}

function headBadge(container: HTMLElement): Element | null {
	return container.querySelector(".match-card__head .receipt-status");
}

beforeEach(() => {
	window.localStorage.clear();
});
afterEach(cleanup);

describe("dossierFromMatch", () => {
	it("threads the signed score receipt through to the dossier", async () => {
		const match = await signedMatch();
		expect(dossierFromMatch(match).score_receipt).toBe(match.score_receipt);
	});
});

describe("DossierCard receipt verdict", () => {
	it("renders the signed Assay method, input hash, and component evidence", async () => {
		const match = await signedMatch();
		renderCard(match);
		fireEvent.click(await screen.findByText("Score proof"));

		await screen.findByText("Assay amlfilter.additive.v2");
		expect(
			screen.getByText(
				match.score_receipt?.payload.assay?.inputs_hash ?? "missing",
			),
		).toBeVisible();
		expect(screen.getByText("Name likeness")).toBeVisible();
		expect(screen.queryByText("name_vector")).toBeNull();
		expect(screen.getByText("0.8 × 0.6 = 0.48")).toBeVisible();
	});

	it("renders a Score-unaltered icon+text badge beside the score for a receipt signed by this install", async () => {
		const match = await signedMatch();
		const { container } = renderCard(match);

		await waitFor(() => {
			expect(headBadge(container)?.getAttribute("data-status")).toBe(
				"verified",
			);
		});
		const badge = headBadge(container);
		// The verdict must survive without color (WCAG 1.4.1): a distinct icon
		// AND a distinct word label, in a live status region.
		expect(badge?.getAttribute("role")).toBe("status");
		expect(
			badge
				?.querySelector(".receipt-status__icon")
				?.getAttribute("aria-hidden"),
		).toBe("true");
		expect(badge?.querySelector(".receipt-status__text")?.textContent).toBe(
			"Score unaltered",
		);
		// Beside the score, not instead of it.
		expect(
			container.querySelector(".match-card__head .match-card__score")
				?.textContent,
		).toBe("0.914");
	});

	it("renders the distinct tampered failure state when the sealed payload is mutated", async () => {
		const match = await signedMatch();
		const receipt = match.score_receipt;
		if (receipt === undefined) throw new Error("test setup: receipt missing");
		const tampered: Match = {
			...match,
			score_receipt: {
				...receipt,
				// Hostile-data simulation: a plain number smuggled where only an
				// AttestedScore may live — exactly what a tamper produces.
				payload: { ...receipt.payload, score: 0.999 } as MatchScoreSubject,
			},
		};
		const { container } = renderCard(tampered);

		await waitFor(() => {
			expect(headBadge(container)?.getAttribute("data-status")).toBe("invalid");
		});
		expect(headBadge(container)?.textContent).toContain(
			"Score altered — don't rely on it",
		);
	});

	it("renders the distinct untrusted-signer failure state for a receipt signed by a foreign key", async () => {
		// Pin this install's key first so the expected key exists and differs.
		await loadInstallKey(window.localStorage);
		const foreign = await signedMatch(FOREIGN_SEED_HEX);
		const { container } = renderCard(foreign);

		await waitFor(() => {
			expect(headBadge(container)?.getAttribute("data-status")).toBe(
				"wrong-key",
			);
		});
		expect(headBadge(container)?.textContent).toContain(
			"Score proof from another device",
		);
	});

	it("re-judges a new receipt against the key the store holds NOW (fail-closed on rekey)", async () => {
		const match = await signedMatch();
		const receipt = match.score_receipt;
		if (receipt === undefined) throw new Error("test setup: receipt missing");
		const { container, rerender } = renderCard(match);
		await waitFor(() => {
			expect(headBadge(container)?.getAttribute("data-status")).toBe(
				"verified",
			);
		});

		// The store re-keys (the e2e drives this via a localStorage swap); the
		// next screen's receipt still arrives signed by the OLD key because the
		// engine's sealer pins its key at first seal. The badge must drop to the
		// untrusted-signer state — never stay green against a stale key.
		window.localStorage.clear();
		const rekeyed: Match = { ...match, score_receipt: { ...receipt } };
		rerender(
			<ul>
				<DossierCard dossier={dossierFromMatch(rekeyed)} />
			</ul>,
		);
		await waitFor(() => {
			expect(headBadge(container)?.getAttribute("data-status")).toBe(
				"wrong-key",
			);
		});
	});

	it("renders no receipt UI at all for a match without a receipt", () => {
		const { container } = renderCard(baseMatch());
		expect(container.querySelector(".receipt-status")).toBeNull();
		expect(container.querySelector(".match-card__receipt")).toBeNull();
		expect(screen.queryByText("Score proof")).toBeNull();
	});
});

// A receipt-bearing match must NEVER render badge-less: a silent badge gap is
// indistinguishable from "this match was never sealed", which quietly downgrades
// the product's central trust claim. So the trust-anchor lifecycle gets its own
// distinct, i18n'd rendered states — pending while the key loads, unavailable
// when storage is blocked or the load fails — alongside the verify verdicts.
describe("DossierCard trust-anchor states", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders the verification-PENDING state while the trust anchor loads (never badge-less)", async () => {
		const match = await signedMatch();
		const { container } = renderCard(match);

		// Synchronously after mount the key cannot have resolved yet — the badge
		// must already exist, in its pending state, not appear later from nothing.
		const badge = headBadge(container);
		expect(badge).not.toBeNull();
		expect(badge?.getAttribute("data-status")).toBe("pending");
		expect(badge?.querySelector(".receipt-status__text")?.textContent).toBe(
			"Checking score proof…",
		);

		// And it resolves into the real verdict, not a dead placeholder.
		await waitFor(() => {
			expect(headBadge(container)?.getAttribute("data-status")).toBe(
				"verified",
			);
		});
	});

	it("renders the verification-UNAVAILABLE state when the trust-anchor load FAILS (never badge-less)", async () => {
		const match = await signedMatch();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("storage fault");
		});

		const { container } = renderCard(match);
		await waitFor(() => {
			expect(headBadge(container)?.getAttribute("data-status")).toBe(
				"unavailable",
			);
		});

		// Icon + text in a live status region (WCAG 1.4.1 — same bar as verdicts).
		const badge = headBadge(container);
		expect(badge?.getAttribute("role")).toBe("status");
		expect(
			badge
				?.querySelector(".receipt-status__icon")
				?.getAttribute("aria-hidden"),
		).toBe("true");
		expect(badge?.querySelector(".receipt-status__text")?.textContent).toBe(
			"Score proof can't be checked here",
		);

		// No receipt panel may open against a missing trust anchor (fail-closed),
		// and the failure is audit-logged as a structured event.
		expect(container.querySelector(".match-card__receipt")).toBeNull();
		expect(warn).toHaveBeenCalledWith(
			"amlfilter.receipt.trust_anchor_load_failed",
			expect.anything(),
		);
	});

	it("renders the verification-UNAVAILABLE state when storage is blocked outright", async () => {
		const match = await signedMatch();
		const original = Object.getOwnPropertyDescriptor(
			globalThis,
			"localStorage",
		);
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			get() {
				throw new Error("storage blocked by policy");
			},
		});
		try {
			const { container } = renderCard(match);
			await waitFor(() => {
				expect(headBadge(container)?.getAttribute("data-status")).toBe(
					"unavailable",
				);
			});
		} finally {
			if (original !== undefined) {
				Object.defineProperty(globalThis, "localStorage", original);
			}
		}
	});
});

describe("DossierCard receipt panel", () => {
	it("discloses the full signed-receipt panel with envelope and sealed subject", async () => {
		const match = await signedMatch();
		const { container } = renderCard(match);

		// The disclosure appears once the install key (the trust anchor) has
		// loaded — no verdict UI renders against a missing key (fail-closed).
		await waitFor(() => {
			expect(
				container.querySelector("details.match-card__receipt"),
			).not.toBeNull();
		});
		const disclosure = container.querySelector("details.match-card__receipt");
		expect(disclosure?.querySelector("summary")?.textContent).toBe(
			"Score proof",
		);

		const panel = container.querySelector("section.receipt-panel");
		expect(panel).not.toBeNull();
		await waitFor(() => {
			expect(
				panel?.querySelector(".receipt-status")?.getAttribute("data-status"),
			).toBe("verified");
		});
		// Envelope metadata comes from the receipt-ui panel itself.
		expect(panel?.textContent).toContain("Ed25519");
		// The sealed subject renders through the card's payload renderer.
		expect(screen.getByText("score")).toBeTruthy();
		expect(panel?.textContent).toContain(
			String(match.score_receipt?.payload.score),
		);
		expect(panel?.textContent).toContain("(Strong)");
		expect(panel?.textContent).not.toContain("STRONG");
		expect(screen.getByText("engine-test-1")).toBeTruthy();
		expect(screen.getByText("watchlist-test-1")).toBeTruthy();
	});
});

// Retrieval provenance: which channels brought the entity into the candidate
// set. It is context beside the score evidence — never a score term — so the
// phonetic-only case carries an explicit "the score still decides" note.
describe("DossierCard retrieval provenance", () => {
	function openWhy(): void {
		fireEvent.click(screen.getByText("Why this score?"));
	}

	it("threads retrieved_via from the match into the dossier", () => {
		const match: Match = { ...baseMatch(), retrieved_via: ["token"] };
		expect(dossierFromMatch(match).retrieved_via).toEqual(["token"]);
	});

	it("lists every channel that reached the match, in order", () => {
		renderCard({
			...baseMatch(),
			retrieved_via: ["vector", "token", "phonetic"],
		});
		openWhy();
		expect(
			screen.getByText(
				"Found by: similar name · same word in the name · sounds similar",
			),
		).toBeVisible();
		expect(
			screen.queryByText(/found only because it sounds similar/),
		).toBeNull();
	});

	it("adds a plain note when pronunciation was the ONLY channel", () => {
		renderCard({ ...baseMatch(), retrieved_via: ["phonetic"] });
		openWhy();
		expect(screen.getByText("Found by: sounds similar")).toBeVisible();
		expect(
			screen.getByText(
				"This name was found only because it sounds similar. Sound never adds to the score — the score above still decides.",
			),
		).toBeVisible();
	});

	it("omits the line for a match without provenance (e.g. a stored row)", () => {
		renderCard(baseMatch());
		openWhy();
		expect(screen.queryByText(/^Found by:/)).toBeNull();
		cleanup();
		renderCard({ ...baseMatch(), retrieved_via: [] });
		openWhy();
		expect(screen.queryByText(/^Found by:/)).toBeNull();
	});
});

// Plain words on every result card. The codes stay in the data (the match, the
// signed receipt, exports); a visitor reads words. Each literal is pinned.
describe("DossierCard plain labels", () => {
	function scoredMatch(over: Partial<Match> = {}): Match {
		return {
			...baseMatch(),
			source_list: "UK_OFSI",
			reasons: [
				{
					signal: "name_vector",
					value: 0.753,
					weight: 0.55,
					contribution: 0.414,
					description: "Vector similarity: 0.753",
				},
				{
					signal: "name_sequence",
					value: 0.387,
					weight: 0.25,
					contribution: 0.097,
					description: "Sequence similarity: 0.387",
				},
			],
			explanation: "Match due to: strong vector similarity, alias match",
			...over,
		};
	}

	it("tags the result with the plain name of the list it came from", () => {
		const { container } = renderCard(scoredMatch());
		expect(container.querySelector(".match-card__list")?.textContent).toBe(
			"UK Sanctions List",
		);
		expect(container.textContent).not.toContain("UK_OFSI");
	});

	it("names the risk category in words", () => {
		const { container } = renderCard(scoredMatch());
		expect(container.querySelector(".match-card__badge")?.textContent).toBe(
			"Sanctioned",
		);
	});

	it("explains the score in plain words, never engine terms", () => {
		const { container } = renderCard(scoredMatch());
		fireEvent.click(screen.getByText("Why this score?"));
		expect(screen.getByText("Name likeness")).toBeVisible();
		expect(screen.getByText("75% alike")).toBeVisible();
		expect(screen.getByText("Spelling close")).toBeVisible();
		expect(screen.getByText("39% alike")).toBeVisible();
		expect(
			screen.getByText(
				"Why it matched: the names are very alike, matches a listed alias",
			),
		).toBeVisible();
		const text = container.textContent ?? "";
		for (const jargon of [
			"name_vector",
			"name_sequence",
			"Vector similarity",
			"Sequence similarity",
			"vector",
			"Metaphone",
		]) {
			expect(text).not.toContain(jargon);
		}
	});

	it("says a no-reason low score is weak instead of printing the engine line", () => {
		renderCard(
			scoredMatch({ explanation: "Low confidence match (score: 0.492)" }),
		);
		expect(screen.getByText("Weak match — check it by hand")).toBeVisible();
	});
});
