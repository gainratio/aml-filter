# Security, privacy, reliability, and performance contract

**TL;DR.** AML-Filter is a static site with two trust domains: public signed
watchlist/model bytes arrive from the same-origin CDN, while customer names and review
data stay inside the browser. A release is blocked if signed data can roll back, typed
queries make a network request, customer deletion leaves review history behind, any
operation is unbounded, or the deployed site cannot prove its exact Git commit.

## Threat and privacy data flow

| Data | Path and storage | Retention / deletion | Network and logs |
| --- | --- | --- | --- |
| Signed watchlists and list vectors | Cloudflare Pages → verified Worker → content-addressed durable cache (OPFS preferred; IndexedDB WebKit fallback) | Replaced by monotonic signed publishes; **Clear cached lists** deletes the public-data cache | Same-origin GET only; public, never PII |
| Embedding model and ORT runtime | Same-origin immutable assets → browser cache / memory | Browser cache policy; user can clear site data | Same-origin GET only; no Hugging Face/jsDelivr fallback |
| Typed screening query | Input → ephemeral worker embedding → score | Not persisted by `/screen`; query vector is ephemeral | **Zero requests while typing/scoring** and no query text in console output, enforced by C1 Chromium |
| Customer profile, DOB, identifiers | UI → SQLite-WASM on origin-private OPFS | Local until explicit customer deletion or browser-site-data deletion; deletion removes application rows with `secure_delete=ON` | No application API, telemetry, prompt, or provider path |
| Matches, reviewer identity, notes, audit events | Same local SQLite database | Lifecycle writes are append-only, enforced by SQLite triggers rather than by convention (not tamper-evidence — the file is yours and there is no hash chain); customer deletion atomically removes matches, reviewer data, and events from SQLite | No application API or telemetry; C1 asserts screened names do not appear in console output |
| Settings | Same local SQLite database | Until changed or browser-site-data deletion; deleting one customer does not erase global settings | No application API or telemetry |

There is no generative-AI prompt path, account service, server database, analytics SDK,
cloud backup, or full restore service. The Customers workspace does provide a local,
preview-first CSV/XLS/XLSX customer-table transfer, but it intentionally excludes
matches, audit events, settings, and the signed watchlist cache; it is not a complete
backup. Clearing browser site data is still the only all-data reset and has no remote
recovery. The operator must not describe this local demo as centrally recoverable.

The persistent SQLite connection fails closed unless `secure_delete=ON` and rollback
journal `DELETE` mode are active; startup also truncates a legacy WAL before disabling
WAL mode. This narrows residual-data exposure inside SQLite, but it is not a claim of
forensic erasure from browser storage, filesystem snapshots, or device backups. Those
layers are controlled by the browser/OS. Clearing the origin's site data is the only
application-supported device-level reset.

### Trust boundaries and adversaries

- **CDN or cache serves hostile/stale bytes.** The browser verifies the Ed25519 pointer,
  its required monotonic `sequence`, the manifest content address, every compressed
  chunk, and every reassembled file before parsing or promotion. Missing/stale sequence,
  signature failure, hash failure, rollback, and an equal-sequence/different-pointer
  collision all fail closed before downstream fetch or promotion.
- **A stale deploy reports success.** Each workflow writes the checked-out 40-character
  Git SHA and GitHub run id to `build.json`, deploys it with the app, then polls the real
  domain until that exact identity is served. A no-op/stale Pages deploy fails.
- **Origin or network stalls.** Each fetch aborts after 15 seconds. Only a typed
  network-unreachable failure may use an already verified active cache; integrity
  failures never fall back.
- **Storage is small/corrupt or a write is interrupted.** Sync checks reported quota,
  validates cached bytes on read, evicts zero-byte/poisoned chunks, and refetches them on
  retry. Database migrations and privacy deletion are transactions.
- **Two tabs sync or clear concurrently.** Web Locks let syncs stage CAS bytes together,
  serialize the final active-pointer re-check/promotion, and make clear exclusive. Every
  acquisition aborts after 10 seconds with a typed retryable error; the UI surfaces the
  existing Retry path instead of waiting forever on a stalled tab. Missing Web Locks is
  detected before boot and is unsupported, not silently unsafe.
- **Large lists exhaust the tab.** Chunk fetches use an eight-worker queue; the real-list
  directory renders 24 cards per page; the vector matrix is a single row-major
  `Float32Array` transferred across worker boundaries instead of cloned.
- **Supply chain or key exposure.** Runtime dependencies are lockfile-pinned, the model
  and staged WASM assets are SHA-256/size checked, the signing seed exists only as a
  GitHub secret, the dependency audits (shipped deps in the `Dagger` check, dev tooling in
  `dev-tool-audit.yml` and before every code release) have no ignore list, and gitleaks
  scans full history.

