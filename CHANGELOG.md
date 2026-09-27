# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **The UK list now comes from the FCDO UK Sanctions List, asset-freeze designations
  only.** OFSI closed its Consolidated List on 2026-06-03 and the adapter was still
  reading that frozen file, so UK screening was months stale (it missed ~550 current
  asset-freeze designations and still flagged ~14 delisted people). The adapter now reads
  `https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv`, keeps designations
  whose `Sanctions Imposed` includes "Asset freeze" (5,682 on the 21-Sep-2026 feed), and
  groups rows by `Unique ID`. The list id stays `UK_OFSI`, so list selection and per-list
  thresholds carry over. **One-time re-review:** UK entity IDs change from OFSI Group IDs
  to UKSL Unique IDs (e.g. `UK_OFSI:AQD0194`), so existing UK matches will appear once
  more for review; the old matches are logged `SUPPRESSED`.

- **README rewritten in plain English for a compliance reader.** It now opens with what
  the tool is and who it is for, then the problem, then a "Try it" on the live site with
  a real sanctioned name (`Vladimir Putin`) and screenshots of the real result and the
  review page. It says plainly that the search page checks only the US list and that
  adding a customer checks all four. Engineering detail (package map, retrieval and
  scoring, security summary, what the gate proves, build-time configuration, Dagger,
  browser support) moved to `docs/ARCHITECTURE.md`, `docs/DEPLOY.md`, and
  `docs/MEMORY-ARCHITECTURE.md`. The README contract test now pins the new section order,
  the OFAC-only fact, and a ban on internal jargon. The "Run it yourself" section
  documents `dev` (demo list) only, because `dev:live` currently fails verification
  locally. A "Technical docs" line under the intro links the developer guide,
  architecture, matching, watchlist format, and deploy docs, and "More detail" links
  every technical doc; the contract test pins both.

- **New `docs/GETTING_STARTED.md` for developers.** Exact prerequisites (Node 22.13.0,
  pnpm via corepack, Python 3.13 + uv, Playwright browsers) and the local traps we hit,
  clone to install to `pnpm gate` with timings from a fresh clone, a map of the
  workspace packages, a first-change walkthrough (test first), and the PR process.

- **README follows the portfolio template.** A plain-language first screen: a tagline
  that says what it does and for whom, "At a glance" (including exactly what leaves the
  device), and a "Try it in 60 seconds" walkthrough whose hero screenshot and pasted
  on-screen text were captured from the local production build screening `fakovic`
  against the fictional demo list. The stale demo GIF (it showed retired score signals)
  is removed. The workspace and app package descriptions now equal the tagline.
- **`@edgeproc/errors` bumped `^0.1.0` → `^0.1.2`** (resolves to 0.1.3, a
  docs-only release over 0.1.2). 0.1.2 filters RFC 9457 Problem Details extension
  members: it drops `toJSON`, `__proto__`, `constructor`, `prototype`, and any value
  that is not a string or finite number, and reads catalog entries and params as own
  properties only. No app caller passes objects, booleans or `null` as params (the only
  production call is `describe(..., {}, ...)`), so no caller changed; a new
  `bootErrorMessage` test pins the filtering on the app's own registry.
- **`frontend/app/.env.example` now names the env vars the code actually reads.** It
  documented `VITE_MODEL_LOAD_TIMEOUT_MS` (120000) and a 180000 boot ceiling; the engine
  reads `VITE_MODEL_LOAD_IDLE_TIMEOUT_MS` (default 90000, an idle window) and
  `VITE_BOOT_TIMEOUT_MS` (default `BOOT_TIMEOUT_MS` = 900000). The stale 120s/180s
  figures in `vite-env.d.ts` are corrected too, and `MODEL_LOAD_IDLE_TIMEOUT_MS` is now
  exported from `@amlfilter/browser` beside `BOOT_TIMEOUT_MS`.

### Added

- `frontend/app/src/__tests__/readme.contract.test.ts`, run by the app's Vitest step in
  `pnpm gate`: tagline equals both package descriptions, at most four badges, the six
  "At a glance" labels, section order, no offline claim, the architecture-map link, and
  every relative README link resolving.
- `frontend/app/src/__tests__/envExample.test.ts`: `.env.example` names exactly the
  `VITE_` vars declared in `vite-env.d.ts`, and its documented defaults equal the
  engine's `MODEL_LOAD_IDLE_TIMEOUT_MS` and `BOOT_TIMEOUT_MS`.

### Known issues

- **`@edgeproc/receipt-ui` 0.2.0 declares a peer range that excludes the installed
  `@edgeproc/avow` 0.4.1.** Its peer is `@edgeproc/avow: ^0.1.0`, which under 0.x caret
  rules means `>=0.1.0 <0.2.0`, so `pnpm peers check` reports it unmet. 0.2.0 is the
  newest receipt-ui on npm (checked 2026-09-24), so there is nothing to bump to; the
  mismatch is recorded here and not forced (no `peerDependencyRules` override). The fix
  belongs upstream: a receipt-ui release that widens the peer to the avow 0.4 line.

### Security

