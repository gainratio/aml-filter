"""Production runs only for this repository: gainratio/aml-filter (hseshadr until plan step 8).

The identity comes from the run itself (``$GITHUB_REPOSITORY``) and is checked by exact
membership in a two-item allow-list. There is no default: a caller that drops the identity
fails loudly instead of gating as a stale owner. A fork, another owner, or a look-alike name
is refused before any GitHub or Foundation call is made.
"""

from __future__ import annotations

import inspect
import json
from collections.abc import Awaitable
from typing import Final, cast

import pytest
from dagger import Secret

import aml_filter.alert as alert_module
import aml_filter.main as main_module
import aml_filter.targets as targets_module
from aml_filter.alert import (
    AlertReport,
    Outcome,
    alert_report,
    failing_workflows,
    raise_or_clear_alert,
    render_body,
)
from aml_filter.main import AmlFilter, PublishRequest
from aml_filter.policy import ReleaseKind
from aml_filter.queue import TurnPolicy
from aml_filter.targets import (
    ALLOWED_REPOSITORIES,
    AmlTarget,
    UnknownRepositoryError,
    parse_green_main,
    validated_repository,
)

HSESHADR: Final = "hseshadr/aml-filter"
GAINRATIO: Final = "gainratio/aml-filter"
ACCEPTED: Final = (HSESHADR, GAINRATIO)
REFUSED: Final = (
    "attacker/aml-filter",
    "gainratio/edge-reco",
    "hseshadr/aml-filter-evil",
    "gainratio-evil/aml-filter",
    "",
)
SHA: Final = "0123456789abcdef0123456789abcdef01234567"
PUBLISH: Final = "Publish watchlist"
DEPLOY: Final = "Deploy aml-filter.com"


class FakeSecret:
    async def plaintext(self) -> str:
        return "sekrit-token"


def evidence_json(repository: str) -> str:
    return json.dumps(
        {
            "branch": "main",
            "commit_sha": SHA,
            "repository": repository,
            "run_attempt": 1,
            "workflow_run_id": "42",
        }
    )


class FakeGitHub:
    """Answer every GitHub call successfully and record the method and path."""

    def __init__(self, issues: list[dict[str, object]] | None = None) -> None:
        self.issues = issues or []
        self.requests: list[tuple[str, str]] = []

    def __call__(self, method: str, path: str, payload: object) -> tuple[int, str]:
        self.requests.append((method, path))
        if method == "GET":
            return 200, json.dumps(self.issues)
        return (201 if method == "POST" else 200), json.dumps({"number": 11})


# --- the allow-list itself ---------------------------------------------------------------


def test_should_pin_the_exact_two_owner_allow_list() -> None:
    assert ALLOWED_REPOSITORIES == (HSESHADR, GAINRATIO)


def test_should_expose_no_default_repository_identity() -> None:
    for module in (targets_module, alert_module, main_module):
        assert not hasattr(module, "DEFAULT_REPOSITORY"), module.__name__


REPOSITORY_TAKERS: Final[tuple[object, ...]] = (
    AmlTarget.production,
    parse_green_main,
    alert_report,
    AlertReport,
    PublishRequest,
    main_module.grant_release_turn,
    main_module.release_event,
    AmlFilter.ci,
    AmlFilter.secret_scan,
    AmlFilter.deploy,
    AmlFilter.release_turn,
    AmlFilter.publish_watchlist,
    AmlFilter.production_alert,
)


@pytest.mark.parametrize(
    "subject", REPOSITORY_TAKERS, ids=lambda item: str(getattr(item, "__qualname__", item))
)
def test_should_require_the_runs_repository_on_every_gate(subject: object) -> None:
    assert callable(subject)
    parameter = inspect.signature(subject).parameters["repository"]
    assert parameter.default is inspect.Parameter.empty


@pytest.mark.parametrize("repository", ACCEPTED)
def test_should_accept_this_repository_under_either_owner(repository: str) -> None:
    assert validated_repository(repository) == repository


@pytest.mark.parametrize("repository", REFUSED)
def test_should_refuse_any_other_repository_identity(repository: str) -> None:
    with pytest.raises(UnknownRepositoryError, match="not an allowed aml-filter repository"):
        validated_repository(repository)


# --- delivery target and Foundation evidence --------------------------------------------


@pytest.mark.parametrize("repository", ACCEPTED)
def test_should_build_production_target_for_either_owner(repository: str) -> None:
    target = AmlTarget.production(repository)
    assert target == AmlTarget(repository, "aml-filter", "main", "aml-filter.com")


def test_should_refuse_a_production_target_without_the_runs_repository() -> None:
    with pytest.raises(TypeError):
        AmlTarget.production()  # type: ignore[call-arg]


@pytest.mark.parametrize("repository", REFUSED)
def test_should_refuse_production_target_for_other_repositories(repository: str) -> None:
    with pytest.raises(ValueError, match="validated production values"):
        AmlTarget(repository, "aml-filter", "main", "aml-filter.com")


@pytest.mark.parametrize("repository", ACCEPTED)
def test_should_accept_green_main_evidence_for_the_runs_repository(repository: str) -> None:
    assert parse_green_main(evidence_json(repository), repository).commit_sha == SHA


@pytest.mark.parametrize(("evidence", "expected"), [(HSESHADR, GAINRATIO), (GAINRATIO, HSESHADR)])
def test_should_refuse_green_main_evidence_for_the_other_owner(
    evidence: str, expected: str
) -> None:
    with pytest.raises(ValueError, match="green-main evidence is malformed"):
        parse_green_main(evidence_json(evidence), expected)


@pytest.mark.parametrize("repository", REFUSED)
def test_should_refuse_green_main_when_the_run_repository_is_not_allowed(
    repository: str,
) -> None:
    with pytest.raises(UnknownRepositoryError):
        parse_green_main(evidence_json(repository), repository)