## Numeric SLA and resource budgets

These are engineering-demo bounds, not a hosted compliance-service availability SLA.
They are fixed in tests before measurement.

| Workload | Budget | Enforcement |
| --- | ---: | --- |
| One bundle/model fetch | ≤ 15 s | `FETCH_TIMEOUT_MS` + abort test |
| Cross-tab store-lock acquisition | ≤ 10 s | abortable Web Locks regression tests |
| Model load | ≤ 120 s | `MODEL_LOAD_TIMEOUT_MS` + never-settles/retry tests |
| Whole cold boot | ≤ 180 s (C1 uses a tighter 160 s vote) | runtime timeout + minified Chromium |
| Warm typed query through rendered result | ≤ 10 s | minified Chromium C1 |
| Exact top-10 retrieval, 31,348 × 384 | p50 ≤ 500 ms; p95 ≤ 1,000 ms | repeatable 20-run Vitest performance contract |
| Vector matrix, 31,348 × 384 | ≤ 50 MiB | realistic performance contract (actual 48,150,528 B) |
| Directory DOM | ≤ 24 dossier cards; < 2,000 total nodes in C1 | 31,348-row unit fixture + Chromium |
| Post-boot JavaScript heap | < 384 MiB where Chromium exposes the metric | C1 Chromium |
| Chunk download fan-out | ≤ 8 requests | concurrency regression test |
| Model requests per cold boot | exactly 1 | C1 Chromium |
| Query-time and third-party requests | exactly 0 | C1 Chromium network boundary assertion |
| One static asset | < 25 MiB | Cloudflare Pages asset preflight |

Local reference measurement on 2026-07-15 (macOS arm64, Node 25.2.1) for the realistic
31,348 × 384 exact scan: **p50 10.2 ms, p95 18.1 ms**, 48,150,528-byte matrix.
Reproduce it:

```bash
cd frontend/packages/amlfilter-browser
pnpm exec vitest run src/engine/vectorIndex.performance.test.ts --reporter=verbose --silent=false
```

The production browser p50/p95 and exact cold/warm timings must be recorded after deploy;
the hard local bounds prevent a regression from shipping, but they are not a substitute
for real-domain measurement.

## Recovery contract

- **Bundle origin unreachable after a verified boot:** use the verified durable active bundle
  and browser-cached model. The bundle lane proves reload and screening with every
  `/bundle/origin/**` request aborted. It does NOT prove offline operation: the lane still
  serves the document, the JS, and the model over the network. There is no service worker,
  so a genuinely offline reload fails to load the page at all.
- **Corrupt/partial chunk:** fail the current read, evict it, then refetch on Retry. Never
  present an empty list as a clear result.
- **Bad signature/hash/rollback:** stop. Do not use the incoming bundle and do not replace
  the last verified active pointer.
- **Boot timeout:** show a visible alert and working Retry; memoized failed boot state is
  cleared so Retry performs real work.
- **Store-lock timeout:** close a stale AML-Filter tab and Retry. A timed-out request does
  not enter its critical section or mutate the active pointer.
- **Database contention:** eight bounded acquisition attempts with 50–800 ms backoff.
- **Browser storage loss:** a customer-table XLSX export can recover the exported
  profiles, but it cannot restore matches, audit events, settings, or watchlist cache.
  Recovery point for the complete workstation remains the last committed local SQLite
  transaction while OPFS survives; if site data is cleared, the omitted state is
  unrecoverable by design.

## Supported browser baseline

Production support covers the current and previous desktop releases of Chrome, Edge,
Firefox, and Safari 17+. A secure context must provide module Workers, durable browser
storage (OPFS or IndexedDB), WebCrypto, and Web Locks. Mobile Chrome and Safari use the
bounded-memory screening path; the SQLite KYC workstation still requires OPFS.
Embedded WebViews remain outside the release contract.

## Release and production runbook

1. Run `cd frontend && pnpm gate` on the exact commit (coverage, build, i18n,
   Chromium and iPhone-shaped WebKit lanes). Run the scheduled dependency/secret
   audits too.
2. Deploy only after CI succeeds. The workflow rebuilds and verifies the real signed
   bundle, stamps `build.json`, deploys, and rejects a stale exact-identity check.
3. On `https://aml-filter.com`, verify `build.json`, CSP, no wildcard CORS (the
   advanced-mode worker strips hosting-added wildcard CORS from static responses),
   `public.key` MIME/revalidation, `latest` no-store, immutable manifest/chunk caching,
   real 404, clean console/network, and mobile + desktop screening.
4. Verify `www` permanently redirects to the canonical apex with path and query intact.
5. Record cold/warm p50/p95, request counts, heap/DOM bounds, and the exact deployed SHA.
   Until this real-domain evidence passes, the release is not complete.
