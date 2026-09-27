# Architecture

**TL;DR.** aml-filter is a **zero-server, pure-TypeScript** app. It screens a name
against **multiple sanctions lists** (OFAC SDN, EU, UN, UK asset-freeze) and returns a
**scored, explained** result entirely in the browser tab, with no application backend
or screening API. A small **publisher** turns each official list into a signed,
self-contained file and registers them in a signed **catalog**; the **browser engine**
verifies the catalog and every list and screens across all enabled lists in-tab; the
**workstation** app stores KYC customers, matches, settings, and audit events in a
local SQLite-WASM database and wraps them in an auditable review workflow. Public
retrieval uses the shared `@edgeproc/browser` Worker with SQLite 3.53.4 (the latest
stable release when this contract was updated) and sqlite-vector 1.1.2. One derived
in-memory database per immutable signed list owns both vector rows and bounded exact
canonical-token/Double-Metaphone postings. TypeScript generates the keys and preserves
the transparent final scoring contract. One screening pipeline, one explainable scoring
contract, three TypeScript units.

There is no Python, no Postgres, no Docker, and no HTTP screening endpoint. The lists ship as
a signed, content-addressed bundle of static files you can host on any CDN, delta-synced
and cached durably in the browser so a repeat visit does not re-download them; the trust comes from
an Ed25519 signature the browser checks — over fetched *and* cached bytes — before it
will load a single byte.

## Why zero-server

Sanctions screening usually means standing up a service, a vector database, and an
ingestion pipeline. But the major sanctions lists are small — each on the order of ~10⁴
entities — small enough that a browser tab can hold and query them locally. Once
you accept that, the server disappears:

- **No server-side vector database.** Candidate retrieval uses sqlite-vector in a browser
  Worker, one isolated in-memory SQLite database per immutable signed list. There is no
  ANN service, pgvector instance, or database server to operate. The signed bundle remains
  the durable public-data authority; the separate workstation SQLite/OPFS database stores
  private KYC state.
- **No backend.** Embedding the *query* name runs in the tab via transformers.js, once,
  and is reused across every list. The lists' vectors were precomputed once at publish
  time, so the tab never has to embed a list.
- **No trusted server in the request path.** The lists ship as a signed,
  content-addressed bundle: a signed pointer names a content-hashed manifest that names
  every chunk. The tab verifies the signed pointer against a pinned public key and
  content-verifies every chunk + reassembled file before loading — and re-verifies the
  same way over the durable browser cache — so a hostile or buggy CDN (or a poisoned cache)
  can't slip in a tampered list. Verification is **fail-closed**.

What you give up is server-side scale; what you get is a screening tool that runs
entirely on the user's machine, with the customer's KYC data never leaving the device.

## The pipeline (the same shape everywhere)

Every screen — whether it's a one-off query or an automatic re-screen of a stored
customer — follows the same five stages:

```
normalize → embed → SQLite vector + lexical retrieve → explainable weighted score → threshold → reasons
```

1. **Normalize.** Lower-case the name, strip accents and honorifics, and run it through
   `canonicalize()`. This is the load-bearing detail: the **same** `canonicalize()`
   (`frontend/packages/amlfilter-browser/src/engine/normalize.ts`) is used by both the
   publisher (when it precomputes each entity's `name_canonical`) and the browser (when
   it normalizes the query). If query and corpus were canonicalized differently, vector
   similarity would be comparing apples to oranges. The publisher imports the exact
   function from `@amlfilter/browser`, so there is one source of truth.
2. **Embed.** A sentence-transformers model — `Xenova/all-MiniLM-L6-v2`, 384-dim
   (`EMBEDDING_MODEL` / `EMBEDDING_DIM` in `embedder.ts`) — turns the normalized name
   into a vector. The publisher runs this model **in Node** to precompute one vector per
   entity name; the browser runs the **same** model **in the tab** to embed the query or
   customer name. Same model, same space, both runtimes — which is what makes the
   precomputed vectors comparable to the live query vector.
3. **Retrieve.** `vectorIndex.ts` delegates cosine search and namespaced posting lookup
   to `@edgeproc/browser/vector/sqlite`: SQLite 3.53.4 plus sqlite-vector 1.1.2 in a
   Worker. TypeScript derives exact canonical-token and Double-Metaphone keys from every
   primary name and alias. SQLite stores those postings beside the vectors, filters
   high-document-frequency keys, and returns a bounded deterministic id set. The engine
   unions those ids with sqlite-vector neighbours; `MultiListScreeningEngine` then merges
   and deterministically re-ranks the per-list candidates.
4. **Score.** `computeScore` (`scoring.ts`) adapts five typed AML signals into the exact
   `@edgeproc/assay@0.5.0-dev.3` additive contract. Assay is the score source of truth.