@pytest.mark.parametrize("repository", REFUSED)
def test_should_refuse_publish_request_for_other_repositories(repository: str) -> None:
    secret = cast(Secret, FakeSecret())
    with pytest.raises(UnknownRepositoryError):
        PublishRequest(ReleaseKind.CODE, secret, secret, secret, secret, f"{SHA}:1", repository)


# --- the production alert POSTs to the run's actual repository ----------------------------


@pytest.mark.parametrize("repository", ACCEPTED)
def test_should_post_the_alert_to_the_runs_repository(repository: str) -> None:
    # Given
    github = FakeGitHub()
    report = alert_report(PUBLISH, "7", "failure", repository)

    # When
    raise_or_clear_alert(github, report)

    # Then: POSTs do not follow a transfer redirect, so every path names the run's repo.
    assert report.run_url == f"https://github.com/{repository}/actions/runs/7"
    assert {path.split("?")[0] for _, path in github.requests} == {
        f"/repos/{repository}/issues",
        f"/repos/{repository}/labels",
    }


def test_should_update_the_open_issue_in_the_runs_repository() -> None:
    # Given: an issue opened before the transfer still links the old owner's run.
    old = f"https://github.com/{HSESHADR}/actions/runs/8"
    github = FakeGitHub([{"number": 5, "title": "Production deploy/publish failed",
                          "body": render_body({DEPLOY: old})}])  # fmt: skip

    # When
    raise_or_clear_alert(github, alert_report(DEPLOY, "9", "success", GAINRATIO))

    # Then
    writes = [entry for entry in github.requests if entry[0] != "GET"]
    assert writes == [
        ("POST", f"/repos/{GAINRATIO}/issues/5/comments"),
        ("PATCH", f"/repos/{GAINRATIO}/issues/5"),
    ]


def test_should_read_failing_runs_recorded_under_either_owner() -> None:
    body = render_body(
        {
            DEPLOY: f"https://github.com/{HSESHADR}/actions/runs/8",
            PUBLISH: f"https://github.com/{GAINRATIO}/actions/runs/9",
        }
    )
    assert set(failing_workflows(body)) == {DEPLOY, PUBLISH}


def test_should_ignore_failing_runs_recorded_under_another_owner() -> None:
    body = render_body({DEPLOY: "https://github.com/attacker/aml-filter/actions/runs/8"})
    assert failing_workflows(body) == {}


@pytest.mark.parametrize("repository", REFUSED)
def test_should_refuse_alerts_for_other_repositories(repository: str) -> None:
    with pytest.raises(UnknownRepositoryError):
        alert_report(PUBLISH, "7", "failure", repository)


def test_should_post_the_gainratio_alert_to_the_gainratio_api() -> None:
    report = alert_report(PUBLISH, "7", "failure", GAINRATIO)
    assert report == AlertReport(
        PUBLISH, f"https://github.com/{GAINRATIO}/actions/runs/7", Outcome.FAILURE, GAINRATIO
    )


def test_should_refuse_an_alert_without_the_runs_repository() -> None:
    with pytest.raises(TypeError):
        alert_report(PUBLISH, "7", "failure")  # type: ignore[call-arg]


@pytest.mark.anyio
@pytest.mark.parametrize("repository", REFUSED)
async def test_should_refuse_production_alert_function_before_reading_the_token(
    repository: str,
) -> None:
    class ExplodingSecret:
        async def plaintext(self) -> str:
            raise AssertionError("token read for a refused repository")

    subject = object.__new__(AmlFilter)
    with pytest.raises(UnknownRepositoryError):
        await cast(
            Awaitable[str],
            subject.production_alert(
                cast(Secret, ExplodingSecret()), PUBLISH, "7", "failure", repository
            ),
        )


# --- the release queue reads the run's repository ----------------------------------------


@pytest.mark.anyio
@pytest.mark.parametrize("repository", ACCEPTED)
async def test_should_queue_against_the_runs_repository(
    monkeypatch: pytest.MonkeyPatch, repository: str
) -> None:
    # Given
    seen: set[str] = set()

    def fetch(repo: str, token: str, workflow_file: str) -> str:
        seen.add(repo)
        return json.dumps({"workflow_runs": []})

    monkeypatch.setattr(main_module, "fetch_runs", fetch)

    # When
    await main_module.grant_release_turn(
        cast(Secret, FakeSecret()), "42", TurnPolicy(1, 5), repository
    )

    # Then
    assert seen == {repository}


@pytest.mark.anyio
@pytest.mark.parametrize("repository", REFUSED)
async def test_should_refuse_to_queue_for_other_repositories(repository: str) -> None:
    with pytest.raises(UnknownRepositoryError):
        await main_module.grant_release_turn(
            cast(Secret, FakeSecret()), "42", TurnPolicy(1, 5), repository
        )


@pytest.mark.anyio
@pytest.mark.parametrize("repository", ACCEPTED)
async def test_should_read_the_trigger_from_the_runs_repository(
    monkeypatch: pytest.MonkeyPatch, repository: str
) -> None:
    calls: list[str] = []

    def fetch(repo: str, token: str, run_id: int) -> str:
        calls.append(repo)
        return "schedule"

    monkeypatch.setattr(main_module, "fetch_run_event", fetch)
    await main_module.release_event(cast(Secret, FakeSecret()), "42", repository)
    assert calls == [repository]


@pytest.mark.anyio
@pytest.mark.parametrize("repository", REFUSED)
async def test_should_refuse_trigger_lookup_for_other_repositories(repository: str) -> None:
    with pytest.raises(UnknownRepositoryError):
        await main_module.release_event(cast(Secret, FakeSecret()), "42", repository)
