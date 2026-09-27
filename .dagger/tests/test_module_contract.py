"""Executable schema contracts for the public Dagger module."""

from __future__ import annotations

import importlib
import inspect
import json
import os
import re
import subprocess
import textwrap
import tomllib
from collections.abc import Awaitable, Mapping
from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path
from shutil import which
from typing import Final, cast

import pytest
from dagger import Container, DaggerError, Directory, Secret
from ruamel.yaml import YAML
from ruamel.yaml.error import YAMLError

import aml_filter.main as main_module
from aml_filter.main import (
    FRESHNESS_CHECK,
    REPOSITORY,
    REPOSITORY_URL,
    AmlFilter,
    PublishRequest,
)
from aml_filter.policy import ReleaseKind, release_identity
from aml_filter.smoke import SMOKE_LISTS, LiveSmokeFailedError, SmokeRun

ROOT: Final = Path(__file__).resolve().parents[2]
WORKFLOW_DIRECTORY: Final = ROOT / ".github" / "workflows"
CHECKOUT_ACTION: Final = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
DAGGER_ACTION: Final = "dagger/dagger-for-github@27b130bf0f79a7f6fbbbe0fbca6760dc9bb40a77"
DELIVERY_ACTIONS: Final = (CHECKOUT_ACTION, DAGGER_ACTION)
DELIVERY_WORKFLOWS: Final = {
    "deploy.yml": "deploy",
    "publish-watchlist.yml": "publish",
}
READ_ONLY_PERMISSIONS: Final = {"contents": "read"}
DELIVERY_PERMISSIONS: Final = {"contents": "read", "actions": "read"}
# Build + deploy took up to 13 min; prime + fresh + returning add ~15. Literal pin.
DELIVERY_TIMEOUT_MINUTES: Final = 45
DELIVERY_CONCURRENCY: Final = {
    "group": "deploy-aml-filter-com",
    "cancel-in-progress": False,
}
CHECKS_CONCURRENCY: Final = {
    "group": "dagger-checks-${{ github.workflow }}-${{ github.ref }}",
    "cancel-in-progress": True,
}
SECURITY_CONCURRENCY: Final = {
    "group": "security-audit-${{ github.ref }}",
    "cancel-in-progress": True,
}
CI_CHECKOUT_INPUTS: Final = {
    "fetch-depth": 0,
    "persist-credentials": False,
    "ref": "${{ github.sha }}",
}
CI_DAGGER_INPUTS: Final = {
    "version": "0.21.8",
    "call": "ci --commit-sha=${{ github.sha }}",
}
AUTHORIZER_TRIGGERS: Final = {
    "push": {"branches": ["main"]},
    "pull_request": None,
}
SECURITY_AUDIT_TRIGGERS: Final = {
    "schedule": [{"cron": "0 9 * * 1"}],
    "workflow_dispatch": None,
}
# Event values reach dagger-for-github's bash only through env as quoted variables
# (fleet rule dagger-args-expression, hseshadr/ci#50): the action pastes `call` raw
# into a bash script, so no `${{ github.event.* }}` may appear in it.
RELEASE_SHA_SOURCE: Final = (
    "${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || github.sha }}"
)
DELIVERY_ENVIRONMENT: Final = {
    "WATCHLIST_SIGNING_KEY": "${{ secrets.WATCHLIST_SIGNING_KEY }}",
    "CLOUDFLARE_API_TOKEN": "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    "CLOUDFLARE_ACCOUNT_ID": "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
    "GITHUB_TOKEN": "${{ github.token }}",
    "RELEASE_SHA": RELEASE_SHA_SOURCE,
}
RELEASE_ID_ARGUMENT: Final = '--release-id="$RELEASE_SHA:$GITHUB_RUN_ID"'
# Every dagger-for-github input the pinned action pastes into bash.
DAGGER_SCRIPT_INPUTS: Final = ("args", "call", "shell", "dagger-flags", "workdir", "cloud-token")
FORBIDDEN_SCRIPT_EXPRESSION: Final = re.compile(
    r"\$\{\{[^}]*(?:\binputs\.|\bgithub\.event\.|\bgithub\.head_ref\b)"
)
EXPECTED_WORKFLOW_JOBS: Final = {
    "dagger.yml": frozenset({"checks"}),
    "deploy.yml": frozenset({"deploy", "queue"}),
    "live-smoke.yml": frozenset({"smoke"}),
    "publish-watchlist.yml": frozenset({"publish", "queue"}),
    "security-audit.yml": frozenset({"security"}),
    "watchlist-freshness.yml": frozenset({"freshness"}),
}
QUEUE_JOB: Final = "queue"
QUEUE_JOB_NAME: Final = "Wait for earlier production writes"
QUEUE_TIMEOUT_MINUTES: Final = 180
QUEUE_ENVIRONMENT: Final = {"GITHUB_TOKEN": "${{ github.token }}"}
QUEUE_INPUTS: Final = {
    "version": "0.21.8",
    "call": 'release-turn --github-token=env://GITHUB_TOKEN --run-id="$GITHUB_RUN_ID"',
}
EXPECTED_WORKFLOW_NAMES: Final = {
    "dagger.yml": "Dagger",
    "deploy.yml": "Deploy aml-filter.com",
    "live-smoke.yml": "Live smoke",
    "publish-watchlist.yml": "Publish watchlist",
    "security-audit.yml": "Security audit",
    "watchlist-freshness.yml": "Watchlist freshness",
}
EXPECTED_WORKFLOW_PERMISSIONS: Final = {
    "dagger.yml": READ_ONLY_PERMISSIONS,
    "deploy.yml": DELIVERY_PERMISSIONS,
    "live-smoke.yml": READ_ONLY_PERMISSIONS,
    "publish-watchlist.yml": DELIVERY_PERMISSIONS,
    "security-audit.yml": READ_ONLY_PERMISSIONS,
    "watchlist-freshness.yml": READ_ONLY_PERMISSIONS,
}
MUTATION_FUNCTIONS: Final = {
    ("deploy.yml", "deploy"): "deploy",
    ("publish-watchlist.yml", "publish"): "publish-watchlist",
}
DEPLOY_SOURCE: Final = (
    "${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || github.sha }}"
)
DELIVERY_SOURCES: Final = {
    "deploy.yml": DEPLOY_SOURCE,
    "publish-watchlist.yml": DEPLOY_SOURCE,
}
DELIVERY_CHECKOUT_INPUTS: Final = {
    "deploy.yml": {
        "fetch-depth": 0,
        "persist-credentials": False,
        "ref": DEPLOY_SOURCE,
    },
    "publish-watchlist.yml": {"persist-credentials": False, "ref": DEPLOY_SOURCE},
}
DEPLOY_AUTHORIZATION: Final = (
    "(github.event_name == 'workflow_run' && "
    "github.event.workflow_run.conclusion == 'success' && "
    "github.event.workflow_run.event == 'push' && "
    "github.event.workflow_run.head_branch == 'main' && "
    "github.event.workflow_run.head_repository.full_name == github.repository) || "
    "(github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')"
)
PUBLISH_AUTHORIZATION: Final = f"{DEPLOY_AUTHORIZATION} || github.event_name == 'schedule'"
PUBLISH_TRIGGERS: Final = frozenset({"schedule", "workflow_run", "workflow_dispatch"})
PUBLISH_SCHEDULE: Final = [{"cron": "0 6 * * *"}]
DANGEROUS_TRIGGER_WAIVER: Final = (
    "on: # zizmor: ignore[dangerous-triggers] guarded deploy-after-CI; tests bind the sole "
    "triggers, repository, event, branch, conclusion, and exact head SHA"
)
PROVIDER_MARKERS: Final = (
    "cloudflare_",
    "watchlist_signing_key",
    "github_token",
    "wrangler",
    "pages deploy",
    "publish-watchlist",
    '"call": "deploy',
    "--cloudflare",
)
YAML_DEPENDENCY: Final = "ruamel-yaml>=0.18.16,<0.19.0"
# hseshadr/ci main: merge of ci#51 (verified Pages rollback).
CENTRAL_SHA: Final = "363be0b98c753c027353f35db0f6cc5b24402f78"
FOUNDATION_MODULE: Final = f"github.com/hseshadr/ci/modules/portfolio-foundation@{CENTRAL_SHA}"
CLOUDFLARE_MODULE: Final = f"github.com/hseshadr/ci/modules/cloudflare-pages@{CENTRAL_SHA}"
REAL_PROVIDER_DEPENDENCIES: Final = (
    ("foundation", FOUNDATION_MODULE),
    ("cloudflare-pages", CLOUDFLARE_MODULE),
)
RECORDED_SHA: Final = "0123456789abcdef0123456789abcdef01234567"
RECORDED_RUN_ID: Final = "123456"
RECORDED_ATTEMPT: Final = 2
MALFORMED_SHA: Final = "not-a-sha"
MALFORMED_GUARD_CALL: Final = (
    "-m",
    FOUNDATION_MODULE,
    "call",
    "guard",
    "--source=.",
    f"--repository={REPOSITORY}",
    f"--commit-sha={MALFORMED_SHA}",
    "sync",
)
PRETRANSPORT_SOURCE: Final = """\
from dagger import dag, function, object_type

SHA = "363be0b98c753c027353f35db0f6cc5b24402f78"
COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
REPOSITORY = "hseshadr/aml-filter"


@object_type
class Pretransport:
    @function
    async def tampered_deploy(self) -> str:
        artifact = dag.directory().with_new_file("dist/index.html", "valid")
        envelope = dag.foundation().envelope(
            artifact, f"{REPOSITORY}@{COMMIT}", f"{SHA}:123456", ["dist"]
        )
        tampered = envelope.with_new_file("artifact/dist/index.html", "tampered")
        github = dag.set_secret("github", "synthetic-github-token")
        api = dag.set_secret("cloudflare-api", "synthetic-cloudflare-token")
        account = dag.set_secret("cloudflare-account", "synthetic-cloudflare-account")
        evidence = dag.cloudflare_pages().deploy(
            tampered, github, api, account, "123456", 2,
            REPOSITORY, "aml-filter", "main", "aml-filter.com", "dist", [],
            f"{REPOSITORY}@{COMMIT}", f"{SHA}:123456", ["dist"],
        )
        return await evidence.deployment_id()
"""


def green_main_json(
    commit_sha: object = RECORDED_SHA,
    workflow_run_id: object = RECORDED_RUN_ID,
    run_attempt: object = RECORDED_ATTEMPT,
    repository: object = REPOSITORY,
    branch: object = "main",
) -> str:
    """Build an external serialized-evidence fixture with explicit boundary values."""
    return json.dumps(
        {
            "branch": branch,
            "commit_sha": commit_sha,
            "repository": repository,
            "run_attempt": run_attempt,
            "workflow_run_id": workflow_run_id,
        }
    )


@dataclass(frozen=True)
class GuardCall:
    """One recorded generated-Foundation boundary invocation."""

    source: Directory
    repository: str
    commit_sha: str


class RecordingFoundation:
    """Record the exact guard call while preserving its returned object."""

    def __init__(self, result: Container) -> None:
        self.result = result
        self.call: GuardCall | None = None

    def guard(self, source: Directory, repository: str, commit_sha: str) -> Container:
        self.call = GuardCall(source, repository, commit_sha)
        return self.result