5. **Threshold → reasons.** A candidate whose final score is **at or above the active
   threshold for its list** becomes a match (per-list threshold =
   `perList[id] ?? query.threshold ?? default`). Each match carries `reasons[]` (one per
   signal: its value, weight, contribution, and a plain-language description), the
   `source_list` it came from, plus a single plain-language `explanation`. It also
   carries `retrieved_via` — the retrieval channels (`vector`, `token`, `phonetic`)
   that reached it — which the dossier shows as "Found via" context. Provenance never
   enters the score, reasons, receipt, or material fingerprint.

## Scoring & explainability contract

The score is **not** a black box. Assay policy `amlfilter.additive.v2` sums weighted
signals:

```
final_score = Σ ( weight_i × value_i )      # clamped to [0, 1]
```

The five signals: `name_vector`, `name_sequence`, `alias_match`, `dob_match`,
`country_match`. The weights and the match threshold come from a named **preset**
(`PRESETS` in `scoring.ts`):

| Preset | name_vector | name_sequence | alias_match | dob_match | country_match | threshold |
| --- | --- | --- | --- | --- | --- | --- |
| strict | 0.60 | 0.25 | 0.05 | 0.05 | 0.05 | 0.75 |
| balanced | 0.55 | 0.20 | 0.10 | 0.10 | 0.05 | 0.65 |
| lenient | 0.50 | 0.15 | 0.15 | 0.10 | 0.10 | 0.55 |

Every match carries:

- `score_evidence` — the Assay method/version, stable `inputs_hash`, and five ordered
  component contributions.
- `reasons[]` — the weighted signals, each with `value`, `weight`, and `contribution`
  (`weight × value`) plus a plain-language description.
