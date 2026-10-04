# Signed Watchlist Format (the bundle wire contract)

**TL;DR** — the app downloads its sanctions lists as a single **signed,
content-addressed bundle** served as plain static files (any host/CDN, no backend).
Trust is end-to-end via Ed25519: a tiny **signed pointer** names a **content-hashed
manifest**, the manifest lists every file as **content-hashed chunks**, and the
browser delta-syncs + verifies all of it **fail-closed** in a Web Worker before a
single byte is parsed. This document is the single source of truth for that artifact.

The legacy flat JSON wire (`watchlist.json` / `catalog.json` + detached `.sig`,
fetched directly) has been **retired** as a distribution path — the app no longer
fetches it. (The publisher's single-list `publish` CLI still *emits* that flat 4-file
set for the OFAC GitHub Action; see [Legacy](#legacy-the-flat-json-wire-retired).)

## Distribution layout (served as static assets)

```
bundle/origin/
  latest                        # the signed VersionPointer (JSON) — the trust anchor
  manifest/<manifest_hash>      # the content-addressed IndexManifest (JSON), named by its own sha256
  chunk/<chunk_hash>            # one file per content-defined chunk, named by the sha256 of its plaintext
```

The app's bundle base URL defaults to **`/bundle/origin`** (overridable with
`VITE_BUNDLE_BASE_URL`); the committed demo bundle lives at
`frontend/app/public/bundle/origin/`. On open the browser:

1. Fetches **`latest`** (`cache: "no-store"` — the only mutable file) and verifies its
   detached Ed25519 `signature` against the pinned same-origin key
   (`frontend/app/public/public.key`). **Fail-closed**: a bad signature aborts. The
   signed monotonic `sequence` must not be lower than the active pointer's sequence,
   so an authentically signed stale pointer cannot roll the browser back.
2. Fetches **`manifest/<manifest_hash>`** and checks that the bytes hash to the
   `manifest_hash` the verified pointer named. Authenticity flows from the signed
   pointer → the content hash, so the manifest needs no separate `.sig`.
3. Diffs the manifest's chunk set against the durable browser store and fetches **only
   the missing `chunk/<hash>` files** — the delta sync. OPFS is preferred; affected
   WebKit builds that expose but cannot open OPFS use a bounded IndexedDB adapter.
   Each chunk is verified to hash to its name, and each reassembled file is verified
   to hash to its `file_sha256`.

Any signature or hash mismatch — over freshly fetched **or** durably cached bytes —
aborts the load with no silent empty list.

## `latest` — the signed `VersionPointer`

The trust anchor: a detached Ed25519 signature over the canonical bytes of the object
**excluding** `signature`. Source of truth:
`@gainratio/browser`'s public `VersionPointer` contract.

```json
{
  "manifest_hash": "9ca69ce7455f04b585c2d9210ce72d2c6ed242c0baf72a067550484b4eb2e434",
  "version": "demo-1",
  "bundle_id": null,
  "channel": null,
  "sequence": 1,
  "signature": "u9kyIPD6PLGEV6KDmZF4HTtDNbOyKCgZG8RWWfWM9BC/+cGctgZXg9zu2KmjKY4jjCbuowpxRtpxXiGsYecTDQ=="
}
```

| Field | Meaning |
|------|---------|
| `manifest_hash` | hex sha256 of the manifest's canonical bytes — the content address under `manifest/` |
| `version` | the composite version stamp (also used for change-detection on poll) |
| `bundle_id` / `channel` | optional edge-proc routing identity; null in the committed demo |
| `sequence` | required non-negative safe integer on new pointers; the publisher derives it as one greater than the signature-verified live pointer. During the one-way first-publish migration, a valid pre-sequence pointer is treated as zero by `next-published-sequence`; all emitted pointers and incoming browser pointers remain sequenced |
| `signature` | base64 Ed25519 over `canonicalBytes(self, exclude {signature})` |

An equal sequence is idempotent only when the pointer identity (manifest, version,
bundle, and channel) is unchanged; reusing it for different bytes is rejected as a
sequence collision. A lower sequence is rejected before any manifest or chunk is
fetched. A sequence-less pointer already cached by a pre-sequence client may upgrade
once to a sequenced pointer; new incoming pointers must carry a valid sequence.

## `manifest/<manifest_hash>` — the `IndexManifest`

Authenticated by its **content hash**, not an embedded signature. Source of truth:
`@gainratio/browser`'s public `IndexManifest`, `FileEntry`, and `ChunkRef` contracts.

```json
{
  "schema_version": 2,
  "bundle_id": "amlfilter-watchlists",
  "version": "demo-1",
  "files": [
    {
      "path": "catalog.json",
      "file_type": null,
      "size": 655,
      "file_sha256": "ba5248fa3d6502a9...",
      "chunks": [{ "hash": "ba5248fa3d65...", "size": 655 }]
    }
    // … ofac/entities.jsonl, ofac/vectors.f32, ofac/meta.json, eu/…, un/…, uk/…
  ],
  "metadata": {}
}
```

| Field | Meaning |
|------|---------|
| `schema_version` | manifest schema version (currently `2`) |
| `bundle_id` | logical bundle identifier (e.g. `amlfilter-watchlists`) |
| `version` | matches the pointer's `version` |
| `files[]` | a `FileEntry` per file the bundle materializes (below) |
| `metadata` | free-form `Record<string, string \| number \| boolean \| null>` (empty in the demo) |

Each **`FileEntry`**:

| Field | Meaning |
|------|---------|
| `path` | the file's path inside the bundle (e.g. `ofac/vectors.f32`) |
| `file_type` | optional content hint (`null` in the demo) |
| `size` | total uncompressed file length in bytes |
| `file_sha256` | bare hex sha256 of the whole reassembled file (verified after reassembly) |
| `chunks[]` | ordered `ChunkRef`s; reassembly = concatenation in this order |

Each **`ChunkRef`** is `{ "hash": <bare hex sha256 of the chunk plaintext>, "size": <bytes> }`.
The chunk plaintext lives at `chunk/<hash>`. Content-defined chunking means an unchanged
list shares its chunks across versions, so a new publish re-fetches only changed chunks.

## The materialized files (what the manifest lists)

After a verified sync the browser materializes the manifest's `files` into a watchlist
catalog + per-list files, all consumed in-tab:

- **`catalog.json`** — the multi-list registry: the lists the bundle carries (OFAC, EU,
  UN, UK …), each with `id` / `title` / `version` / `entitiesCount`, and the per-list
  slug. The catalog is the verify-before-parse entry into the lists.
- **`<slug>/entities.jsonl`** — one `WatchlistEntity` JSON object per line (the full
  list rows: `entity_id`, `name_canonical`, `aliases`, `dob`, `countries`,
  `risk_category`, `source_list`, `list_version`).
- **`<slug>/vectors.f32`** — the precomputed name embeddings as a raw **row-major
  little-endian Float32** buffer, `entitiesCount * dim` floats. Row *i* is the embedding
  of `entities[i].name_canonical`. (Decoded in-tab and pinned to `dim = 384`,
  fail-closed.)
- **`<slug>/meta.json`** — the per-list `BundleListMeta`. Source of truth:
  `frontend/packages/amlfilter-browser/src/engine/watchlist.ts`
  (`BundleListMeta`, `BundleListFiles`).

`BundleListMeta` (the per-list `meta.json`):

```json
{
  "listId": "OFAC_SDN",
  "version": "demo-1",
  "generatedAt": "2026-06-19T00:00:00Z",
  "model": "Xenova/all-MiniLM-L6-v2",
  "dim": 384,
  "entitiesCount": 3
}
```

`BundleListFiles` is the in-tab triple the engine reassembles per list:
`{ entitiesJsonl, vectorsF32, meta }` (raw `Uint8Array` bytes of the three files above).

### Notes
- **Vectors are precomputed at publish time** with transformers.js in Node (the SAME
  `EMBEDDING_MODEL` / `EMBEDDING_DIM` as the browser), so the browser never embeds the
  list — only the query/customer name in-tab. No torch, no Python.
- **Namespaced entity ids.** Every adapter stamps `entity_id = "<source_list>:<rawId>"`
  (e.g. `OFAC_SDN:12345`, `EU_CONSOLIDATED:13`) so ids stay unique once lists are merged
  into one engine.
- **Determinism**: `name_canonical` via the shared `canonicalize()`; `countries` sorted —
  same rules as the committed scoring golden, so screening output stays parity-locked.
- **One pinned key.** The pointer's signature is checked against
  `frontend/app/public/public.key` (pinned, served same-origin — never from the list
  origin). The signing **private** key never lives in the repo or the app; production
  signs in CI (the `WATCHLIST_SIGNING_KEY` secret). The committed **demo** bundle is
  signed with a clearly-labeled non-production demo key whose public half is
  `public.key`. Build the committed demo bundle with
  `pnpm --filter @amlfilter/publisher run build-demo-bundle`.

## Legacy: the flat JSON wire (retired)

The earlier distribution format was a directory of plain signed JSON files —
`catalog.json(.sig)` over per-list `watchlist.json(.sig)` + `watchlist.manifest.json(.sig)`,
each fetched and verified directly. **The browser no longer fetches this**; the bundle
above is the only distribution path. The publisher's single-list `publish` CLI
(`amlfilter-publish publish --in <jsonl> --version <v> --key <privkey> --out <dir>`, run
by `.github/workflows/publish-watchlist.yml` for OFAC) still emits the flat 4-file set
(`watchlist.json`/`.sig` + `watchlist.manifest.json`/`.sig`) as a source artifact, but it
is not what the app loads at runtime.
