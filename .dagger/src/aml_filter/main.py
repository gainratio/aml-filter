"""Portable AML Filter CI/CD composed from native Dagger objects."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime
from shlex import split
from typing import Annotated, Final, cast

import dagger
from dagger import (
    Container,
    DefaultPath,
    Directory,
    Ignore,
    ReturnType,
    Secret,
    Service,
    check,
    dag,
    field,
    function,
    object_type,
)

from .policy import (
    ReleaseIdentity,
    ReleaseKind,
    carried_list_ceiling_days,
    parse_release_identity,
    release_identity,
    release_version,
    whole_bundle_fallback_days,
)
from .queue import TurnPolicy, fetch_runs, parse_run_id, wait_for_turn
from .smoke import (
    SMOKE_LISTS,
    RollbackOutcome,
    SmokeRun,
    prime_note,
    recovery_failure,
    smoke_passes,
    smoke_verdict,
)
from .targets import AmlTarget, GreenMainEvidence, ProviderIdentity, parse_green_main

NODE_IMAGE: Final = (
    "node:22.13.0-bookworm@sha256:fa54405993eaa6bab6b6e460f5f3e945a2e2f07942ba31c0e297a7d9c2041f62"
)
UV_IMAGE: Final = (
    "ghcr.io/astral-sh/uv:0.11.32@sha256:"
    "df4cae8f3a96d175e2e5f992e597550000edbe78fdc2594d5cd8de1a217f504c"
)
EDGEPROC_REPO: Final = "https://github.com/hseshadr/edge-proc"
EDGEPROC_COMMIT: Final = "e3bfb570feb8619c823df63b6c012fd8c8c6a9b6"
# hseshadr/ci main: merge of ci#51 (verified Pages rollback).
CENTRAL_MODULE_SHA: Final = "363be0b98c753c027353f35db0f6cc5b24402f78"
TARGET: Final = AmlTarget.production()
REPOSITORY: Final = TARGET.repository
REPOSITORY_URL: Final = f"https://github.com/{REPOSITORY}.git"
LIVE_ORIGIN: Final = f"https://{TARGET.domain}"
DEPLOY_ROOT: Final = "dist"
PAGES_DOMAINS: Final = ()
PUBLIC_KEY: Final = "/src/frontend/app/public/public.key"
SOURCE_EXCLUDES: Final = split(
    ".git .venv **/.venv **/node_modules **/dist **/.decision-out "
    "**/playwright-report **/test-results frontend/app/public/models"
)
NODE_CACHES: Final = (
    ("/root/.local/share/pnpm/store", "aml-filter-pnpm"),
    ("/root/.cache/corepack", "aml-filter-corepack"),
    ("/src/frontend/app/public/models", "aml-filter-minilm"),
)
QUALITY_CACHES: Final = (
    ("/root/.cache/uv", "aml-filter-uv"),
    ("/root/.cache/ms-playwright", "aml-filter-playwright"),
)
PLAYWRIGHT_INSTALL: Final = split(
    "pnpm --filter aml-filter-app exec playwright install --with-deps chromium firefox webkit"
)
APP_BUILD: Final = split("pnpm --filter aml-filter-app run build")
FRESHNESS_CHECK: Final = [
    "pnpm",
    "--silent",
    "--filter",
    "@amlfilter/publisher",
    "run",
    "check-published-freshness",
    "--",
    "--base-url",
    f"{LIVE_ORIGIN}/bundle/origin",
    "--pubkey",
    PUBLIC_KEY,
]
SMOKE_PROFILE: Final = "/smoke-profile"
SMOKE_BROWSER_INSTALL: Final = split(
    "pnpm --filter aml-filter-app exec playwright install --with-deps chromium"
)
# The post-deploy / scheduled LIVE smoke: the signed catalog first (every list
# present, non-empty, inside the documented carry ceiling), then a real Chromium
# driving the deployed site (frontend/app/tests/e2e-live).
SMOKE_SCRIPT: Final = r"""
set -euo pipefail
pnpm --silent --filter @amlfilter/publisher run check-published-freshness -- \
  --base-url "$LIVE_SMOKE_URL/bundle/origin" --pubkey "$PUBLIC_KEY" \
  --carry-ceiling-days "$CARRY_DAYS" --expect-lists "$SMOKE_LISTS"