class RecordingGitRef:
    """Resolve one exact commit and source tree without network access."""

    def __init__(self, source: Directory, events: list[str]) -> None:
        self.source = source
        self.events = events

    async def commit(self) -> str:
        self.events.append("resolve-commit")
        return RECORDED_SHA

    def tree(self, *, depth: int) -> Directory:
        self.events.append(f"tree:{depth}")
        return self.source


class RecordingGitRepository:
    """Record main resolution and exact-SHA checkout operations."""

    def __init__(self, source: Directory, events: list[str]) -> None:
        self.source = source
        self.events = events

    def branch(self, name: str) -> RecordingGitRef:
        self.events.append(f"branch:{name}")
        return RecordingGitRef(self.source, self.events)

    def commit(self, commit_sha: str) -> RecordingGitRef:
        self.events.append(f"commit:{commit_sha}")
        return RecordingGitRef(self.source, self.events)


class RecordingDag:
    """Record the consumer graph around Git and Foundation boundaries."""

    def __init__(self, source: Directory, result: Container) -> None:
        self.events: list[str] = []
        self.source = source
        self.shared = RecordingFoundation(result)

    def git(self, url: str) -> RecordingGitRepository:
        self.events.append(f"git:{url}")
        return RecordingGitRepository(self.source, self.events)

    def foundation(self) -> RecordingFoundation:
        self.events.append("foundation")
        return self.shared


class CiContainerRecorder:
    """Record one caller-bound CI stage and optionally fail it."""

    def __init__(self, name: str, events: list[str], failure: str = "") -> None:
        self.name = name
        self.events = events
        self.failure = failure

    async def sync(self) -> CiContainerRecorder:
        self.events.append(self.name)
        if self.name == self.failure:
            raise RuntimeError(f"{self.name} failed")
        return self


class CiProductRecorder:
    """Replace the three materialized CI stages."""

    def __init__(self, events: list[str], failure: str) -> None:
        self.events = events
        self.failure = failure

    def quality(self) -> Container:
        return cast(Container, CiContainerRecorder("quality", self.events, self.failure))

    def dependency_audit(self) -> Container:
        return cast(Container, CiContainerRecorder("audit", self.events, self.failure))

    def secret_scan(self, commit_sha: str) -> Container:
        assert commit_sha == RECORDED_SHA
        return cast(Container, CiContainerRecorder("secret-scan", self.events, self.failure))


@dataclass(frozen=True)
class RecordedCi:
    """Typed context for one explicit caller-snapshot CI run."""

    subject: AmlFilter
    recorder: RecordingDag
    events: list[str]
    caller_source: Directory
    canonical_source: Directory


def recorded_ci(monkeypatch: pytest.MonkeyPatch, failure: str = "") -> RecordedCi:
    """Install distinct caller/canonical sources and materialization recorders."""
    events: list[str] = []
    caller = cast(Directory, object())
    canonical = cast(Directory, object())
    guard = cast(Container, CiContainerRecorder("guard", events, failure))
    recorder = RecordingDag(canonical, guard)
    products = CiProductRecorder(events, failure)
    monkeypatch.setattr(main_module, "dag", recorder)
    monkeypatch.setattr(AmlFilter, "quality", products.quality)
    monkeypatch.setattr(AmlFilter, "dependency_audit", products.dependency_audit)
    monkeypatch.setattr(AmlFilter, "secret_scan", products.secret_scan)
    subject = object.__new__(AmlFilter)
    subject.source = caller
    return RecordedCi(subject, recorder, events, caller, canonical)


class ReleaseContainerRecorder:
    """Record release-base composition without materializing a container."""

    def __init__(self, events: list[str]) -> None:
        self.events = events

    def with_mounted_cache(self, path: str, volume: object) -> ReleaseContainerRecorder:
        del volume
        self.events.append(f"cache:{path}")
        return self

    def with_directory(self, path: str, directory: object) -> ReleaseContainerRecorder:
        del directory
        self.events.append(f"directory:{path}")
        return self

    def with_env_variable(self, name: str, value: str) -> ReleaseContainerRecorder:
        self.events.append(f"env:{name}={value}")
        return self

    def with_service_binding(self, name: str, service: object) -> ReleaseContainerRecorder:
        del service
        self.events.append(f"service:{name}")
        return self

    def with_exec(self, arguments: list[str], expect: object = None) -> ReleaseContainerRecorder:
        kind = "exec" if expect is None else "exec-any"
        self.events.append(f"{kind}:{' '.join(arguments)}")
        return self


class ReleaseGitRefRecorder:
    """Return one inert EdgeProc directory for the release-base graph."""

    def tree(self) -> Directory:
        return cast(Directory, object())


class ReleaseGitRecorder:
    """Record the exact pinned EdgeProc commit."""

    def __init__(self, events: list[str]) -> None:
        self.events = events

    def commit(self, commit_sha: str) -> ReleaseGitRefRecorder:
        self.events.append(f"edgeproc:{commit_sha}")
        return ReleaseGitRefRecorder()


class ReleaseDagRecorder:
    """Provide only the Dagger calls needed by ``_release_base``."""

    def __init__(self, events: list[str]) -> None:
        self.events = events

    def cache_volume(self, name: str) -> object:
        self.events.append(f"cache-volume:{name}")
        return object()

    def git(self, url: str) -> ReleaseGitRecorder:
        self.events.append(f"git:{url}")
        return ReleaseGitRecorder(self.events)


@dataclass(frozen=True)
class ProviderCall:
    """Exact provider mutation boundary observed by the consumer test."""

    arguments: tuple[object, ...]


class DeliveryDirectoryRecorder:
    """Record the single artifact root packaged for Foundation."""

    def __init__(self, events: list[str]) -> None:
        self.events = events

    def with_directory(self, path: str, directory: Directory) -> Directory:
        del directory
        self.events.append(f"package:{path}")
        return cast(Directory, self)


class GreenMainRecorder:
    """Materialize the canonical Foundation evidence once."""

    def __init__(self, events: list[str]) -> None:
        self.events = events

    async def serialization(self) -> str:
        self.events.append("materialize:green-main")
        return green_main_json()


class DeliveryGitRefRecorder:
    """Produce a complete exact-commit source tree."""

    def __init__(self, events: list[str], source: Directory) -> None:
        self.events = events
        self.source = source

    def tree(self, *, depth: int, include_tags: bool) -> Directory:
        self.events.append(f"tree:{depth}:tags={include_tags}")
        return self.source


class DeliveryGitRecorder:
    """Bind the public Git graph to a single evidence SHA."""

    def __init__(self, events: list[str], source: Directory) -> None:
        self.events = events
        self.source = source

    def commit(self, commit_sha: str) -> DeliveryGitRefRecorder:
        self.events.append(f"commit:{commit_sha}")
        return DeliveryGitRefRecorder(self.events, self.source)


class DeliveryFoundationRecorder:
    """Record green-main, source binding, and envelope composition."""

    def __init__(self, context: RecordedDelivery) -> None:
        self.context = context

    def green_main(self, github_token: Secret, repository: str) -> GreenMainRecorder:
        assert github_token is self.context.github_token
        assert repository == REPOSITORY
        self.context.events.append("construct:green-main")
        return GreenMainRecorder(self.context.events)

    def source(self, source: Directory, repository: str, commit_sha: str) -> Directory:
        assert source is self.context.fetched_source
        assert (repository, commit_sha) == (REPOSITORY, RECORDED_SHA)
        self.context.events.append("foundation:source")
        return self.context.bound_source

    def envelope(
        self,
        artifact: Directory,
        consumer_identity: str,
        producing_identity: str,
        allowed_roots: list[str],
    ) -> Directory:
        if self.context.fail_envelope:
            raise RuntimeError("envelope failed")
        self.context.events.append("construct:envelope")
        self.context.envelope_values = (
            artifact,
            consumer_identity,
            producing_identity,
            tuple(allowed_roots),
        )
        return self.context.envelope


class ProviderEvidenceRecorder:
    """Distinguish deployment graph construction from mutation materialization."""

    def __init__(self, context: RecordedDelivery) -> None:
        self.context = context

    async def id(self) -> str:
        self.context.events.append("materialize:deploy")
        if self.context.fail_materialization:
            raise RuntimeError("provider materialization failed")
        return "provider-evidence-id"


class StoredProviderEvidenceRecorder:
    """Expose only the nominally reloaded non-secret deployment fields."""

    def __init__(self, events: list[str]) -> None:
        self.events = events

    async def deployment_id(self) -> str:
        self.events.append("stored:deployment-id")
        return "deployment-123"

    async def deployment_url(self) -> str:
        self.events.append("stored:deployment-url")
        return "https://deployment.example.pages.dev"


class ProductionRecorder:
    """The read-only rollback target recorded before upload."""

    def __init__(self, context: RecordedDelivery) -> None:
        self.context = context

    async def deployment_id(self) -> str:
        self.context.events.append("materialize:previous-production")
        if self.context.fail_target:
            raise RuntimeError("previous production unreadable")
        return "deployment-good"


class RollbackRecorder:
    """Verified rollback evidence, or the module's fail-closed refusal."""

    def __init__(self, context: RecordedDelivery) -> None:
        self.context = context

    async def from_deployment_id(self) -> str:
        self.context.events.append("materialize:rollback")
        if self.context.fail_rollback:
            raise RuntimeError("target is already live")
        return "deployment-123"

    async def to_deployment_id(self) -> str:
        return "deployment-good"

    async def live_deployment_id(self) -> str:
        return "deployment-good"

    async def live_deployment_url(self) -> str:
        return "https://deployment-good.pages.dev"


class ProviderRecorder:
    """Record exactly one generated-provider deploy call."""

    def __init__(self, context: RecordedDelivery) -> None:
        self.context = context

    def previous_production_deployment(
        self, token: Secret, account: Secret, project: str
    ) -> ProductionRecorder:
        assert (token, account, project) == (
            self.context.api_token,
            self.context.account_id,
            "aml-filter",
        )
        self.context.events.append("construct:previous-production")
        return ProductionRecorder(self.context)

    def rollback(
        self, token: Secret, account: Secret, project: str, *, deployment_id: str = ""
    ) -> RollbackRecorder:
        assert (token, account, project) == (
            self.context.api_token,
            self.context.account_id,
            "aml-filter",
        )
        self.context.events.append(f"construct:rollback:{deployment_id}")
        return RollbackRecorder(self.context)

    def deploy(self, *arguments: object) -> ProviderEvidenceRecorder:
        assert arguments[1:4] == (
            self.context.github_token,
            self.context.api_token,
            self.context.account_id,
        )
        self.context.events.append("construct:deploy")
        self.context.provider_call = ProviderCall(arguments)
        return ProviderEvidenceRecorder(self.context)


