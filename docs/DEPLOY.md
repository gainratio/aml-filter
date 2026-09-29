# Deploy

> aml-filter is a portfolio demo, **not** a compliance product. Do not deploy it as a
> production sanctions-screening control. See [`../NOTICE`](../NOTICE).

**TL;DR.** aml-filter is a **static single-page app** plus a **signed catalog of static
watchlist files**. There is no server-side database or service to provision. Build it,
then host the output directory on any static host or CDN
(Netlify, Vercel, GitHub Pages, S3 + CloudFront, Cloudflare Pages, …). The only hard
requirement is that it be served over a **secure context (HTTPS)** so the browser can do
WebCrypto signature verification and use private browser storage.

## 1. Build the static site

All commands run from `frontend/` — there is no root `package.json`.

```bash
cd frontend
pnpm install
pnpm --filter aml-filter-app build
```

`build` runs `tsc --noEmit && vite build`. A `prebuild` hook first fetches the embedding
model weights and regenerates demo stats, so the output is self-contained.

The build emits **`frontend/app/dist/`**. Ship that directory as-is. It already includes
everything the app needs at runtime:

| Bundled into `dist/` | What it is |
| --- | --- |
| the SPA (HTML/JS/CSS) | the React app and the in-tab screening/scorer code |
| `bundle/origin/` | the committed **signed** content-addressed demo bundle: the `latest` pointer + `manifest/` + `chunk/` CAS |
| `public.key` | the pinned Ed25519 public key the app verifies the bundle against |
| `models/` | the MiniLM embedding-model weights (loaded once, in-tab) |

## 2. Serve it (secure context required)

Serve `dist/` as plain static files over **HTTPS**. A secure context is required:

- **WebCrypto** (`crypto.subtle`) — the in-tab Ed25519 signature verification of the
  watchlist. The verification is **fail-closed**: any signature or hash mismatch aborts
  the load.
- **OPFS** — where the local-first KYC store (SQLite-WASM) persists in the browser.
- **OPFS or IndexedDB** — the signed-list cache prefers OPFS and uses a bounded
  IndexedDB compatibility adapter when WebKit cannot actually open OPFS.

`localhost` also counts as a secure context, which is what local preview and the e2e
lanes rely on; a LAN IP does **not** and will fail differently. Any static host that
serves over HTTPS works without further configuration.

## 3. Refreshing the lists

The sanctions lists change frequently; screening against a stale copy can miss
newly-listed entities. The real multi-list bundle is regenerated, re-signed, deployed,
and live-verified by the **`publish-watchlist` GitHub Action**; the committed demo
**bundle** is rebuilt locally with `build-demo-bundle`
([`../.github/workflows/publish-watchlist.yml`](../.github/workflows/publish-watchlist.yml)).

**Trigger.** It runs **nightly on a cron** (`0 6 * * *`, 06:00 UTC), **after every green
`Dagger` CI run on `main`**, and on manual **`workflow_dispatch`** from `main`. The
after-CI trigger means a merged publisher change goes live without waiting for the nightly
run. It uses the same guarded `workflow_run` pattern as `deploy.yml`: the job only runs
when the CI run succeeded, came from a same-repository `push` to `main`, and it publishes
that run's exact head SHA. Publishes are content-addressed, so a run with no list changes
is harmless.

**A daily run is not a daily refresh.** Each of the four lists is refreshed
independently; when one upstream is unreachable that list is re-served from the bundle
already published — re-verified end to end, keeping its own version, stamped `stale` with
its real age — while the others refresh normally. So the run can be green while one list
is older than a day. The workflow summary names any list it could not refresh, and
[`watchlist-freshness.yml`](../.github/workflows/watchlist-freshness.yml) checks the live
bundle on its own schedule and opens an issue when a list goes stale. That guard exists
because this cron failed for 22 consecutive days (2026-06-21 → 07-12, a missing signing
secret) and the only signal was a red dot nobody was watching.

