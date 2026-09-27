import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mirror of ScreenPage's debounce window so the stale-result test can wait out
// the first query's debounce before issuing the second.
const DEBOUNCE_MS = 180;

// Mirror of ScreenPage's SEARCH_K — the number of results the page asks the
// engine for. The truncation tests drive the engine to return EXACTLY this many
// (the capped case) and one fewer (the uncapped case). If the page's real cap
// ever moves, the "exactly K" fixture stops matching it and the capped test goes
// red rather than silently testing nothing.
const SEARCH_K = 25;

// Minimal Entity/Match doubles — only the fields ScreenPage reads.
const ivanEntity = {
	entity_id: "DEMO:1",
	entity_type: "PERSON",
	primary_name: "Ivan Fakovich",
	name_canonical: "ivan fakovich",
	aliases: [
		{
			name: "Vanya Fakovich",
			name_canonical: "vanya fakovich",
			source: "DEMO",
		},
	],
	dob: ["1971-03-14"],
	countries: ["RU"],
	nationalities: ["RU"],
	addresses: ["123 Invented Prospekt"],
	identifiers: { passport: ["FAKE0001"], national_id: [], other: {} },
	risk_category: "SANCTION",
	source_list: "DEMO_SDN",
	list_version: "demo-v1",
};
const olgaEntity = {
	...ivanEntity,
	entity_id: "DEMO:2",
	primary_name: "Olga Notrealova",
};

const ivanMatch = {
	...ivanEntity,
	aliases: ["Vanya Fakovich"],
	score: 0.7,
	reasons: [
		{
			signal: "name_vector",
			value: 1,
			weight: 0.55,
			contribution: 0.55,
			description: "Vector similarity: 1.000",
		},
	],
	explanation: "Match due to: strong vector similarity",
};

// Build a Match-like double carrying a name_sequence reason of the given value,
// so the strictness gate (which reads that reason) can be driven deterministically.
// `score` drives the presentation split: below Balanced's 0.40 display line a
// kept match renders grouped under the low-confidence disclosure, not primary.
function matchWithTrigram(
	over: { entity_id: string; primary_name: string },
	trigram: number,
	score = 0.301,
): typeof ivanMatch {
	return {
		...ivanMatch,
		entity_id: over.entity_id,
		primary_name: over.primary_name,
		score,
		reasons: [
			{
				signal: "name_vector",
				value: 0.45,
				weight: 0.55,
				contribution: 0.2475,
				description: "Vector similarity: 0.450",
			},
			{
				signal: "name_sequence",
				value: trigram,
				weight: 0.2,
				contribution: trigram * 0.2,
				description: `Sequence similarity: ${trigram.toFixed(3)}`,
			},
		],
	};
}