cd app
pnpm exec playwright test -c playwright.live.config.ts --grep "$SMOKE_PASSES"
"""
PRIME_SCRIPT: Final = r"""
set -euo pipefail
cd app
pnpm exec playwright test -c playwright.live.config.ts --grep "$SMOKE_PASSES"
"""
PREVIEW_ARGS: Final = split("pnpm --filter aml-filter-app exec vite preview --host --port 4173")
RELEASE_SCRIPT: Final = r"""
set -euo pipefail
rm -rf /release /tmp/bundle-candidate /tmp/verify-cache /tmp/verify-out
mkdir -p /release
SEQUENCE="$(pnpm --silent --filter @amlfilter/publisher run next-published-sequence -- \
  --base-url "$LIVE_BUNDLE" --pubkey "$PUBLIC_KEY")"
umask 077
printf '%s' "$WATCHLIST_SIGNING_KEY" | base64 -d > /run/watchlist-signing.key
[ "$(wc -c < /run/watchlist-signing.key)" -eq 32 ]
trap 'rm -f /run/watchlist-signing.key' EXIT
set +e
pnpm --filter @amlfilter/publisher run build-real-bundle -- \
  --version "$VERSION" --sequence "$SEQUENCE" --key /run/watchlist-signing.key \
  --out /tmp/bundle-candidate \
  --live-base-url "$LIVE_BUNDLE" --pubkey "$PUBLIC_KEY" \
  --max-carried-age-days "$CARRY_DAYS" \
  | tee /tmp/build.out
BUILD_STATUS="${PIPESTATUS[0]}"
set -e
if [ "$BUILD_STATUS" -eq 0 ]; then
  mv /tmp/bundle-candidate /release/origin
  printf 'BUNDLE_REFRESHED=true\nSERVED_VERSION=%s\n' "$VERSION" > /release/identity.env
  printf 'SERVED_SEQUENCE=%s\n' "$SEQUENCE" >> /release/identity.env
elif [ "$FALLBACK_DAYS" -gt 0 ]; then
  pnpm --silent --filter @amlfilter/publisher run mirror-published-origin -- \
    --base-url "$LIVE_BUNDLE" --pubkey "$PUBLIC_KEY" \
    --out /release/origin --max-age-days "$FALLBACK_DAYS" > /tmp/mirror.env
  grep -E '^SERVED_(VERSION|SEQUENCE|AGE_DAYS)=' /tmp/mirror.env > /release/identity.env
  printf 'BUNDLE_REFRESHED=false\n' >> /release/identity.env
else
  exit "$BUILD_STATUS"
fi
grep -E '^(ALIAS_(MODE|ADDED)|STALE_LISTS)=' /tmp/build.out >> /release/identity.env || true
uv run --project /edgeproc edgeproc sync \
  --base-url /release/origin --cache-dir /tmp/verify-cache \
  --materialize-to /tmp/verify-out --key "$PUBLIC_KEY" --pretty
"""
VERIFY_SCRIPT: Final = r"""
set -euo pipefail
value() { sed -n "s/^$1=//p" /release/identity.env; }
VERSION="$(value SERVED_VERSION)"
SEQUENCE="$(value SERVED_SEQUENCE)"
[ -n "$VERSION" ] && [ -n "$SEQUENCE" ]
node app/scripts/build-identity.mjs verify \
  --url "$APP_ORIGIN/build.json" --sha "$SOURCE_SHA" --run-id "$RUN_ID"
pnpm --filter @amlfilter/publisher run verify-published-origin -- \
  --base-url "$APP_ORIGIN/bundle/origin" --pubkey "$PUBLIC_KEY" \
  --expect-version "$VERSION" --expect-sequence "$SEQUENCE" \
  --attempts "$ATTEMPTS" --delay-seconds "$DELAY_SECONDS"
"""
CANONICAL_SCRIPT: Final = r"""
set -euo pipefail
curl --fail --silent --show-error --max-time 15 \
  --output /dev/null https://aml-filter.com/
readarray -t redirect < <(curl --silent --show-error --max-time 15 \
  --output /dev/null --write-out '%{http_code}\n%{redirect_url}\n' \
  'https://www.aml-filter.com/settings?source=dagger-check')