@dataclass
class RecordedDelivery:
    """All inert objects and events for one publication attempt."""

    events: list[str]
    fetched_source: Directory
    bound_source: Directory
    release: Directory
    app: Directory
    envelope: Directory
    signing_key: Secret
    api_token: Secret
    account_id: Secret
    github_token: Secret
    fail_envelope: bool = False
    fail_materialization: bool = False
    envelope_values: tuple[object, str, str, tuple[str, ...]] | None = None
    provider_call: ProviderCall | None = None
    profile: Directory = field(default_factory=lambda: cast(Directory, object()))
    prime_exit: int = 0
    smoke_exit: int = 0
    recovery_exit: int = 0
    fail_target: bool = False
    fail_live: bool = False
    fail_rollback: bool = False


class DeliveryDagRecorder:
    """Provide only the generated boundaries used by production orchestration."""

    def __init__(self, context: RecordedDelivery) -> None:
        self.context = context

    def foundation(self) -> DeliveryFoundationRecorder:
        return DeliveryFoundationRecorder(self.context)

    def git(self, url: str) -> DeliveryGitRecorder:
        assert url == REPOSITORY_URL
        self.context.events.append(f"git:{url}")
        return DeliveryGitRecorder(self.context.events, self.context.fetched_source)

    def directory(self) -> Directory:
        return cast(Directory, DeliveryDirectoryRecorder(self.context.events))

    def cloudflare_pages(self) -> ProviderRecorder:
        return ProviderRecorder(self.context)

    def load_cloudflare_pages_deployment_evidence_from_id(
        self, evidence_id: object
    ) -> StoredProviderEvidenceRecorder:
        assert str(evidence_id) == "provider-evidence-id"
        self.context.events.append("load:provider-evidence-id")
        return StoredProviderEvidenceRecorder(self.context.events)


class ProductContainerRecorder:
    """Materialize only preview and live product proof in unit tests."""

    def __init__(self, label: str, context: RecordedDelivery) -> None:
        self.label = label
        self.context = context

    def directory(self, path: str) -> Directory:
        self.context.events.append(f"directory:{self.label}:{path}")
        return self.context.release if self.label == "release" else self.context.app

    async def sync(self) -> ProductContainerRecorder:
        self.context.events.append("preview")
        return self

    async def stdout(self) -> str:
        self.context.events.append("live" if self.label == "live" else "direct-upload")
        if self.label == "live" and self.context.fail_live:
            raise DaggerError("build.json git_sha 0000000 != expected release SHA")
        return "live product proof" if self.label == "live" else "legacy upload"


class ReleaseIdentityLike:
    """The one identity field the smoke recorder reads."""

    source_sha: str


class ProductMethodRecorder:
    """Replace product-only build and verification containers."""

    def __init__(self, context: RecordedDelivery) -> None:
        self.context = context

    def signed_release(
        self,
        source: Directory,
        signing_key: Secret,
        version: str,
        kind: ReleaseKind,
    ) -> Container:
        assert (source, signing_key) == (self.context.bound_source, self.context.signing_key)
        assert version
        self.context.events.append(f"sign:{kind.value}")
        return cast(Container, ProductContainerRecorder("release", self.context))

    def release_app(
        self,
        source: Directory,
        release: Directory,
        source_sha: str,
        run_id: str,
    ) -> Container:
        assert (source, release) == (self.context.bound_source, self.context.release)
        self.context.events.append(f"stamp:{source_sha}:{run_id}")
        return cast(Container, ProductContainerRecorder("app", self.context))

    def preview_verify(
        self,
        source: Directory,
        app: Directory,
        release: Directory,
        identity: object,
    ) -> Container:
        del identity
        expected = (self.context.bound_source, self.context.app, self.context.release)
        assert (source, app, release) == expected
        return cast(Container, ProductContainerRecorder("preview", self.context))

    def live_verify(
        self,
        source: Directory,
        release: Directory,
        identity: object,
    ) -> Container:
        del identity
        assert (source, release) == (self.context.bound_source, self.context.release)
        return cast(Container, ProductContainerRecorder("live", self.context))

    async def prime_profile(
        self, source: Directory, identity: object
    ) -> tuple[Directory, SmokeRun]:
        del identity
        assert source is self.context.bound_source
        self.context.events.append("prime")
        return self.context.profile, SmokeRun(self.context.prime_exit, "Error: prime refused")

    async def post_deploy_smoke(
        self, source: Directory, profile: Directory, identity: ReleaseIdentityLike
    ) -> SmokeRun:
        assert (source, profile) == (self.context.bound_source, self.context.profile)
        self.context.events.append(f"smoke:{identity.source_sha}")
        output = "[live-smoke fresh] UK_OFSI: Igor Ivanovich Sechin\nError: signature failed"
        return SmokeRun(self.context.smoke_exit, output)

    async def recovery_smoke(self, source: Directory, identity: ReleaseIdentityLike) -> SmokeRun:
        assert source is self.context.bound_source
        self.context.events.append(f"recovery-smoke:{identity.source_sha}")
        return SmokeRun(self.context.recovery_exit, "Error: recovery pass output")

    def direct_upload(
        self,
        source: Directory,
        app: Directory,
        token: Secret,
        account_id: Secret,
    ) -> Container:
        del source, app, token, account_id
        return cast(Container, ProductContainerRecorder("upload", self.context))


def recorded_delivery() -> RecordedDelivery:
    """Create distinct opaque values so identity mistakes cannot pass."""
    return RecordedDelivery(
        events=[],
        fetched_source=cast(Directory, object()),
        bound_source=cast(Directory, object()),
        release=cast(Directory, object()),
        app=cast(Directory, object()),
        envelope=cast(Directory, object()),
        signing_key=cast(Secret, object()),
        api_token=cast(Secret, object()),
        account_id=cast(Secret, object()),
        github_token=cast(Secret, object()),
    )


def install_product_recorders(
    monkeypatch: pytest.MonkeyPatch, context: RecordedDelivery
) -> AmlFilter:
    """Replace product containers while retaining real delivery orchestration."""
    recorder = ProductMethodRecorder(context)
    monkeypatch.setattr(main_module, "dag", DeliveryDagRecorder(context))
    monkeypatch.setattr(AmlFilter, "_signed_release", recorder.signed_release)
    monkeypatch.setattr(AmlFilter, "_release_app", recorder.release_app)
    monkeypatch.setattr(AmlFilter, "_preview_verify", recorder.preview_verify)
    monkeypatch.setattr(AmlFilter, "_live_verify", recorder.live_verify)
    monkeypatch.setattr(AmlFilter, "_prime_profile", recorder.prime_profile)
    monkeypatch.setattr(AmlFilter, "_post_deploy_smoke", recorder.post_deploy_smoke)
    monkeypatch.setattr(AmlFilter, "_recovery_smoke", recorder.recovery_smoke)
    monkeypatch.setattr(AmlFilter, "_upload", recorder.direct_upload, raising=False)
    subject = object.__new__(AmlFilter)
    subject.source = cast(Directory, object())
    return subject


@dataclass(frozen=True)
class RecordedSecretScan:
    """Typed test context for one public secret-scan composition."""

    subject: AmlFilter
    recorder: RecordingDag
    result: Container
    caller_source: Directory
    canonical_source: Directory


def recorded_secret_scan(monkeypatch: pytest.MonkeyPatch) -> RecordedSecretScan:
    """Install one recorder without weakening the production signature."""
    caller = cast(Directory, object())
    canonical = cast(Directory, object())
    result = cast(Container, object())
    recorder = RecordingDag(canonical, result)
    monkeypatch.setattr(main_module, "dag", recorder)
    subject = object.__new__(AmlFilter)
    subject.source = caller
    return RecordedSecretScan(subject, recorder, result, caller, canonical)


def dagger_bin() -> str:
    """Resolve Dagger once while retaining a non-optional subprocess type."""
    executable = which("dagger")
    if executable is None:
        raise RuntimeError("dagger executable is required for module contract tests")
    return executable


DAGGER_BIN: Final = dagger_bin()
FUNCTIONS: Final = frozenset(
    {
        "ci",
        "dependency-audit",
        "deploy",
        "freshness",
        "live-smoke",
        "live-verify",
        "preview",
        "publish-watchlist",
        "quality",
        "release-turn",
        "secret-scan",
        "signed-origin",
    }
)
CHECKS: Final = frozenset({"aml-filter:dependency-audit", "aml-filter:quality"})


def workflow_paths(directory: Path = WORKFLOW_DIRECTORY) -> tuple[Path, ...]:
    """Discover every supported GitHub workflow extension."""
    paths = (*directory.glob("*.yml"), *directory.glob("*.yaml"))
    return tuple(sorted(paths))


def mapping_field(mapping: Mapping[str, object], field: str) -> Mapping[str, object]:
    """Require one YAML mapping field without accepting coercion."""
    value = mapping.get(field)
    assert isinstance(value, dict), f"{field} must be a mapping"
    return cast(Mapping[str, object], value)


def workflow_jobs(workflow: Mapping[str, object]) -> Mapping[str, object]:
    """Return jobs only after every job has a mapping body."""
    jobs = mapping_field(workflow, "jobs")
    assert all(isinstance(job, dict) for job in jobs.values()), "jobs must contain mappings"
    return jobs


def yaml_12_load(content: str) -> object:
    """Load GitHub Actions YAML using safe YAML 1.2 scalar semantics."""
    parser = YAML(typ="safe", pure=True)
    parser.version = (1, 2)
    return cast(object, parser.load(content))


def load_workflow(path: Path) -> Mapping[str, object]:
    """Parse one workflow semantically and reject malformed boundaries."""
    try:
        loaded = yaml_12_load(path.read_text(encoding="utf-8"))
    except YAMLError as error:
        raise AssertionError(f"malformed workflow: {path.name}") from error
    assert isinstance(loaded, dict), "workflow must be a mapping"
    workflow = cast(Mapping[str, object], loaded)
    assert isinstance(workflow.get("name"), str), "workflow name must be a string"
    mapping_field(workflow, "permissions")
    workflow_jobs(workflow)
    return workflow


def workflow_inventory() -> Mapping[str, Mapping[str, object]]:
    """Load the complete checked-in workflow inventory."""
    return {path.name: load_workflow(path) for path in workflow_paths()}


def job_body(workflow: Mapping[str, object], name: str) -> Mapping[str, object]:
    """Require one named job mapping."""
    job = workflow_jobs(workflow).get(name)
    assert isinstance(job, dict), f"{name} must be a job mapping"
    return cast(Mapping[str, object], job)


def step_bodies(job: Mapping[str, object]) -> tuple[Mapping[str, object], ...]:
    """Require a job's steps to be a list of mappings."""
    steps = job.get("steps")
    assert isinstance(steps, list), "steps must be a list"
    assert all(isinstance(step, dict) for step in steps), "steps must contain mappings"
    return tuple(cast(Mapping[str, object], step) for step in steps)


def action_step(job: Mapping[str, object], action: str) -> Mapping[str, object]:
    """Require exactly one use of an immutable action reference."""
    matches = tuple(step for step in step_bodies(job) if step.get("uses") == action)
    assert len(matches) == 1, f"expected one {action} step"
    return matches[0]


