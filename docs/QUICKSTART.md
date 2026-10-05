# Quickstart

aml-filter is a **zero-server, in-browser** watchlist-filtering and KYC-review app: a
static React SPA that syncs a **signed catalog of sanctions lists** (OFAC, EU, UN,
UK asset-freeze) into the tab and screens names locally — embedding, search, and the explainable
scorer all run in the browser. No server-side database or service to provision; private
customer state uses local SQLite-WASM on OPFS.

Clone → install → run → screen a name → work it in the review board. About **ten
minutes**, most of it the first run fetching the ~23 MB embedding-model weights.

The repository is public and MIT-licensed:
<https://github.com/hseshadr/aml-filter>. No account, key, or collaborator access is
needed to clone it and run everything below.

> Reminder: aml-filter is a portfolio demo, **not** a compliance product. See
> [`../NOTICE`](../NOTICE).

## Prerequisites

- **Node 22.13.0** (see [`../frontend/.nvmrc`](../frontend/.nvmrc); `nvm use` picks it
  up). Any Node ≥ 22.13 runs the app; the `pnpm gate` step below additionally requires
  the exact `.nvmrc` version, because that is what CI runs.
- **pnpm** (`corepack enable` provides the pinned version)
- **Internet access on the first run** — the first `dev` or `build` downloads the
  MiniLM embedding weights (~23 MB, SHA-256-pinned) into `frontend/app/public/models/`
  so the browser never fetches a model from a CDN at runtime. Every later run reuses
  them, and the dev server then serves everything from your machine. The app is not an
  offline app, though: it has no service worker, so a browser tab still has to reach the
  server to load the page.
- **A supported desktop browser** — current or previous Chrome, Edge, Firefox, or
  Safari 17+, with module Workers, private browser storage, WebCrypto, and Web Locks.
  The KYC workstation additionally needs OPFS for SQLite.

That's the whole list. There is no backend, database, API key, or account to set up.

## 1. Clone, install, run

All commands run from `frontend/` — there is no root `package.json`.

```bash
git clone https://github.com/hseshadr/aml-filter.git
cd aml-filter/frontend
corepack enable                       # provides the pnpm version pinned in package.json
pnpm install
pnpm --filter aml-filter-app dev      # stages the model weights, then starts Vite
```

The first `dev` run stages three things before Vite starts — the MiniLM weights, the
onnxruntime WASM runtime, and the landing page's measured stats — so `/screen` works
on a cold clone with nothing else to do. Expect a couple of minutes the first time and
about a second every time after.