- **A visitor stuck behind the anti-rollback floor can now get out in-app, and only on
  purpose.** With the `@edgeproc/browser` bump below, the stored pointer stays the
  rollback floor even across a key change, so a browser that once accepted a higher
  `sequence` than the origin now serves refuses every sync (`RollbackError`) until its
  cached lists are cleared. Three fixes make that recoverable:
  - **"Clear cached lists" no longer syncs before it clears.** The old clear opened a
    bundle source first (sync → read catalog → sync) and only then cleared, so the one
    store a user most needed to clear, one the floor refuses, could never be cleared.
    `clearBundleStore()` now calls the library's `EngineClient.clear()` directly in a
    temporary Worker, under the same cross-tab sync Web Lock, with a 30 s bound. That
    removes the OPFS chunks and manifests, the active pointers and the IndexedDB
    rollback floor for this app's namespace and layout. The running sync Worker is
    torn down first. The customer SQLite database lives in a separate Worker and OPFS
    directory that the clear never opens; a real-Chromium check confirmed
    `.amlfilter-workstation/` and the analyst name survive it.
  - **The boot-failure card offers recovery instead of a dead end.** When the live
    Worker error is `rollback` or `integrity`, both `/screen` and the workstation
    engine strip now show "Clear cached lists" inline, plus an "Open Settings" link.
    Both paths use a two-step confirm and then re-run the boot. The workstation strip
    now keeps the error object rather than its message, so the real error type
    reaches the card instead of the generic "engine unavailable" fallback.
  - **A rollback is explained before anything can be cleared.** The card warns: "The
    server offered an older version of the screening lists than the one you already
    have. That can mean someone is tampering with it. Only clear if you trust this."
    It also says retrying will not help. The app never clears on its own: an automatic
    clear would hand anyone who can serve an old signed pointer a way to erase the
    protection.
  New `test:e2e:bundle` spec `rollback-recovery.spec.ts` seeds a real floor through the
  real sync path: it serves the committed, signed demo-2 fixture (sequence 2) first,
  then the demo-1 origin (sequence 1). It checks the warning, the confirm, that a
  reload stays refused until the user acts, and that after the clear the lists
  re-download and verify. Run against the old sync-first clear, the same spec stays
  stuck on the card.