def assert_ci_steps(job: Mapping[str, object]) -> None:
    """Require exact local caller-snapshot CI without privilege."""
    steps = step_bodies(job)
    assert tuple(step.get("uses") for step in steps) == DELIVERY_ACTIONS
    checkout = action_step(job, CHECKOUT_ACTION)
    dagger_step = action_step(job, DAGGER_ACTION)
    assert mapping_field(checkout, "with") == CI_CHECKOUT_INPUTS
    assert mapping_field(dagger_step, "with") == CI_DAGGER_INPUTS
    assert job.get("environment") is None and job.get("env") is None
    assert job.get("permissions") is None
    assert all(step.get("env") is None and "run" not in step for step in steps)


def assert_authorizer_workflow(workflow: Mapping[str, object]) -> None:
    """Require the sole protected Dagger authorizer boundary."""
    assert workflow.get("name") == "Dagger"
    assert mapping_field(workflow, "on") == AUTHORIZER_TRIGGERS
    assert mapping_field(workflow, "permissions") == READ_ONLY_PERMISSIONS
    assert frozenset(workflow_jobs(workflow)) == frozenset({"checks"})
    checks = job_body(workflow, "checks")
    assert checks.get("name") == "Dagger"
    assert_ci_steps(checks)


def assert_security_workflow(workflow: Mapping[str, object]) -> None:
    """Require isolated weekly/manual caller-snapshot diagnostics."""
    assert workflow.get("name") == "Security audit"
    assert mapping_field(workflow, "on") == SECURITY_AUDIT_TRIGGERS
    assert mapping_field(workflow, "permissions") == READ_ONLY_PERMISSIONS
    assert frozenset(workflow_jobs(workflow)) == frozenset({"security"})
    security = job_body(workflow, "security")
    assert security.get("name") == "Dagger security", "diagnostic job must not be named Dagger"
    assert mapping_field(security, "concurrency") == SECURITY_CONCURRENCY
    assert_ci_steps(security)


def expected_delivery_arguments(filename: str, function_name: str) -> list[str]:
    """Build the exact typed Dagger delivery invocation."""
    source = DELIVERY_SOURCES[filename]
    call = (
        f"{function_name} --signing-key=env://WATCHLIST_SIGNING_KEY "
        "--cloudflare-api-token=env://CLOUDFLARE_API_TOKEN "
        "--cloudflare-account-id=env://CLOUDFLARE_ACCOUNT_ID "
        "--github-token=env://GITHUB_TOKEN "
        f"{RELEASE_ID_ARGUMENT}"
    )
    assert source == RELEASE_SHA_SOURCE
    return call.split()


def expected_delivery_inputs(filename: str, function_name: str) -> Mapping[str, object]:
    """Build the complete allowed Dagger action input mapping."""
    return {
        "version": "0.21.8",
        "call": " ".join(expected_delivery_arguments(filename, function_name)),
    }


def assert_delivery_steps(filename: str, job: Mapping[str, object], function_name: str) -> None:
    """Require credentialless checkout followed by typed Dagger delivery."""
    steps = step_bodies(job)
    assert tuple(step.get("uses") for step in steps) == DELIVERY_ACTIONS
    checkout = action_step(job, CHECKOUT_ACTION)
    dagger_step = action_step(job, DAGGER_ACTION)
    assert mapping_field(checkout, "with") == DELIVERY_CHECKOUT_INPUTS[filename]
    assert checkout.get("env") is None, "checkout env is forbidden"
    assert dagger_step.get("env") == DELIVERY_ENVIRONMENT, "delivery env must be exact"
    assert mapping_field(dagger_step, "with") == expected_delivery_inputs(filename, function_name)
    assert all("run" not in step for step in steps)


def assert_queue_job(filename: str, job: Mapping[str, object]) -> None:
    """Require the credential-free turnstile: read-only token, no secret, no environment."""
    assert job.get("environment") is None, "environment is forbidden in the queue job"
    assert job.get("concurrency") is None, "the queue job must wait outside the mutex"
    assert "secrets." not in json.dumps(job).lower(), "secret inputs are forbidden in the queue"
    assert job.get("name") == QUEUE_JOB_NAME
    assert job.get("timeout-minutes") == QUEUE_TIMEOUT_MINUTES
    assert tuple(step.get("uses") for step in step_bodies(job)) == DELIVERY_ACTIONS
    checkout = action_step(job, CHECKOUT_ACTION)
    assert mapping_field(checkout, "with") == DELIVERY_CHECKOUT_INPUTS[filename]
    assert checkout.get("env") is None, "checkout env is forbidden"
    dagger_step = action_step(job, DAGGER_ACTION)
    assert dagger_step.get("env") == QUEUE_ENVIRONMENT, "queue env must be exact"
    assert mapping_field(dagger_step, "with") == QUEUE_INPUTS, "queue call must be exact"


def production_jobs(
    workflows: Mapping[str, Mapping[str, object]],
) -> frozenset[tuple[str, str]]:
    """Collect every job that can enter a GitHub environment."""
    return frozenset(
        (filename, name)
        for filename, workflow in workflows.items()
        for name, job in workflow_jobs(workflow).items()
        if isinstance(job, dict) and job.get("environment") is not None
    )


def workflows_with_job(
    workflows: Mapping[str, Mapping[str, object]],
    filename: str,
    job_name: str,
    job: Mapping[str, object],
) -> Mapping[str, Mapping[str, object]]:
    """Copy a workflow inventory and replace one job for adversarial tests."""
    copied = deepcopy({name: dict(workflow) for name, workflow in workflows.items()})
    jobs = cast(dict[str, object], copied[filename]["jobs"])
    jobs[job_name] = dict(job)
    return copied


def direct_provider_step() -> Mapping[str, object]:
    """Build one forbidden direct-transport step for adversarial contracts."""
    return {
        "run": "npx wrangler pages deploy",
        "env": {"CLOUDFLARE_API_TOKEN": "${{ secrets.CLOUDFLARE_API_TOKEN }}"},
    }


def assert_nonmutation_job(
    job: Mapping[str, object], steps: tuple[Mapping[str, object], ...]
) -> None:
    """Reject environment, secret, and provider inputs outside delivery jobs."""
    assert job.get("environment") is None, "environment is forbidden outside mutation jobs"
    assert all(step.get("env") is None for step in steps), (
        "secret inputs are forbidden outside mutation jobs"
    )
    serialized = json.dumps(job).lower()
    assert "secrets." not in serialized, "secret inputs are forbidden outside mutation jobs"
    assert all(marker not in serialized for marker in PROVIDER_MARKERS), (
        "provider inputs are forbidden outside approved mutation jobs"
    )


def assert_safe_job(filename: str, name: str, job: Mapping[str, object]) -> None:
    """Reject job-local privilege and every direct transport path."""
    assert job.get("permissions") is None, "job permissions are forbidden"
    assert job.get("env") is None, "job env is forbidden"
    steps = step_bodies(job)
    assert all("run" not in step for step in steps), "shell steps are forbidden"
    assert all(step.get("uses") in DELIVERY_ACTIONS for step in steps), "action is not approved"
    if name == QUEUE_JOB and filename in DELIVERY_WORKFLOWS:
        assert_queue_job(filename, job)
        return
    function_name = MUTATION_FUNCTIONS.get((filename, name))
    if function_name is not None:
        assert_delivery_steps(filename, job, function_name)
        return
    assert_nonmutation_job(job, steps)


def assert_workflow_policy(workflows: Mapping[str, Mapping[str, object]]) -> None:
    """Enforce the complete fail-closed GitHub Actions boundary."""
    assert frozenset(workflows) == frozenset(EXPECTED_WORKFLOW_JOBS), (
        "exact workflow inventory is required"
    )
    for filename, workflow in workflows.items():
        assert workflow.get("env") is None, "workflow env is forbidden"
        assert workflow.get("name") == EXPECTED_WORKFLOW_NAMES[filename]
        jobs = workflow_jobs(workflow)
        assert frozenset(jobs) == EXPECTED_WORKFLOW_JOBS[filename], (
            "exact job inventory is required"
        )
        assert mapping_field(workflow, "permissions") == EXPECTED_WORKFLOW_PERMISSIONS[filename]
        for name, job in jobs.items():
            assert isinstance(job, dict)
            assert_safe_job(filename, name, cast(Mapping[str, object], job))


def test_should_keep_authorizing_workflow_provider_free() -> None:
    # Given / When
    workflow = workflow_inventory()["dagger.yml"]
    serialized = json.dumps(workflow).lower()

    # Then
    assert frozenset(workflow_jobs(workflow)) == frozenset({"checks"})
    assert production_jobs({"dagger.yml": workflow}) == frozenset()
    assert "secrets." not in serialized
    assert all(marker not in serialized for marker in PROVIDER_MARKERS)


def test_should_bind_hosted_ci_to_exact_caller_snapshot_without_tokens() -> None:
    # Given
    workflow = workflow_inventory()["dagger.yml"]
    checks = job_body(workflow, "checks")

    # When / Then
    assert_authorizer_workflow(workflow)
    assert_ci_steps(checks)
    assert "github.token" not in json.dumps(workflow).lower()


def test_should_isolate_weekly_manual_security_diagnostics() -> None:
    # Given
    path = WORKFLOW_DIRECTORY / "security-audit.yml"
    assert path.exists(), "security diagnostics must use a separate workflow"

    # When / Then
    assert_security_workflow(load_workflow(path))


@pytest.mark.parametrize(
    ("trigger", "value"),
    [("schedule", [{"cron": "0 9 * * 1"}]), ("workflow_dispatch", None)],
)
def test_should_reject_nonpush_trigger_when_added_to_authorizer(
    trigger: str, value: object
) -> None:
    # Given
    workflow = deepcopy(dict(workflow_inventory()["dagger.yml"]))
    cast(dict[str, object], workflow["on"])[trigger] = value

    # When / Then
    with pytest.raises(AssertionError):
        assert_authorizer_workflow(workflow)


def test_should_reject_dagger_name_when_assigned_to_security_diagnostic() -> None:
    # Given
    workflow = deepcopy(dict(workflow_inventory()["security-audit.yml"]))
    security = cast(dict[str, object], cast(dict[str, object], workflow["jobs"])["security"])
    security["name"] = "Dagger"

    # When / Then
    with pytest.raises(AssertionError, match="diagnostic job must not be named Dagger"):
        assert_security_workflow(workflow)


def test_should_trigger_deploy_only_after_completed_dagger_workflow() -> None:
    # Given / When
    trigger = mapping_field(load_workflow(WORKFLOW_DIRECTORY / "deploy.yml"), "on")
    workflow_run = mapping_field(trigger, "workflow_run")

    # Then
    assert frozenset(trigger) == frozenset({"workflow_run", "workflow_dispatch"})
    assert workflow_run.get("workflows") == ["Dagger"]
    assert workflow_run.get("types") == ["completed"]
    assert workflow_run.get("branches") == ["main"]
    assert "workflow_dispatch" in trigger


def test_should_require_exact_successful_main_push_for_automatic_deploy() -> None:
    # Given / When
    workflow = load_workflow(WORKFLOW_DIRECTORY / "deploy.yml")
    condition = " ".join(str(job_body(workflow, "deploy").get("if", "")).split())

    # Then
    assert condition == DEPLOY_AUTHORIZATION


