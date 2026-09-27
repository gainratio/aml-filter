# Browser memory architecture

**TL;DR.** AML-Filter uses SQLite for two separate jobs without mixing their trust
boundaries. Public retrieval runs in a Worker through `@edgeproc/browser`, SQLite 3.53.4
(the latest stable release when this contract was updated), and sqlite-vector 1.1.2;
each immutable signed list gets one derived in-memory database containing vectors and
bounded exact token/Double-Metaphone postings. The verified bundle remains durably
cached in the public OPFS-first bundle store. Private KYC records live in a different
SQLite-WASM database persisted to OPFS.

## What is resident

There are four deliberately separate storage classes:

| Data | Durable browser storage | Runtime cost | Why it stays separate |
| --- | --- | --- | --- |
| MiniLM weights | Same-origin CacheStorage | ~23 MB model asset plus runtime/WASM allocations | The model is loaded once by its worker and reused; it is not customer data |
| Signed public watchlist bundle | Worker-owned content-addressed store: OPFS preferred, bounded IndexedDB WebKit fallback | Verified bytes plus the lists selected for the current route | Ed25519, SHA-256, monotonic pointer, cached reuse, and verify-before-parse remain byte-level invariants |
| Public retrieval index | One in-memory SQLite 3.53.4 database per immutable signed list, with sqlite-vector 1.1.2 in a Worker | Derived vector rows plus exact token/Double-Metaphone postings for the currently loaded lists | The database is disposable query state rebuilt only from verified bundle bytes; it is not another durable authority |
| Customers, matches, settings, audit events | Separate SQLite-WASM database on origin-private OPFS | Small transactional rows | Private state needs transactions, deletion, and audit semantics and never enters the public-list index |

The realistic 31,348 × 384 Float32 matrix is **48,150,528 bytes** (≤50 MiB) before
SQLite/WASM and model allocations. That matrix bound is still useful, but end-to-end
sqlite-vector latency and total browser memory come from the real Chromium lane; native
WASM memory and iOS tab limits still require a physical-device measurement.

## Residency policy

`frontend/app/src/lib/memoryPolicy.ts` is deterministic:

- unknown browser memory, mobile/iPadOS, or reported memory ≤8 GB → `streaming`;
- only a desktop explicitly reporting >8 GB may use `eager`;
- streaming retains metadata, loads one verified list, serializes screens, and disposes
  the prior index before loading the next one;
- the persisted list selection and scoring thresholds do not change with the policy.

The public `/screen` route picks its lists by device (`frontend/app/src/pages/screenScope.ts`).
A desktop eagerly initializes every catalog list; a phone or tablet eagerly initializes
only OFAC SDN, because all four eagerly is what ran iOS Safari out of memory (PR #71).
A phone can opt in to every list with one tap, which switches to `streaming` residency.
Either way the Ready state means the SQLite Worker, sqlite-vector runtime, and vector rows
are already local, so typing and scoring make zero network requests.

Measured on 2026-09-26 against a local mirror of the live bundle (4 lists, 32,325 entries,
headless Chromium on an Apple-silicon desktop, total browser RSS, one run each):

| `/screen` scope | Cold boot | RSS after boot | Peak RSS | Search |
|---|---|---|---|---|
| OFAC only, eager (old default) | 7.3 s | 948 MB | 1,405 MB | 0.3–0.4 s |
| All four, eager (desktop default) | 8.5 s | 1,109 MB | 1,564 MB | 0.3–0.8 s |
| All four, streaming (phone opt-in) | 4.0 s | 1,016 MB | 1,596 MB | ~8 s |

Streaming re-reads and re-verifies each list from OPFS on every search, which is why it
is an explicit opt-in on phones rather than the default. These are desktop numbers; the
iPhone budget itself was not measured here. The configurable workstation keeps the policy above, so a low-power laptop is
not treated as safe merely because it identifies as a desktop or omits
`navigator.deviceMemory`.

The Chromium C1 gate keeps post-boot JavaScript heap below **384 MiB** when the metric is
available. This is a regression ceiling, not a claim about total RSS or WebAssembly
memory; the physical iPhone acceptance run remains a separate release evidence item.

## Shipped SQLite retrieval design

`VectorIndex` calls `createSqliteVectorIndex` from
`@edgeproc/browser/vector/sqlite`. The shared runtime packages SQLite 3.53.4 with the
Apache-2.0 sqlite-vector 1.1.2 extension and executes it in a Worker. AML inserts decoded
vectors and namespaced canonical-token/Double-Metaphone keys in bounded batches and
requests `persistence: "memory"`; consequently each loaded immutable list has its own
isolated, disposable database. SQLite owns postings, document-frequency filtering, and
deterministic id lookup; sqlite-vector owns cosine retrieval. TypeScript still generates
the keys, unions the bounded candidate sets, and applies the transparent final score.

The AML database does not create an FTS5 trigram table, and spellfix1 is not linked.
Measured corpus experiments found those alternatives noisier, larger, or semantically
different from the accepted retrieval contract. This design reuses one database without
turning a phonetic or edit-distance hit into a decision rule.

This does **not** move the signed bundle into an additional durable database. The
OPFS-first content-addressed bundle store remains the recovery source of truth and every
input is verified before rows are derived. Streaming residency disposes the prior list's
database before loading the next, while eager residency may retain one database per
enabled list. A reload can always rebuild these indexes from the verified cached bundle.

The KYC store is intentionally unrelated: `@amlfilter/workstation` owns its own
SQLite-WASM Worker and OPFS database for customers, matches, settings, and audit events.
No customer record or query is written to the public-list databases or bundle cache.
This keeps the design composable: the shared package owns vector execution, the signed
bundle owns public-data durability, and the workstation owns private transactional data.

## Browser support and memory safeguards

The model and sanctions lists are large enough to exhaust a mobile tab if they are
loaded carelessly. The app therefore:

- serializes boot behind one shared promise;
- keeps one runtime owner instead of compiling duplicate ONNX sessions;
- uses one-list-at-a-time vector residency on mobile, unknown-memory devices, and
  desktops reporting 8 GB or less;
- delegates signed-bundle transport, verification, cross-tab locking, and durable
  storage to `@edgeproc/browser` pinned to a reviewed public commit;
- disposes the old engine before a reload, then builds and swaps the replacement;
- prevents overlapping update checks and clears recurring timers on unmount.

The supported baseline is the current and previous desktop Chrome, Edge, Firefox, and
Safari 17+. Mobile Safari and Chrome use the bounded-memory path. Embedded WebViews are
outside the release contract. Screening requires Workers, durable browser storage
(OPFS or IndexedDB), WebCrypto, Web Locks, and a secure context. The KYC workstation
additionally requires OPFS for its SQLite database.