- **`@edgeproc/browser` bumped `a6a2049` → `02171df`: the anti-rollback floor now
  survives a key change, and the trust root can be a keyring.** The pinned sync substrate
  used to re-verify its stored active pointer under the *current* pinned key and, on a
  signature failure, discard it — so any change to the pinned key reset the floor and the
  next pointer (even an old release re-signed under the new key) was promoted with no
  freshness check (edgeproc-browser #13). The stored pointer is now kept as the floor
  whether or not the current key verifies it; serving a cached bundle offline still
  requires a signature valid under the current key, so a cache signed by a key that is no
  longer pinned fails closed instead of being served. The same range adds optional
  `edgeproc.keyring/v1` trust roots with `key_id` selection, revocation and signed pointer
  expiry (#14), plus an unused opt-in `@edgeproc/browser/sqlite` export (#12). This app
  keeps its raw 32-byte `public.key` (loaded as a one-key keyring) and its existing
  signed bundle byte-for-byte: legacy pointers without `key_id`/`expires_at` keep their
  exact signing preimage, every new error surfaces as the existing `integrity` code, and
  no OPFS storage key or format changes. Only the two package pins, the dependency
  contract test's pinned revision, and the lockfile entry change.

- **"Reviews are append-only" is now enforced by the database instead of merely
  claimed.** The README, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md` and half a dozen
  code comments have described `match_events` as append-only since schema v2, and
  nothing enforced it. The claim was not false — every write we had written was an
  `INSERT` — but it was completely unguarded: `UPDATE match_events SET to_status = ...`
  and `DELETE FROM match_events` both succeeded silently, so a reviewer's disposition
  could be rewritten, backdated, stripped of its reviewer's name, or lifted out of a
  live customer's trail with no trace. Schema **v4** adds two triggers:
  `match_events_no_update` refuses every `UPDATE`, and `match_events_no_delete` refuses
  a `DELETE` whose `customer_id` still exists in `customers`. The one sanctioned removal
  — deleting a customer, which is all-or-nothing and destroys the customer record too —
  still works, so `deleteCustomer` now deletes the customer *before* its events; that
  order is the only sequence the trigger permits. `PRAGMA recursive_triggers` is set and
  **verified** in `migrate()`, closing a hole that would otherwise have gone straight
  through the guard: `INSERT OR REPLACE` resolves a primary-key conflict by deleting the
  old row first, and SQLite skips `DELETE` triggers for that implicit delete unless
  recursive triggers are on, so one `REPLACE` could have swapped a forged event in under
  an existing `event_id`. Nine new tests fire raw SQL at the database, bypassing
  `operations.ts` entirely, and assert the row is **unchanged** after each refusal — a
  statement matching zero rows also fails to throw, and only reading the row back tells
  a refusal from a no-op.
- **The append-only claim is narrowed to what is actually true.** The README now carries
  a "What append-only means here" section stating plainly what the triggers do *not*
  buy: this is not tamper-evidence. The database is a local file, the person using it
  holds every key to it, there is no hash chain and no signature over the ledger, and
  anyone who can open that OPFS file with their own SQLite can drop the triggers and
  rewrite rows without leaving a trace. What is now true and enforced is narrower and
  worth stating on its own terms — *the application cannot rewrite its own audit
  history*, by accident, by a future code path, or through the devtools console.

### Removed

- **The "works offline" claim is withdrawn — it was false.** The app has no service
  worker (`grep -rniE "serviceWorker|workbox|vite-plugin-pwa|manifest.webmanifest"`
  returns two incidental console-filter mentions and nothing else), so a reload with the
  network off cannot fetch the document or the JS bundle: the live site returns
  `net::ERR_INTERNET_DISCONNECTED` and a blank page. The claim is withdrawn in the landing
  copy, the boot banner, the settings cache note, the README, `docs/ARCHITECTURE.md`,
  `docs/QUICKSTART.md`, and `docs/OPERATIONS.md`, rather than implemented — a service
  worker plus a precache manifest and an update/rollback story is a feature with its own
  failure modes, not a doc fix. What is true and stays: screening runs in the tab and
  nothing you type is uploaded, and the verified bundle really is cached in OPFS so a
  repeat visit does not re-download the list. Two unit tests asserted the false claim by
  matching the word "offline" in the copy; they are inverted to pin what is now true, not
  deleted. The `e2e-bundle` "offline reload" lane is unchanged and still passes — it
  aborts `**/bundle/origin/**` only, so it proves OPFS reuse when the bundle origin is
  unreachable, never a true offline load.
- **Two unsourced numbers are gone from the README.** "31,566 sanctioned entities" and
  "34.3 MB of OFAC SDN data" appeared nowhere else in the repository — no code, fixture,
  or generated file produced either. The OFAC SDN count of 19,181 stays, because
  `buildRealBundle.ts` cross-validates it against Treasury's own `SDN_ADVANCED.XML`; the
  live per-list counts are rendered from real data in Settings.
- **The hand-written README status block is gone.** It pinned `c0f2370` as "current
  `main`" while `main` was 37 commits and 11 days ahead, and it asserted test counts
  nothing verified. Replaced by the CI badge, the Actions tab,
  `aml-filter.com/build.json`, and `pnpm gate` — sources that cannot go stale.

### Changed

- **Registry releases are accepted by evidence, not elapsed time.** The pnpm
  publication-age delay and its exemption machinery are removed. Exact versions,
  frozen locks, registry provenance, integrity hashes, full-history secret scanning,
  and unsuppressed dependency audits remain mandatory.


- **`@edgeproc/errors` now comes from npm, not a vendored copy.** The canonical-errors
  library was vendored at `frontend/packages/edgeproc-errors` as a 509-line snapshot;
  it is now a real dependency (`@edgeproc/errors@^0.1.0`, 853 source lines, resolving
  to 0.1.1) and the copy is deleted. The equivalence below was measured against the
  0.1.0 tarball and holds unchanged for 0.1.1: unpacking both and diffing shows the
  only difference between them is the `version` field in `package.json` — every
  `dist/` byte is identical. The published library is a strict superset — all 18 starter-pack
  codes are present, in the same registration order (which is `classify` precedence),
  with identical `category`, `httpStatus`, `params`, `en`, `i18nKey` and `problemType`
  on every code, and identical `match` behaviour on the three codes that carry one.
  It adds `corePack` / `aiPack` / `bundlePack` subsets and a configurable-fallback
  registry (`defineErrorsWith`) that this app does not yet use. No error code, HTTP
  status, i18n key or rendered string changed, and the library's name is still
  imported in exactly one production module — the `bootErrorMessage.ts` seam.

### Added

- **Each match now says how it was found.** Double-Metaphone keys already widened
  candidate retrieval, but a hit reached only by sound looked identical to any other
  in "Why this score?". `Match` gains `retrieved_via` — every retrieval channel that
  reached the entity, in the fixed order `vector`, `token`, `phonetic` (new exported
  `RetrievalChannel` type) — and the dossier shows a "Found via" line, plus a one-line
  note when pronunciation was the only way in. It is provenance, not evidence:
  `LexicalIndex.provenance` re-runs the same capped key list split by namespace (two
  extra SQLite lookups per list per screen), `candidates()` and the candidate order are
  untouched, and the field never reaches the score, `reasons[]`, `score_evidence`, the
  signed receipt, or the workstation `material_fingerprint`. Stored review rows do not
  persist it (no schema change); the UI renders nothing when it is absent.

- **Retrieval recall is measured, published, and gated — it never was before.** The
  product exists to find a sanctioned entity whose name is spelled differently, and
  nothing in the repository measured whether it does: no labelled set, no recall@k, no
  query→expected-entity fixture anywhere. The scoring golden froze
  `computeScore(entity, query)` on pre-selected pairs and never touched retrieval, so it
  passed at any recall. A new harness (`amlfilter-publisher/src/recall`) rebuilds the
  screening engine over a frozen 19,181-entity OFAC SDN snapshot with the real MiniLM
  embedder and screens labelled queries derived from the feed's own published aliases —
  every alias is a known-true variant of a known parent, which yields **24,026 labelled
  pairs with no human labelling and no involvement from the ranker being measured**. The
  first number, at the parameters `/screen` actually sends (threshold 0.30, k 25):
  alias-derived queries **recall@1 0.5930, @10 0.6185, @25 0.6195, and 38.05% where the
  true entity appears nowhere in the results**; canonical-name queries 0.9995 across the
  board. Reported as two segments and never averaged — looking an entity up by its own
  indexed name works, looking it up by a name OFAC publishes for that same entity fails
  about two times in five. `pnpm gate` now fails when any of those drops below the
  committed measured floors. **The gate was watched failing:** re-narrowing retrieval
  from `search(queryVec, k * 2)` to `search(queryVec, 1)` leaves all 510
  `@amlfilter/browser` tests green (exit 0) and drives alias recall@10 to 0.3885 — the
  recall gate exits 1 on four breached floors, and goes green again on restore. See
  [docs/RECALL.md](docs/RECALL.md).
- **A capped result list now says it is capped.** `/screen` asks the engine for 25
  results and rendered them as 25 visually identical cards, so a broad query like
  "mohammed" gave a reader no way to tell whether that was every match or merely the
  first 25. A note under the list now says so when — and only when — the engine returned
  a full quota. It states the cut-off and nothing more: the engine reports no total, so
  there is no honest "25 of 431" to show.

- **The Ed25519 signature check is now actually tested.** The score-receipt suite had
  two "tamper" tests and neither one ever reached the signature: the mutated-score case
  leaves a stale `payload_hash` and dies at the content-hash compare, and the wrong-key
  case dies at the signer compare. Measured, not assumed — forcing avow's Ed25519
  verdict to always-succeed left all 366 tests in `@amlfilter/browser` green. A new test
  builds a genuinely valid receipt and flips **one hex nibble of the `signature` only**,
  leaving `payload_hash` and `public_key` correct, so both earlier gates pass and control
  reaches the Ed25519 check. Under that same always-succeed mutation this test — and only
  this test — turns red. No verification behavior changed; this is test coverage only.
- **Visible, verifiable score receipts** — every scored match card on `/screen` now
  renders its signed Avow receipt through `@edgeproc/receipt-ui` (v0.1.0): a compact
  icon+text verdict badge beside the score (WCAG 1.4.1 — never color-only) and a
  "Score receipt" disclosure with the full envelope (algorithm, signer key, payload
  hash, signature) plus the sealed subject (score, tier, engine and watchlist
  versions, inputs hash). Verification is fail-closed against this install's own
  key — the same localStorage seed the engine's sealer signs with — with three
  distinct non-verified states: pending, tampered/invalid signature, and untrusted
  signer. Guarded property-based end to end: the C1 e2e re-keys the store under the
  sealer's pinned key and asserts the badge drops to "untrusted signer".

### Fixed

- **A short network blip during the first download is a pause, not a dead end.** The
  per-chunk retry ladder was budgeted in attempts rather than in seconds of outage:
  three attempts at a 250 ms base absorb only 750–1250 ms, so a measured 3-second
  offline blip mid-download stranded the cold boot **0/5** — the ladder expired about
  1.9 s before the network came back and the visitor got a Retry banner for a blip they
  never noticed. Six attempts now absorb 7.75–9.0 s, and the same harness survives the
  same blip **5/5** with the clean cold-boot median unchanged (865 ms → 865 ms). The
  budget is bounded from above too: it stays inside the engine client's 30 s
  no-progress watchdog, because a retry pause is silence on the progress channel. The
  cost is paid only by a visitor who loses the network *mid*-download — they wait ~9 s
  instead of ~1 s for the Retry button. Someone offline before the boot starts is
  unaffected: the signed-pointer fetch has no ladder and still fails immediately. The
  tests assert seconds of outage survived rather than attempts taken; the previous
  attempt-counting tests passed at any budget, however short.
- **A failed sync no longer leaves seven chunk downloads running behind it.** The
  eight-way fetch pool used `Promise.all`, which rejects the moment the first worker
  exhausts its ladder — the other seven kept retrying against a network that was still
  down, firing requests after the boot had already shown its Retry banner and producing
  unhandled promise rejections in the console. It now waits for every worker and
  re-throws the first failure; fail-closed behavior is unchanged.
- **The overall boot ceiling no longer fires on healthy slow connections.** The ceiling
  does bind — verified in a real browser against the production build, where a
  slow-but-moving sync is terminated at exactly the configured deadline — but at 180 s
  it sat *below* the ~535 s a completely healthy Fast-3G download of the ~47 MB bundle
  takes. The first visitors it would ever have fired on were the ones it was never meant
  to catch, handed "Screening list could not be loaded" two-thirds of the way through a
  working download. It is now 900 s, and is documented as what it actually is: a
  backstop, not the stall detector. Genuine stalls are still caught in seconds by the
  bounds that key on silence rather than elapsed time — the 15 s per-fetch transport
  ceiling and the 30 s no-progress watchdog — and a unit test now pins the ceiling above
  the slowest healthy download so it cannot drift back under it.
- **Retry is proven to recover, by clicking it.** Nothing had ever exercised the one
  control a stranded visitor has. A new browser test fails a cold boot on a chunk
  outage, lifts the outage, presses Retry, and requires the app to reach a screenable
  state and actually match the committed sanctioned name.
- **The quickstart works from a cold clone, and the docs no longer call the repository
  private.** A fresh `git clone` plus the documented steps ended at "Local screening
  engine unavailable — signature verification failed", because (a) `dev` was bare `vite`
  and only `prebuild` staged the git-ignored MiniLM weights and onnxruntime WASM runtime,
  and (b) a local server served the production trust root `public/public.key` against the
  committed demo bundle, which is signed with the throwaway demo key. The plugin that
  pairs them existed but was opt-in behind `AMLFILTER_E2E_DEMO_PUBKEY=1`, set only by the
  Playwright `webServer` blocks — so every browser lane was green while the human path was
  broken. `dev` now shares `prebuild`'s `stage:assets` step, the demo pin is the default
  for any local dev/preview server (announced at server start), and the lanes dropped the
  env so they exercise what a cold clone gets. Shipped bytes are unchanged: `vite build`
  copies the real `public.key` into `dist/`. Repository-visibility claims are corrected in
  `README.md`, `docs/QUICKSTART.md`, `CONTRIBUTING.md`, and `public/llms.txt`, and the
  guard that asserted the app must not link its own source is inverted — the footer now
  links the MIT repository.
- **Decompression bound survives the zstd API change** — `@hpcc-js/wasm-zstd` 1.15.0
  removes `decompressChunk`'s `outputSize` parameter ("Callers must not guess an
  output size"). That argument *was* the expansion-bomb guard: WASM allocated exactly
  the size we passed. Because JavaScript drops extra arguments silently, the old
  two-argument call would have kept compiling and running while enforcing nothing —
  a 147-byte frame expands to 4 MiB unchecked. The bound now moves ahead of the
  decoder: the Zstandard frame header (RFC 8878 §3.1.1) is parsed and a chunk is
  refused unless it is exactly one frame, spanning every input byte, declaring a
  `Frame_Content_Size` within the chunk ceiling. The single-frame rule matters on its
  own — `decompressChunk` decodes concatenated frames in one call, so bounding only
  the first frame still lets 512 KiB of input decode to ~14.9 GB. Decoding then runs
  `resetDecompression` → `decompressChunk` → `decompressEnd` (which reports truncated
  frames), with the output length re-checked as a final fail-closed gate. All five
  checks are mutation-tested: each one, removed, turns a specific test red. Both
  workspace packages that declare the library are moved together — the app and the
  browser tier each resolve their own copy, and a split version is how the bundle
  ends up decoding through a decoder the code was not written for.
- **Bounded, accessible watchlist directory** — `/screen` no longer mounts the entire
  real-list population as tens of thousands of dossier cards. It renders 24 cards per
  page behind semantic Previous/Next controls, an announced visible range, and stable
  focus behavior; a 31,348-entity regression fixture locks the DOM bound.
- **Signed-pointer rollback prevention end to end** — `sequence` is now required on
  every newly published pointer, derived by both deployment workflows from the
  signature-verified live pointer, verified after live publication, and rejected by
  the browser before manifest/chunk fetch when missing or stale. A verified
  sequence-less live pointer is treated as zero only while bootstrapping the first
  sequence-aware publish; a cached legacy pointer may upgrade once; equal sequence is
  idempotent only for the same pointer identity, while a different pointer reusing it
  is rejected before manifest fetch.
- **Production response contract** — Cloudflare Pages now ships a browser-validated,
  worker/WASM-safe CSP without unsafe or network-wide escape hatches; explicit MIME and
  cache rules for the trust root, mutable pointer, and immutable CAS; and no wildcard
  CORS. A test derives the JSON-LD script hash so HTML/CSP drift fails locally.
- **Honest public discovery** — the public pages and `llms.txt` no longer advertise a
  private source repository as publicly accessible. `robots.txt` no longer contradicts
  Cloudflare's managed training-bot policy, and deployment docs identify the external
  `www` → apex redirect that must be verified on the host.
- **Complete local customer deletion** — deleting a customer now atomically erases its
  match-event ledger, reviewer identity, and notes as well as the customer/match rows;
  the prior append-only table intentionally lacked a customer FK and retained that
  private history indefinitely.
- **Measurable production truth and performance** — deploys stamp and live-verify the
  exact Git SHA/run id so a stale no-op cannot pass. A 31,348 × 384 retrieval benchmark
  enforces fixed p50/p95 and memory budgets, while C1 enforces cold boot, warm search,
  DOM/heap, single-model-request, zero third-party egress, and zero query-time network.
- **Immutable CDN caching for the self-hosted model (`/models/*`)** — Cloudflare Pages
  served the ~23 MB pinned MiniLM model with `max-age=0, must-revalidate` and no
  Content-Length, so production re-downloaded it in full on every visit. A `_headers`
  rule now caches `/models/*` as `public, max-age=31536000, immutable` (safe: the
  weights are SHA-256-pinned at build time and never mutate in place), guarded by a
  deploy-config test. Also graduates the stashed triple-fetch boot-hang diagnosis to
  `.planning/debug/minified-browser-boot-hang.md` (its app-level fix shipped in #57)
  and makes the C1 lane's preview port env-overridable (`E2E_C1_SPA_PORT`) like the
  kyc/bundle lanes.

### Added

- **Full SPA localization with i18next (#61)** — every user-facing string in the SPA is
  extracted to namespaced i18n keys with an English baseline bundled **offline** (no runtime
  network fetch); a `verify-i18n` step keeps the catalog complete, and coded errors plug in
  as i18n keys.
- **Graceful, observable iOS `/screen` boot (#60)** — a capability preflight, a bounded
  whole-boot timeout (`VITE_BOOT_TIMEOUT_MS`, default 180s), per-stage progress, and lower
  peak memory make the cold boot legible and keep locked-down iOS Safari / WebViews from
  hanging silently; a device that cannot run the local engine dead-ends gracefully (no
  futile Retry) instead of spinning.
- **Adopted `@edgeproc/errors` for the bundle-load error path (#63)** — the portfolio's
  canonical-errors library (vendored when #63 landed, taken from npm since — see
  "Changed" above) classifies raw boot/screen failures through a registered taxonomy expressed
  in the shared error vocabulary. Behavior-identical: every failure still renders the exact
  same existing `errors:*` string — no user-visible copy or i18n key moved.
- **Self-hosted ORT wasm loader** — onnxruntime-web dynamically imports its wasm
  loader module (`ort-wasm-simd-threaded.asyncify.mjs` + sibling `.wasm`) from the
  jsDelivr CDN at runtime; a cold audit with jsDelivr aborted proved /screen never
  reached ready. Fixed end-to-end: `scripts/stage-ort-wasm.mjs` stages the pair from the
  lockfile-pinned node_modules into `public/ort/` on every `prebuild`,
  `env.backends.onnx.wasm.wasmPaths = "/ort/"` (embedder) makes the import same-origin,
  a dev-server middleware keeps dev === prod, and the C1 cold spec now aborts jsDelivr
  permanently alongside the HF globs (context-level routing, so Worker requests are
  covered). Includes a Cloudflare Pages 25 MiB asset-size preflight over the staged ORT
  runtime and the pinned model manifest, so a runtime/model bump fails in CI, not on
  deploy.
- **Vitest coverage floors, enforced** — every workspace package pins
  `coverage.thresholds` (statements 90 / lines 90 / functions 90 / branches 85) and the
  gate's unit step now runs `pnpm -r run test:coverage`, so the thresholds actually
  enforce (they are inert under a plain `vitest run`). Reached honestly with ~230 new
  behavior tests — no floor was lowered: app 86/79/82/87 → 95/88/94/96,
  browser 90/84/89/90 → 98/94/100/98, publisher 84/67/86/84 → 100/93/100/100,
  workstation already above at 95/94/91/94 (s/b/f/l).
- **Canonical `pnpm gate`** (`frontend/package.json`): one command fanning out to Biome
  lint → tsc typecheck → Vitest units (with coverage thresholds) → production build →
  all three Playwright e2e lanes. `ci.yml` now literally runs `pnpm run gate`, so the
  local gate and CI cannot silently drift.
- **`.gitleaks.toml` documented allowlist** — full upstream ruleset kept; the only
  exceptions are verified false positives (pre-v4 dummy docs/test fixture keys on
  deleted paths, and the EU webgate's public non-rotating list-download token). The
  weekly full-history secret scan is green again.
- **CLAUDE.md**: scarred "Quality Gates (Non-Negotiable)" section and the
  WASM / edge-compute patterns writeup (vendored/self-hosted WASM runtimes +
  parity-tested TS and sqlite-wasm-over-OPFS).
- **README 4-part TL;DR** (what / why it works / worked example / core invariants).
- **Post-publish live-origin integrity gate** — after the nightly publish deploys,
  `publish-watchlist.yml` now runs `verify-published-origin` (publisher package): it
  re-fetches the LIVE `/bundle/origin` and verifies the whole chain through the exact
  decode path the in-tab verifier enforces (`@amlfilter/browser` zstd decompress →
  sha256 == content-address, 8-way like the client) — signed pointer (version pinned to
  the stamp just published), manifest hash, and every chunk. A deploy that serves bytes
  the client would reject now fails the workflow loudly instead of shipping silently.

### Fixed

- **Permanent "failed content-address check" screen outage (2026-07-13)** — OPFS
  `getFileHandle(create: true)` creates the durable chunk entry BEFORE any bytes are
  written, so a sync interrupted mid-write (tab close, quota abort) could strand a
  zero-byte `chunk/<hash>` file. `hasChunk()` checked existence only, so every
  subsequent sync skipped re-fetching it, and reassembly then failed fail-closed with
  `chunk <hash> failed content-address check` on every boot — Retry could never heal
  (observed live: 1264 chunks in OPFS, exactly one zero-byte, exactly the chunk named
  in the error; the served origin verified byte-perfect). The store now implements the
  missing remove half of edge-proc cas.py's `_verify_or_remove`: a zero-byte chunk
  counts as absent (silently re-fetched on the next sync), a chunk failing integrity on
  read is evicted before the error propagates (fail-closed preserved, next sync heals),
  and a failed write removes whatever partial entry it created.
- **Browser model boot could fail as a fake network error** — transformers.js 4.2.0's
  progress callback starts three overlapping requests for the same 23 MB ONNX model.
  Under Chromium cache pressure that produced `ERR_CACHE_WRITE_FAILURE` and left
  screening unavailable even though the self-hosted model was healthy. Production now
  uses the indeterminate loading banner and omits that callback; the minified-browser
  gate asserts exactly one model request and races readiness against the error banner so
  failures surface immediately instead of after a 160-second disabled-input wait.
- **Silent false-clear on /screen (§C1, critical)** — the screen call was fired from a
  `setTimeout` with no `try/catch`, so a rejected `engine.screen()` left the previous
  (stale or empty) results on screen, reading as a confident "no matches". It is now
  awaited inside a guard that surfaces a visible `role="alert"` error state and never
  presents an empty result as a clear. Regression-tested with a rejecting engine.
- **Watchlist rollback via a stale signed pointer** — a monotonic `sequence` on the
  signed `VersionPointer` now rejects promoting an older watchlist over a newer active
  one (downgrade/replay), while a sequence-less legacy pointer still upgrades once and an
  equal sequence is an idempotent re-sync. `sequence` is part of the existing signed
  canonical bytes, so no signing/crypto/storage change. Replay-tested.
- **Model remote-fallback fail-closed** — `env.allowRemoteModels = false` so a missing or
  renamed local weight throws instead of silently fetching an unpinned model from
  huggingface.co. Tested: zero HF fetch on a missing weight.
- **Exact-alias recall** — alias scoring scored only the first alias that partially hit
  and early-returned at 0.5, so an exact-alias-only entity listed after a substring alias
  was silently halved and could drop below the threshold (a false clear). Every alias is
  now scored; an exact hit wins full weight regardless of order. The 0.5 substring
  behavior and the frozen scoring golden are unchanged; guarded by a shadowing test.
- **Zero font-CDN egress** — the marketing landing loaded Fraunces / Hanken Grotesk from
  `fonts.googleapis.com` via a `<link>` in `index.html` that fired on every route
  (including /screen). Removed; the faces now resolve local-or-system (see
  `--landing-font-*`). The C1 cold-blocked e2e asserts zero font-CDN requests.
- **ORT wasm env fails loud** — `ortWasmEnv()` now throws when
  `env.backends.onnx.wasm` is absent instead of configuring a throwaway `{}` (which would
  have left the loader on the jsDelivr CDN default). Guarded by a mocked-env import test.
- **Dev `/ort/` middleware path-traversal guard** — the dev-server raw-serve middleware
  now resolves each request through `resolveOrtAsset`, which rejects anything escaping the
  staged `/ort` dir via `..`. Dev-only; unit-tested (`src/dev/ortDevAsset.test.ts`).
- **Stale tab title** — `index.html` `<title>` was `AML-Filter v2`; corrected to
  `AML-Filter v4` (matches the header and `package.json`).
- **Weekly security-audit red** — `undici` (transitive via `jsdom`) bumped 7.26.0 →
  7.28.0 in the lockfile, clearing GHSA-hm92-r4w5-c3mj and the undici header-injection
  advisory; `pnpm audit --audit-level low` is clean again with no suppressions.
- **Action floors**: `gitleaks/gitleaks-action` v2 → v3; `astral-sh/setup-uv`
  full-pinned 8.2.0 → 8.3.2 (no floating major tag exists).

### Changed

- **Signed content-addressed bundle is now the only watchlist transport.** The browser
  delta-syncs a signed `latest` pointer → content-hashed `manifest` → deduplicated
  `chunk/` files, verifies every byte fail-closed (Ed25519 + SHA-256) against the pinned
  key, and materializes the catalog + per-list files into the durable OPFS store. The
  standalone `catalog.json` / per-list `watchlist.json` fetch path was retired.
- **OSS presentation pass** — README and docs aligned to the signed-bundle reality, plus
  a guarded (inert-until-secrets) Cloudflare Pages deploy workflow for the static SPA.

## [4.0.0] — 2026-06-20

> _Release tags v2.2–v3.x were never cut; per the tag-forward-only rule
> the annotated `v4.0.0` tag ("aml-filter 4.0.0 —
> browser-local screening workstation") is cut at the 2026-07 `main` tip reached
> during the standards-alignment work, not at the 2026-06-20 feature commit —
> history is not backfilled._

**From a single-list screener to a watchlist-filtering + KYC-review product.** aml-filter
still runs entirely in the browser tab — zero-server, pure-TypeScript — but it now screens
against **multiple sanctions lists** you select, wraps the matches in an **enterprise
review workflow** with an immutable audit trail, and **caches the lists durably** so it
works offline. Shipped on branch `feat/review-tool-v4`.

### Added

- **Multi-list screening.** A `WatchlistSource` adapter (`@amlfilter/publisher`
  `src/sources/`) per list — **OFAC SDN, EU, UN, UK/OFSI** — each with `fetchRaw()` +
  `parse()`. The publisher emits a **signed `catalog.json`** registry plus per-list signed
  artifacts under `watchlist/<id>/`, and the browser's `MultiListScreeningEngine`
  (`engine/multiEngine.ts`) holds one vector index per list over a single shared embedder,
  screening across all enabled lists and merging the results. _(OFAC/UN `fetchRaw` are live;
  EU/UK `fetchRaw` are scaffolded — real endpoint URL + a `TODO` for the access token /
  asset path — while all four `parse()` are real and fixture-tested.)_
- **List selection + per-list thresholds.** `/settings` lets you enable/disable lists and
  set a per-list sensitivity override; the engine applies
  `perList[id] ?? query.threshold ?? default`.
- **Enterprise review tool.** A `/settings` page (sensitivity Strict/Balanced/Lenient,
  per-list overrides, watchlist selection, analyst name) and a review board with a **View
  filter** (All / Needs review / Changed only), a **Source** column, a **"CHANGED — needs
  re-review"** badge, and a per-match **History drawer** backed by an append-only
  `match_events` audit trail (`DETECTED` / `DISPOSITIONED` / `REOPENED` / `CHANGED` /
  `SUPPRESSED`).
- **Review-once / re-review-on-material-change.** A `material_fingerprint`
  (`@amlfilter/workstation` `fingerprint.ts`) hashed over the customer's and matched
  entity's identity fields: an unchanged match stays suppressed with its prior disposition;
  a materially-changed one is flagged `CHANGED` while keeping the prior disposition.
- **Durable IndexedDB list cache** (`@amlfilter/browser` `engine/listCache.ts`,
  `watchlistCache.ts`) — verified list bytes cached in a store separate from the customer
  DB, **re-verified fail-closed on every load**, enabling **offline** screening. "Clear
  cached lists" lives in `/settings`.

### Changed

- **Single signed watchlist → signed catalog + per-list artifacts.** The browser now loads
  `watchlist/catalog.json` (verified first) and then each enabled list, instead of one flat
  `watchlist.json`. The v3 per-list file format is unchanged — it is exactly the N=1 case.
- **Namespaced entity ids.** Every adapter stamps `entity_id = "<source_list>:<rawId>"`
  (e.g. `OFAC_SDN:12345`) so ids stay unique once lists are merged into one engine.
- **SQLite schema bumped to v2** (`SCHEMA_VERSION = 2`): `kyc_matches` gains
  `material_fingerprint` and `review_state`; a new append-only `match_events` table records
  the audit trail.

## [3.0.0] — 2026-06-19

**The pivot to zero-server.** aml-filter is now a free, **pure-TypeScript, in-browser**
AML/sanctions screening app — no backend, no database, no signup. The entire
Python/FastAPI/Postgres server tier was removed; screening, customer storage, and
watchlist sync all run in the browser tab. (Closes #13, #16, #23 as won't-fix — there is
no Postgres, no server, and no torch left to fix.)

### Added

- **Signed-watchlist publisher** (`@amlfilter/publisher`) — fetch OFAC SDN → embed names
  with **transformers.js in Node** (no torch, no Python) → Ed25519-sign
  `{version, entities, vectors}` → emit 4 signed static files. Wire format documented in
  [`docs/WATCHLIST_FORMAT.md`](docs/WATCHLIST_FORMAT.md); published by
  `.github/workflows/publish-watchlist.yml`.
- **Bidirectional auto-rescan** — a watchlist change re-screens every customer; a
  customer change re-screens just that customer. Sync runs on app-open and via a
  "Check for updates" button. A resolved match keeps its disposition across rescans.
- **In-tab signed-watchlist load** — the browser engine verifies the watchlist
  **fail-closed** (Ed25519 / WebCrypto) and loads precomputed name vectors; only the
  query / customer name is embedded in-tab, so cold start stays fast.

### Changed

- **Screening engine** now consumes a single signed JSON watchlist + brute-force cosine,
  replacing the chunked content-addressed bundle + FAISS index (and its OPFS/zstd/GearCDC
  sync tier, ~1.5k lines, removed).
- **Goldens are now frozen committed regression snapshots** — the TS scorer/tiering is the
  single source of truth (the Python golden generators were removed with the backend).
- **Frontend majors**: React 18→19, React Router 6→7, Vite 7→8, `@vitejs/plugin-react`
  5→6, TypeScript 5→6.
- **CI is pure pnpm** — Biome → tsc → Vitest → build → Playwright C1 + KYC e2e.

### Removed

- **The entire Python/FastAPI server tier**: Postgres/pgvector, alembic + RLS,
  multi-tenancy / API-keys / rate-limiting, batch + RQ workers, OFAC ingest, the DB-path
  search backends, the `amlfilter` CLI, torch / sentence-transformers, and docker-compose.
- The dead admin/auth SPA surface (login, the 8 server-tier pages, the axios client,
  `@tanstack/react-query`).
- `docs/API_SPEC.md` and `docs/DATABASE_SCHEMA.md` (no HTTP API, no SQL schema).

## [2.1.0] — 2026-05-31

Built on the [edge-proc](https://github.com/hseshadr/edge-proc) substrate:
sanctions screening now runs **at the edge**. The OFAC list can be published as a
signed, versioned bundle and screened against locally — on the server with no vector
database, or entirely in a browser tab with no backend at all.

### Added

- **edge-proc localvec retrieval** (`aml_filter/search/localvec_backend.py`) — a
  drop-in for the pgvector ANN backed by edge-proc's FAISS `IndexFlatIP`, preserving
  aml's list/tenant filter semantics. Persisted via `VECTOR_INDEX_DIR`.
- **Signed OFAC bundle + `amlfilter` CLI** (`aml_filter/bundle/`,
  `aml_filter/cli.py`) — `keygen` / `bundle` / `sync` / `screen`. Publishes the list
  as a content-addressed, Ed25519-signed edge-proc bundle (`entities.jsonl` +
  prebuilt localvec `vector/` index + `ofac_meta.json` version pointer) and screens
  against it with fail-closed verification.
- **Config-gated, Postgres-free screening read-path** — `BUNDLE_BASE_URL` +
  `VERIFY_KEY_PATH` (+ `BUNDLE_CACHE_DIR`) source candidates from a synced bundle
  instead of a database (`aml_filter/bundle/runtime.py`).
- **In-browser screening tier** — `@amlfilter/browser`
  (`frontend/packages/amlfilter-browser/`), vendoring edge-proc's browser sync
  engine and porting the explainable scorer, plus a backend-free `/screen` page that
  syncs the signed bundle and screens names in-tab. Parity-tested against the Python
  runtime.

### Changed

- The frontend is now a **pnpm workspace** (`app/` + `packages/amlfilter-browser/`).
- Candidate generation is documented per path: hybrid search (pgvector + pg_trgm) on
  the DB path; localvec + a trigram stand-in on the bundle/browser path. The
  explainable `reasons[]` + `explanation` contract is identical across all three.
- `README.md`, `docs/ARCHITECTURE.md`, and `docs/QUICKSTART.md` updated to hero the
  edge-proc substrate and document both the server and in-browser paths.

## [2.0.0] — 2026-05-30

Public-launch readiness: a teen-readable two-altitude README, legal attribution and
disclaimers for the OFAC sanctions data, a green strict quality gate, and CI.

### Added

- `LICENSE` (MIT) and `NOTICE` — OFAC SDN attribution (public domain, never bundled)
  plus a prominent not-legal-advice / not-a-compliance-product disclaimer.
- Two-altitude `README.md` — a plain-language front door (what/why, one-command demo)
  over an "Under the hood" developer section.
- `docs/ARCHITECTURE.md`, `docs/DEPLOY.md`, and d2 diagrams (`docs/diagrams/`:
  `system-context`, `screening-pipeline`) with rendered SVGs.
- GitHub Actions CI: `.github/workflows/ci.yml` (backend gate) and
  `frontend.yml` (lint/typecheck/test/build + Playwright e2e).
- Typed, env-overridable configuration for scoring presets (`SCORING_*`) and
  rate-limit tiers (`RATE_LIMIT_*`), replacing in-source magic numbers.
- Frontend unit tests (vitest + Testing Library) for the API client, auth context,
  and error boundary.

### Changed

- Fail-closed configuration: a missing `DATABASE_URL` now aborts startup with an
  explicit error instead of silently degrading.
- Eliminated all `dict[str, Any]` from the backend in favour of precise Pydantic
  models and typed JSON aliases (`aml_filter/types.py`).
- Decomposed over-complex functions to the strict floor (≤15-line functions,
  Radon Grade A); `mypy --strict` clean across the backend.
- Frontend tooling moved from bun + eslint to **pnpm + Biome**, matching the
  portfolio standard.

### Removed

- Legacy `DEPLOYMENT_READY.md` status doc and `docs/archive/` implementation notes.