def script_expression_findings(
    workflows: Mapping[str, Mapping[str, object]],
) -> list[str]:
    """Name every caller-shapeable expression in a Dagger input pasted into bash."""
    findings: list[str] = []
    for filename, workflow in workflows.items():
        for name, job in workflow_jobs(workflow).items():
            for step in step_bodies(cast(Mapping[str, object], job)):
                if not str(step.get("uses", "")).startswith("dagger/dagger-for-github@"):
                    continue
                inputs = cast(Mapping[str, object], step.get("with") or {})
                findings += [
                    f"{filename}:{name}:{key}"
                    for key in DAGGER_SCRIPT_INPUTS
                    if FORBIDDEN_SCRIPT_EXPRESSION.search(str(inputs.get(key, "")))
                ]
    return findings


def test_should_keep_event_expressions_out_of_dagger_script_inputs() -> None:
    # Given / When / Then
    assert script_expression_findings(workflow_inventory()) == []


@pytest.mark.parametrize(
    "expression",
    [
        "${{ github.event.workflow_run.head_sha }}",
        "${{ inputs.tag }}",
        "${{ github.head_ref }}",
        DEPLOY_SOURCE,
    ],
)
def test_should_reject_event_expression_when_pasted_into_dagger_call(expression: str) -> None:
    # Given
    workflows = workflow_inventory()
    job = dict(job_body(workflows["deploy.yml"], "deploy"))
    steps = [dict(step) for step in step_bodies(job)]
    steps[-1]["with"] = {"version": "0.21.8", "call": f"deploy --release-id={expression}"}
    job["steps"] = steps

    # When
    findings = script_expression_findings(
        workflows_with_job(workflows, "deploy.yml", "deploy", job)
    )

    # Then
    assert findings == ["deploy.yml:deploy:call"]


def test_should_bind_deploy_bytes_to_authorized_head_and_own_run() -> None:
    # Given
    workflow = load_workflow(WORKFLOW_DIRECTORY / "deploy.yml")
    job = job_body(workflow, "deploy")
    checkout = mapping_field(action_step(job, CHECKOUT_ACTION), "with")
    call = str(mapping_field(action_step(job, DAGGER_ACTION), "with").get("call", ""))

    # When / Then
    assert checkout == DELIVERY_CHECKOUT_INPUTS["deploy.yml"]
    assert RELEASE_ID_ARGUMENT in call
    assert mapping_field(action_step(job, DAGGER_ACTION), "env")["RELEASE_SHA"] == DEPLOY_SOURCE
    assert "github.event" not in call


def assert_after_dagger_trigger(trigger: Mapping[str, object]) -> None:
    """Require the completed-Dagger-on-main workflow_run shape."""
    workflow_run = mapping_field(trigger, "workflow_run")
    assert workflow_run.get("workflows") == ["Dagger"]
    assert workflow_run.get("types") == ["completed"]
    assert workflow_run.get("branches") == ["main"]


def assert_publish_authorization(workflow: Mapping[str, object]) -> None:
    """Require the exact guarded publish condition."""
    condition = " ".join(str(job_body(workflow, "publish").get("if", "")).split())
    assert condition == PUBLISH_AUTHORIZATION, "publish authorization must be exact"


def test_should_trigger_publish_nightly_manually_and_after_completed_dagger() -> None:
    # Given / When
    trigger = mapping_field(load_workflow(WORKFLOW_DIRECTORY / "publish-watchlist.yml"), "on")

    # Then
    assert frozenset(trigger) == PUBLISH_TRIGGERS
    assert trigger.get("schedule") == PUBLISH_SCHEDULE
    assert_after_dagger_trigger(trigger)


def test_should_require_exact_successful_main_push_for_automatic_publish() -> None:
    # Given / When
    workflow = load_workflow(WORKFLOW_DIRECTORY / "publish-watchlist.yml")

    # Then
    assert_publish_authorization(workflow)


@pytest.mark.parametrize(
    "guard",
    [
        "github.event.workflow_run.conclusion == 'success' && ",
        "github.event.workflow_run.event == 'push' && ",
        "github.event.workflow_run.head_branch == 'main' && ",
        " && github.ref == 'refs/heads/main'",
    ],
)
def test_should_reject_publish_when_a_run_guard_is_dropped(guard: str) -> None:
    # Given
    workflow = deepcopy(dict(workflow_inventory()["publish-watchlist.yml"]))
    publish = cast(dict[str, object], cast(dict[str, object], workflow["jobs"])["publish"])
    condition = " ".join(str(publish["if"]).split())
    assert guard in condition, "mutation must apply"
    publish["if"] = condition.replace(guard, "")

    # When / Then
    with pytest.raises(AssertionError, match="publish authorization must be exact"):
        assert_publish_authorization(workflow)


def test_should_bind_publish_bytes_to_authorized_head_and_own_run() -> None:
    # Given
    job = job_body(load_workflow(WORKFLOW_DIRECTORY / "publish-watchlist.yml"), "publish")
    checkout = mapping_field(action_step(job, CHECKOUT_ACTION), "with")
    call = str(mapping_field(action_step(job, DAGGER_ACTION), "with").get("call", ""))

    # When / Then
    assert checkout.get("ref") == DEPLOY_SOURCE
    assert RELEASE_ID_ARGUMENT in call
    assert mapping_field(action_step(job, DAGGER_ACTION), "env")["RELEASE_SHA"] == DEPLOY_SOURCE
    assert "github.event" not in call


@pytest.mark.parametrize("filename", ["deploy.yml", "publish-watchlist.yml"])
def test_should_justify_guarded_workflow_run_trigger_for_zizmor(filename: str) -> None:
    # Given / When
    lines = (WORKFLOW_DIRECTORY / filename).read_text(encoding="utf-8").splitlines()

    # Then
    assert DANGEROUS_TRIGGER_WAIVER in lines


def test_should_discover_both_workflow_extensions(tmp_path: Path) -> None:
    # Given
    tmp_path.joinpath("first.yml").write_text("one", encoding="utf-8")
    tmp_path.joinpath("second.yaml").write_text("two", encoding="utf-8")
    tmp_path.joinpath("ignored.txt").write_text("three", encoding="utf-8")

    # When
    names = tuple(path.name for path in workflow_paths(tmp_path))

    # Then
    assert names == ("first.yml", "second.yaml")


@pytest.mark.parametrize(
    "content",
    [
        "{",
        "[]",
        "name: Broken\npermissions: []\njobs: {}\n",
        "name: Broken\npermissions: {}\njobs: []\n",
        "name: Broken\npermissions: {}\njobs:\n  broken: scalar\n",
    ],
)
def test_should_fail_closed_when_workflow_structure_is_malformed(
    tmp_path: Path, content: str
) -> None:
    # Given
    path = tmp_path / "broken.yaml"
    path.write_text(content, encoding="utf-8")

    # When / Then
    with pytest.raises(AssertionError):
        load_workflow(path)


def test_should_reject_unapproved_job_with_direct_provider_path() -> None:
    # Given
    rogue = {
        "runs-on": "ubuntu-latest",
        "steps": [direct_provider_step()],
    }
    workflows = workflows_with_job(workflow_inventory(), "dagger.yml", "rogue", rogue)

    # When / Then
    with pytest.raises(AssertionError, match="exact job inventory"):
        assert_workflow_policy(workflows)


def test_should_reject_direct_provider_step_inside_known_check_job() -> None:
    # Given
    checks = deepcopy(dict(job_body(workflow_inventory()["dagger.yml"], "checks")))
    steps = cast(list[object], checks["steps"])
    steps.append(dict(direct_provider_step()))
    workflows = workflows_with_job(workflow_inventory(), "dagger.yml", "checks", checks)

    # When / Then
    with pytest.raises(AssertionError, match="shell steps are forbidden"):
        assert_workflow_policy(workflows)


def test_should_reject_check_when_job_permissions_override_read_only_policy() -> None:
    # Given
    checks = dict(job_body(workflow_inventory()["dagger.yml"], "checks"))
    checks["permissions"] = {"contents": "write"}
    workflows = workflows_with_job(workflow_inventory(), "dagger.yml", "checks", checks)

    # When / Then
    with pytest.raises(AssertionError, match="job permissions are forbidden"):
        assert_workflow_policy(workflows)


def test_should_reject_secret_environment_when_injected_into_check_step() -> None:
    # Given
    checks = deepcopy(dict(job_body(workflow_inventory()["dagger.yml"], "checks")))
    steps = cast(list[object], checks["steps"])
    dagger_step = cast(dict[str, object], steps[1])
    dagger_step["env"] = {"OTHER_TOKEN": "${{ secrets.OTHER_TOKEN }}"}
    workflows = workflows_with_job(workflow_inventory(), "dagger.yml", "checks", checks)

    # When / Then
    with pytest.raises(AssertionError, match="secret inputs are forbidden"):
        assert_workflow_policy(workflows)


def test_should_reject_workflow_secret_environment_before_check_inherits_it() -> None:
    # Given
    workflows = deepcopy(dict(workflow_inventory()))
    dagger_workflow = cast(dict[str, object], workflows["dagger.yml"])
    dagger_workflow["env"] = {"SHARED_TOKEN": "${{ secrets.SHARED_TOKEN }}"}

    # When / Then
    with pytest.raises(AssertionError, match="workflow env is forbidden"):
        assert_workflow_policy(workflows)


@pytest.mark.parametrize("filename", list(DELIVERY_WORKFLOWS))
def test_should_gate_every_production_write_behind_the_release_turnstile(filename: str) -> None:
    # Given / When
    workflow = workflow_inventory()[filename]
    delivery = job_body(workflow, DELIVERY_WORKFLOWS[filename])
    queue = job_body(workflow, QUEUE_JOB)

    # Then
    assert delivery.get("needs") == QUEUE_JOB
    assert mapping_field(delivery, "concurrency") == DELIVERY_CONCURRENCY
    assert " ".join(str(queue.get("if")).split()) == " ".join(str(delivery.get("if")).split())
    assert_queue_job(filename, queue)


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("environment", "production", "environment is forbidden in the queue job"),
        ("concurrency", DELIVERY_CONCURRENCY, "the queue job must wait outside the mutex"),
    ],
)
def test_should_reject_queue_job_when_it_gains_production_privilege(
    field: str, value: object, message: str
) -> None:
    # Given
    queue = dict(job_body(workflow_inventory()["deploy.yml"], QUEUE_JOB))
    queue[field] = value
    workflows = workflows_with_job(workflow_inventory(), "deploy.yml", QUEUE_JOB, queue)

    # When / Then
    with pytest.raises(AssertionError, match=message):
        assert_workflow_policy(workflows)


@pytest.mark.parametrize(
    ("key", "value", "message"),
    [
        ("env", {"GITHUB_TOKEN": "${{ secrets.CLOUDFLARE_API_TOKEN }}"}, "secret inputs"),
        ("env", {**QUEUE_ENVIRONMENT, "EXTRA": "x"}, "queue env must be exact"),
        ("with", {**QUEUE_INPUTS, "call": "deploy --release-id=x"}, "queue call must be exact"),
    ],
)
def test_should_reject_queue_step_when_it_carries_secret_or_provider_call(
    key: str, value: object, message: str
) -> None:
    # Given
    queue = deepcopy(dict(job_body(workflow_inventory()["publish-watchlist.yml"], QUEUE_JOB)))
    dagger_step = cast(dict[str, object], cast(list[object], queue["steps"])[1])
    dagger_step[key] = value
    workflows = workflows_with_job(workflow_inventory(), "publish-watchlist.yml", QUEUE_JOB, queue)

    # When / Then
    with pytest.raises(AssertionError, match=message):
        assert_workflow_policy(workflows)