**What the nightly run needs to be green.** Every publish and deploy needs the `Dagger`
check green on the exact `main` head: the full quality gate (publisher tests included),
the audit of the dependencies that ship (`pnpm audit --prod`), and the secret scan. The
build then signs the bundle, verifies it, verifies it again live, and runs the live smoke,
rolling back if the smoke fails. Advisories in build and deploy tooling (`pnpm audit
--dev`: vite, vitest, wrangler) are checked by a separate workflow,
[`dev-tool-audit.yml`](../.github/workflows/dev-tool-audit.yml). A red dev-tool audit fails
the PR and `main`, and **every code release** re-runs it and refuses to ship: `deploy.yml`,
the publish that follows a merge, and a manual publish. Only the **scheduled** nightly
refresh skips it, and Dagger reads the trigger from GitHub's record of the run, not from
an argument. The rule exists because on 2026-09-29 an undici advisory under wrangler
turned the whole CI red, and the nightly refresh stopped for two days while nothing that
ships to visitors had changed. The nightly still deploys the app built from `main`, so
while a dev-tool advisory is open that build comes from tooling with a known advisory.
That is the accepted trade-off; fix the advisory quickly.

**When a production run fails.** `deploy.yml`, `publish-watchlist.yml`, `live-smoke.yml`,
and `watchlist-freshness.yml` each end with a `Report production failure` job. It runs the
`production-alert` Dagger function with a token that can only read the checkout and write
issues. A failure opens one issue, **"Production deploy/publish failed"** (label
`production-alert`, so GitHub emails the owner), or adds the run to it if it is already
open. The body lists every workflow that is still failing. When that workflow's next run
is green it comes off the list, and the issue closes itself once the list is empty.

**What it does.** Install workspace deps and pinned edge-proc → resolve the version
stamp → fetch and embed the live source lists → fetch and signature-verify the live
`latest` pointer, deriving the next `sequence` by incrementing it (a pre-sequence
legacy pointer is treated as the zero baseline for this one-way migration) → publish
the signed bundle → verify it against the pinned public key → build and deploy the
same-origin SPA → re-fetch and verify the live pointer, manifest, and every chunk
through the browser-compatible decode path.

**The signing key.** The `WATCHLIST_SIGNING_KEY` repository secret holds the **raw
32-byte Ed25519 seed, base64-encoded** (so it round-trips cleanly through a GitHub
secret). The job decodes it back to 32 raw bytes before signing and **fails if it is not
exactly 32 bytes**. The key's public half is the `public.key` pinned in the app build —
that pairing is what makes in-tab verification meaningful, so never rotate one without
the other.

**The signed artifact.** The real and demo builders emit the same signed,
content-addressed distribution the app loads at runtime:
a signed `latest` pointer → a content-hashed `manifest` → a `chunk/` CAS, under
`frontend/app/public/bundle/origin/`. See [`WATCHLIST_FORMAT.md`](WATCHLIST_FORMAT.md).

Running the single-list publisher directly (the same CLI the Action invokes):

```bash
cd frontend
pnpm publish-list -- \
  --in <entities.jsonl> \
  --version <version-stamp> \
  --key <raw-32-byte-ed25519-seed-file> \
  --out <output-dir> \
  [--models <model-weights-dir>]
```

(`pnpm publish-list` is an alias for `pnpm --filter @amlfilter/publisher run publish`.)
This retired flat-wire CLI remains available for source-artifact tooling; it is not the
bundle the browser loads. The production bundle builder requires an explicit monotonic
`--sequence`; see the Cloudflare CLI path below.
The wire format is documented in [`WATCHLIST_FORMAT.md`](WATCHLIST_FORMAT.md).

## 4. How clients pick up a refresh