// The strictness scenario: a real query ("ivan fal") that the engine returns
// BOTH an intended close hit (Ivan, high trigram ~0.667) AND irrelevant vector
// noise (Hassan-like, low trigram ~0.261) for. The combined-score floor lets the
// noise through; the lexical gate is what hides it at Balanced/Strict.
const ivanCloseMatch = matchWithTrigram(
	{ entity_id: "DEMO:IVAN", primary_name: "Ivan Fakovich" },
	0.667,
	// A realistic close-hit combined score — comfortably above Balanced's 0.40
	// display line, so the intended hit renders as a PRIMARY match card.
	0.55,
);
const hassanNoiseMatch = matchWithTrigram(
	{ entity_id: "DEMO:HASSAN", primary_name: "Hassan Pretendi" },
	0.261,
);
// The live-observed junk shape ("Zzyzx Nobody" → 0.32–0.36 fuzz): nonsense
// whose fuzz PASSES the lexical gate (trigram ≥ 0.35) yet lands in the
// 0.30–0.40 combined band. At Balanced these must render grouped under the
// collapsed low-confidence disclosure — never as primary match cards. At
// Lenient they stay primary (show-everything preserved).
const zzyzxFuzzOne = matchWithTrigram(
	{ entity_id: "DEMO:ZZ1", primary_name: "Zzyzx Impostor One" },
	0.36,
	0.362,
);
const zzyzxFuzzTwo = matchWithTrigram(
	{ entity_id: "DEMO:ZZ2", primary_name: "Zzyzx Impostor Two" },
	0.36,
	0.322,
);
const nobodyFuzz = matchWithTrigram(
	{ entity_id: "DEMO:NOBODY", primary_name: "Nobody Impostor One" },
	0.36,
	0.362,
);
// The reported production shape: a one-token "obama" query received only weak
// nearest neighbours. Some happen to share a few letters ("Osama"), but none
// carries the exact published token and none clears the Balanced display line.
// They must not be advertised as analyst candidates.
const obamaNoise = [
	matchWithTrigram(
		{ entity_id: "DEMO:ASSAD", primary_name: "Al-Assad Bashar" },
		0.4,
		0.386,
	),
	matchWithTrigram(
		{ entity_id: "DEMO:OSAMA", primary_name: "Mehmood Osama" },
		0.8,
		0.349,
	),
];
// The token-containment case: a short query ("bank") against a long org name has
// a tiny trigram (~0.267 < 0.35) yet must be KEPT because the query token "bank"
// is one of the entity's canonical name tokens.
const bankMatch = matchWithTrigram(
	{ entity_id: "DEMO:BANK", primary_name: "Madeupistan Imaginary Bank" },
	0.267,
);
// A NON-PERSON entity (an organization). The signed watchlist wire format
// carries no entity type, so — like every bundle-materialized entity — it
// arrives with the engine's "PERSON" placeholder. That placeholder is the
// mislabel the match card must not surface. Kept via token-containment on "banco".
const bancoMatch = matchWithTrigram(
	{ entity_id: "DEMO:BANCO", primary_name: "Banco Nacional De Cuba" },
	0.2,
	// Above the display line so the card renders primary — this double exists
	// for the type-badge assertion, not the confidence split.
	0.45,
);

// A broad query ("mohammed" on the live site) returns a full page of near-identical
// primary cards. Build n of them named after the query token, so they clear the
// page's lexical gate by token containment, and score them above the display line
// so all n render as primary cards rather than grouped low-confidence ones.
function broadMatches(given: string, n: number): Array<typeof ivanMatch> {
	return Array.from({ length: n }, (_, i) => ({
		...ivanMatch,
		entity_id: `DEMO:${given.toUpperCase()}${i}`,
		primary_name: `${given} Placeholder ${i}`,
		score: 0.7,
	}));
}

// Two distinguishable matches for the stale-cancellation test. The "slow"
// query resolves LATER (longer delay) than the "fast" one, so if cancellation
// is broken the slow result would clobber the fast one.
const slowMatch = {
	...ivanMatch,
	entity_id: "DEMO:SLOW",
	primary_name: "Ivan Slowman",
};
const fastMatch = {
	...ivanMatch,
	entity_id: "DEMO:FAST",
	primary_name: "Ivan Fastman",
};

// Thresholds the page passed to engine.screen, in call order — lets a test
// assert the strictness level maps to the documented floor.
const observedThresholds: Array<number | undefined> = [];

// The dob the page passed to engine.screen, in call order — lets a test assert
// the Date-of-birth input threads its YYYY-MM-DD value through to screening.
const observedDobs: Array<string | undefined> = [];

// The public screen is intentionally bounded to the OFAC list. The route's
// copy promises OFAC screening, and loading every signed list on iOS can exceed
// Safari's tab/WASM memory ceiling before the model is ready.
const observedSelections: Array<unknown> = [];