def test_should_reject_secret_environment_when_injected_into_deploy_job() -> None:
    # Given
    deploy = dict(job_body(workflow_inventory()["deploy.yml"], "deploy"))
    deploy["env"] = {"SHARED_TOKEN": "${{ secrets.SHARED_TOKEN }}"}
    workflows = workflows_with_job(workflow_inventory(), "deploy.yml", "deploy", deploy)

    # When / Then
    with pytest.raises(AssertionError, match="job env is forbidden"):
        assert_workflow_policy(workflows)


def test_should_reject_secret_environment_when_injected_into_checkout_step() -> None:
    # Given
    deploy = deepcopy(dict(job_body(workflow_inventory()["deploy.yml"], "deploy")))
    steps = cast(list[object], deploy["steps"])
    checkout = cast(dict[str, object], steps[0])
    checkout["env"] = {"SHARED_TOKEN": "${{ secrets.SHARED_TOKEN }}"}
    workflows = workflows_with_job(workflow_inventory(), "deploy.yml", "deploy", deploy)

    # When / Then
    with pytest.raises(AssertionError, match="checkout env is forbidden"):
        assert_workflow_policy(workflows)


def test_should_parse_on_as_yaml_12_string_when_workflow_loads() -> None:
    # Given / When
    workflow = load_workflow(WORKFLOW_DIRECTORY / "dagger.yml")

    # Then
    assert "on" in workflow


def test_should_declare_bounded_yaml_parser_as_direct_test_dependency() -> None:
    # Given
    configuration = cast(
        object,
        tomllib.loads(ROOT.joinpath(".dagger/pyproject.toml").read_text(encoding="utf-8")),
    )
    assert isinstance(configuration, dict)

    # When
    dependency_groups = mapping_field(
        cast(Mapping[str, object], configuration), "dependency-groups"
    )
    development = dependency_groups.get("dev")

    # Then
    assert isinstance(development, list)
    assert YAML_DEPENDENCY in development


def test_should_scope_exact_production_jobs_to_environment() -> None:
    # Given / When
    workflows = workflow_inventory()

    # Then
    assert_workflow_policy(workflows)
    assert production_jobs(workflows) == frozenset(
        {("deploy.yml", "deploy"), ("publish-watchlist.yml", "publish")}
    )
    for filename, job_name in DELIVERY_WORKFLOWS.items():
        assert job_body(workflows[filename], job_name).get("environment") == "production"


def test_should_keep_dagger_check_unprivileged_and_uniquely_named() -> None:
    # Given
    workflows = workflow_inventory()
    dagger_workflow = workflows["dagger.yml"]
    checks = job_body(dagger_workflow, "checks")

    # When
    named_dagger = tuple(
        (filename, name)
        for filename, workflow in workflows.items()
        for name, job in workflow_jobs(workflow).items()
        if isinstance(job, dict) and job.get("name") == "Dagger"
    )

    # Then
    assert dagger_workflow.get("name") == "Dagger"
    assert named_dagger == (("dagger.yml", "checks"),)
    assert checks.get("environment") is None
    assert checks.get("env") is None
    assert checks.get("permissions") is None
    assert mapping_field(dagger_workflow, "permissions") == READ_ONLY_PERMISSIONS
    assert mapping_field(checks, "concurrency") == CHECKS_CONCURRENCY


def test_should_grant_only_read_permissions_to_mutation_workflows() -> None:
    # Given / When
    workflows = workflow_inventory()

    # Then
    for filename, job_name in DELIVERY_WORKFLOWS.items():
        workflow = workflows[filename]
        job = job_body(workflow, job_name)
        assert mapping_field(workflow, "permissions") == DELIVERY_PERMISSIONS
        assert job.get("permissions") is None


def test_should_serialize_all_delivery_through_one_concurrency_group() -> None:
    # Given / When
    workflows = workflow_inventory()

    # Then
    for filename, job_name in DELIVERY_WORKFLOWS.items():
        job = job_body(workflows[filename], job_name)
        assert mapping_field(job, "concurrency") == DELIVERY_CONCURRENCY
    assert job_body(workflows["publish-watchlist.yml"], "publish").get("name") == (
        "Publish signed watchlist"
    )


@pytest.mark.parametrize(
    ("filename", "job_name", "function_name"),
    [
        ("deploy.yml", "deploy", "deploy"),
        ("publish-watchlist.yml", "publish", "publish-watchlist"),
    ],
)
def test_should_pass_typed_secrets_to_only_dagger_delivery(
    filename: str, job_name: str, function_name: str
) -> None:
    # Given
    job = job_body(workflow_inventory()[filename], job_name)

    # When / Then
    assert_delivery_steps(filename, job, function_name)


def test_should_budget_delivery_time_for_the_post_deploy_live_smoke() -> None:
    # Given: build + deploy took up to 13 min; prime + fresh + returning add ~15.
    workflows = workflow_inventory()

    # When / Then
    for filename, job_name in DELIVERY_WORKFLOWS.items():
        assert job_body(workflows[filename], job_name).get("timeout-minutes") == (
            DELIVERY_TIMEOUT_MINUTES
        )


def test_should_probe_the_live_site_every_four_hours_outside_production() -> None:
    # Given
    workflow = workflow_inventory()["live-smoke.yml"]
    serialized = json.dumps(workflow)
    job = job_body(workflow, "smoke")

    # When / Then
    assert mapping_field(workflow, "on") == {
        "schedule": [{"cron": "40 */4 * * *"}],
        "workflow_dispatch": None,
    }
    assert mapping_field(workflow, "permissions") == READ_ONLY_PERMISSIONS
    assert job.get("environment") is None
    assert job.get("name") == "Live smoke (fresh visitor)"
    dagger_step = step_bodies(job)[-1]
    assert mapping_field(dagger_step, "with") == {"version": "0.21.8", "call": "live-smoke"}
    for forbidden in (*DELIVERY_ENVIRONMENT, "cloudflare-pages", "deploy-aml-filter-com"):
        assert forbidden not in serialized


def test_should_keep_freshness_read_only_and_outside_production() -> None:
    # Given
    workflow = workflow_inventory()["watchlist-freshness.yml"]
    serialized = json.dumps(workflow)

    # When / Then
    assert mapping_field(workflow, "permissions") == {"contents": "read"}
    for job in workflow_jobs(workflow).values():
        assert isinstance(job, dict)
        assert job.get("environment") is None
        assert job.get("env") is None
    for forbidden in (*DELIVERY_ENVIRONMENT, "cloudflare-pages", "publish-watchlist"):
        assert forbidden not in serialized


def dagger(*arguments: str) -> str:
    """Execute the real module schema from the repository root."""
    completed: subprocess.CompletedProcess[str] = subprocess.run(
        [DAGGER_BIN, *arguments], cwd=ROOT, check=True, capture_output=True, text=True
    )
    return completed.stdout


def dagger_result(*arguments: str) -> subprocess.CompletedProcess[str]:
    """Execute a contract that intentionally inspects a failure exit code."""
    return subprocess.run(
        [DAGGER_BIN, *arguments], cwd=ROOT, check=False, capture_output=True, text=True
    )


