# Security Policy

aml-filter is a **signing- and verification-adjacent** app: it pins an Ed25519 trust key,
verifies signed, content-addressed watchlist bundles **fail-closed** in the browser tab
before any list is trusted, and does all customer screening locally with no server in the
path. We treat cryptographic and supply-chain issues with the seriousness that posture
demands. If a verification, signature, content-addressing, or trust-pinning path can be
bypassed, weakened, or made to silently accept tampered or unsigned watchlist data, that is
a high-severity bug.

## Reporting a vulnerability

**Please do not open a public GitHub issue, pull request, or discussion for a security
vulnerability** — that discloses it before a fix exists.

Instead, report it privately by email to:

> **harish.seshadri@gmail.com**

Please include, as far as you can:

- A description of the issue and the impact (what a malicious publisher / CDN / network
  attacker could achieve).
- The affected version(s) or commit.
- Steps to reproduce, or a minimal proof of concept.
- Any suggested remediation.

You can expect an acknowledgement within a few days. We will work with you to confirm the
issue, develop a fix, and coordinate disclosure. We are happy to credit you in the release
notes unless you prefer to remain anonymous.

## Supported versions

aml-filter is an engineering-portfolio demo. Security fixes land on `main` and ship in the
next release. We support the **latest released version**; please upgrade to it before
reporting, in case the issue is already fixed.

| Version | Supported          |
| ------- | ------------------ |
| 4.x     | :white_check_mark: |
| < 4.0   | :x:                |

## Key history

This repository is public, and its history is permanent. One production signing seed was
committed here and must be treated as burned, even though the live key has since been
rotated.

| | Value |
| --- | --- |
| Exposed | `frontend/packages/amlfilter-publisher/fixtures/demo.key`, added 2026-06-20 (`8ffd09d`), a 32-byte Ed25519 seed |
| Rotated | 2026-07-21 (`16512cf`) — new production pin `838dd1d016aa5f8bfdcd00381d4c216873d43c399f900447ec66c079faaa642f` |
| Revoked pin | `db2c8c8abd1ea38438b949ae45889fab58bfcbafc7d78de4bf4e717f8482264c` (the public half derived from the committed seed) |
| Exposure window | ~31 days (2026-06-20 → 2026-07-21) |

**Impact.** Anyone could have extracted the seed during that window and signed a
watchlist bundle that a client pinning the old key would accept. The current deployment
serves the new pin (`https://aml-filter.com/public.key` matches the rotated value), so the
live app is not vulnerable. An old deployment, a cached tab, or a restored pre-rotation
build that still pins the old key would be.

**Remediation.** The seed was rotated, the production pin was replaced, demo and
production keys were decoupled, the demo key was replaced with a throwaway seed, and a
regression test asserts the demo key can never equal the production pin again. The
temporary sequence-derivation bridge that trusted the retired key has been removed.

**Do not** roll production back to a deployment built before 2026-07-21, and do not
reintroduce the old public key as trusted material. The revoked key is recorded above and
must be kept as a revocation record, not deleted from history.

## Scope notes

- The trust model is **pinned-key, fail-closed**: the app trusts only the Ed25519
  `public.key` served from its own origin and pinned at
  [`frontend/app/public/public.key`](frontend/app/public/public.key) — never a key carried
  in the bundle. The key is fetched same-origin at runtime and is not read from the
  bundle origin. The signed `latest` pointer, the content-addressed manifest, and every
  chunk are verified (Ed25519 + SHA-256) **before** any list is promoted into the running
  engine; the same check re-runs over bytes served from the durable cache. Reports that
  demonstrate trust without the pinned key, signature acceptance after tampering, a
  content-address bypass, or a verification failure turned into a silent fallback are in
  scope and prioritized.
- aml-filter is **not** a compliance product (see [`NOTICE`](NOTICE)). Reports about
  regulatory adequacy of the screening itself are out of scope; reports about the integrity
  of the verify-then-trust pipeline are in scope.
- Issues in third-party dependencies (e.g. `transformers.js`, `@noble/ed25519`,
  `@sqlite.org/sqlite-wasm`) should be reported upstream; if aml-filter's *use* of them is
  the weakness, report it here.