// The page builds its own EngineRuntime; mock the module so the test drives a
// deterministic engine with no Worker/bundle/model.
vi.mock("@amlfilter/browser", async (importActual) => {
	// Keep the REAL canonicalize so the page's token-containment tokenizes names
	// exactly as the engine's trigram does — only the runtime/engine is faked.
	const actual = await importActual<typeof import("@amlfilter/browser")>();
	class EngineRuntime {
		// The real runtime always exposes this, and /screen reads it to state the
		// age of the list it screens against. A mock without it would leave the page
		// permanently reporting "age unknown".
		catalogLists() {
			return Promise.resolve([
				{
					id: "OFAC_SDN",
					title: "OFAC SDN",
					version: "demo-1",
					entitiesCount: 1,
					fetchedAt: "2026-08-01T08:00:00Z",
					agedFrom: "fetchedAt",
					sourceUpdatedAt: null,
					stale: false,
					staleReason: null,
				},
			]);
		}
		bootstrap(
			_config: unknown,
			_onStage?: unknown,
			selection?: unknown,
		): Promise<void> {
			observedSelections.push(selection);
			return Promise.resolve();
		}
		engine() {
			return {
				allEntities: () => [ivanEntity, olgaEntity],
				screen: ({
					name,
					threshold,
					dob,
				}: {
					name: string;
					threshold?: number;
					dob?: string;
				}) => {
					const lower = name.toLowerCase();
					// Record the floor the page passed per call so a test can assert
					// the strictness level actually changes the engine threshold.
					observedThresholds.push(threshold);
					// Record the dob so a test can assert the Date-of-birth input
					// threads its value straight into the engine.screen call.
					observedDobs.push(dob);
					// A dob alongside an "ivan" query surfaces the exact-DOB-match
					// reason the parity-locked scorer emits, so the dossier renders it.
					if (lower.includes("ivan") && dob === "1971-03-14") {
						return Promise.resolve({
							request_id: "ivandob",
							list_versions_used: {},
							execution_time_ms: 4,
							matches: [
								{
									...ivanMatch,
									reasons: [
										...ivanMatch.reasons,
										{
											signal: "dob_match",
											value: 1,
											weight: 0.1,
											contribution: 0.1,
											description: "Exact DOB match: 1971-03-14",
										},
									],
								},
							],
						});
					}
					// "ivan fal": the engine returns the close hit AND the vector
					// noise; the page's lexical gate decides which survive.
					if (lower.includes("ivan fal")) {
						return Promise.resolve({
							request_id: "ivanfal",
							list_versions_used: {},
							execution_time_ms: 3,
							matches: [ivanCloseMatch, hassanNoiseMatch],
						});
					}
					// "bank": low-trigram org kept only via token-containment.
					if (lower === "bank") {
						return Promise.resolve({
							request_id: "bank",
							list_versions_used: {},
							execution_time_ms: 3,
							matches: [bankMatch],
						});
					}
					// "banco": a non-person org whose wire record has no entity type.
					if (lower === "banco") {
						return Promise.resolve({
							request_id: "banco",
							list_versions_used: {},
							execution_time_ms: 3,
							matches: [bancoMatch],
						});
					}
					// "zzyzx": ONLY sub-line fuzz — the pure junk-query case. Every
					// candidate passes the gate but sits below the 0.40 display line.
					if (lower.includes("zzyzx")) {
						return Promise.resolve({
							request_id: "zzyzx",
							list_versions_used: {},
							execution_time_ms: 3,
							matches: [zzyzxFuzzOne, zzyzxFuzzTwo],
						});
					}
					if (lower === "obama") {
						return Promise.resolve({
							request_id: "obama",
							list_versions_used: {},
							execution_time_ms: 3,
							matches: obamaNoise,
						});
					}
					// "nobody ivan": a strong hit ALONGSIDE sub-line fuzz — the mixed case.
					if (lower.includes("nobody ivan")) {
						return Promise.resolve({
							request_id: "mixed",
							list_versions_used: {},
							execution_time_ms: 3,
							matches: [ivanCloseMatch, nobodyFuzz],
						});
					}
					// "mohammed": the engine fills the request exactly — the signal that
					// the result list was cut off at k and more may exist behind it.
					if (lower.includes("mohammed")) {
						return Promise.resolve({
							request_id: "capped",
							list_versions_used: {},
							execution_time_ms: 6,
							matches: broadMatches("Mohammed", SEARCH_K),
						});
					}
					// "mustafa": one short of the cap — the engine ran out of candidates,
					// so this IS the whole list and nothing was cut off.
					if (lower.includes("mustafa")) {
						return Promise.resolve({
							request_id: "nearcap",
							list_versions_used: {},
							execution_time_ms: 6,
							matches: broadMatches("Mustafa", SEARCH_K - 1),
						});
					}
					// Delay-aware branches drive the stale-result test: "slow"
					// resolves LATER than "fast" despite being issued FIRST.
					if (lower.includes("slow")) {
						return new Promise((resolve) =>
							setTimeout(
								() =>
									resolve({
										request_id: "slow",
										list_versions_used: {},
										execution_time_ms: 80,
										matches: [slowMatch],
									}),
								80,
							),
						);
					}
					if (lower.includes("fast")) {
						return new Promise((resolve) =>
							setTimeout(
								() =>
									resolve({
										request_id: "fast",
										list_versions_used: {},
										execution_time_ms: 5,
										matches: [fastMatch],
									}),
								5,
							),
						);
					}
					return Promise.resolve({
						request_id: "t",
						list_versions_used: {},
						execution_time_ms: 4,
						matches: lower.includes("ivan") ? [ivanMatch] : [],
					});
				},
			};
		}
		dispose(): Promise<void> {
			// The page disposes its page-owned runtime on real unmount (deferred one
			// macrotask); a resolved no-op keeps that teardown inert here.
			return Promise.resolve();
		}
	}
	return {
		...actual,
		EngineRuntime,
		configFromEnv: () => ({}),
		// Force "supported" so the boot proceeds: the real engineSupport reads
		// globalThis, and jsdom lacks Worker/OPFS, which would otherwise route
		// every test to the unsupported-device screen.
		engineSupport: () => ({ supported: true, missing: [] }),
	};
});