def run_real_dagger(directory: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    """Run an isolated real module without inheriting credential values."""
    environment = {**os.environ, "DAGGER_NO_NAG": "1"}
    return subprocess.run(
        [DAGGER_BIN, *arguments],
        cwd=directory,
        check=False,
        capture_output=True,
        env=environment,
        text=True,
    )


def require_dagger_success(result: subprocess.CompletedProcess[str]) -> None:
    """Retain the real Dagger diagnostics when bootstrap fails."""
    assert result.returncode == 0, result.stdout + result.stderr


def real_provider_module(tmp_path: Path) -> Path:
    """Build one isolated exact-pin consumer for the pre-transport proof."""
    module = tmp_path / "real-provider"
    require_dagger_success(
        run_real_dagger(tmp_path, "init", "--sdk", "python", "--name", "pretransport", str(module))
    )
    for name, dependency in REAL_PROVIDER_DEPENDENCIES:
        require_dagger_success(run_real_dagger(module, "install", dependency, "--name", name))
    source = module / "src" / "pretransport" / "main.py"
    source.write_text(textwrap.dedent(PRETRANSPORT_SOURCE), encoding="utf-8")
    require_dagger_success(run_real_dagger(module, "develop"))
    return module


def listed_names(output: str) -> frozenset[str]:
    """Read the first column of Dagger's stable tabular list output."""
    return frozenset(line.split()[0] for line in output.splitlines() if line.strip())


def test_should_expose_typed_pipeline_when_module_loads() -> None:
    # Given / When
    exposed = listed_names(dagger("functions"))

    # Then
    assert exposed >= FUNCTIONS


def test_should_register_security_and_quality_when_checks_load() -> None:
    # Given / When
    checks = listed_names(dagger("check", "--list"))

    # Then
    assert checks >= CHECKS


def test_should_require_typed_secrets_when_deploy_help_loads() -> None:
    # Given / When
    help_texts = (
        dagger("call", "deploy", "--help"),
        dagger("call", "publish-watchlist", "--help"),
    )

    # Then
    for help_text in help_texts:
        assert "--signing-key Secret" in help_text
        assert "--cloudflare-api-token Secret" in help_text
        assert "--cloudflare-account-id Secret" in help_text
        assert "--github-token Secret" in help_text
        assert "--release-id string" in help_text


def test_should_require_typed_token_when_release_turn_help_loads() -> None:
    # Given / When
    help_text = dagger("call", "release-turn", "--help")

    # Then
    assert "--github-token Secret" in help_text
    assert "--run-id string" in help_text
    assert "--signing-key" not in help_text
    assert "--cloudflare" not in help_text


def test_should_supply_exec_arguments_as_dagger_list() -> None:
    # Given / When / Then
    assert isinstance(FRESHNESS_CHECK, list)


def test_should_bind_the_only_production_pages_target() -> None:
    # Given / When
    try:
        targets = importlib.import_module("aml_filter.targets")
    except ModuleNotFoundError:
        pytest.fail("AML delivery target is missing", pytrace=False)

    # Then
    production = targets.AmlTarget.production()
    assert production == targets.AmlTarget(
        "hseshadr/aml-filter", "aml-filter", "main", "aml-filter.com"
    )


@pytest.mark.parametrize(
    "values",
    [
        ("other/aml-filter", "aml-filter", "main", "aml-filter.com"),
        ("hseshadr/aml-filter", "other", "main", "aml-filter.com"),
        ("hseshadr/aml-filter", "aml-filter", "release", "aml-filter.com"),
        ("hseshadr/aml-filter", "aml-filter", "main", "other.example"),
    ],
)
def test_should_reject_target_when_any_production_value_differs(
    values: tuple[str, str, str, str],
) -> None:
    # Given
    targets = importlib.import_module("aml_filter.targets")

    # When / Then
    with pytest.raises(ValueError, match="validated production values"):
        targets.AmlTarget(*values)


def test_should_parse_exact_green_main_evidence() -> None:
    # Given
    targets = importlib.import_module("aml_filter.targets")

    # When
    evidence = targets.parse_green_main(green_main_json())

    # Then
    assert evidence.commit_sha == RECORDED_SHA
    assert evidence.workflow_run_id == RECORDED_RUN_ID
    assert evidence.run_attempt == RECORDED_ATTEMPT


@pytest.mark.parametrize("serialization", ["{", "[]", "null", '"not-an-object"'])
def test_should_reject_green_main_when_serialization_is_malformed(serialization: str) -> None:
    # Given
    targets = importlib.import_module("aml_filter.targets")

    # When / Then
    with pytest.raises(ValueError, match="green-main evidence is malformed"):
        targets.parse_green_main(serialization)


@pytest.mark.parametrize(
    "serialization",
    [
        green_main_json(repository="other/repository"),
        green_main_json(branch="release"),
        green_main_json(commit_sha="A" * 40),
        green_main_json(commit_sha="a" * 39),
        green_main_json(workflow_run_id="0"),
        green_main_json(workflow_run_id="12x"),
        green_main_json(workflow_run_id=123456),
        green_main_json(run_attempt=0),
        green_main_json(run_attempt=-1),
        green_main_json(run_attempt=True),
        green_main_json(run_attempt="1"),
    ],
)
def test_should_reject_green_main_when_identity_or_attempt_is_not_exact(
    serialization: str,
) -> None:
    # Given
    targets = importlib.import_module("aml_filter.targets")

    # When / Then
    with pytest.raises(ValueError, match="green-main evidence is malformed"):
        targets.parse_green_main(serialization)


def test_should_bind_edgeproc_directory_when_release_base_is_built(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    events: list[str] = []
    source = cast(Directory, object())
    recorder = ReleaseContainerRecorder(events)

    def node(_subject: AmlFilter, actual: Directory) -> Container:
        assert actual is source
        events.append("node:bound-source")
        return cast(Container, recorder)

    monkeypatch.setattr(main_module, "dag", ReleaseDagRecorder(events))
    monkeypatch.setattr(AmlFilter, "_node", node)
    monkeypatch.setattr(AmlFilter, "_with_uv", lambda _subject, container: container)
    subject = object.__new__(AmlFilter)

    # When
    actual = subject._release_base(source)

    # Then
    assert actual is cast(Container, recorder)
    assert "directory:/edgeproc" in events
    assert "env:EDGEPROC_DIR=/edgeproc" in events


def test_should_bind_preview_service_to_exact_foundation_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    events: list[str] = []
    source = cast(Directory, object())
    app = cast(Directory, object())
    release = cast(Directory, object())
    recorder = ReleaseContainerRecorder(events)

    def verify(_subject: AmlFilter, *arguments: object) -> Container:
        assert arguments[0] is source
        return cast(Container, recorder)

    def exact_preview(
        _subject: AmlFilter, actual_source: Directory, actual_app: Directory
    ) -> object:
        assert (actual_source, actual_app) == (source, app)
        events.append("preview:bound-source")
        return object()

    def legacy_preview(_subject: AmlFilter, actual_app: Directory) -> object:
        del actual_app
        raise AssertionError("public workspace preview bypassed the bound source")

    monkeypatch.setattr(AmlFilter, "_verify_container", verify)
    monkeypatch.setattr(AmlFilter, "_preview", exact_preview, raising=False)
    monkeypatch.setattr(AmlFilter, "preview", legacy_preview)
    subject = object.__new__(AmlFilter)

    # When
    actual = subject._preview_verify(source, app, release, release_identity(RECORDED_SHA, "9999"))

    # Then
    assert actual is cast(Container, recorder)
    assert "preview:bound-source" in events


@pytest.mark.anyio
@pytest.mark.parametrize("kind", [ReleaseKind.CODE, ReleaseKind.WATCHLIST])
async def test_should_materialize_one_provider_deploy_before_live_verification(
    monkeypatch: pytest.MonkeyPatch, kind: ReleaseKind
) -> None:
    # Given
    context = recorded_delivery()
    subject = install_product_recorders(monkeypatch, context)
    request = PublishRequest(
        kind,
        context.signing_key,
        context.api_token,
        context.account_id,
        context.github_token,
        f"{RECORDED_SHA}:9999",
    )

    # When
    result = await subject._publish(request)

    # Then
    assert result.startswith(
        "provider deployment verified: id=deployment-123 url=https://deployment.example.pages.dev"
    )
    assert context.events.count("construct:deploy") == 1
    assert context.events.count("materialize:deploy") == 1
    assert context.events.index("materialize:deploy") < context.events.index("live")
    assert f"sign:{kind.value}" in context.events


@pytest.mark.anyio
async def test_should_bind_exact_source_and_identities_when_provider_deploys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    context = recorded_delivery()
    subject = install_product_recorders(monkeypatch, context)
    request = PublishRequest(
        ReleaseKind.CODE,
        context.signing_key,
        context.api_token,
        context.account_id,
        context.github_token,
        f"{RECORDED_SHA}:9999",
    )

    # When
    await subject._publish(request)

    # Then
    consumer = f"{REPOSITORY}@{RECORDED_SHA}"
    producing = f"{CENTRAL_SHA}:{RECORDED_RUN_ID}"
    assert context.events[:6] == [
        "construct:green-main",
        "materialize:green-main",
        f"git:{REPOSITORY_URL}",
        f"commit:{RECORDED_SHA}",
        "tree:0:tags=True",
        "foundation:source",
    ]
    assert context.envelope_values is not None
    assert context.envelope_values[1:] == (consumer, producing, ("dist",))
    assert context.provider_call == ProviderCall(
        (
            context.envelope,
            context.github_token,
            context.api_token,
            context.account_id,
            RECORDED_RUN_ID,
            RECORDED_ATTEMPT,
            REPOSITORY,
            "aml-filter",
            "main",
            "aml-filter.com",
            "dist",
            [],
            consumer,
            producing,
            ["dist"],
        )
    )
    assert f"stamp:{RECORDED_SHA}:9999" in context.events


@pytest.mark.anyio
async def test_should_reject_release_when_product_sha_differs_from_green_main(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    context = recorded_delivery()
    subject = install_product_recorders(monkeypatch, context)
    request = PublishRequest(
        ReleaseKind.CODE,
        context.signing_key,
        context.api_token,
        context.account_id,
        context.github_token,
        f"{'a' * 40}:9999",
    )

    # When / Then
    with pytest.raises(ValueError, match="green-main SHA"):
        await subject._publish(request)
    assert "construct:deploy" not in context.events
    assert "live" not in context.events


@pytest.mark.anyio
async def test_should_stop_before_provider_when_envelope_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    context = recorded_delivery()
    context.fail_envelope = True
    subject = install_product_recorders(monkeypatch, context)
    request = PublishRequest(
        ReleaseKind.CODE,
        context.signing_key,
        context.api_token,
        context.account_id,
        context.github_token,
        f"{RECORDED_SHA}:9999",
    )

    # When / Then
    with pytest.raises(RuntimeError, match="envelope failed"):
        await subject._publish(request)
    assert "construct:deploy" not in context.events
    assert "live" not in context.events


@pytest.mark.anyio
async def test_should_stop_before_live_when_provider_materialization_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    context = recorded_delivery()
    context.fail_materialization = True
    subject = install_product_recorders(monkeypatch, context)
    request = PublishRequest(
        ReleaseKind.WATCHLIST,
        context.signing_key,
        context.api_token,
        context.account_id,
        context.github_token,
        f"{RECORDED_SHA}:9999",
    )

    # When / Then
    with pytest.raises(RuntimeError, match="provider materialization failed"):
        await subject._publish(request)
    assert context.events.count("construct:deploy") == 1
    assert context.events.count("materialize:deploy") == 1
    assert "live" not in context.events


def recorded_request(context: RecordedDelivery, kind: ReleaseKind) -> PublishRequest:
    """Build one exact publication request over the recorded secrets."""
    return PublishRequest(
        kind,
        context.signing_key,
        context.api_token,
        context.account_id,
        context.github_token,
        f"{RECORDED_SHA}:9999",
    )


@pytest.mark.anyio
@pytest.mark.parametrize("kind", [ReleaseKind.CODE, ReleaseKind.WATCHLIST])
async def test_should_prime_before_provider_and_smoke_after_live_verification(
    monkeypatch: pytest.MonkeyPatch, kind: ReleaseKind
) -> None:
    # Given
    context = recorded_delivery()
    subject = install_product_recorders(monkeypatch, context)

    # When
    result = await subject._publish(recorded_request(context, kind))

    # Then
    events = context.events
    assert events.index("prime") < events.index("construct:deploy")
    assert events.index("live") < events.index(f"smoke:{RECORDED_SHA}")
    assert "returning-visitor profile primed on the previous release" in result
    assert "live smoke PASSED on deployment deployment-123" in result
    assert "[live-smoke fresh] UK_OFSI: Igor Ivanovich Sechin" in result


@pytest.mark.anyio
async def test_should_record_the_rollback_target_before_upload_and_never_roll_back_green(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    context = recorded_delivery()
    subject = install_product_recorders(monkeypatch, context)

    # When
    await subject._publish(recorded_request(context, ReleaseKind.CODE))

    # Then
    events = context.events
    assert events.index("materialize:previous-production") < events.index("construct:deploy")
    assert not any(event.startswith("construct:rollback") for event in events)
    assert not any(event.startswith("recovery-smoke") for event in events)


@pytest.mark.anyio
async def test_should_refuse_to_upload_when_the_rollback_target_cannot_be_recorded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    context = recorded_delivery()
    context.fail_target = True
    subject = install_product_recorders(monkeypatch, context)

    # When / Then
    with pytest.raises(RuntimeError, match="previous production unreadable"):
        await subject._publish(recorded_request(context, ReleaseKind.CODE))
    assert "construct:deploy" not in context.events


@pytest.mark.anyio
@pytest.mark.parametrize("kind", [ReleaseKind.CODE, ReleaseKind.WATCHLIST])
async def test_should_roll_back_to_the_recorded_target_and_recheck_live_on_smoke_failure(
    monkeypatch: pytest.MonkeyPatch, kind: ReleaseKind
) -> None:
    # Given
    context = recorded_delivery()
    context.smoke_exit = 1
    subject = install_product_recorders(monkeypatch, context)

    # When / Then: production recovers, the job still fails.
    with pytest.raises(LiveSmokeFailedError) as raised:
        await subject._publish(recorded_request(context, kind))
    events = context.events
    assert events.index(f"smoke:{RECORDED_SHA}") < events.index(
        "construct:rollback:deployment-good"
    )
    assert events.index("materialize:rollback") < events.index(f"recovery-smoke:{RECORDED_SHA}")
    message = str(raised.value)
    assert "rolled production back from deployment-123 to deployment-good" in message
    assert "recovery smoke PASSED" in message


@pytest.mark.anyio
async def test_should_roll_back_once_when_live_identity_verification_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given: the live site serves the wrong commit or bundle after upload.
    context = recorded_delivery()
    context.fail_live = True
    subject = install_product_recorders(monkeypatch, context)

    # When / Then
    with pytest.raises(LiveSmokeFailedError) as raised:
        await subject._publish(recorded_request(context, ReleaseKind.WATCHLIST))
    events = context.events
    assert events.count("construct:rollback:deployment-good") == 1
    assert events.index("materialize:rollback") < events.index(f"recovery-smoke:{RECORDED_SHA}")
    assert f"smoke:{RECORDED_SHA}" not in events
    message = str(raised.value)
    assert "live identity verification FAILED" in message
    assert "build.json git_sha 0000000 != expected release SHA" in message
    assert "rolled production back from deployment-123 to deployment-good" in message


@pytest.mark.anyio
async def test_should_roll_back_exactly_once_when_smoke_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    context = recorded_delivery()
    context.smoke_exit = 1
    context.recovery_exit = 1
    subject = install_product_recorders(monkeypatch, context)

    # When / Then
    with pytest.raises(LiveSmokeFailedError):
        await subject._publish(recorded_request(context, ReleaseKind.CODE))
    rollbacks = [e for e in context.events if e.startswith("construct:rollback")]
    assert rollbacks == ["construct:rollback:deployment-good"]


@pytest.mark.anyio
async def test_should_fail_loudly_when_production_is_still_broken_after_rollback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    context = recorded_delivery()
    context.smoke_exit = 1
    context.recovery_exit = 1
    subject = install_product_recorders(monkeypatch, context)

    # When / Then
    with pytest.raises(LiveSmokeFailedError, match="STILL BROKEN after rollback"):
        await subject._publish(recorded_request(context, ReleaseKind.CODE))


@pytest.mark.anyio
async def test_should_demand_manual_rollback_when_automatic_rollback_refuses(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    context = recorded_delivery()
    context.smoke_exit = 1
    context.fail_rollback = True
    subject = install_product_recorders(monkeypatch, context)

    # When / Then
    with pytest.raises(LiveSmokeFailedError, match="automatic rollback FAILED") as raised:
        await subject._publish(recorded_request(context, ReleaseKind.CODE))
    assert "deployment-123" in str(raised.value)
    assert not any(event.startswith("recovery-smoke") for event in context.events)


def test_should_compose_the_recovery_smoke_as_a_fresh_pass_on_the_live_domain(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    subject, events = smoke_recorder(monkeypatch)

    # When
    subject._recovery_container(subject.source, release_identity(RECORDED_SHA, "9999"))

    # Then: the restored release has an older SHA, so no identity pin.
    assert "env:LIVE_SMOKE_URL=https://aml-filter.com" in events
    assert "env:SMOKE_PASSES=@fresh" in events
    assert "env:SMOKE_NONCE=9999:recovery" in events
    assert not any("LIVE_SMOKE_EXPECT_SHA" in event for event in events)
    assert events[-1].startswith("exec-any:bash -ceu")


@pytest.mark.anyio
@pytest.mark.parametrize("kind", [ReleaseKind.CODE, ReleaseKind.WATCHLIST])
async def test_should_fail_loudly_naming_the_deployment_when_live_smoke_fails(
    monkeypatch: pytest.MonkeyPatch, kind: ReleaseKind
) -> None:
    # Given
    context = recorded_delivery()
    context.smoke_exit = 1
    subject = install_product_recorders(monkeypatch, context)

    # When / Then
    with pytest.raises(LiveSmokeFailedError) as raised:
        await subject._publish(recorded_request(context, kind))
    message = str(raised.value)
    assert "deployment-123 (https://deployment.example.pages.dev)" in message
    assert "rolled production back" in message
    assert "Error: signature failed" in message
    assert "live" in context.events


@pytest.mark.anyio
async def test_should_still_deliver_when_the_previous_release_cannot_be_primed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given: what is live before this deploy is itself broken; this may be the fix.
    context = recorded_delivery()
    context.prime_exit = 1
    subject = install_product_recorders(monkeypatch, context)

    # When
    result = await subject._publish(recorded_request(context, ReleaseKind.CODE))

    # Then
    assert "construct:deploy" in context.events
    assert "WARNING: returning-visitor profile NOT primed (exit 1)" in result
    assert "Error: prime refused" in result


def smoke_recorder(monkeypatch: pytest.MonkeyPatch) -> tuple[AmlFilter, list[str]]:
    """Record live-smoke container composition without materializing it."""
    events: list[str] = []

    def node(_subject: AmlFilter, source: Directory) -> Container:
        del source
        return cast(Container, ReleaseContainerRecorder(events))

    monkeypatch.setattr(AmlFilter, "_node", node)
    monkeypatch.setattr(main_module, "dag", ReleaseDagRecorder(events))
    subject = object.__new__(AmlFilter)
    subject.source = cast(Directory, object())
    return subject, events


def test_should_compose_post_deploy_smoke_with_profile_identity_and_both_passes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    subject, events = smoke_recorder(monkeypatch)
    identity = release_identity(RECORDED_SHA, "9999")

    # When
    subject._post_deploy_container(subject.source, cast(Directory, object()), identity)

    # Then
    for expected in (
        "env:LIVE_SMOKE_URL=https://aml-filter.com",
        "env:CARRY_DAYS=7",
        f"env:SMOKE_LISTS={SMOKE_LISTS}",
        "env:SMOKE_PASSES=@fresh|@returning",
        f"env:LIVE_SMOKE_EXPECT_SHA={RECORDED_SHA}",
        "env:SMOKE_NONCE=9999:post",
        "directory:/smoke-profile",
        "cache:/root/.cache/ms-playwright",
    ):
        assert expected in events
    assert events[-1].startswith("exec-any:bash -ceu")


def test_should_prime_without_failing_the_release_on_a_broken_previous_release(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    subject, events = smoke_recorder(monkeypatch)

    # When
    subject._prime_container(subject.source, release_identity(RECORDED_SHA, "9999"))

    # Then
    assert "env:SMOKE_NONCE=9999:prime" in events
    assert "env:SMOKE_PASSES=@prime" in events
    assert events[-1].startswith("exec-any:bash -ceu")


def test_should_run_only_a_failing_fresh_pass_on_the_scheduled_probe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    subject, events = smoke_recorder(monkeypatch)

    # When
    subject.live_smoke()

    # Then
    assert "env:SMOKE_PASSES=@fresh" in events
    assert any(event.startswith("env:SMOKE_NONCE=scheduled:") for event in events)
    assert not any("LIVE_SMOKE_EXPECT_SHA" in event for event in events)
    assert "directory:/smoke-profile" not in events
    assert events[-1].startswith("exec:bash -ceu")


def test_should_wire_the_catalog_and_browser_checks_into_one_smoke_script() -> None:
    # Given / When
    script = main_module.SMOKE_SCRIPT

    # Then: the catalog check runs first, with the carry ceiling and list set.
    assert script.index("check-published-freshness") < script.index("playwright test")
    assert '--carry-ceiling-days "$CARRY_DAYS"' in script
    assert '--expect-lists "$SMOKE_LISTS"' in script
    assert '-c playwright.live.config.ts --grep "$SMOKE_PASSES"' in script


def test_should_keep_provider_mutation_inside_shared_module() -> None:
    # Given / When
    source = inspect.getsource(main_module)

    # Then
    for forbidden in (
        "WRANGLER_DEPLOY",
        "def _upload",
        ".verify_envelope(",
        ".preflight(",
        "wrangler pages deploy",
    ):
        assert forbidden not in source


@pytest.mark.skipif(
    os.environ.get("DAGGER_REAL_PROVIDER_PRETRANSPORT") != "1",
    reason="set DAGGER_REAL_PROVIDER_PRETRANSPORT=1 for the no-secret provider proof",
)
def test_should_reject_real_provider_before_transport_when_envelope_is_tampered(
    tmp_path: Path,
) -> None:
    # Given
    module = real_provider_module(tmp_path)
    config = json.loads(module.joinpath("dagger.json").read_text(encoding="utf-8"))

    # When
    result = run_real_dagger(module, "call", "tampered-deploy")
    output = result.stdout + result.stderr

    # Then
    dependencies = {item["name"]: item["pin"] for item in config["dependencies"]}
    assert dependencies == {"foundation": CENTRAL_SHA, "cloudflare-pages": CENTRAL_SHA}
    assert result.returncode != 0
    assert "Foundation.verifyEnvelope" in output
    assert "artifact bytes or modes differ from manifest" in output
    assert "Foundation.greenMain" not in output
    assert "api.github.com" not in output
    assert "api.cloudflare.com" not in output


def test_should_pin_both_shared_modules_to_exact_central_main() -> None:
    config = json.loads(ROOT.joinpath("dagger.json").read_text())
    dependencies = {item["name"]: item for item in config["dependencies"]}
    for name, module in (
        ("foundation", "portfolio-foundation"),
        ("cloudflare-pages", "cloudflare-pages"),
    ):
        assert (
            dependencies[name]["source"] == f"github.com/hseshadr/ci/modules/{module}@{CENTRAL_SHA}"
        )
        assert dependencies[name]["pin"] == CENTRAL_SHA


def test_should_materialize_exact_foundation_guard_when_secret_scan_runs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    context = recorded_secret_scan(monkeypatch)

    # When
    actual = context.subject.secret_scan(RECORDED_SHA)

    # Then
    assert actual is context.result and context.caller_source is not context.canonical_source
    assert context.recorder.events == ["foundation"]
    assert context.recorder.shared.call == GuardCall(
        context.caller_source, REPOSITORY, RECORDED_SHA
    )


@pytest.mark.anyio
async def test_should_orchestrate_ci_through_public_snapshot_scan(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    context = recorded_ci(monkeypatch)
    assert context.caller_source is not context.canonical_source

    # When
    await cast(Awaitable[str], context.subject.ci(RECORDED_SHA))

    # Then
    assert context.events == ["quality", "audit", "secret-scan"]
    assert context.recorder.events == []
    assert context.recorder.shared.call is None


@pytest.mark.anyio
@pytest.mark.parametrize("failure", ["quality", "audit", "secret-scan"])
async def test_should_propagate_ci_failure_from_every_stage(
    monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    # Given
    context = recorded_ci(monkeypatch, failure)

    # When / Then
    with pytest.raises(RuntimeError, match=f"{failure} failed"):
        await cast(Awaitable[str], context.subject.ci(RECORDED_SHA))
    assert failure in context.events


def test_should_reject_removed_history_override_at_exact_schema_boundary(tmp_path: Path) -> None:
    # Given / When
    result = dagger_result("call", f"--history={tmp_path}", "secret-scan")

    # Then
    assert result.returncode == 1
    assert "unknown flag: --history" in result.stderr


def test_should_reject_malformed_sha_at_real_foundation_boundary() -> None:
    # Given / When
    result = dagger_result(*MALFORMED_GUARD_CALL)

    # Then
    assert result.returncode == 1
    assert "SHA must be a lowercase 40-character hexadecimal value" in result.stderr
