"""Behavioral contracts for the no-drop production release turnstile."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import ClassVar, Final, cast

import pytest
from dagger import Secret

import aml_filter.main as main_module
import aml_filter.queue as queue_module
from aml_filter.queue import (
    DELIVERY_WORKFLOW_FILES,
    MalformedRunListError,
    ReleaseTurnTimeoutError,
    RunListUnavailableError,
    TurnPolicy,
    WorkflowRun,
    fetch_runs,
    parse_run_id,
    parse_runs,
    runs_ahead,
    runs_path,
    wait_for_turn,
)

REPOSITORY: Final = "gainratio/aml-filter"
OWN_RUN: Final = 500
LARGE_RUN_ID: Final = 18123456789
FAST: Final = TurnPolicy(poll_seconds=1, max_wait_seconds=3)


def payload(*runs: tuple[object, object]) -> str:
    """Build one GitHub list-workflow-runs response body."""
    return json.dumps({"workflow_runs": [{"id": rid, "status": st} for rid, st in runs]})


class ScriptedRuns:
    """Serve scripted list-runs bodies per workflow file, one poll at a time."""

    def __init__(self, polls: Sequence[Mapping[str, str]]) -> None:
        self.polls = list(polls)
        self.calls: list[str] = []
        self.sleeps: list[float] = []

    async def fetch(self, workflow_file: str) -> str:
        self.calls.append(workflow_file)
        index = min(len(self.calls) - 1, 2 * len(self.polls) - 1) // 2
        return self.polls[index][workflow_file]

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)


def both(deploy: str, publish: str) -> Mapping[str, str]:
    return {"deploy.yml": deploy, "publish-watchlist.yml": publish}


def test_should_cover_exactly_both_production_writers() -> None:
    assert DELIVERY_WORKFLOW_FILES == ("deploy.yml", "publish-watchlist.yml")


def test_should_wait_only_on_older_incomplete_runs_in_fifo_order() -> None:
    # Given
    runs = (
        WorkflowRun(499, "in_progress", "deploy.yml"),
        WorkflowRun(498, "completed", "deploy.yml"),
        WorkflowRun(497, "queued", "publish-watchlist.yml"),
        WorkflowRun(OWN_RUN, "in_progress", "deploy.yml"),
        WorkflowRun(501, "queued", "publish-watchlist.yml"),
    )

    # When
    ahead = runs_ahead(runs, OWN_RUN)

    # Then
    assert ahead == (497, 499)


@pytest.mark.parametrize("status", ["queued", "in_progress", "waiting", "pending", "requested"])
def test_should_block_on_every_non_completed_status(status: str) -> None:
    assert runs_ahead((WorkflowRun(1, status, "deploy.yml"),), OWN_RUN) == (1,)


def test_should_parse_runs_from_github_list_response() -> None:
    # Given
    body = payload((12, "queued"), (11, "completed"))

    # When
    runs = parse_runs(body, "deploy.yml")

    # Then
    assert runs == (
        WorkflowRun(12, "queued", "deploy.yml"),
        WorkflowRun(11, "completed", "deploy.yml"),
    )


@pytest.mark.parametrize(
    "body",
    [
        "not json",
        "[]",
        "{}",
        json.dumps({"workflow_runs": {}}),
        json.dumps({"workflow_runs": ["x"]}),
        json.dumps({"workflow_runs": [{"id": "12", "status": "queued"}]}),
        json.dumps({"workflow_runs": [{"id": True, "status": "queued"}]}),
        json.dumps({"workflow_runs": [{"id": 12}]}),
        json.dumps({"workflow_runs": [{"id": 12, "status": ""}]}),
    ],
)
def test_should_fail_closed_when_run_list_is_malformed(body: str) -> None:
    with pytest.raises(MalformedRunListError):
        parse_runs(body, "deploy.yml")


@pytest.mark.parametrize("raw", ["", "12a", "-1", "0", " 12"])
def test_should_reject_run_id_that_is_not_a_positive_integer(raw: str) -> None:
    with pytest.raises(MalformedRunListError):
        parse_run_id(raw)


def test_should_parse_positive_run_id() -> None:
    assert parse_run_id(str(LARGE_RUN_ID)) == LARGE_RUN_ID


def test_should_build_exact_repository_workflow_runs_path() -> None:
    assert runs_path("gainratio/aml-filter", "deploy.yml") == (
        "/repos/gainratio/aml-filter/actions/workflows/deploy.yml/runs?per_page=100"
    )


@pytest.mark.parametrize(("poll", "wait"), [(0, 10), (-1, 10), (5, -1)])
def test_should_reject_nonsensical_turn_policy(poll: int, wait: int) -> None:
    with pytest.raises(ValueError, match="turn policy"):
        TurnPolicy(poll_seconds=poll, max_wait_seconds=wait)


@pytest.mark.anyio
async def test_should_proceed_immediately_when_nothing_is_ahead() -> None:
    # Given
    script = ScriptedRuns([both(payload((OWN_RUN, "in_progress")), payload((499, "completed")))])

    # When
    waited = await wait_for_turn(script.fetch, OWN_RUN, FAST, script.sleep)

    # Then
    assert waited == ()
    assert script.sleeps == []
    assert script.calls == list(DELIVERY_WORKFLOW_FILES)


@pytest.mark.anyio
async def test_should_wait_across_both_workflows_until_older_runs_finish() -> None:
    # Given
    script = ScriptedRuns(
        [
            both(payload((499, "in_progress")), payload((498, "queued"))),
            both(payload((499, "completed")), payload((498, "in_progress"))),
            both(payload((499, "completed")), payload((498, "completed"))),
        ]
    )

    # When
    waited = await wait_for_turn(script.fetch, OWN_RUN, FAST, script.sleep)

    # Then
    assert waited == (498, 499)
    assert script.sleeps == [1, 1]


@pytest.mark.anyio
async def test_should_fail_loudly_when_earlier_run_never_finishes() -> None:
    # Given
    script = ScriptedRuns([both(payload((499, "in_progress")), payload())])

    # When / Then
    with pytest.raises(ReleaseTurnTimeoutError, match="499"):
        await wait_for_turn(script.fetch, OWN_RUN, FAST, script.sleep)
    assert script.sleeps == [1, 1, 1]


@dataclass(frozen=True)
class FakeResponse:
    status: int
    body: bytes

    def read(self) -> bytes:
        return self.body


class FakeConnection:
    """Record one HTTPS request and serve a scripted response or transport error."""

    seen: ClassVar[list[tuple[str, float, str, str, Mapping[str, str]]]] = []
    response: ClassVar[FakeResponse | OSError] = FakeResponse(200, b"{}")

    def __init__(self, host: str, timeout: float) -> None:
        self.host, self.timeout = host, timeout

    def request(self, method: str, path: str, headers: Mapping[str, str]) -> None:
        FakeConnection.seen.append((self.host, self.timeout, method, path, headers))

    def getresponse(self) -> FakeResponse:
        if isinstance(FakeConnection.response, OSError):
            raise FakeConnection.response
        return FakeConnection.response

    def close(self) -> None:
        return None


def serve(monkeypatch: pytest.MonkeyPatch, response: FakeResponse | OSError) -> None:
    FakeConnection.seen = []
    FakeConnection.response = response
    monkeypatch.setattr(queue_module, "HTTPSConnection", FakeConnection)


def test_should_request_runs_over_https_with_bearer_token_and_api_version(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    serve(monkeypatch, FakeResponse(200, b"{}"))

    # When
    body = fetch_runs("gainratio/aml-filter", "sekrit-token", "publish-watchlist.yml")

    # Then
    host, timeout, method, path, headers = FakeConnection.seen[0]
    assert body == "{}"
    assert (host, timeout, method) == ("api.github.com", queue_module.HTTP_TIMEOUT_SECONDS, "GET")
    assert path == runs_path("gainratio/aml-filter", "publish-watchlist.yml")
    assert headers["Authorization"] == "Bearer sekrit-token"
    assert headers["X-GitHub-Api-Version"] == "2022-11-28"


@pytest.mark.parametrize(
    "response",
    [OSError("refused Bearer sekrit-token"), FakeResponse(401, b"{}"), FakeResponse(200, b"\xff")],
)
def test_should_fail_closed_without_echoing_token_when_github_is_unreadable(
    monkeypatch: pytest.MonkeyPatch, response: FakeResponse | OSError
) -> None:
    # Given
    serve(monkeypatch, response)

    # When / Then
    with pytest.raises(RunListUnavailableError) as caught:
        fetch_runs("gainratio/aml-filter", "sekrit-token", "deploy.yml")
    assert "sekrit-token" not in str(caught.value)
    assert caught.value.__cause__ is None


class FakeSecret:
    async def plaintext(self) -> str:
        return "sekrit-token"


@pytest.mark.anyio
async def test_should_grant_release_turn_after_older_writes_complete(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    polls = iter([payload((41, "in_progress")), payload(), payload((41, "completed")), payload()])
    calls: list[tuple[str, str, str]] = []

    def fetch(repository: str, token: str, workflow_file: str) -> str:
        calls.append((repository, token, workflow_file))
        return next(polls)

    monkeypatch.setattr(main_module, "fetch_runs", fetch)
    token = cast(Secret, FakeSecret())

    # When
    result = await main_module.grant_release_turn(token, "42", TurnPolicy(1, 5), REPOSITORY)

    # Then
    assert result == "release turn granted to run 42 after waiting on runs [41]"
    assert {call[0] for call in calls} == {REPOSITORY}
    assert [call[2] for call in calls] == list(DELIVERY_WORKFLOW_FILES) * 2


@pytest.mark.anyio
async def test_should_refuse_release_turn_for_malformed_run_id() -> None:
    with pytest.raises(MalformedRunListError):
        await main_module.grant_release_turn(cast(Secret, FakeSecret()), "42; rm", FAST, REPOSITORY)


# --- which event started a run: GitHub's record, never the caller's claim ---------------


def test_should_read_the_trigger_from_githubs_record_of_the_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    serve(monkeypatch, FakeResponse(200, json.dumps({"id": 42, "event": "schedule"}).encode()))

    # When
    event = queue_module.fetch_run_event("gainratio/aml-filter", "sekrit-token", 42)

    # Then
    _, _, method, path, headers = FakeConnection.seen[0]
    assert (method, path) == ("GET", "/repos/gainratio/aml-filter/actions/runs/42")
    assert headers["Authorization"] == "Bearer sekrit-token"
    assert event == "schedule"


@pytest.mark.parametrize(
    "body",
    [
        b"not json",
        b"[]",
        b'{"id": 42}',
        b'{"id": 42, "event": ""}',
        b'{"id": 43, "event": "schedule"}',
    ],
)
def test_should_refuse_a_run_record_that_is_not_exactly_this_run(
    monkeypatch: pytest.MonkeyPatch, body: bytes
) -> None:
    # Given
    serve(monkeypatch, FakeResponse(200, body))

    # When / Then
    with pytest.raises(MalformedRunListError):
        queue_module.fetch_run_event("gainratio/aml-filter", "sekrit-token", 42)


@pytest.mark.parametrize("response", [OSError("Bearer sekrit-token"), FakeResponse(404, b"{}")])
def test_should_fail_closed_when_the_run_record_is_unreadable(
    monkeypatch: pytest.MonkeyPatch, response: FakeResponse | OSError
) -> None:
    # Given
    serve(monkeypatch, response)

    # When / Then
    with pytest.raises(RunListUnavailableError) as caught:
        queue_module.fetch_run_event("gainratio/aml-filter", "sekrit-token", 42)
    assert "sekrit-token" not in str(caught.value)


@pytest.mark.anyio
async def test_should_ask_github_for_this_repositorys_run_when_resolving_the_trigger(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    calls: list[tuple[str, str, int]] = []

    def fetch(repository: str, token: str, run_id: int) -> str:
        calls.append((repository, token, run_id))
        return "schedule"

    monkeypatch.setattr(main_module, "fetch_run_event", fetch)

    # When
    event = await main_module.release_event(cast(Secret, FakeSecret()), "42", REPOSITORY)

    # Then
    assert (event, calls) == ("schedule", [(REPOSITORY, "sekrit-token", 42)])