import { ScreenPage } from "./ScreenPage";

afterEach(() => {
	cleanup();
	observedThresholds.length = 0;
	observedDobs.length = 0;
	observedSelections.length = 0;
});

// Wait until the search box is enabled (boot resolved) and return it.
async function readyBox(): Promise<HTMLInputElement> {
	return (await waitFor(() => {
		const el = screen.getByPlaceholderText(/Search a name/);
		expect((el as HTMLInputElement).disabled).toBe(false);
		return el;
	})) as HTMLInputElement;
}

describe("ScreenPage — in-browser search", () => {
	// CONTRACT CHANGE: this pinned the OFAC-only boot. The home page promises
	// four lists, so a desktop now boots every catalog list; the bounded OFAC
	// selection is the phone default (see ScreenPage.scope.test.tsx).
	it("boots every catalog list on a desktop", async () => {
		render(<ScreenPage />);
		await waitFor(() =>
			expect(observedSelections).toEqual([{ residency: "eager" }]),
		);
	});

	it("opens the paginated directory when the box is empty", async () => {
		render(<ScreenPage />);
		await waitFor(() =>
			expect(screen.getByText("Showing 1–2 of 2 entities")).toBeTruthy(),
		);
		// "Ivan Fakovich" is also an example chip — scope to the card name.
		expect(
			screen.getByText("Ivan Fakovich", { selector: ".match-card__name" }),
		).toBeTruthy();
		expect(screen.getByText("Olga Notrealova")).toBeTruthy();
	});

	it("shows a scored, explainable dossier for a matching query", async () => {
		render(<ScreenPage />);
		const box = await waitFor(() => {
			const el = screen.getByPlaceholderText(/Search a name/);
			expect((el as HTMLInputElement).disabled).toBe(false);
			return el;
		});
		fireEvent.change(box, { target: { value: "ivan" } });
		await waitFor(() =>
			expect(screen.getByText(/1 potential match/)).toBeTruthy(),
		);
		expect(screen.getByText("0.700")).toBeTruthy();
		expect(screen.getByText("123 Invented Prospekt")).toBeTruthy();
		expect(screen.getByText("Why this score?")).toBeTruthy();
	});

	it("shows a clean no-match for an unrelated query", async () => {
		render(<ScreenPage />);
		const box = await waitFor(() => {
			const el = screen.getByPlaceholderText(/Search a name/);
			expect((el as HTMLInputElement).disabled).toBe(false);
			return el;
		});
		fireEvent.change(box, { target: { value: "zxqw" } });
		await waitFor(() =>
			expect(screen.getByText(/No sanctions match/)).toBeTruthy(),
		);
	});

	it("renders only the latest query's result when an earlier search resolves later", async () => {
		render(<ScreenPage />);
		const box = await waitFor(() => {
			const el = screen.getByPlaceholderText(/Search a name/);
			expect((el as HTMLInputElement).disabled).toBe(false);
			return el;
		});
		// Issue the SLOW query first (resolves after ~80ms), wait for its
		// debounced search to actually fire, then issue the FAST query (resolves
		// after ~5ms). The fast result must win and the slow result, arriving
		// later, must NOT overwrite it — the seq-ref cancellation contract.
		fireEvent.change(box, { target: { value: "ivan slow" } });
		await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + 20));
		fireEvent.change(box, { target: { value: "ivan fast" } });

		await waitFor(
			() =>
				expect(
					screen.getByText("Ivan Fastman", { selector: ".match-card__name" }),
				).toBeTruthy(),
			{ timeout: 1000 },
		);
		// Give the slower (earlier) search ample time to resolve and (wrongly)
		// clobber the UI if cancellation were broken.
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(
			screen.getByText("Ivan Fastman", { selector: ".match-card__name" }),
		).toBeTruthy();
		expect(screen.queryByText("Ivan Slowman")).toBeNull();
	});

	it("exposes a labeled, keyboard-operable strictness radiogroup defaulting to Balanced", async () => {
		render(<ScreenPage />);
		await readyBox();
		const group = screen.getByRole("radiogroup", { name: /match strictness/i });
		expect(group).toBeTruthy();
		const balanced = screen.getByRole("radio", { name: /balanced/i });
		expect(balanced.getAttribute("aria-checked")).toBe("true");
		// ArrowRight from Balanced selects Strict.
		balanced.focus();
		fireEvent.keyDown(balanced, { key: "ArrowRight" });
		await waitFor(() =>
			expect(
				screen
					.getByRole("radio", { name: /strict/i })
					.getAttribute("aria-checked"),
			).toBe("true"),
		);
	});

	it("hides low-trigram vector noise at the default Balanced strictness", async () => {
		render(<ScreenPage />);
		const box = await readyBox();
		fireEvent.change(box, { target: { value: "ivan fal" } });
		await waitFor(() =>
			expect(
				screen.getByText("Ivan Fakovich", { selector: ".match-card__name" }),
			).toBeTruthy(),
		);
		// Hassan is vector noise (trigram 0.261 < 0.35, no token overlap) → dropped.
		expect(screen.queryByText("Hassan Pretendi")).toBeNull();
	});

	it("shows the noise again when switched to Lenient and re-runs the search", async () => {
		render(<ScreenPage />);
		const box = await readyBox();
		fireEvent.change(box, { target: { value: "ivan fal" } });
		await waitFor(() =>
			expect(
				screen.getByText("Ivan Fakovich", { selector: ".match-card__name" }),
			).toBeTruthy(),
		);
		fireEvent.click(screen.getByRole("radio", { name: /lenient/i }));
		// Changing strictness re-runs search live; the noise now reappears.
		await waitFor(() =>
			expect(
				screen.getByText("Hassan Pretendi", { selector: ".match-card__name" }),
			).toBeTruthy(),
		);
		expect(
			screen.getByText("Ivan Fakovich", { selector: ".match-card__name" }),
		).toBeTruthy();
		// Lenient passes the lower floor (0.30); Strict would pass 0.40.
		expect(observedThresholds).toContain(0.3);
	});

	it("keeps only the closest match under Strict", async () => {
		render(<ScreenPage />);
		const box = await readyBox();
		fireEvent.change(box, { target: { value: "ivan fal" } });
		await waitFor(() =>
			expect(
				screen.getByText("Ivan Fakovich", { selector: ".match-card__name" }),
			).toBeTruthy(),
		);
		fireEvent.click(screen.getByRole("radio", { name: /strict/i }));
		// Ivan's trigram (0.667) clears Strict's 0.50; Hassan's (0.261) never does.
		await waitFor(() => expect(observedThresholds).toContain(0.4));
		expect(screen.queryByText("Hassan Pretendi")).toBeNull();
		expect(
			screen.getByText("Ivan Fakovich", { selector: ".match-card__name" }),
		).toBeTruthy();
	});

	it("keeps a short keyword match via token-containment even below minLexical (the 'bank' case)", async () => {
		render(<ScreenPage />);
		const box = await readyBox();
		// "bank" vs "Madeupistan Imaginary Bank": trigram 0.267 < 0.35, but the
		// query token "bank" equals an entity name token → KEPT at Balanced.
		// Its combined score (0.301) sits below the 0.40 display line, so it is
		// presented inside the low-confidence disclosure — kept, not dropped.
		fireEvent.change(box, { target: { value: "bank" } });
		const name = await waitFor(() =>
			screen.getByText("Madeupistan Imaginary Bank", {
				selector: ".match-card__name",
			}),
		);
		expect(name.closest("details.screen-results__low")).not.toBeNull();
	});

	it("groups sub-line fuzz under a collapsed disclosure at Balanced (the 'Zzyzx Nobody' case)", async () => {
		render(<ScreenPage />);
		const box = await readyBox();
		fireEvent.change(box, { target: { value: "Zzyzx Nobody" } });
		// The disclosure summary counts the grouped candidates and names the level.
		await waitFor(() =>
			expect(
				screen.getByText(
					"2 low-confidence candidates (below Balanced threshold)",
				),
			).toBeTruthy(),
		);
		// No primary match cards: the count line is absent and an honest
		// nothing-above-the-line headline renders in its place.
		expect(screen.queryByText(/potential match/)).toBeNull();
		expect(
			screen.getByText(/No match above the Balanced threshold/),
		).toBeTruthy();
		// Every candidate is KEPT (recall) but sits INSIDE the disclosure,
		// which starts collapsed.
		const details = document.querySelector(
			"details.screen-results__low",
		) as HTMLDetailsElement;
		expect(details.open).toBe(false);
		for (const fuzz of ["Zzyzx Impostor One", "Zzyzx Impostor Two"]) {
			const card = screen.getByText(fuzz, { selector: ".match-card__name" });
			expect(card.closest("details.screen-results__low")).toBe(details);
		}
	});

	it("reports an honest no-match for 'obama' without exposing weak nearest-neighbour noise", async () => {
		render(<ScreenPage />);
		const box = await readyBox();
		fireEvent.change(box, { target: { value: "obama" } });

		await waitFor(() =>
			expect(
				screen.getByText(/No match above the Balanced threshold/),
			).toBeTruthy(),
		);
		expect(screen.queryByText(/low-confidence candidate/)).toBeNull();
		expect(document.querySelector("details.screen-results__low")).toBeNull();
		expect(screen.queryByText("Al-Assad Bashar")).toBeNull();
		expect(screen.queryByText("Mehmood Osama")).toBeNull();
	});

	it("keeps a strong hit as a primary card while grouping sub-line fuzz (the mixed case)", async () => {
		render(<ScreenPage />);
		const box = await readyBox();
		fireEvent.change(box, { target: { value: "nobody ivan" } });
		// The count line counts ONLY primary matches (1, not 2).
		await waitFor(() =>
			expect(screen.getByText(/1 potential match/)).toBeTruthy(),
		);
		const strong = screen.getByText("Ivan Fakovich", {
			selector: ".match-card__name",
		});
		expect(strong.closest("details")).toBeNull();
		// The fuzz is grouped, not interleaved with the primary card.
		const fuzz = screen.getByText("Nobody Impostor One", {
			selector: ".match-card__name",
		});
		expect(fuzz.closest("details.screen-results__low")).not.toBeNull();
		expect(
			screen.getByText("1 low-confidence candidate (below Balanced threshold)"),
		).toBeTruthy();
	});

	it("renders every candidate as a primary card at Lenient (show-everything preserved)", async () => {
		render(<ScreenPage />);
		const box = await readyBox();
		fireEvent.change(box, { target: { value: "Zzyzx Nobody" } });
		await waitFor(() =>
			expect(
				screen.getByText(
					"2 low-confidence candidates (below Balanced threshold)",
				),
			).toBeTruthy(),
		);
		fireEvent.click(screen.getByRole("radio", { name: /lenient/i }));
		// Lenient declares no display line: both fuzz candidates become primary
		// cards, the disclosure disappears, and the count line counts them all.
		await waitFor(() =>
			expect(screen.getByText(/2 potential matches/)).toBeTruthy(),
		);
		expect(screen.queryByText(/low-confidence candidate/)).toBeNull();
		expect(document.querySelector("details.screen-results__low")).toBeNull();
		for (const fuzz of ["Zzyzx Impostor One", "Zzyzx Impostor Two"]) {
			const card = screen.getByText(fuzz, { selector: ".match-card__name" });
			expect(card.closest("details")).toBeNull();
		}
	});

	it("renders an optional Date-of-birth input alongside the search box", async () => {
		render(<ScreenPage />);
		await readyBox();
		const dobInput = screen.getByLabelText(
			/date of birth/i,
		) as HTMLInputElement;
		expect(dobInput).toBeTruthy();
		expect(dobInput.type).toBe("date");
		// Optional: starts empty.
		expect(dobInput.value).toBe("");
	});

	it("threads the entered DOB into the engine.screen call", async () => {
		render(<ScreenPage />);
		const box = await readyBox();
		const dobInput = screen.getByLabelText(/date of birth/i);
		fireEvent.change(dobInput, { target: { value: "1971-03-14" } });
		fireEvent.change(box, { target: { value: "ivan" } });
		await waitFor(() =>
			expect(screen.getByText(/1 potential match/)).toBeTruthy(),
		);
		// The page passed the date input's YYYY-MM-DD value straight through.
		expect(observedDobs).toContain("1971-03-14");
	});

	it("surfaces the dob_match reason in the dossier when a matching DOB is entered", async () => {
		render(<ScreenPage />);
		const box = await readyBox();
		const dobInput = screen.getByLabelText(/date of birth/i);
		fireEvent.change(dobInput, { target: { value: "1971-03-14" } });
		fireEvent.change(box, { target: { value: "ivan" } });
		await waitFor(() =>
			expect(screen.getByText(/1 potential match/)).toBeTruthy(),
		);
		// The reasons[] detail block now carries the exact-DOB-match line.
		expect(screen.getByText("Exact DOB match: 1971-03-14")).toBeTruthy();
	});

	it("omits dob from the engine.screen call when the DOB input is left empty", async () => {
		render(<ScreenPage />);
		const box = await readyBox();
		fireEvent.change(box, { target: { value: "ivan" } });
		await waitFor(() =>
			expect(screen.getByText(/1 potential match/)).toBeTruthy(),
		);
		// Empty date input must not pass an empty string — it is omitted entirely.
		expect(observedDobs.every((d) => d === undefined)).toBe(true);
	});

	it("does not mislabel a non-person entity with a PERSON type badge", async () => {
		render(<ScreenPage />);
		const box = await readyBox();
		fireEvent.change(box, { target: { value: "banco" } });
		const name = await waitFor(() =>
			screen.getByText("Banco Nacional De Cuba", {
				selector: ".match-card__name",
			}),
		);
		const card = name.closest("li.match-card") as HTMLElement;
		// The signed watchlist wire format carries no entity type, so an org
		// materializes with the engine's "PERSON" placeholder. Rather than assert a
		// fabricated "PERSON" for a bank, the dossier OMITS the type label.
		expect(card.querySelector(".match-card__type")).toBeNull();
		expect(within(card).queryByText("PERSON")).toBeNull();
	});
});

