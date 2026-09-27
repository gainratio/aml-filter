# AML-Filter Frontend

The entire aml-filter product: a **zero-server, pure-TypeScript, in-browser** AML/sanctions
screening app. There is no backend — the React SPA and the screening engine run entirely in
the tab. This directory is a **pnpm workspace** (pnpm + Biome; not npm/bun).

## Packages

| Package | Name | What it is |
|---------|------|------------|
| `app/` | `aml-filter-app` | The React + TypeScript (Vite) SPA — routes `/`, `/screen`, `/customers`, `/review`. |
| `packages/amlfilter-browser/` | `@amlfilter/browser` | The in-tab screening engine: fetch + fail-closed-verify the signed watchlist, embed in-tab, cosine search, Assay scoring and evidence. |
| `packages/amlfilter-publisher/` | `@amlfilter/publisher` | The Node-side tool that builds + Ed25519-signs the static watchlist files. |
| `packages/amlfilter-workstation/` | `@amlfilter/workstation` | The local-first KYC tier: SQLite-WASM/OPFS store + onboarding, review, tiering, and the bidirectional rescan. |

## Setup

```bash
cd frontend
corepack enable
pnpm install
```

Requires Node 22.13.0 (see `.nvmrc`) and pnpm. `pnpm gate` requires that exact version;
running the app only needs Node ≥ 22.13.

## Development

```bash
pnpm --filter aml-filter-app dev
```

This stages the MiniLM weights, the onnxruntime WASM runtime, and the landing page's
measured stats before Vite starts — a couple of minutes on a cold clone (a ~23 MB
SHA-256-pinned download), about a second on every run after.

The app is served at `http://localhost:5173` (Vite prints the exact URL). Open `/screen` for
the in-tab sanctions search (all four lists on a computer), then `/customers` and `/review` for the KYC workstation.
The Customers page supports preview-first local CSV/XLS/XLSX import and XLSX customer
table export; the spreadsheet is not a full match/audit backup.

The scorer composes the exact registry release `@edgeproc/assay@0.5.0-dev.3` behind
AML-Filter's typed five-signal contract. It emits stable input hashes and ordered
component contributions that are sealed into each score receipt.

## Build

```bash
pnpm --filter aml-filter-app build      # tsc --noEmit && vite build
pnpm --filter aml-filter-app preview    # serve the minified build locally
```

The `prebuild` hook self-hosts the MiniLM model weights and generates demo stats. The
production build ships everything as static files in `app/dist/` — host it on any static
host/CDN over HTTPS. A secure context is required for in-tab WebCrypto verification;
screening prefers OPFS and falls back to IndexedDB for its signed-list cache, while the
SQLite KYC workstation requires OPFS.

## The gate

The same canonical gate runs locally and in CI:

```bash
pnpm gate
```

It includes lint, type checks, coverage, production builds, recall/evaluation, i18n,
signed-bundle contracts, and the real-browser lanes. Run an individual lane from
`frontend/app` when iterating:

```bash
pnpm test:e2e:c1        # in-tab C1 screening
pnpm test:e2e:kyc       # backend-free local-first KYC journey
pnpm test:e2e:mobile:ci # WebKit iPhone + Chromium Android/desktop cold/reload
```

## Publish a watchlist

```bash
pnpm build-demo-list    # rebuild the committed signed DEMO watchlist
pnpm publish-list       # production publisher (CLI flags: --in --version --key --out [--models])
```

See `../docs/WATCHLIST_FORMAT.md` for the signed-watchlist wire contract and the package
READMEs above for details.

> aml-filter is an engineering-portfolio demonstration. It is **not** legal advice and **not**
> a compliance product — see the root `NOTICE` and `LICENSE`.
