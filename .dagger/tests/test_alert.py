"""Behavioral contracts for the one deduplicated production-failure issue."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Final

import pytest

import aml_filter.alert as alert_module
from aml_filter.alert import (
    ALERT_LABEL,
    ISSUE_TITLE,
    AlertDeliveryError,
    AlertReport,
    InvalidAlertError,
    OpenIssue,
    Outcome,
    alert_report,
    failing_workflows,
    plan_alert,
    raise_or_clear_alert,
    render_body,
)

REPOSITORY: Final = "gainratio/aml-filter"
RUN_URL: Final = f"https://github.com/{REPOSITORY}/actions/runs/"
PUBLISH: Final = "Publish watchlist"
DEPLOY: Final = "Deploy aml-filter.com"


def report(workflow: str, run_id: int, outcome: Outcome) -> AlertReport:
    return alert_report(workflow, str(run_id), outcome.value, REPOSITORY)


# --- parsing the caller's inputs -------------------------------------------------------


@pytest.mark.parametrize(
    ("workflow", "run_id", "outcome", "message"),
    [
        ("Dagger", "1", "failure", "workflow"),
        ("Publish watchlist\n- Deploy", "1", "failure", "workflow"),
        (PUBLISH, "0", "failure", "run id"),
        (PUBLISH, "12a", "failure", "run id"),
        (PUBLISH, "1", "cancelled", "outcome"),
        (PUBLISH, "1", "", "outcome"),
    ],
)
def test_should_reject_alert_inputs_outside_the_watched_contract(
    workflow: str, run_id: str, outcome: str, message: str
) -> None:
    # Given / When / Then: only the four production workflows may write the issue.
    with pytest.raises(InvalidAlertError, match=message):
        alert_report(workflow, run_id, outcome, REPOSITORY)


def test_should_build_the_run_url_from_the_repository_not_the_caller() -> None:
    # Given / When
    parsed = alert_report(PUBLISH, "42", "failure", REPOSITORY)

    # Then
    assert parsed.run_url == f"{RUN_URL}42"
    assert parsed.outcome is Outcome.FAILURE


# --- the pure open/update/close plan ---------------------------------------------------


def test_should_open_one_issue_when_a_production_run_fails_and_none_is_open() -> None:
    # Given / When
    plan = plan_alert(None, report(PUBLISH, 7, Outcome.FAILURE))

    # Then
    assert plan.body is not None
    assert failing_workflows(plan.body) == {PUBLISH: f"{RUN_URL}7"}
    assert plan.comment is None
    assert plan.close is False


def test_should_update_the_open_issue_instead_of_opening_a_second_one() -> None:
    # Given
    issue = OpenIssue(3, render_body({PUBLISH: f"{RUN_URL}7"}))

    # When
    plan = plan_alert(issue, report(DEPLOY, 8, Outcome.FAILURE))

    # Then
    assert plan.body is not None
    assert failing_workflows(plan.body) == {PUBLISH: f"{RUN_URL}7", DEPLOY: f"{RUN_URL}8"}
    assert plan.comment is not None and f"{RUN_URL}8" in plan.comment
    assert plan.close is False


def test_should_close_the_issue_when_the_last_failing_workflow_goes_green() -> None:
    # Given
    issue = OpenIssue(3, render_body({PUBLISH: f"{RUN_URL}7"}))

    # When
    plan = plan_alert(issue, report(PUBLISH, 9, Outcome.SUCCESS))

    # Then
    assert plan.close is True
    assert plan.body is not None and failing_workflows(plan.body) == {}
    assert plan.comment is not None and f"{RUN_URL}9" in plan.comment


def test_should_keep_the_issue_open_while_another_workflow_is_still_failing() -> None:
    # Given
    issue = OpenIssue(3, render_body({PUBLISH: f"{RUN_URL}7", DEPLOY: f"{RUN_URL}8"}))

    # When
    plan = plan_alert(issue, report(PUBLISH, 9, Outcome.SUCCESS))

    # Then
    assert plan.close is False
    assert plan.body is not None
    assert failing_workflows(plan.body) == {DEPLOY: f"{RUN_URL}8"}


@pytest.mark.parametrize(
    "issue", [None, OpenIssue(3, render_body({DEPLOY: f"{RUN_URL}8"}))], ids=["none", "other"]
)
def test_should_do_nothing_when_a_green_run_has_nothing_to_clear(issue: OpenIssue | None) -> None:
    # Given / When
    plan = plan_alert(issue, report(PUBLISH, 9, Outcome.SUCCESS))

    # Then
    assert (plan.body, plan.comment, plan.close) == (None, None, False)


def test_should_ignore_hand_written_lines_when_reading_the_failing_set() -> None:
    # Given
    body = f"{render_body({PUBLISH: f'{RUN_URL}7'})}\n- Someone failed: https://example.com/x\n"

    # When / Then
    assert failing_workflows(body) == {PUBLISH: f"{RUN_URL}7"}


# --- delivery over the GitHub REST API -------------------------------------------------


@dataclass
class FakeGitHub:
    """Serve scripted responses per (method, path prefix) and record every request."""

    issues: list[dict[str, object]] = field(default_factory=list)
    label_status: int = 201
    fail: str = ""
    requests: list[tuple[str, str, object]] = field(default_factory=list)

    def __call__(self, method: str, path: str, payload: object) -> tuple[int, str]:
        self.requests.append((method, path, payload))
        if self.fail and path.endswith(self.fail) and method != "GET":
            return 500, "{}"
        if method == "GET":
            return 200, json.dumps(self.issues)
        if path.endswith("/labels"):
            return self.label_status, "{}"
        return (201 if method == "POST" else 200), json.dumps({"number": 11})


def open_issue(number: int, body: str, title: str = ISSUE_TITLE) -> dict[str, object]:
    return {"number": number, "title": title, "body": body, "state": "open"}


def test_should_create_the_labelled_issue_when_a_production_run_fails() -> None:
    # Given
    github = FakeGitHub()

    # When
    result = raise_or_clear_alert(github, report(PUBLISH, 7, Outcome.FAILURE))

    # Then
    method, path, query = github.requests[0]
    assert (method, query) == ("GET", None)
    assert path.startswith("/repos/gainratio/aml-filter/issues?") and ALERT_LABEL in path
    created = [r for r in github.requests if r[1].endswith("/issues") and r[0] == "POST"]
    assert len(created) == 1
    payload = created[0][2]
    assert isinstance(payload, dict)
    assert payload["title"] == ISSUE_TITLE and payload["labels"] == [ALERT_LABEL]
    assert "opened" in result


def test_should_accept_an_existing_label() -> None:
    # Given: GitHub answers 422 when the label already exists.
    github = FakeGitHub(label_status=422)

    # When / Then
    assert "opened" in raise_or_clear_alert(github, report(PUBLISH, 7, Outcome.FAILURE))


def test_should_comment_on_and_update_the_open_issue_instead_of_duplicating() -> None:
    # Given
    github = FakeGitHub(issues=[open_issue(5, render_body({DEPLOY: f"{RUN_URL}8"}))])

    # When
    raise_or_clear_alert(github, report(PUBLISH, 7, Outcome.FAILURE))

    # Then
    writes = [(m, p) for m, p, _ in github.requests if m != "GET"]
    assert ("POST", "/repos/gainratio/aml-filter/issues") not in writes
    assert ("PATCH", "/repos/gainratio/aml-filter/issues/5") in writes
    assert ("POST", "/repos/gainratio/aml-filter/issues/5/comments") in writes


def test_should_close_the_issue_on_the_next_green_run() -> None:
    # Given
    github = FakeGitHub(issues=[open_issue(5, render_body({PUBLISH: f"{RUN_URL}7"}))])

    # When
    result = raise_or_clear_alert(github, report(PUBLISH, 9, Outcome.SUCCESS))

    # Then
    patch = [r for r in github.requests if r[0] == "PATCH"][-1]
    assert patch[1] == "/repos/gainratio/aml-filter/issues/5"
    assert isinstance(patch[2], dict) and patch[2]["state"] == "closed"
    assert "closed" in result


def test_should_stay_silent_when_green_and_nothing_is_open() -> None:
    # Given
    github = FakeGitHub()

    # When
    result = raise_or_clear_alert(github, report(PUBLISH, 9, Outcome.SUCCESS))

    # Then
    assert [m for m, _, _ in github.requests] == ["GET"]
    assert "no open" in result


def test_should_ignore_pull_requests_and_other_titles_under_the_label() -> None:
    # Given
    pull = {**open_issue(4, render_body({PUBLISH: f"{RUN_URL}1"})), "pull_request": {}}
    other = open_issue(6, render_body({PUBLISH: f"{RUN_URL}1"}), title="Something else")
    github = FakeGitHub(issues=[pull, other])

    # When
    raise_or_clear_alert(github, report(PUBLISH, 9, Outcome.SUCCESS))

    # Then
    assert [m for m, _, _ in github.requests] == ["GET"]


@pytest.mark.parametrize("fail", ["/issues", "/labels", "/comments"])
def test_should_fail_loudly_when_github_rejects_a_write(fail: str) -> None:
    # Given
    issues = [open_issue(5, render_body({DEPLOY: f"{RUN_URL}8"}))] if fail == "/comments" else []
    github = FakeGitHub(issues=issues, fail=fail)

    # When / Then: an alert that could not be raised must turn the job red.
    with pytest.raises(AlertDeliveryError):
        raise_or_clear_alert(github, report(PUBLISH, 7, Outcome.FAILURE))


@pytest.mark.parametrize(
    "body",
    ["not json", "{}", "[1]", json.dumps([{"number": "5", "title": ISSUE_TITLE}])],
)
def test_should_fail_loudly_when_the_issue_list_is_malformed(body: str) -> None:
    # Given
    def github(method: str, path: str, payload: object) -> tuple[int, str]:
        del method, path, payload
        return 200, body

    # When / Then
    with pytest.raises(AlertDeliveryError):
        raise_or_clear_alert(github, report(PUBLISH, 7, Outcome.FAILURE))


def test_should_fail_loudly_when_the_issue_list_cannot_be_read() -> None:
    # Given
    def github(method: str, path: str, payload: object) -> tuple[int, str]:
        del method, path, payload
        return 403, "{}"

    # When / Then
    with pytest.raises(AlertDeliveryError):
        raise_or_clear_alert(github, report(PUBLISH, 7, Outcome.FAILURE))


# --- the real HTTPS transport ----------------------------------------------------------


class FakeResponse:
    def __init__(self, status: int, body: bytes) -> None:
        self.status = status
        self.body = body

    def read(self) -> bytes:
        return self.body


class FakeConnection:
    sent: list[tuple[str, str, str | None, dict[str, str]]] = []  # noqa: RUF012
    response: FakeResponse | OSError = FakeResponse(200, b"[]")

    def __init__(self, host: str, timeout: float) -> None:
        assert host == "api.github.com" and timeout > 0

    def request(self, method: str, path: str, body: str | None, headers: dict[str, str]) -> None:
        FakeConnection.sent.append((method, path, body, headers))

    def getresponse(self) -> FakeResponse:
        if isinstance(FakeConnection.response, OSError):
            raise FakeConnection.response
        return FakeConnection.response

    def close(self) -> None:
        return None


def test_should_send_json_with_the_token_only_in_the_authorization_header(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    FakeConnection.sent = []
    FakeConnection.response = FakeResponse(201, b'{"number": 1}')
    monkeypatch.setattr(alert_module, "HTTPSConnection", FakeConnection)
    transport = alert_module.https_transport("secret-token")

    # When
    status, body = transport("POST", "/repos/gainratio/aml-filter/issues", {"title": "t"})

    # Then
    assert (status, body) == (201, '{"number": 1}')
    method, path, sent_body, headers = FakeConnection.sent[0]
    assert (method, path, sent_body) == (
        "POST",
        "/repos/gainratio/aml-filter/issues",
        '{"title": "t"}',
    )
    assert headers["Authorization"] == "Bearer secret-token"


def test_should_hide_the_token_when_the_network_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    # Given
    FakeConnection.response = OSError("connection reset for secret-token")
    monkeypatch.setattr(alert_module, "HTTPSConnection", FakeConnection)
    transport = alert_module.https_transport("secret-token")

    # When / Then
    with pytest.raises(AlertDeliveryError) as error:
        transport("GET", "/repos/gainratio/aml-filter/issues", None)
    assert "secret-token" not in str(error.value)
    assert error.value.__cause__ is None