/**
 * The page asks the engine for a fixed number of results (SEARCH_K). A broad
 * query — "mohammed" on the live site — fills that quota with near-identical
 * cards, and nothing on screen told the reader whether they were looking at ALL
 * the matches or merely the first 25. That is the difference between "this list
 * is complete" and "there may be more you cannot see", which on a sanctions
 * screen is not a cosmetic distinction.
 *
 * The engine reports no total, so the honest statement is that the list was
 * capped — never "25 of 431". And a full-quota return is the ONLY evidence of a
 * cap: one result short means the engine ran out of candidates, so the note must
 * stay off rather than becoming permanent furniture.
 */
describe("ScreenPage — a capped result list says so", () => {
	it("flags the list as capped when the engine fills the whole quota", async () => {
		render(<ScreenPage />);
		const box = await readyBox();
		fireEvent.change(box, { target: { value: "mohammed" } });

		const note = await waitFor(() =>
			screen.getByText(/closest matches/i, {
				selector: ".screen-results__capped",
			}),
		);
		// The number in the copy is the page's real cap rendered through the real
		// path — not a literal typed into the catalogue — and it is the count of
		// cards actually on screen.
		expect(note.textContent).toContain(String(SEARCH_K));
		expect(
			screen.getAllByText(/Mohammed Placeholder/, {
				selector: ".match-card__name",
			}),
		).toHaveLength(SEARCH_K);
		// It must read as a cap, not as an exact total the engine never reported.
		expect(note.textContent).not.toMatch(/\bof\s+\d/i);
	});

	it("stays silent when the engine returns fewer results than the cap", async () => {
		render(<ScreenPage />);
		const box = await readyBox();
		fireEvent.change(box, { target: { value: "mustafa" } });

		await waitFor(() =>
			expect(
				screen.getAllByText(/Mustafa Placeholder/, {
					selector: ".match-card__name",
				}),
			).toHaveLength(SEARCH_K - 1),
		);
		expect(document.querySelector(".screen-results__capped")).toBeNull();
	});
});
