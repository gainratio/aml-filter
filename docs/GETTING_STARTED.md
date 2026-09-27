# Getting started for developers

This guide takes you from nothing to a passing local build and your first change. Every
command here was run on macOS on 2026-09-25: the install and the full check from a
fresh clone. Times are from those runs.

If you only want to use the app, open [aml-filter.com](https://aml-filter.com) or read
the user [Quickstart](QUICKSTART.md) instead.

## 1. What you need

| Tool | Version | How to get it |
| --- | --- | --- |
| Node | exactly **22.13.0** (see [`frontend/.nvmrc`](../frontend/.nvmrc)) | `nvm install 22.13.0 && nvm use 22.13.0` |
| pnpm | 11.5.0 (pinned in `frontend/package.json`) | `corepack enable`, run with Node 22.13.0 active |
| Python + uv | Python 3.13, uv 0.8 or later | [uv install guide](https://docs.astral.sh/uv/getting-started/installation/). Only the full check needs it. |
| Playwright browsers | Chromium, Firefox, WebKit | `pnpm --filter aml-filter-app exec playwright install chromium firefox webkit` (step 3) |
| Dagger (optional) | 0.21.8 | Only to run CI's container locally. See [Deploy](DEPLOY.md#run-the-gate-or-build-with-dagger). |

Traps we hit on a real machine:

- **Use Node 22.13.0 exactly.** The full check refuses to run on any other version,
  because a different Node once hid a bug that CI caught. `engines: >=22.13` in
  `package.json` is not enough.
- **A newer system Node breaks corepack's pnpm.** With Node 26 active, `pnpm -v` crashed
  with `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`. Switch to Node 22.13.0 first, then run
  `corepack enable`.
- **Use `localhost`, not a network address.** The app checks the list signature with
  the browser's WebCrypto, which only works in a secure context. `http://192.168.x.x`
  is not one.
- **`dev:live` does not work locally right now.** The dev server always serves the demo
  signing key, so the real lists fail verification. Use `dev` (the demo list).

## 2. Clone, install, run

All commands run from `frontend/`. There is no `package.json` at the repo root.

```bash
git clone https://github.com/hseshadr/aml-filter
cd aml-filter/frontend
corepack enable
pnpm install                          # 17 s here, with a warm pnpm store
pnpm --filter aml-filter-app dev      # downloads the 23 MB model once, then starts Vite
```

Success looks like this in the terminal:

```text
[aml-filter] local server: serving the DEMO verify key at /public.key (it pairs with the committed demo bundle). Production ships public/public.key.

  VITE v8.3.0  ready in 141 ms

  ➜  Local:   http://localhost:5173/
```

Open http://localhost:5173/screen and type `fakovic`. You should see
"1 potential match", Ivan Fakovich, score 0.547. The local copy searches a made-up list
of 8 people that is committed to the repo, so it works without the real lists.

## 3. Run the full check

This is the same script CI runs. Run it before you open a PR.

```bash
pnpm --filter aml-filter-app exec playwright install chromium firefox webkit   # once
pnpm gate
```

It runs, in order: the Node version check, lint (Biome), type checks, unit tests with
coverage for every package, production builds, the match-quality checks (recall on the
real OFAC list and the Python evaluation in [`eval/`](../eval)), translation checks,
and five real-browser test runs (receipt, screening, customers, signed lists, phones).
On a fresh clone it took about 14 minutes on a 12-core Mac. In CI it takes about 24
minutes. On a busy machine a unit test can hit its 5-second timeout; the first run here
did that under heavy load and passed when rerun.

To run one package's unit tests while you work:

```bash
pnpm --filter aml-filter-app test                       # the React app
pnpm --filter @amlfilter/browser test                   # matching and scoring
pnpm --filter @amlfilter/workstation test               # customers and review
pnpm --filter @amlfilter/publisher test                 # list download and signing
```

## 4. Map of the code

```text
frontend/
├── app/                        the React app you see at aml-filter.com
│   ├── src/pages/              one file per page: Screen, Customers, Review, Settings, Landing
│   ├── src/locales/en/         every piece of on-screen text, as JSON
│   ├── src/components/         layout, error screens, the analyst-name prompt
│   ├── tests/                  Playwright real-browser tests
│   └── public/bundle/origin/   the committed demo list (8 made-up people), signed
└── packages/
    ├── amlfilter-browser/      runs in the tab: checks list signatures, matches names, scores
    │   └── src/engine/         scoring.ts, tiering.ts, screeningEngine.ts, runtime.ts
    ├── amlfilter-workstation/  customers, review decisions, re-screening, the local SQLite store
    └── amlfilter-publisher/    downloads the official lists and signs them (runs in CI, not the browser)
        └── src/sources/        one adapter per list: ofacSource.ts, euSource.ts, unSource.ts, ukSource.ts
eval/                           independent Python harness that measures match quality
.github/workflows/              CI (dagger.yml), deploy, daily list publish, live smoke test
```

[Architecture](ARCHITECTURE.md) explains how these fit together.

## 5. Make your first change

A typical small change is editing text on a page. Here we change the hint next to the
Strictness buttons on `/screen` from "how closely a name must match" to "how close a
name must be to count as a match". We write the test first.

1. Add a test to `frontend/app/src/pages/ScreenPage.test.tsx`, inside the
   `"ScreenPage — in-browser search"` block:

   ```tsx
   it("explains the strictness control in plain words", async () => {
   	render(<ScreenPage />);
   	await readyBox();
   	expect(
   		screen.getByText("how close a name must be to count as a match"),
   	).toBeTruthy();
   });
   ```

2. Run just that test and watch it fail (about 2 seconds):

   ```bash
   pnpm --filter aml-filter-app exec vitest run src/pages/ScreenPage.test.tsx -t "strictness control"
   ```

   You should see `× explains the strictness control in plain words` and
   `Unable to find an element with the text`.

3. Make the change. The text lives in `frontend/app/src/locales/en/screen.json`, under
   `strictness.hint`. Edit it there, not in the `.tsx` file.

4. Run the same test again. It passes. Then check the translations and lint:

   ```bash
   pnpm --filter aml-filter-app run verify:i18n
   pnpm --filter aml-filter-app run lint
   ```

5. Run `pnpm gate` before you push.

Changes to scoring are different. The score's parts and weights are a contract that
frozen test fixtures lock down. If you change them, update the scorer and its golden
fixtures together, and say so in the PR. See
[Architecture](ARCHITECTURE.md#scoring--explainability-contract).

## 6. Open a pull request

- **Branch** off `main` with a short prefix that says what kind of change it is:
  `fix/`, `feat/`, `docs/`, `ci/`. For example `fix/uk-feed-fetch`.
- **Commits** use the same prefix style: `fix(publisher): ...`, `docs: ...`.
- **CI** runs two checks on every PR: `Dagger` (the full `pnpm gate` in a container)
  and GitGuardian (secret scanning). Both must pass.
- **Reviewers look for:** a test written first that fails without your change, no
  weakened signature or hash check, every match still showing why it scored what it
  did, and README, `docs/` and [CHANGELOG](../CHANGELOG.md) updated when behaviour
  changes. The [PR template](../.github/PULL_REQUEST_TEMPLATE.md) has the checklist.
- More on how we work: [CONTRIBUTING.md](../CONTRIBUTING.md).