status="${redirect[0]:-missing}"
target="${redirect[1]:-missing}"
expected='https://aml-filter.com/settings?source=dagger-check'
{ [ "$status" = 301 ] || [ "$status" = 308 ]; } && [ "$target" = "$expected" ]
"""


@dataclass(frozen=True)
class PublishRequest:
    """Secrets and exact identity for one production publication."""

    kind: ReleaseKind
    signing_key: Secret
    api_token: Secret
    account_id: Secret
    github_token: Secret
    release_id: str


@dataclass(frozen=True)
class ReleaseContext:
    """Foundation-authorized source and exact hosted workflow attempt."""

    source: Directory
    evidence: GreenMainEvidence


@dataclass(frozen=True)
class ProviderRequest:
    """Closed central-envelope inputs for one shared provider transaction."""

    envelope: Directory
    consumer_identity: str
    producing_identity: str
    workflow_run_id: str
    run_attempt: int


@dataclass(frozen=True)
class RecoveryPlan:
    """What a red post-deploy smoke needs to restore production and prove it."""

    request: PublishRequest
    target: str
    source: Directory
    identity: ReleaseIdentity


class ReleaseSourceMismatchError(ValueError):
    """The caller's product identity is not the authorized green-main SHA."""


def mount_caches(container: Container, caches: tuple[tuple[str, str], ...]) -> Container:
    for path, name in caches:
        container = container.with_mounted_cache(path, dag.cache_volume(name))
    return container


def with_env(container: Container, pairs: tuple[tuple[str, str], ...]) -> Container:
    for name, value in pairs:
        container = container.with_env_variable(name, value)
    return container


async def smoke_run(container: Container) -> SmokeRun:
    """Materialize an ``expect=ANY`` smoke and capture its verdict inputs."""
    ran = await container.sync()
    output = f"{await ran.stdout()}\n{await ran.stderr()}"
    return SmokeRun(await ran.exit_code(), output)


async def grant_release_turn(github_token: Secret, run_id: str, policy: TurnPolicy) -> str:
    """Block until no older deploy/publish run of this repository is still alive."""
    own = parse_run_id(run_id)
    token = await github_token.plaintext()

    async def fetch(workflow_file: str) -> str:
        return await asyncio.to_thread(fetch_runs, REPOSITORY, token, workflow_file)

    waited = await wait_for_turn(fetch, own, policy, asyncio.sleep)
    return f"release turn granted to run {own} after waiting on runs {list(waited)}"


