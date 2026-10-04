# @amlfilter/browser

**The in-browser screening engine of AML-Filter — multi-list sanctions screening that runs entirely in the tab, with no backend.**

Through `@gainratio/browser` (from npm, latest release) it delta-syncs a
same-origin OFAC/EU/UN/UK bundle, verifies the signed pointer,
manifest, compressed chunks, and materialized files **fail-closed** against a pinned
Ed25519 public key and SHA-256 content addresses, embeds the query in-tab with MiniLM,
and retrieves candidates through SQLite 3.53.4 + sqlite-vector 1.1.2 in a Worker. SQLite
3.53.4 is the latest stable release at the time of this contract. Each immutable signed
list gets one derived in-memory SQLite database containing vector rows and bounded exact
canonical-token/Double-Metaphone postings. TypeScript creates those keys; SQLite owns
their document-frequency filtering and deterministic lookup. Verified bundle bytes are
cached durably in the OPFS-first public store; customer queries and the separate private
KYC SQLite/OPFS database never enter that cache.

> aml-filter is an engineering-portfolio demonstration. It is **not** legal advice and **not** a compliance product — see the root `NOTICE` and `LICENSE`.

## Two export surfaces

### `.` — domain screening

Bootstrap the engine over the signed multi-list bundle and screen names.

```ts
import { EngineRuntime } from "@amlfilter/browser";

const engine = await EngineRuntime.bootstrap();
const result = await engine.screen({ name: "Some Name" });
```

This surface owns entity/alias types, the explainable scoring presets (`computeScore` /
`PRESETS`, five weighted signals), the embedder seam, and `ScreeningEngine`.

For memory-constrained browsers, opt into bounded residency. Metadata remains available
for the directory, while one selected list's vector index is loaded and released at a
time; overlapping screens are serialized and a single most-recent index is retained:

```ts
const engine = await runtime.bootstrap(config, onStage, {
	residency: "streaming",
	enabledLists: ["OFAC_SDN", "EU_CONSOLIDATED"],
});
```

The workstation's deterministic memory policy uses streaming by default when the
browser's memory budget is unknown or ≤8 GB; eager residency is reserved for an
explicitly reported >8 GB desktop. Callers that need desktop throughput can still pass
`residency: "eager"` explicitly. The public `/screen` route eagerly initializes only
its one selected OFAC list, so the Ready state includes the SQLite Worker, sqlite-vector
runtime, and rows: typing and scoring trigger zero network requests. It never eagerly
loads the rest of the catalog. `EngineRuntime` serializes bootstrap, reload, and
cache-clear lifecycle operations; clear-cache disposes vector databases, metadata, and
the optional model worker before the next verified boot.

### `./engine` — shared fail-closed primitives

This compatibility subpath re-exports the Ed25519/SHA-256 primitives and keeps
two tiny call-shape adapters over `@gainratio/browser`; AML does not carry a
second sync engine.
Production bundle sync runs the shared Worker through the one-line
`edgeproc.worker.ts` Vite entry. AML's index adapter uses
`@gainratio/browser/vector/sqlite`; it creates one in-memory SQLite database per immutable
signed list, inserts vectors and namespaced token/phonetic lookup keys together, delegates
semantic search to sqlite-vector, and resolves bounded lexical candidates from SQLite
postings. The engine unions both result sets, then applies the existing explainable score
unchanged. The durable bundle cache remains separate and authoritative, so the derived
database can be discarded and rebuilt from verified bytes. Publisher/browser parity
tests pin the same public package contract:

```ts
import { verifyEd25519, sha256Hex, SignatureError } from "@amlfilter/browser/engine";

// throws SignatureError if the detached signature does not verify (fail-closed)
await verifyEd25519(pubkeyRaw32, bytes, sigBase64);
```

## Shared substrate

`@gainratio/browser` is a normal npm dependency (`^0.2.0`, no upper cap), not
vendored source, a Git pin, or a local sibling link. The app tracks its latest
release; the committed lockfile makes clean-clone CI and deploys install the
exact version CI tested, including SQLite 3.53.4 and
the Apache-2.0 sqlite-vector 1.1.2 runtime.

The AML schema intentionally does not add an FTS5 trigram index or link spellfix1.
Corpus experiments found those alternatives noisier, larger, or semantically different
from the accepted exact-token/Double-Metaphone retrieval contract. Keeping phonetic key
generation behind the small TypeScript seam also preserves the measured rule that
phonetics widen recall but never decide a match.

This package is also MIT licensed (see the repository root `LICENSE` and `NOTICE`).