Open the printed URL (default <http://localhost:5173>). Use **`localhost`**, not a LAN
IP — a secure context is required for the in-tab WebCrypto signature check and private
browser storage.

> **Which signing key does local use?** The bundle under
> `frontend/app/public/bundle/origin/` is the committed *demo* bundle, signed with a
> throwaway demo key that is deliberately **not** the production trust root. So a local
> `vite dev` / `vite preview` server serves that demo verify key at `/public.key`, and
> prints one line saying so when it starts. The deployed site pairs
> the production bundle with the production pin in `frontend/app/public/public.key`;
> `vite build` copies that file into `dist/` untouched.

## 2. Screen a name (`/screen`)

Go to **`/screen`**. On first visit the page:

1. boots the **MiniLM** embedder once (cached after the first load),
2. syncs the committed **signed bundle** into the tab — it verifies the Ed25519
   `latest` pointer, content-addressed manifest and compressed chunks before parsing
   the materialized `catalog.json` and enabled lists (fail-closed — a tampered,
   oversized, stale, or unsigned artifact aborts the load),
3. is then ready to screen names across all enabled lists entirely in-tab.

Type a sanctioned-ish name (something close to a demo entry) and submit. You get an
**Assay-computed result with a `reasons[]` breakdown and a plain-language explanation** —
which name signals fired (name similarity, alias, country, DOB), how they rolled up
into the score, and which **source list** the match came from. Adjust the strictness
slider (Lenient / Balanced / Strict) to see the match threshold tighten. See
[`ARCHITECTURE.md`](ARCHITECTURE.md) for the scoring contract.

Beside each match score you'll also see a small **Verified** chip — the engine seals
every score it produces with a signed **score receipt**. Expand **Score receipt** on the
match card to see the full signed envelope: algorithm, signer key, payload hash,
signature, sealed score, tier, engine version, watchlist version, identity inputs hash,
Assay policy version, Assay input hash, and the five ordered contributions. Prove it to
yourself: the verdict is computed in your browser, with no server asked, against
this install's own key — if the sealed data were altered in any way, the chip would read
**Not verified — tampered**.

That key belongs to this browser. To keep it when you clear browser data or move to a
new computer, open **`/settings` → Receipt signing key → Export the key**, pick a
passphrase (12+ characters), and keep the file. **Import a key** on the new browser
restores it, so your old receipts still verify there. **Reset signing key** makes a new
key; after that, receipts signed earlier only verify against the public key you saved.

## 3. Choose lists and sensitivity (`/settings`)

Go to **`/settings`** to configure the screening run. It persists to the local SQLite
`settings` table (not the server — there is no server):

- **Screening sensitivity** — Strict / Balanced / Lenient. This is the global match
  threshold; Strict surfaces fewer, higher-confidence matches.
- **Watchlists** — tick the lists to screen against (OFAC SDN, EU, UN, UK asset-freeze). A list
  you disable drops out of future screens; its matches become `SUPPRESSED` on the next
  rescan.
- **Per-list overrides** — tighten or loosen the threshold for one list independently.
- **Analyst name** — stamped on the dispositions you record.
- **Clear cached lists** — drops the durable signed-bundle cache; the next load
  re-fetches and re-verifies fail-closed.

## 4. Onboard a customer and work a match (`/customers` → `/review`)

The app is a small **local-first KYC workstation** on top of screening. Its store is a
SQLite-WASM database persisted in your browser's OPFS — local to the tab, no server.

1. Go to **`/customers`** and onboard a customer (name, and optionally country / DOB).
   The customer is **auto-screened on the spot** across all enabled lists; any hits are
   saved with the customer.
2. Go to **`/review`** to work the resulting matches. They are tiered
   (STRONG / POSSIBLE / WEAK) and carry a **Source** column naming the list. Use the
   **View filter** (All / Needs review / Changed only) to focus; open the per-match
   **History drawer** to read the audit trail; open a match, read its reasons, and
   **resolve** it with a reviewer note (e.g. true positive / false positive).
3. **Re-screen behavior.** When a list version advances (or you edit the customer), the
   match is re-screened. If nothing material changed, the match keeps your prior
   disposition and stays suppressed — you don't re-review it. If the matched entity's
   identity data changed, the match is flagged **CHANGED — needs re-review** (keeping the
   prior disposition) and shows up under "Needs review" / "Changed only". Every
   transition is appended to the `match_events` audit trail. Deleting that customer
   atomically removes the customer, matches, reviewer notes, and event history from the
   application database. The persistent connection enables SQLite `secure_delete` and
   disables reusable WAL journaling; browser/OS forensic remnants remain outside the
   app's guarantee, so clear this origin's site data for the device-level reset.

Everything — onboarding, screening, and the review decision — happens in the browser
against the in-tab database and the signed lists.

### Move customer tables between devices

On `/customers`, use **Import CSV/XLS/XLSX** to preview a customer spreadsheet before
committing it. Parsing stays local, accepts at most 10 MB / 5,000 rows, validates the
identity fields, skips duplicate references, and commits accepted rows in one SQLite
transaction before a serial re-screen. **Export XLSX** saves the customer table locally.
This spreadsheet is not a full backup: matches, audit events, settings, and the signed
watchlist cache remain in the browser and are not included.

## 5. Build a demo bundle

The repo already ships a committed **demo** bundle (the signed, content-addressed
distribution under `frontend/app/public/bundle/origin/` — the `latest` pointer +
`manifest/<hash>` + `chunk/<hash>` CAS) so `/screen` works on a cold clone. To rebuild it:

```bash
cd frontend
pnpm --filter @amlfilter/publisher run build-demo-bundle
```

This regenerates the signed `latest` pointer, the content-hashed manifest, and the chunk
store the browser delta-syncs (carrying `catalog.json` + each list's `entities.jsonl` /
`vectors.f32` / `meta.json`). For building lists from your own exports, and for refreshing
the live data, see [`DEPLOY.md`](DEPLOY.md) and the wire format in
[`WATCHLIST_FORMAT.md`](WATCHLIST_FORMAT.md).

## 6. Run the gate

Run the same canonical gate CI runs, from `frontend/`. It refuses to run on any Node
other than the exact `.nvmrc` version, because a gate green on a runtime CI never uses
is not evidence:

```bash
cd frontend
nvm use          # or: nvm install $(cat .nvmrc)
pnpm gate
```

This runs lint, strict typechecking, thresholded coverage, production builds, i18n
verification, and all three real-browser lanes. The golden parity tests guard the
in-browser scorer and tier classifier against their frozen reference output.

### End-to-end browser lanes

Three Playwright lanes drive the **real minified build** against the **committed signed
demo bundle** in real Chromium (from `frontend/app`):

```bash
cd frontend/app
pnpm test:e2e:c1     # the in-tab C1 screening lane (boot → verify → screen)
pnpm test:e2e:kyc    # the backend-free KYC journey: onboard → auto-screen → review → resolve
pnpm test:e2e:bundle # signed-bundle delta sync: verify → durable cache → offline reload
pnpm test:e2e:mobile:ci # iPhone WebKit + Android/desktop cold boot and reload
```

CI runs all four. A green build is **not** proof the app works — these lanes are the
guard that the actual demo bundle verifies and screens in a real browser.

## Production build + preview (browser-validation path)

To exercise exactly what ships (and what the e2e lanes drive):

```bash
cd frontend
pnpm --filter aml-filter-app build      # runs tsc --noEmit && vite build;
                                        #   a prebuild hook stages the same model
                                        #   weights, WASM runtime, and demo stats
pnpm --filter aml-filter-app preview    # serves the dist/ build; open the printed URL
```

## Troubleshooting

- **`/screen` never becomes ready** — it boots the embedder and verifies the signed
  watchlist bundle on first load; give the model fetch a moment on a cold cache, and
  confirm a clean browser console.
- **"Local screening engine unavailable" on a fresh clone** — check the terminal: the
  `dev` script stages the model weights and WASM runtime before Vite starts, and it
  fails loudly if a download or hash check fails. Re-run
  `pnpm --filter aml-filter-app dev`; it resumes and skips whatever is already staged
  and hash-correct.
- **"signature verification failed"** — verification is fail-closed by design. Serve the
  app through `pnpm dev` or `pnpm preview` (which pair the committed demo bundle with
  its demo verify key), over a secure context (`localhost` or HTTPS) — not a LAN IP, and
  not a bare static file server, which would serve the production pin against a
  demo-signed bundle. The same check runs over cached bytes, so a stale/corrupt cache
  also fails closed; use **Clear cached lists** in `/settings` to force a re-fetch.
- **No matches ever** — screen a name that's actually close to one on an enabled list
  (the committed demo lists are small), and confirm the list is enabled in `/settings`.
