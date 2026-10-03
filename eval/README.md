# eval — how good is the decision?

**TL;DR.** aml-filter has measured retrieval recall for months. This directory measures the other
half: of the alerts the product raises, how many are the entity you screened, and how often does a
real sanctions match produce nothing at all. It reads an artifact the TypeScript emitter writes and
scores it with [`assay-engine`](https://pypi.org/project/assay-engine/) pinned to
`0.5.0.dev6`. It ships **zero bytes** to the browser.

Before you quote any number here, read
[`src/amlfilter_eval/collision.py`](./src/amlfilter_eval/collision.py). It carries one assumption
that sets a ceiling on every figure, and the owner has not ruled on it yet.

## Run it

```bash
# From the repo root. ~3 minutes: the emitter rebuilds the screening engine over a
# frozen 19,181-entity OFAC snapshot with the real MiniLM embedder, screens the
# sample, and the scorer grades it.
cd frontend && pnpm --filter @amlfilter/publisher run gate:decision
```

That is one command on purpose. It emits the evidence and scores it in the same breath, so the
committed floors can never grade a run describing a matcher that is no longer in the tree.

To re-measure and move the committed baseline (floors ratchet — they only go up):

```bash
cd frontend && pnpm --filter @amlfilter/publisher run measure-decision
```

The quality gate for this package alone:

```bash
cd eval && uv run poe gate     # ruff -> mypy -> xenon -> pytest (>=90% coverage)
```

## Why recall@k was not enough

`recall@25` answers *did the sanctioned entity appear in the results.* It is 1.0 here, and it is
true. It cannot answer either of the questions a compliance officer actually asks:

- **How much of what we showed was noise?** That is precision, and nothing measured it.
- **How often did we show nothing for a real match?** That is the false-negative rate, and nothing
  measured that either.

Before this directory existed there was no precision, no FPR, no FNR and no F1 anywhere in the
repository. The product's launch is gated on the miss rate of the decision, and nobody knew it.

## How it works

```
TypeScript                                  Python
──────────                                  ──────
frozen OFAC snapshot (sha256-pinned)
  → real MiniLM embedder
  → real ScreeningEngine
  → 4 segments of queries
  → the LIVE strictness decision       →    assay.metrics.binary_scores
    per (query, entity) pair                → precision / recall / F1 / FPR / FNR
                                            → compared against committed floors
  .decision-out/*.jsonl (generated)         baselines/decision-baseline.json (committed)
```

Two rules govern the split, and both are load-bearing:

**The metric is Python's.** One rule written in two languages will diverge, and only the rendered
number would ever show it. Nothing in this package or in the TypeScript emitter reimplements a
metric — `assay` is imported in exactly one file
([`assay_seam.py`](./src/amlfilter_eval/assay_seam.py)) and nowhere else.

**The decision is TypeScript's.** For the same reason, in the other direction. The emitter computes
"would the user have been shown this entity, at this strictness level" using
[`decide.ts`](../frontend/packages/amlfilter-publisher/src/decision/decide.ts) and writes the answer
as a boolean. Python reads booleans. `decide.ts` is in turn held to the app's real
`passesStrictness` / `partitionByConfidence` by
[`decisionParity.test.ts`](../frontend/app/src/pages/decisionParity.test.ts), which drives both
implementations over a 198-case boundary grid at every level.

### The thresholds are the live ones

`PRESETS` in the engine carries 0.75 / 0.65 / 0.55 and **no user has ever been screened at any of
them** — the /screen page always overrides with `LEVEL[strictness].floor`. Balanced sends floor 0.30
and a 0.35 lexical gate, with a 0.40 line splitting leading cards from the collapsed low-confidence
group. Those are the numbers measured here.

### The four segments, never averaged

| segment | what it is | what it measures |
| --- | --- | --- |
| `alias` | a name OFAC publishes for a designation | the product's actual promise |
| `canonical` | a designation's own primary name | the floor case |
| `clean-hard` | two designations' name elements recombined | false positives under adversarial input |
| `clean-plain` | ordinary names with **zero** token overlap | false positives on a normal customer |

The two negative populations are **bounds, not samples of one thing**, and they are never pooled
with each other. `clean-hard` is built from tokens the sanctions list itself publishes, so the
lexical gate's whole-token escape hatch fires on all of it and its false-positive rate saturates.
`clean-plain` holds that variable at zero. The truth for any real screening population is between
them and much nearer the plain one. See
[`negatives.ts`](../frontend/packages/amlfilter-publisher/src/decision/negatives.ts) and
[`plainNames.ts`](../frontend/packages/amlfilter-publisher/src/decision/plainNames.ts) for exactly
how each is built and — more importantly — what neither covers.

## A floor that cannot fail is refused

`clean-hard`'s query-level FPR is exactly 1.0 at Balanced: every recombined name produces at least
one alert. A ceiling of 1.0 is satisfied by every possible measurement, so committing it as a
"floor" would add a permanently green check that gates nothing. `write` refuses to do that. Such
metrics are still measured and still written into the baseline — under `saturated`, not under
`floors` — so a reader can see which numbers are pinned and why.

This is the defect this portfolio keeps finding in its own guards: a check that reports success
because it cannot report anything else looks identical to a passing one. Here it cannot be
committed.