Once a new bundle is live, browser clients verify the signed `latest` pointer's
repository-wide monotonic `sequence`, reject any rollback, then delta-sync the changed
chunks and **re-verify
fail-closed** against the pinned `public.key`, re-screening every customer. The durable
bundle cache is content-addressed, so unchanged chunks are reused and a new publish only
fetches what changed. So the refresh flow is: rebuild + re-sign the bundle (the Action /
`build-demo-bundle`) → publish the new `latest`/`manifest`/`chunk` files to your host →
clients converge on their own.

## Deploy to Cloudflare Pages (same-origin bundle)

**TL;DR.** **Cloudflare Pages** hosts *everything* at **`aml-filter.com`** (apex is canonical;
`www` redirects to it) — both the SPA **and** the signed watchlist bundle, served **same-origin**
from `/bundle/origin`. There is no separate object store: Pages is already CDN-fronted, so the
edgeproc model (local-first processing over CDN-delivered signed artifacts) needs nothing extra
to provision. The GitHub Actions rebuild the REAL bundle from the live source lists (OFAC + UN +
EU + UK), sign it with `WATCHLIST_SIGNING_KEY`, and write it into
`frontend/app/public/bundle/origin/` so the Vite build copies it into `dist/` and Pages serves
it. **Porkbun** stays the registrar; **Cloudflare** does DNS + hosting + CDN. The `_redirects` /
`_headers` files in `frontend/app/public/` (copied verbatim into `dist/`) give the SPA fallback
and safe security headers.

> The committed `frontend/app/public/bundle/origin/` is the small **demo** bundle — the
> cold-clone / test artifact (a fresh clone screens against it with zero setup). **Production
> always serves the real bundle:** `deploy.yml` (after CI on `main`) and
> `publish-watchlist.yml` (nightly and after CI on `main`) overwrite `public/bundle/origin/` with the real list before building,
> so a routine code deploy never reverts the live site to the demo. "Real" is not the same as
> "rebuilt this run": a list whose upstream was down is re-served from the last published copy,
> marked stale with its real age, and the app displays that age.
>
> To run locally against the real lists, `pnpm --filter aml-filter-app dev:live` (or
> `build:live`) mirrors the live signed bundle into the gitignored `app/public/bundle/live/`
> through the same fail-closed verifier the deploy uses, pinned to `public.key`.

### Cloudflare Pages (SPA + same-origin bundle)

Create the Pages project once and attach the domain; the GitHub Actions in this repo do the
builds + deploys (the Pages Git integration is **not** used — the build needs the signing key +
the Node embedder, which run in Actions):

```bash
npx wrangler pages project create aml-filter --production-branch=main
```

| Setting | Value |
| --- | --- |
| Deployer | `.github/workflows/deploy.yml` (after CI on `main`) + `publish-watchlist.yml` (nightly + after every green `main` CI) |
| Build output directory | `frontend/app/dist` |
| Build env: `VITE_BUNDLE_BASE_URL` | *(unset — runtime defaults to same-origin `/bundle/origin`)* |
| Build env: `NODE_VERSION` | from `frontend/.nvmrc` |

`VITE_BUNDLE_BASE_URL` is now an **optional override** only (e.g. to point the app at a separate
CDN host); leave it unset for the same-origin production default.

**CLI path (manual deploy).** Build the real bundle + SPA locally, then deploy with Wrangler
(needs `WATCHLIST_SIGNING_KEY` decoded to a 32-byte key file and a local edge-proc checkout /
`EDGEPROC_DIR`):

```bash
cd frontend
# 1. build + sign the real bundle straight into the SPA's public tree:
pnpm --filter @amlfilter/publisher run build-real-bundle -- \
  --version "$(date -u +%Y-%m-%d)" --sequence <monotonic-integer> \
  --key /path/to/signing.key \
  --out app/public/bundle/origin
# 2. build the SPA same-origin (no VITE_BUNDLE_BASE_URL) and deploy:
pnpm --filter aml-filter-app run build
npx wrangler pages deploy app/dist --project-name=aml-filter --branch=main
```