@object_type
class AmlFilter:
    """Run every repository-authored CI/CD operation through Dagger."""

    source: Annotated[Directory, DefaultPath("/"), Ignore(SOURCE_EXCLUDES)] = field()

    def _node(self, source: Directory) -> Container:
        container = mount_caches(dag.container().from_(NODE_IMAGE), NODE_CACHES)
        container = container.with_directory("/src", source).with_workdir("/src/frontend")
        container = container.with_env_variable("COREPACK_HOME", "/root/.cache/corepack")
        container = container.with_exec(["npm", "install", "--global", "corepack@0.34.5"])
        container = container.with_exec(["corepack", "enable"])
        return container.with_exec(["pnpm", "install", "--frozen-lockfile"])

    def _with_uv(self, container: Container) -> Container:
        uv = dag.container().from_(UV_IMAGE).file("/uv")
        container = container.with_file("/usr/local/bin/uv", uv)
        container = container.with_env_variable("UV_PYTHON", "3.13.5")
        return container.with_env_variable("SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt")

    def _release_base(self, source: Directory) -> Container:
        container = mount_caches(self._with_uv(self._node(source)), QUALITY_CACHES[:1])
        edgeproc = dag.git(EDGEPROC_REPO).commit(EDGEPROC_COMMIT).tree()
        container = container.with_directory("/edgeproc", edgeproc)
        container = container.with_env_variable("EDGEPROC_DIR", "/edgeproc")
        container = container.with_exec(
            ["uv", "sync", "--project", "/edgeproc", "--extra", "bundles"]
        )
        container = container.with_exec(["node", "app/scripts/download-model.mjs"])
        return container

    def _signed_release(
        self, source: Directory, signing_key: Secret, version: str, kind: ReleaseKind
    ) -> Container:
        fallback = 0 if kind is ReleaseKind.WATCHLIST else whole_bundle_fallback_days(kind)
        container = self._release_base(source)
        container = container.with_secret_variable("WATCHLIST_SIGNING_KEY", signing_key)
        container = container.with_env_variable("VERSION", version)
        container = container.with_env_variable("FALLBACK_DAYS", str(fallback))
        container = container.with_env_variable("CARRY_DAYS", str(carried_list_ceiling_days()))
        container = container.with_env_variable("LIVE_BUNDLE", f"{LIVE_ORIGIN}/bundle/origin")
        container = container.with_env_variable("PUBLIC_KEY", PUBLIC_KEY)
        return container.with_exec(["bash", "-ceu", RELEASE_SCRIPT])

    def _release_app(
        self, source: Directory, release: Directory, source_sha: str, run_id: str
    ) -> Container:
        container = self._node(source).without_directory("/src/frontend/app/public/bundle/origin")
        container = container.with_directory(
            "/src/frontend/app/public/bundle/origin", release.directory("origin")
        )
        stamp = ["node", "app/scripts/build-identity.mjs", "stamp", "--dist", "app/dist"]
        stamp += ["--sha", source_sha, "--run-id", run_id]
        return container.with_exec(APP_BUILD).with_exec(stamp)

    def _verify_container(
        self, source: Directory, release: Directory, identity: ReleaseIdentity, origin: str
    ) -> Container:
        container = self._node(source).with_directory("/release", release)
        container = container.with_env_variable("APP_ORIGIN", origin)
        container = container.with_env_variable("SOURCE_SHA", identity.source_sha)
        container = container.with_env_variable("RUN_ID", identity.run_id)
        container = container.with_env_variable("PUBLIC_KEY", PUBLIC_KEY)
        return container

    def _preview_verify(
        self, source: Directory, app: Directory, release: Directory, identity: ReleaseIdentity
    ) -> Container:
        container = self._verify_container(source, release, identity, "http://preview:4173")
        container = container.with_service_binding("preview", self._preview(source, app))
        container = container.with_env_variable("ATTEMPTS", "1")
        container = container.with_env_variable("DELAY_SECONDS", "0")
        return container.with_exec(["bash", "-ceu", VERIFY_SCRIPT])

    def _preview(self, source: Directory, app: Directory) -> Service:
        container = self._node(source).with_directory("/src/frontend/app/dist", app)
        container = container.with_exposed_port(4173)
        return container.as_service(args=PREVIEW_ARGS)

    def _live_verify(
        self, source: Directory, release: Directory, identity: ReleaseIdentity
    ) -> Container:
        container = self._verify_container(source, release, identity, LIVE_ORIGIN)
        container = container.with_env_variable("ATTEMPTS", "10")
        container = container.with_env_variable("DELAY_SECONDS", "15")
        container = container.with_exec(["bash", "-ceu", VERIFY_SCRIPT])
        return container.with_exec(["bash", "-ceu", CANONICAL_SCRIPT])

    def _smoke_base(self, source: Directory, passes: str, nonce: str) -> Container:
        """Chromium + the live-smoke environment; the nonce defeats exec caching."""
        container = mount_caches(self._node(source), QUALITY_CACHES[1:])
        container = container.with_exec(SMOKE_BROWSER_INSTALL)
        return with_env(container, (
            ("LIVE_SMOKE_URL", LIVE_ORIGIN), ("PUBLIC_KEY", PUBLIC_KEY),
            ("CARRY_DAYS", str(carried_list_ceiling_days())), ("SMOKE_LISTS", SMOKE_LISTS),
            ("LIVE_SMOKE_PROFILE", SMOKE_PROFILE), ("SMOKE_PASSES", passes),
            ("SMOKE_NONCE", nonce),
        ))  # fmt: skip

    def _prime_container(self, source: Directory, identity: ReleaseIdentity) -> Container:
        """Cache the release live BEFORE this deploy into a returning profile."""
        container = self._smoke_base(source, "@prime", f"{identity.run_id}:prime")
        return container.with_exec(["bash", "-ceu", PRIME_SCRIPT], expect=ReturnType.ANY)

    async def _prime_profile(
        self, source: Directory, identity: ReleaseIdentity
    ) -> tuple[Directory, SmokeRun]:
        container = await self._prime_container(source, identity).sync()
        return container.directory(SMOKE_PROFILE), await smoke_run(container)

    def _post_deploy_container(
        self, source: Directory, profile: Directory, identity: ReleaseIdentity
    ) -> Container:
        """Fresh + returning passes against the deployed site and its identity."""
        passes = smoke_passes(returning=True)
        container = self._smoke_base(source, passes, f"{identity.run_id}:post")
        container = container.with_directory(SMOKE_PROFILE, profile)
        container = container.with_env_variable("LIVE_SMOKE_EXPECT_SHA", identity.source_sha)
        return container.with_exec(["bash", "-ceu", SMOKE_SCRIPT], expect=ReturnType.ANY)

    async def _post_deploy_smoke(
        self, source: Directory, profile: Directory, identity: ReleaseIdentity
    ) -> SmokeRun:
        return await smoke_run(self._post_deploy_container(source, profile, identity))

    def _recovery_container(self, source: Directory, identity: ReleaseIdentity) -> Container:
        """Fresh pass against the live domain after a rollback (older SHA: no pin)."""
        passes = smoke_passes(returning=False)
        container = self._smoke_base(source, passes, f"{identity.run_id}:recovery")
        return container.with_exec(["bash", "-ceu", SMOKE_SCRIPT], expect=ReturnType.ANY)

    async def _checked_live(
        self, source: Directory, release: Directory, identity: ReleaseIdentity
    ) -> SmokeRun:
        """Live identity proof; a mismatch is a failed post-deploy check, not a crash.

        Production already serves the upload here, so a wrong commit or bundle must
        take the same single rollback path as a red smoke.
        """
        try:
            return SmokeRun(0, await self._live_verify(source, release, identity).stdout())
        except dagger.DaggerError as error:
            return SmokeRun(1, f"live identity verification FAILED: {error}")

    async def _post_deploy_checks(
        self, source: Directory, release: Directory, profile: Directory, identity: ReleaseIdentity
    ) -> tuple[SmokeRun, SmokeRun]:
        """Identity first; a mismatch IS the failed check (the smoke would pin it anyway)."""
        live = await self._checked_live(source, release, identity)
        if live.exit_code:
            return live, live
        return live, await self._post_deploy_smoke(source, profile, identity)

    async def _recovery_smoke(self, source: Directory, identity: ReleaseIdentity) -> SmokeRun:
        return await smoke_run(self._recovery_container(source, identity))

    @staticmethod
    async def _rollback_target(request: PublishRequest) -> str:
        """Read-only, BEFORE upload: the deployment a failed smoke restores."""
        pages = dag.cloudflare_pages()
        before = pages.previous_production_deployment(
            request.api_token, request.account_id, TARGET.project
        )
        return await before.deployment_id()

    @staticmethod
    async def _rollback(plan: RecoveryPlan) -> RollbackOutcome | str:
        """Restore the recorded target; a fail-closed refusal becomes its reason."""
        request = plan.request
        rolled = dag.cloudflare_pages().rollback(
            request.api_token, request.account_id, TARGET.project, deployment_id=plan.target
        )
        try:
            return RollbackOutcome(
                await rolled.from_deployment_id(), await rolled.to_deployment_id(),
                await rolled.live_deployment_id(), await rolled.live_deployment_url(),
            )  # fmt: skip
        except (dagger.DaggerError, RuntimeError) as error:
            return str(error)

    async def _verdict_or_recover(
        self, smoke: SmokeRun, provider: ProviderIdentity, plan: RecoveryPlan
    ) -> str:
        """Green: evidence. Red: roll back, re-check live, and fail loudly either way."""
        if smoke.exit_code == 0:
            return smoke_verdict(smoke, provider.deployment_id, provider.deployment_url)
        rollback = await self._rollback(plan)
        recovery = None
        if not isinstance(rollback, str):
            recovery = await self._recovery_smoke(plan.source, plan.identity)
        deployment = f"{provider.deployment_id} ({provider.deployment_url})"
        raise recovery_failure(smoke, deployment, rollback, recovery)

    def _shared_guard(self, source: Directory, commit_sha: str) -> Container:
        """Build the exact-SHA Foundation repository guard."""
        return dag.foundation().guard(
            source=source,
            repository=REPOSITORY,
            commit_sha=commit_sha,
        )

    async def _release_context(self, github_token: Secret) -> ReleaseContext:
        shared = dag.foundation()
        raw = shared.green_main(github_token=github_token, repository=TARGET.repository)
        evidence = parse_green_main(await raw.serialization())
        source = (
            dag.git(REPOSITORY_URL).commit(evidence.commit_sha).tree(depth=0, include_tags=True)
        )
        bound = shared.source(source, TARGET.repository, evidence.commit_sha)
        return ReleaseContext(bound, evidence)

    async def _build_publication(
        self, request: PublishRequest, context: ReleaseContext, identity: ReleaseIdentity
    ) -> tuple[Directory, Directory]:
        stamp = release_version("", datetime.now(UTC).date())
        release = self._signed_release(
            context.source, request.signing_key, stamp, request.kind
        ).directory("/release")
        built = self._release_app(context.source, release, identity.source_sha, identity.run_id)
        app = built.directory("/src/frontend/app/dist")
        await self._preview_verify(context.source, app, release, identity).sync()
        return release, app

    @staticmethod
    def _require_matching_source(identity: ReleaseIdentity, context: ReleaseContext) -> None:
        if identity.source_sha != context.evidence.commit_sha:
            raise ReleaseSourceMismatchError("release identity must match the green-main SHA")

    @staticmethod
    def _provider_request(app: Directory, context: ReleaseContext) -> ProviderRequest:
        consumer = f"{TARGET.repository}@{context.evidence.commit_sha}"
        producing = f"{CENTRAL_MODULE_SHA}:{context.evidence.workflow_run_id}"
        artifact = dag.directory().with_directory(DEPLOY_ROOT, app)
        envelope = dag.foundation().envelope(artifact, consumer, producing, [DEPLOY_ROOT])
        return ProviderRequest(
            envelope,
            consumer,
            producing,
            context.evidence.workflow_run_id,
            context.evidence.run_attempt,
        )

    @staticmethod
    def _provider_deploy(
        request: ProviderRequest, github_token: Secret, token: Secret, account: Secret
    ) -> dagger.CloudflarePagesDeploymentEvidence:
        provider = dag.cloudflare_pages()
        r = request
        target = TARGET
        domains: list[str] = list(PAGES_DOMAINS)
        return provider.deploy(
            r.envelope, github_token, token, account, r.workflow_run_id, r.run_attempt,
            target.repository, target.project, target.branch, target.domain, DEPLOY_ROOT, domains,
            r.consumer_identity, r.producing_identity, [DEPLOY_ROOT])  # fmt: skip

    @staticmethod
    async def _provider_identity(
        evidence: dagger.CloudflarePagesDeploymentEvidence,
    ) -> ProviderIdentity:
        object_id = dagger.CloudflarePagesDeploymentEvidenceID(await evidence.id())
        stored = dag.load_cloudflare_pages_deployment_evidence_from_id(object_id)
        deployment_id = await stored.deployment_id()
        deployment_url = await stored.deployment_url()
        return ProviderIdentity(deployment_id, deployment_url)

    async def _deliver(
        self, request: ProviderRequest, publication: PublishRequest
    ) -> ProviderIdentity:
        evidence = self._provider_deploy(
            request, publication.github_token, publication.api_token, publication.account_id
        )
        return await self._provider_identity(evidence)

    @staticmethod
    def _deployment_result(identity: ProviderIdentity, live: str) -> str:
        evidence = f"provider deployment verified: id={identity.deployment_id}"
        return f"{evidence} url={identity.deployment_url}\n{live}"

    async def _publish(self, request: PublishRequest) -> str:
        identity = parse_release_identity(request.release_id)
        context = await self._release_context(request.github_token)
        self._require_matching_source(identity, context)
        release, app = await self._build_publication(request, context, identity)
        profile, primed = await self._prime_profile(context.source, identity)
        target = await self._rollback_target(request)
        provider_request = self._provider_request(app, context)
        provider = await self._deliver(provider_request, request)
        live, smoke = await self._post_deploy_checks(context.source, release, profile, identity)
        plan = RecoveryPlan(request, target, context.source, identity)
        verdict = await self._verdict_or_recover(smoke, provider, plan)
        proof = f"{live.output}\n{prime_note(primed)}\n{verdict}"
        return self._deployment_result(provider, proof)

    @function
    async def ci(self, commit_sha: str) -> str:
        """Run all CI stages against the caller's exact source snapshot."""
        await cast(Container, self.quality()).sync()
        await cast(Container, self.dependency_audit()).sync()
        await cast(Container, self.secret_scan(commit_sha)).sync()
        return "caller snapshot CI passed"

    @function
    def secret_scan(self, commit_sha: str) -> Container:
        """Guard the caller's exact source and commit through Foundation."""
        return self._shared_guard(self.source, commit_sha)

    @function
    @check
    def dependency_audit(self) -> Container:
        """Audit the locked frontend dependency graph without suppressions."""
        return self._node(self.source).with_exec(["pnpm", "audit", "--audit-level", "low"])

    @function
    @check
    def quality(self) -> Container:
        """Run the repository's complete canonical product gate."""
        container = mount_caches(self._with_uv(self._node(self.source)), QUALITY_CACHES)
        container = container.with_exec(["uv", "sync", "--project", "../eval", "--frozen"])
        container = container.with_exec(PLAYWRIGHT_INSTALL)
        return container.with_exec(["pnpm", "run", "gate"])

    @function
    def preview(self, app: Directory) -> Service:
        """Serve an application Directory for pre-upload verification."""
        return self._preview(self.source, app)

    @function
    def signed_origin(
        self,
        signing_key: Secret,
        version: str = "",
        code_deploy: bool = False,
    ) -> Directory:
        """Build and verify an isolated, monotonically sequenced signed origin."""
        kind = ReleaseKind.CODE if code_deploy else ReleaseKind.WATCHLIST
        stamp = release_version(version, datetime.now(UTC).date())
        container = self._signed_release(self.source, signing_key, stamp, kind)
        return container.directory("/release")

    @function
    def freshness(self) -> Container:
        """Fail closed unless the live signed sanctions origin is fresh."""
        return self._node(self.source).with_exec(FRESHNESS_CHECK)

    @function
    def live_smoke(self) -> Container:
        """Drive the live site in real Chromium as a first-time visitor; fail loudly."""
        nonce = f"scheduled:{datetime.now(UTC).isoformat()}"
        container = self._smoke_base(self.source, smoke_passes(returning=False), nonce)
        return container.with_exec(["bash", "-ceu", SMOKE_SCRIPT])

    @function
    def live_verify(self, release: Directory, source_sha: str, run_id: str) -> Container:
        """Verify exact live app, signed bundle, source, run, and canonical identity."""
        identity = release_identity(source_sha, run_id)
        return self._live_verify(self.source, release, identity)

    @function
    async def deploy(
        self,
        signing_key: Secret,
        cloudflare_api_token: Secret,
        cloudflare_account_id: Secret,
        github_token: Secret,
        release_id: str,
    ) -> str:
        """Build, verify, upload, and live-verify an exact code release."""
        secrets = signing_key, cloudflare_api_token, cloudflare_account_id, github_token
        return await self._publish(PublishRequest(ReleaseKind.CODE, *secrets, release_id))

    @function
    async def release_turn(
        self,
        github_token: Secret,
        run_id: str,
        poll_seconds: int = 20,
        max_wait_seconds: int = 10800,
    ) -> str:
        """Wait, outside the production mutex, until every older production write finished."""
        return await grant_release_turn(
            github_token, run_id, TurnPolicy(poll_seconds, max_wait_seconds)
        )

    @function
    async def publish_watchlist(
        self,
        signing_key: Secret,
        cloudflare_api_token: Secret,
        cloudflare_account_id: Secret,
        github_token: Secret,
        release_id: str,
    ) -> str:
        secrets = signing_key, cloudflare_api_token, cloudflare_account_id, github_token
        return await self._publish(PublishRequest(ReleaseKind.WATCHLIST, *secrets, release_id))
