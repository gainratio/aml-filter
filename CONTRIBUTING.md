# Contributing

Contributions are welcome. aml-filter is small enough to read end-to-end in an
afternoon — start with [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

> aml-filter is a portfolio demo, not a compliance product — see [`NOTICE`](NOTICE).

aml-filter is a pure-TypeScript, zero-server, in-browser app. It's a pnpm
workspace under [`frontend/`](frontend) with three packages: `frontend/app` (the
React app), `frontend/packages/amlfilter-browser` (the in-browser screening tier),
and `frontend/packages/amlfilter-workstation` (the local-first KYC tier). Tooling
is **pnpm + Biome** — no bun, ESLint, or Prettier.

## Local setup

New here? [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) walks you from a fresh
clone to a passing local build and your first change.

```bash
cd frontend
corepack enable
pnpm install
pnpm --filter aml-filter-app dev   # stages the model weights, then starts Vite
```

The first `dev` run downloads the ~23 MB SHA-256-pinned MiniLM weights and stages the
onnxruntime WASM runtime into `frontend/app/public/` (both git-ignored), so `/screen`
works on a cold clone. [`docs/QUICKSTART.md`](docs/QUICKSTART.md) has the full tour.

## Quality gate (run before opening a PR)

One command from `frontend/` — CI runs this exact script, so local and CI can't drift.
It requires the exact Node in [`frontend/.nvmrc`](frontend/.nvmrc) and fails otherwise,
because a gate green on a runtime CI never uses is not evidence:

```bash
cd frontend
nvm use          # or: nvm install $(cat .nvmrc)
pnpm install
pnpm gate        # lint, typecheck, coverage, build, i18n, and every browser lane
```

## How we work

- **Test-first.** Write the failing test, watch it fail for the right reason, then
  write the smallest code that turns it green.
- **TypeScript strict, no escape hatches.** No `any`, no default exports except
  top-level entry components (routes, pages, layout, and error boundaries), no
  loosening Biome or tsconfig to make the gate pass.
- **Explainability is non-negotiable.** Every screening match must carry its signal
  breakdown — don't add a scoring path that returns a bare number.

## Invariants

The scoring signals and preset weights are the load-bearing contract (see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#scoring--explainability-contract)).
Changing them changes the explanation shape — update the scorer and its tests
together.