**Custom domains.** In the Pages project → *Custom domains*, add both `aml-filter.com` and
`www.aml-filter.com`. The checked-in advanced-mode worker (`frontend/app/public/_worker.js`)
makes the apex canonical and redirects every `www` request with status 308 while preserving
path and query. This is code-reviewed and covered by the contract gate, so it does not depend
on a separate host-level Redirect Rule.

> Pages serves over HTTPS automatically, which is the secure context the app needs for
> WebCrypto signature verification and private browser storage — nothing extra to configure. Because the bundle is
> same-origin, **no CORS policy is required** (the former `deploy/r2-cors.json` is obsolete).
> The advanced-mode worker also strips any permissive CORS headers that the static host adds
> before returning an asset to a browser.

### CI secrets for the deploy + publish workflows

Both `deploy.yml` and `publish-watchlist.yml` need these repository secrets:

| Name | What it is |
| --- | --- |
| `WATCHLIST_SIGNING_KEY` | base64 of the raw 32-byte Ed25519 signing seed (pairs with the pinned `public.key`) |
| `CLOUDFLARE_API_TOKEN` | Pages:Edit-scoped API token |
| `CLOUDFLARE_ACCOUNT_ID` | the Cloudflare account that owns the `aml-filter` Pages project |

Never rotate the signing key without re-pinning `public.key` in the app build — the pairing is
what makes in-tab verification meaningful. (The former `R2_*` secrets are no longer used —
same-origin delivery retires them.)

### Validation (drive it in a real browser)

After a deploy, confirm it actually works — green CI is not enough:

- Open **`https://aml-filter.com/screen`**, watch it boot, type a query, read the rendered
  result, and confirm a **clean console**.
- In the Network tab, confirm the bundle (`latest` / `manifest` / `chunk/...`) loaded
  **same-origin** from `https://aml-filter.com/bundle/origin/…`.
- Deep-link **`/customers`**, **`/review`**, and **`/settings`** and refresh each one to
  confirm the SPA fallback serves the app (no 404).
- Confirm `https://www.aml-filter.com/<path>?<query>` returns a permanent redirect to
  the same path and query on `https://aml-filter.com`.
- Confirm the response carries the repository's CSP, `public.key` has
  `application/octet-stream` plus revalidation, `latest` is `no-store`, and immutable
  manifests/chunks have a one-year cache lifetime.
- Fetch `/build.json` and confirm its `git_sha` is the exact reviewed commit and its
  `github_run_id` is the deploying workflow run. Both workflows enforce this after
  upload so a successful no-op cannot pass.

### The live smoke (automated, after every deploy and publish)

Both delivery workflows now finish by driving the deployed site in a real Chromium, so
"deployed" means "a browser used it", not "the upload returned 200". It exists because
prod served a weeks-stale UK list behind green publishes (2026-09), and a sister app broke
for returning visitors because nothing opened the live site after a deploy.

- **Catalog:** every list (`OFAC_SDN`, `EU_CONSOLIDATED`, `UN_CONSOLIDATED`, `UK_OFSI`)
  is present with a positive entity count, and none is stale beyond the documented 7-day
  carry ceiling. Per-list counts are printed on green runs as well as red ones.
- **Browser, fresh profile:** `/screen` boots (the signed bundle verified in-tab,
  fail-closed), an OFAC name matches with a verified signed receipt, then `/settings`
  enables every list and one known designation per list is onboarded and shows on the
  Review Board tagged with *its* list. The console must be clean the whole way.
- **Browser, returning profile:** before the upload, a profile is primed against the
  release that is live *then*. After the upload the same profile reloads and repeats the
  journey, which is the path a cached visitor takes.