- `explanation` — a plain-language summary (e.g. _"Match due to: strong vector
  similarity, country match"_).

This is the load-bearing contract: **a reviewer can always see why a score is what it
is.** If you change the signal set or the preset weights, the explanation shape changes
with it — keep the scorer and its golden test in lockstep.

## The three TypeScript units

### 1. Publisher — `@amlfilter/publisher`

`frontend/packages/amlfilter-publisher`. A Node tool that turns each official list into a
self-contained watchlist, registers them in a `catalog.json`, and packs the whole set
into a signed, content-addressed **bundle** (the `latest` pointer + chunked manifest the
browser delta-syncs). It runs offline, ahead of time — typically in CI — and **never
ships a list inside the app**.

**The adapter interface.** Each list is a `WatchlistSource` (`src/sources/source.ts`):
`{ id, title, fetchRaw(): Promise<RawListBytes>, parse(raw, version): SourceLine[] }`.
`fetchRaw()` pulls the raw source bytes; `parse()` maps them deterministically (no
network) to a neutral `SourceLine[]`. Four adapters ship — `OFAC_SDN`, `EU_CONSOLIDATED`,
`UN_CONSOLIDATED`, `UK_OFSI` — and all four live endpoints are fixture-tested. (`UK_OFSI` is
a historical id: the adapter reads the FCDO UK Sanctions List, filtered to asset-freeze
designations, since OFSI's Consolidated List closed on 2026-06-03.) External
fetches use a 45-second abortable deadline, so a stalled sanctions provider fails closed
without leaving the publish job hanging. **All four `parse()` implementations are real
and fixture-tested** (`fixtures/sources/`).

The per-list pipeline:

1. **Fetch + parse** the source via the adapter.
2. **Canonicalize** each entity's `name_canonical` with the **same** `canonicalize()`
   the browser uses (imported from `@amlfilter/browser`), so query and corpus match.
   Entity IDs are namespaced `"<source_list>:<rawId>"` (e.g. `OFAC_SDN:12345`) so they
   stay unique once lists are merged into one engine.
3. **Precompute name vectors** with transformers.js in Node (`createNodeEmbedder`, on
   `@huggingface/transformers`) — **no torch, no Python**. One 384-dim vector per entity
   name. `packVectors` packs them into a single little-endian Float32 buffer.
4. **Pack + sign the bundle.** The lists + a `catalog.json` are content-defined-chunked
   into a content-addressed manifest, and a `latest` `VersionPointer` over that manifest
   is Ed25519-signed (`signBytes` / `derivePublicKey`) — the signed pointer the browser
   delta-syncs and verifies fail-closed (see
   [Signed-list trust model](#signed-list-trust-model)).

The single-list production CLI (`publish`) takes
`--in <jsonl> --version <v> --key <privkey-file> --out <dir> [--models <dir>]`. The
committed demo **bundle** is built by `build-demo-bundle` (`src/buildDemoBundle.ts`),
which writes the signed content-addressed bundle to `frontend/app/public/bundle/origin/`
— the tree the app actually loads at runtime. (`build-demo-bundle-v2` writes the
OFAC-bumped `demo-2` fixture the delta-sync e2e routes in.)

### 2. Browser engine — `@amlfilter/browser`

`frontend/packages/amlfilter-browser`. The in-tab screening engine. It runs the whole
pipeline above against the signed bundle, with no backend in the request path.

The boot + screen flow:

1. **Sync + verify the signed bundle.** It fetches the signed `latest` pointer
   (`cache: "no-store"`) from the bundle base URL (default `/bundle/origin`), verifies its
   detached Ed25519 signature fail-closed (`@edgeproc/browser`, against the pinned
   public key), then fetches the content-addressed `manifest/<hash>` and verifies it
   hashes to the signed `manifest_hash`. The signed pointer is the trust anchor:
   verify-before-parse, top to bottom.
2. **Delta-sync + content-verify the chunks.** It diffs the manifest's chunk set against
   the durable browser store and fetches only the missing `chunk/<hash>` files,
   verifying each chunk hashes to its name and each reassembled file hashes to its
   `file_sha256`. Any signature or hash mismatch aborts the load — there is no fallback
   to unverified bytes.
3. **Materialize + decode.** The verified bundle is materialized into `catalog.json` +
   per-list `{entities.jsonl, vectors.f32, meta.json}` files;
   `buildLoadedFromBundleFiles` (`engine/watchlist.ts`) reconstructs the Float32 vector
   rows (failing closed on any dim ≠ 384). AML's `VectorIndex` inserts each immutable
   list into a separate in-memory SQLite database through
   `@edgeproc/browser/vector/sqlite`; vectors and namespaced exact token/phonetic
   postings share that database, while SQLite and sqlite-vector execute in a Worker.
   On the public `/screen` route, boot awaits that one selected OFAC database before
   reporting Ready. Static Worker/WASM assets and vector rows are therefore local
   before a user types; search causes no network request.
4. **Embed** the query name in-tab through the `Embedder` seam (`engine/embedder.ts`;
   stubbable for tests via `createEmbedder`) — **once**, then reused across all lists.
5. **Retrieve + score + merge**: the `ScreeningEngine` unions sqlite-vector neighbours
   with exact token/Double-Metaphone candidates resolved from the same SQLite database,
   obtains the real cosine for every candidate, and runs the unchanged transparent
   scorer. The `MultiListScreeningEngine` (`engine/multiEngine.ts`) applies the per-list
   threshold (`perList[id] ?? query.threshold ?? default`), then concatenates and
   re-ranks the matches so a strong hit in *any* list surfaces.

The retrieval schema deliberately uses neither an FTS5 trigram table nor spellfix1.
The base SQLite build has FTS5 available, but the AML database does not create such an
index, and spellfix1 is not linked. Corpus experiments found those alternatives noisier,
larger, or semantically different from the accepted exact-token/Double-Metaphone path.
Most importantly, a shared phonetic key remains candidate evidence only: the measured
Assay policy, not the retrieval index, decides whether a candidate is a match. Each
match's `retrieved_via` records which channels reached it (`LexicalIndex.provenance`
re-reads the same capped keys split by namespace; SQLite's document-frequency cap is
per key, so the split partitions exactly the lexical union) — context for the reviewer,
never a score input.

**Durable, fail-closed bundle cache.** `@edgeproc/browser` owns the Worker, signed
sync state machine, cross-tab lock, and content-addressed store contract (separate
from the customer DB). The Worker prefers
**OPFS**; if WebKit exposes OPFS but cannot open it, the same contract uses bounded
**IndexedDB** storage. AML passes its established IndexedDB layout
(`aml-filter-signed-bundles-v1` / `entries` / slash-delimited keys) into every
shared sync and clear request, so the extraction reuses and clears existing
verified caches in place. On every load the bytes — cached or freshly fetched — are
re-verified: chunks against their content hash
and the pointer against the pinned key. A tampered or version-mismatched entry is
rejected. If the pointer fetch fails, the sync falls back to the cached active version
(`readActive`) and re-verifies it fail-closed, so screening survives an unreachable bundle
origin with no network call. That is list caching, not an offline app: there is no service
worker, so the document and the JS bundle still have to load over the network before any
of this runs. ("Clear cached lists" in `/settings` drops the store.)

The public retrieval databases are deliberately **not** part of that durable cache.
Their vector rows and lexical/phonetic postings are derived in memory from verified
materialized list bytes, one database per immutable list, and are disposed with their
list residency. The private KYC SQLite/OPFS database is a third, separate store with a
different schema and lifecycle; customer data never enters the public bundle cache or
public retrieval indexes.

Cross-tab mutations use two bounded Web Locks. Syncs share a lifecycle lock while
staging verified CAS bytes; clear takes that lock exclusively. A separate short
exclusive promotion lock re-reads the active pointer immediately before writing it, so
a slower lower-sequence tab cannot become the last writer. Lock acquisition aborts after
10 seconds and surfaces a retryable timeout instead of hanging on a stale live tab.

Entry point: `EngineRuntime.bootstrap()` drives the boot stages and yields a
`ScreeningEngine`; `ScreeningEngine.screen({ name })` runs one screen and returns the
scored, explained matches.

The package's **`./engine` subpath** preserves its public verification imports by
re-exporting them from the exact `@edgeproc/browser` dependency. AML owns only the
domain orchestration: two-phase catalog→selected-list scoping, bundle-file decoding,
screening, and user-facing error mapping. The standalone dependency owns the generic
Worker/sync/storage/crypto implementation, preventing a second copy from drifting.

### 3. Workstation app — `@amlfilter/workstation` + the React SPA

`frontend/packages/amlfilter-workstation` provides the local-first KYC store; `frontend/app`
is the React single-page app that drives it (entry `frontend/app/src/main.tsx`).

- **Local data, local DB.** KYC records live in **SQLite-WASM** (the official
  `@sqlite.org/sqlite-wasm` build) running inside a **Web Worker**, persisted to **OPFS**
  via the `opfs-sahpool` VFS (`src/db/sqlite.ts` — persistent, no COOP/COEP headers
  required). The customer's data never leaves the device.
- **Two stores, two trust models.** The reference lists come from the signed,
  fail-closed bundle-sync path (`@amlfilter/browser`), cached as content-addressed chunks
  behind the OPFS-first storage adapter; your KYC records live in the local
  SQLite-WASM/OPFS database. The reference
  data is verified-and-trusted; your data is yours.

#### Bidirectional rescan — the key behavior

`src/rescan.ts` (`RescanService`) keeps customers and the watchlist in sync **both
ways**:

- A **customer edit** → re-screen that one customer. `screenCustomer(customerId)` loads
  the customer and re-runs the pipeline for it.
- A **watchlist update** → re-screen every customer. `rescanAll()` re-screens the whole
  book. `syncWatchlist(currentVersion)` compares the new watchlist `version` against the
  stored `last_synced_watchlist_version` setting; if it advanced, it triggers
  `rescanAll()` and records the new version (idempotent on version — it only rescans when
  the version actually changed).

So neither side drifts: edit a customer and only that customer is re-checked; publish a
new list and everyone is re-checked against it.

#### Review once, re-review on material change — the review workflow

A rescan should not force a reviewer to re-clear matches that haven't actually changed.
The workstation gates re-review on a **material fingerprint** (`fingerprint.ts`):
`materialFingerprint(profile, entity)` is an FNV-1a hash over a canonicalized
`{ profile: { name_canonical, country }, entity: { name_canonical, aliases, dob,
countries } }` — the customer's identity fields plus the matched entity's identity
fields. (It is for stability, not collision-resistance; it never gates trust — the
signed catalog does that.)

On a rescan (`replaceMatches` → `planReplacement`, `db/operations.ts`):

- **Unchanged** (fingerprint equal) → the match keeps its prior disposition and stays
  **suppressed** (no event, no re-review).
- **Materially changed** (fingerprint differs) → the match is flagged
  **`CHANGED`** while **keeping the prior disposition**, and a `CHANGED` event is
  appended. It then shows up under the review board's "Needs review" / "Changed only"
  views.
- **Dropped** (entity no longer in the new set, e.g. a list was disabled) → a
  `SUPPRESSED` event is appended.

Every transition is written to the append-only-during-lifecycle **`match_events`** audit
trail (`appendEvent` is INSERT-only; explicit customer deletion removes that customer's
events, reviewer identity, and notes in the same transaction): event types
are `DETECTED`, `DISPOSITIONED`, `REOPENED`, `CHANGED`, `SUPPRESSED`. The review board's
per-match **History drawer** reads this trail; `/settings` configures sensitivity,
per-list thresholds, list selection, and the analyst name (persisted in the SQLite
`settings` table).

## Signed-list trust model

The lists are distributed as a single **signed, content-addressed bundle** of plain
static files — host them on any server or CDN, no application backend required. The
directory layout:

```
bundle/origin/
  latest                        # the signed VersionPointer (JSON) — the trust anchor
  manifest/<manifest_hash>      # the content-addressed IndexManifest, named by its own sha256
  chunk/<chunk_hash>            # one file per content-defined chunk, named by its plaintext sha256
```

On open, the browser fetches and verifies the signed **`latest`** pointer first
(`cache: "no-store"`), then fetches the `manifest/<hash>` it names and checks the bytes
hash to that `manifest_hash`. It delta-syncs only the missing `chunk/<hash>` files,
verifying each chunk against its content hash and each reassembled file against its
`file_sha256`. The pointer's detached Ed25519 signature is checked against a public key
pinned in the app and served **same-origin** from `frontend/app/public/public.key` (never
from the untrusted list origin). Any verification failure aborts the load — and the same
check runs over durably cached bytes, so a poisoned cache entry is never trusted. The
bundle then materializes into `catalog.json` + the per-list files the engine reads.

The signing **private** key never lives in the repo or the app — it is held only in CI
(the `WATCHLIST_SIGNING_KEY` secret); the committed demo bundle is signed with a
clearly-labeled non-production demo key whose public half is the pinned `public.key`.

The exact wire format (the signed `VersionPointer`, the content-addressed `IndexManifest`
+ `FileEntry`/`ChunkRef`, the per-list materialized files, the base64/Float32 vector
buffer layout) is specified in **[`WATCHLIST_FORMAT.md`](WATCHLIST_FORMAT.md)** — that
document is the single source of truth for the artifact and this one does not restate it.

## Score receipts

The signed-list trust model covers the engine's *input*. Score receipts extend the same
discipline to its *output*: every scored match carries a signed record a reviewer can
verify locally, with no server asked — proof that **this exact score was produced and not
altered afterwards**. An explainable score (the `reasons[]` contract above) tells you *why* the
number is what it is; the receipt tells you the number on screen is still the number the
engine computed.

**The seal path.** When the screening engine scores a match, it seals it on the spot:
the engine hands each scored match to a sealer built by `createMatchReceiptSealer`
(`engine/matchReceipts.ts`), which signs with a **per-install Ed25519 key**
(`engine/installKey.ts` — generated on first use, stored in this browser's
`localStorage`). Receipts use the `@edgeproc/avow` format — RFC-8785 canonical JSON
signed with Ed25519 (`engine/scoreReceipt.ts`).

**The sealed subject.** The receipt seals `{ score, tier, engine version, watchlist
version, identity inputs hash, assay }`. The Assay evidence contains method
`additive@amlfilter.additive.v2`, a separate stable scoring-input hash, and the ordered
five component contributions. Verification rejects even a correctly signed receipt if
that evidence is malformed, reordered, uses another policy, or disagrees with `score`.

**Bounds are validated at both ends — reject, never clamp.** The scorer clamps its
output to `[0, 1]`, so an out-of-range score reaching the sealer is a bug or hostile
data — and a clamped signature would attest a number the engine never produced. Sealing
therefore **throws** on any out-of-range score rather than clamping it. Verification
independently re-checks the same range, plus that the inputs hash uses the `sha256`
scheme — so even a validly-signed out-of-range receipt renders **Not verified**.

**The six UI verification states.** The chip beside each match score renders exactly one
of:

| State | Chip reads | When |
| --- | --- | --- |
| pending | "Verification pending…" | receipt present, trust key still loading |
| checking | "Verifying…" | key loaded, signature check in flight |
| verified | "Verified" (✓) | signature and every subject check pass |
| invalid | "Not verified — tampered or invalid signature" (✕) | payload, signature, or subject check fails |
| wrong-key | "Not verified — untrusted signer" (⚠) | valid signature, but not this install's key |
| unavailable | "Verification unavailable" (?) | browser storage blocked / trust key can't load |

A receipt-bearing match **never renders without a chip** — there is no state in which a
sealed score appears and its verification status is silently omitted.

**Fail-closed on trust, additive on availability.** The receipt panel is never rendered
without a ready trust anchor: while the key resolves the state is pending (the
fail-closed default), and blocked storage lands on unavailable — a receipt is never
judged against a stale or absent key. At the same time, receipts are **additive
provenance**: screening never goes dark because provenance is unavailable. Matches still
score, render, and can be reviewed; only the chip reports that the receipt could not be
checked.

**Corrupt-seed quarantine.** If the stored signing seed is ever found corrupted, the
engine does not silently destroy the evidence: only a SHA-256 digest, length, and
timestamp are written under a separate quarantine storage key (the arbitrary value is
never duplicated into storage), a fresh key is generated, and the returned key flags
the reset (`resetFromCorruptSeed`). Recovery runs under the origin-scoped Web Lock on
supported browsers, so concurrent tabs cannot mint divergent replacement anchors.
Receipts sealed before the reset now verify against a key this install no longer holds,
so they read "Not verified — untrusted signer" — which is the honest answer.

**Availability when provenance cannot load.** Receipt sealing is additive: a blocked,
quota-failing, or temporarily unavailable storage/crypto provider returns the original
matches without receipts and emits a metadata-only warning. Engine invariants such as
an out-of-range score still throw; availability fallback never hides a bad score.

**The custody caveat.** The signing key lives in ordinary browser storage. A receipt is
therefore **tamper-evident provenance** — "this exact score was produced and not altered
afterwards" — **not** proof the machine was uncompromised at signing time, and **not** a
hardware-backed key. Treat it as an integrity seal on the score's journey from engine to
screen, not as an attestation of the environment.

**i18n and the panel labels.** Every app-rendered string — the chip labels, all six
states — goes through i18next like the rest of the app. The expanded receipt panel
itself is rendered by `@edgeproc/receipt-ui` 0.1.0, whose internal labels ("Algorithm",
"Signer", …) are English-only. receipt-ui 0.2.0 adds an injectable-labels API (released
on the library's main branch; its npm publish is pending), and its adoption here is
**pending** until that exact registry artifact and its integrity are verified. Until then
the panel-internal labels remain English. (The `DossierCard` source comment points readers
here.)

## Local data model (SQLite-WASM)

The schema lives in `frontend/packages/amlfilter-workstation/src/db/schema.ts`
(`SCHEMA_VERSION = 3`; migrations are an ordered ledger applied by `migrate()`). The
tables that hold the workstation's state:

- **`customers`** — a KYC customer.
  - `customer_id` (PK), `customer_reference` (NOT NULL, UNIQUE), `name` (NOT NULL),
    `country`, `onboarding_status` (NOT NULL, default `'DRAFT'`), `kyc_risk_rating`,
    `id_documents` (JSON text, NOT NULL, default `'[]'`), `onboarded_by` (NOT NULL,
    default `'local'`), `created_at`, `updated_at`.
- **`kyc_matches`** — a match between a customer and a watchlist entity.
  - `match_id` (PK), `customer_id` (FK → `customers`, `ON DELETE CASCADE`),
    `ofac_entity_id`, `match_score` (REAL), `match_tier`, `list_version`,
    `sanctioned_name`, `source_list`, `reasons` (JSON text), `explanation`,
    `detected_at`, `resolution_status` (NOT NULL, default `'PENDING'`), `resolved_at`,
    `reviewer_id`, `review_notes`.
  - **v2 columns**: `material_fingerprint` (the re-review fingerprint above) and
    `review_state` (NOT NULL, default `'CURRENT'`; set to `'CHANGED'` on a material change).
  - `UNIQUE (customer_id, ofac_entity_id)` so a customer/entity pair has one match row.
  - Index `idx_kyc_matches_review` on `(resolution_status, match_tier)` for the review
    board.
- **`match_events`** (v2) — the **append-only audit trail**. `event_id` (PK),
  `match_id` (nullable — null for a `SUPPRESSED` event), `customer_id` (NOT NULL),
  `ofac_entity_id` (NOT NULL), `event_type` (NOT NULL), `from_status`, `to_status`,
  `reviewer_id`, `notes`, `at` (NOT NULL). Indexed on `(match_id)` and
  `(customer_id, ofac_entity_id)`. Lifecycle writes use `appendEvent` only; explicit
  customer deletion removes the customer's ledger atomically with the customer row.
  Two v4 triggers make "append-only" a property of the database rather than of the
  code: `match_events_no_update` refuses every `UPDATE`, and `match_events_no_delete`
  refuses a `DELETE` whose `customer_id` still exists in `customers`. The second is
  why `deleteCustomer` deletes the customer *before* its events — that order is the
  only sequence the trigger permits. `PRAGMA recursive_triggers` is set and verified
  in `migrate()`, because `INSERT OR REPLACE` otherwise skips the delete trigger and
  would swap a forged row in under an existing `event_id`. See the README for what
  this does **not** claim (there is no hash chain, and a local operator can drop the
  triggers).
- **`settings`** — `key` (PK), `value` (NOT NULL). Holds
  `last_synced_watchlist_version` (the rescan version pointer above), the screening
  sensitivity / per-list overrides, the enabled-watchlist selection, and the analyst
  name.

The production OPFS connection enables SQLite `secure_delete`, truncates a legacy WAL,
and requires rollback-journal `DELETE` mode before opening the schema. That overwrites
deleted SQLite cells and prevents a reusable WAL from retaining committed customer
pages. It does not promise forensic erasure from browser/OS storage, snapshots, or
backups; clearing origin site data is the device-level privacy boundary.

## Match tiers (review triage)

`src/tiering.ts` buckets each match's **final score** into a review tier. This layers
**on top of** the scoring contract and **never changes the score, reasons, or
explanation** — it only triages:

- **STRONG** — score ≥ `0.8` (`STRONG_TIER_FLOOR`).
- **POSSIBLE** — score ≥ the active preset threshold.
- **WEAK** — below that.

Boundaries are inclusive on the lower edge of each tier. The TS implementation is the
**source of truth**, parity-locked by a **frozen committed golden** snapshot
(`tiering.parity.test.ts`) so any unintended drift in a tier boundary fails CI.

## Search-layer strictness (`/screen` presentation)

`app/src/pages/strictness.ts` owns the public screen's Lenient / Balanced / Strict
control. Like tiering, it layers **on top of** the scoring contract — it never changes
a score, and it never drops a match the engine returned:

| level | engine floor | min `name_sequence` | display line |
| --- | --- | --- | --- |
| lenient | 0.30 | — | — (every match is a primary card) |
| balanced | 0.30 | 0.35 | 0.40 (`BALANCED_LOW_CONFIDENCE_LINE`) |
| strict | 0.40 | 0.50 | — (engine floor already enforces 0.40) |

A Balanced result below the display line passed the search gate but sits in the
0.30–0.40 band that is mostly embedding-baseline fuzz, so it renders **grouped under a
collapsed "low-confidence candidates" disclosure** instead of as a primary match card —
recall preserved (the analyst expands to inspect every kept candidate), junk
de-emphasized. Lenient keeps the classic show-everything rendering; Strict is
unchanged. The token-containment escape hatch (a query token exactly matching an
entity-name token, e.g. `bank`) keeps a match in the results but does **not** exempt it
from the display line.

## Parity / correctness

Both the **Assay-backed scoring** output (score, evidence, reasons, and each reason's
plain-language description)
and the **tiering** classification are locked by committed golden-JSON parity tests —
**frozen regression snapshots**. There is no Python side anymore: the TypeScript
adapter contract is the source of truth, and the goldens are TS-emitted snapshots (the old
Python golden generators were deleted in the v3 pivot). The fixtures:

- `frontend/packages/amlfilter-browser/src/engine/__fixtures__/scoring/golden.json`
- `frontend/packages/amlfilter-workstation/src/__fixtures__/tiering/golden.json`

A change to the scorer or the tier boundaries that isn't reflected in the golden fails
the parity test — that's the regression guard that keeps the explainable contract
stable.

## Invariants (load-bearing rules)

- **Explainability is non-negotiable.** Every match carries its full signal breakdown.
  Don't add a scoring path that returns a bare number.
- **Watchlist bytes are trusted only after verification.** The repository commits a
  small fictional signed demo bundle; production builds replace it with freshly
  published official-source data. Fetched and cached bytes cross the trust boundary
  only after the signature and every content hash verify.
- **Same embedder, query and corpus.** The publisher (Node) and the browser (tab) must
  use the **same** model and the **same** `canonicalize()`, or vector similarity is
  meaningless. This is what makes precomputed vectors comparable to the live query.
- **Fail closed on trust.** A list is loaded only after the catalog and the list's
  Ed25519 signatures verify against the pinned, same-origin public key — over fetched
  *and* cached bytes. Any signature or SHA-256 mismatch aborts the load — never a silent
  fallback to an unverified list.
- **The audit trail is append-only during the customer's lifecycle.** `match_events`
  lifecycle writes are INSERT-only; dispositions and
  re-review transitions are recorded, never rewritten. SQLite triggers enforce this, so
  it binds any code path rather than only the ones written so far — but it is not
  tamper-evidence: the file is local, there is no hash chain, and an operator with direct
  SQLite access can drop the triggers. See [Security summary](#security-summary).
- **Your data stays local.** KYC records live only in the in-tab SQLite-WASM/OPFS
  database; nothing is sent to a server.

## Package map

AML-Filter is four small, separately tested pieces. There is no backend in the path.

| Package | Responsibility |
| --- | --- |
| `@amlfilter/publisher` | Converts public source lists into signed, content-addressed static bundles. |
| `@amlfilter/browser` | Verifies bundles, embeds the query, retrieves candidates, and composes the Assay scorer. |
| `@amlfilter/workstation` | Owns customer records, review state, rescans, and the SQLite audit ledger. |
| React app | Composes the three into the Screen, Customers, Review, and Settings pages. |

```text
aml-filter/
├── frontend/                  pnpm workspace
│   ├── app/                   React + Vite browser app
│   └── packages/
│       ├── amlfilter-browser/ verification, retrieval, scoring
│       ├── amlfilter-publisher/ source adapters and signed bundles
│       └── amlfilter-workstation/ SQLite KYC workflow
├── eval/                      independent Python evaluation harness
└── docs/                      architecture and operating guides
```

## Retrieval and scoring in one paragraph

Publisher adapters support the U.S. Treasury OFAC SDN list, the EU Consolidated list, the
UN Consolidated list, and the UK Sanctions List (FCDO; asset-freeze designations only —
OFSI's old Consolidated List closed on 2026-06-03). Candidate retrieval unions two
bounded paths in one Worker-owned database: MiniLM nearest neighbours through
sqlite-vector, plus exact canonical-token and Double-Metaphone postings through SQLite.
TypeScript creates the lookup keys and applies the transparent final policy;
`@edgeproc/assay` combines vector similarity, sequence similarity, alias, date-of-birth,
and country evidence. Phonetics can widen the candidate set but cannot by itself declare
a match. Each result records `retrieved_via` (which channels reached it); the "Why this
score?" panel shows it as "Found via" context, and it is never a score term. Each result
includes ordered contributions and a stable input hash, and the signed score receipt
seals that evidence. Frozen golden fixtures lock score and tier behaviour; the recall
gate measures retrieval against the real OFAC corpus and fails below its published
floors ([RECALL.md](RECALL.md)).

## Security summary

- **Verified:** the signed `latest` pointer (with a sequence number that may only go up),
  the content-addressed manifest, and every chunk are checked with Ed25519 + SHA-256
  against the one public key pinned in the app build
  ([`frontend/app/public/public.key`](../frontend/app/public/public.key)), never a key
  carried inside the bundle. The same check re-runs over bytes read back from the
  browser's cache. The 23 MB model is checked against pinned SHA-256 digests at build time.
- **Refuses rather than warns:** a bad signature, hash mismatch, older-than-seen list
  (rollback), or incomplete update never becomes an active list, and the app shows an
  error instead of an empty result. A rollback is explained before the app lets you clear
  the cache; it never clears on its own.
- **Not protected:** a compromised device or browser, a malicious browser extension, or
  someone with access to your browser profile. The review ledger is append-only by
  database triggers, but it is a local file with no hash chain, not tamper-evidence.
  Whether a match is legally a match is always the reviewer's call.
- **Customer data stays local:** customer records and review history live in
  SQLite-WASM on the browser's Origin Private File System.
- **Spreadsheet boundaries:** imports are validated and bounded; exports escape
  spreadsheet formulas.
- **Score receipts** seal Assay method `amlfilter.additive.v2`, ordered component
  contributions, and input fingerprints, not customer text.
- **Deletion is explicit:** deleting a customer removes that customer's matches and
  review history in the same SQLite transaction.
- **One network destination:** the hosted site's Content-Security-Policy sets
  `connect-src 'self'` ([`frontend/app/public/_headers`](../frontend/app/public/_headers)).
- **Verify a release:** `curl -fsSL https://aml-filter.com/build.json` names the exact
  deployed commit; `pnpm --filter aml-filter-app bundle:live` mirrors the live signed
  lists and verifies the pointer, manifest, and every chunk against the pinned key.

Report a vulnerability through [SECURITY.md](../SECURITY.md).

## What the release gate proves

| Claim | Backed by |
| --- | --- |
| Tampered, unsigned, or rolled-back lists are refused | `pnpm test:e2e:bundle` (real Chromium, incl. `rollback-recovery.spec.ts`) and the `@amlfilter/browser` unit suites |
| The committed demo bundle verifies against the committed key in a real tab | `pnpm test:e2e:c1` and `pnpm test:e2e:kyc` against the minified production build |
| Retrieval recall stays above published floors on the real OFAC corpus | `pnpm --filter @amlfilter/publisher run gate:recall` ([RECALL.md](RECALL.md)) |
| Score and tier behaviour do not drift | frozen golden fixtures (`amlfilter-browser/src/engine/__fixtures__/scoring/golden.json`, `amlfilter-workstation/src/__fixtures__/tiering/golden.json`) |
| The receipt signs, verifies, and rejects tampering in Chromium, Firefox, and WebKit | `pnpm test:e2e:receipt` |
| A phone tab survives the model and lists | `pnpm test:e2e:mobile:ci` (iPhone-shaped WebKit, Android Chromium) |

`pnpm gate` runs strict type checks, lint, unit and coverage suites, production builds,
the recall and evaluation gates, translation checks, signed-bundle contracts, and the
real-browser KYC, receipt, bundle, and mobile lanes.

It does **not** prove behaviour on a physical iPhone (checked by hand), that the lists
are complete or legally sufficient for your obligations, or that a match or non-match
is correct. It proves the software does what it says with the lists it was given.

## Further reading

- [`WATCHLIST_FORMAT.md`](WATCHLIST_FORMAT.md) — the exact signed catalog + per-list
  wire contract (the single source of truth for the published artifacts).
- [`../NOTICE`](../NOTICE) — OFAC attribution and the not-a-compliance-product
  disclaimer.