Before the upload, the pipeline records the deployment production serves now
(`previous-production-deployment`, read-only; no upload happens if it can't be read).
If the smoke goes red, or the live site serves the wrong commit or bundle identity, it calls the shared module's `rollback` with that ID (once per job), which
confirms Cloudflare now serves it, and then re-runs the fresh smoke against
`https://aml-filter.com`. The job **fails either way**. The error says whether
production recovered ("recovery smoke PASSED"), is STILL BROKEN after the rollback, or
could not be rolled back automatically (roll back by hand).
[`live-smoke.yml`](../.github/workflows/live-smoke.yml) runs the fresh pass every four
hours.

Run it yourself (from `frontend/app`, read-only against production):

```bash
pnpm test:e2e:live --grep @fresh
# or the containerized path CI uses, from the repo root:
dagger call live-smoke stdout
```

**Before you merge anything that touches the UI or the smoke, run every pass locally.**
Production must not be the first place the smoke runs. From `frontend/` (Node 22):

```bash
pnpm smoke:local
```

It builds this tree and the release aml-filter.com serves now as production-like
`--mode live` builds (real signed lists mirrored from production, verified against the
production key, `build.json` stamped), then runs, all on one local origin so browser
storage carries over like a real returning visitor: `@prime` against production
(read-only), `@prime` against the old build, `@returning` in that profile after the
port switches to your build, and `@fresh`. Exit status is the verdict.
`PREVIOUS_REF=<ref>` picks a different old release; `SKIP_PRODUCTION_PRIME=1` skips the
production pass.

Watch it fail on purpose. The rehearsal proxy serves the real site on
`http://localhost:4191` with one property broken:

```bash
TAMPER=chunk node scripts/live-smoke-rehearsal.mjs &     # or TAMPER=pointer
LIVE_SMOKE_URL=http://localhost:4191 pnpm test:e2e:live --grep @fresh   # must go red
```

The checked-in `_headers` CSP is intentionally narrow: same-origin scripts, data, and
connections; `wasm-unsafe-eval` for ONNX; and same-origin/blob workers. A unit guard
keeps the inline JSON-LD hash synchronized, and the C1 Playwright lane applies that
exact policy to the minified build so a worker/WASM regression fails before deploy.
The complete threat/privacy, recovery, and numeric performance contract is in
[`OPERATIONS.md`](OPERATIONS.md).

## Build-time configuration

None of these are needed for the local demo. They are build-time Vite variables, set in
`frontend/app/.env` (gitignored; see [`frontend/app/.env.example`](../frontend/app/.env.example)).
There are no secrets in the app: it holds only the public verification key.

| Variable | Default | What it changes |
| --- | --- | --- |
| `VITE_BUNDLE_BASE_URL` | same-origin `/bundle/origin` | Where the signed list bundle is fetched from. The pinned public key is always read same-origin, never from here. `dev:live` / `build:live` set it to `/bundle/live`. |
| `VITE_MODEL_LOAD_IDLE_TIMEOUT_MS` | `90000` | How long model loading may make no progress before boot fails loudly. |
| `VITE_BOOT_TIMEOUT_MS` | `900000` | Upper bound for the whole boot (list sync + verify + model warm-up) before `/screen` fails loudly. |

Per-list thresholds, strictness, list selection, and the analyst name are set in the
app's **Settings** page and stored in the browser. Publishing signed lists needs a
private signing key, which is never committed; see [Operations](OPERATIONS.md).

The build stages the verified model and ONNX-WASM assets from local dependencies, so
the production browser never downloads executable code or model weights from a
third-party CDN.

## Run the gate or build with Dagger

The same gate is a portable Dagger Function. With Dagger 0.21.8 installed:

```bash
dagger check
dagger call build export --path=frontend/app/dist
```

The module is thin: it composes Dagger's directory, container, and cache objects around
the existing repository commands.

## Operational caveats

- **Same embedder on both sides.** The publisher precomputes name vectors with the same
  MiniLM model the app loads at query time. They must match, or vector similarity is
  meaningless — don't swap one without re-publishing.
- **This is a demo.** Re-read [`../NOTICE`](../NOTICE): not legal advice, not a
  compliance product. Every match must be reviewed by qualified compliance personnel
  against the official OFAC source.
