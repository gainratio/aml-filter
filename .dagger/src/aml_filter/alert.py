"""One deduplicated GitHub issue for a failed production deploy, publish, or probe.

A failing run of a watched workflow opens the issue (GitHub emails the owner) or, if it
is already open, records the run and comments. A green run removes that workflow from
the issue's failing list and closes the issue once nothing is failing. The issue body is
the state: one ``- <workflow> failed: <run url>`` line per failing workflow.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import StrEnum
from http.client import HTTPException, HTTPSConnection
from typing import Final

REPOSITORY: Final = "hseshadr/aml-filter"
ISSUE_TITLE: Final = "Production deploy/publish failed"
ALERT_LABEL: Final = "production-alert"
LABEL_COLOR: Final = "b60205"
WATCHED_WORKFLOWS: Final = frozenset(
    {"Deploy aml-filter.com", "Publish watchlist", "Live smoke", "Watchlist freshness"}
)
RUN_ID: Final = re.compile(r"^[1-9][0-9]*$")
RUN_URL: Final = f"https://github.com/{REPOSITORY}/actions/runs/"
FAILING_LINE: Final = re.compile(
    rf"^- (?P<workflow>[^\n:]+) failed: (?P<url>{re.escape(RUN_URL)}[1-9][0-9]*)$", re.M
)
API_HOST: Final = "api.github.com"
API_VERSION: Final = "2022-11-28"
TIMEOUT_SECONDS: Final = 30.0
UNPROCESSABLE: Final = 422

Payload = Mapping[str, object] | None
Transport = Callable[[str, str, Payload], tuple[int, str]]


class InvalidAlertError(ValueError):
    """The caller asked to alert for something outside the watched contract."""


class AlertDeliveryError(RuntimeError):
    """GitHub could not be told; the alert job must go red rather than stay silent."""


class Outcome(StrEnum):
    SUCCESS = "success"
    FAILURE = "failure"


@dataclass(frozen=True)
class AlertReport:
    workflow: str
    run_url: str
    outcome: Outcome


@dataclass(frozen=True)
class OpenIssue:
    number: int
    body: str


@dataclass(frozen=True)
class AlertPlan:
    """What to write: a body (create when no issue is open), a comment, and/or close."""

    body: str | None = None
    comment: str | None = None
    close: bool = False


def alert_report(workflow: str, run_id: str, outcome: str) -> AlertReport:
    """Validate the caller's inputs; the run URL is built here, never passed in."""
    if workflow not in WATCHED_WORKFLOWS:
        raise InvalidAlertError("workflow is not a watched production workflow")
    if RUN_ID.fullmatch(run_id) is None:
        raise InvalidAlertError("run id must be a positive integer")
    if outcome not in {item.value for item in Outcome}:
        raise InvalidAlertError("outcome must be success or failure")
    return AlertReport(workflow, f"{RUN_URL}{run_id}", Outcome(outcome))


def failing_workflows(body: str) -> dict[str, str]:
    """Read the failing set back out of an issue body this module rendered."""
    return {
        match["workflow"]: match["url"]
        for match in FAILING_LINE.finditer(body)
        if match["workflow"] in WATCHED_WORKFLOWS
    }


def render_body(failing: Mapping[str, str]) -> str:
    lines = [f"- {workflow} failed: {url}" for workflow, url in sorted(failing.items())]
    return "\n".join(
        [
            "A production workflow on aml-filter.com is failing. This issue is opened, updated,",
            "and closed by the `production-alert` Dagger function; it closes itself once every",
            "workflow below has a green run again.",
            "",
            "Currently failing:",
            *(lines or ["(nothing)"]),
            "",
        ]
    )


def plan_alert(issue: OpenIssue | None, report: AlertReport) -> AlertPlan:
    """Decide the one write this run owes the issue, if any."""
    failing = failing_workflows(issue.body) if issue else {}
    if report.outcome is Outcome.FAILURE:
        failing[report.workflow] = report.run_url
        comment = None if issue is None else f"{report.workflow} failed: {report.run_url}"
        return AlertPlan(render_body(failing), comment)
    if failing.pop(report.workflow, None) is None:
        return AlertPlan()
    return AlertPlan(render_body(failing), _recovery_comment(report, failing), not failing)


def _recovery_comment(report: AlertReport, failing: Mapping[str, str]) -> str:
    recovered = f"{report.workflow} is green again: {report.run_url}"
    if not failing:
        return f"{recovered}\n\nNothing is failing any more; closing."
    return f"{recovered}\n\nStill failing: {', '.join(sorted(failing))}."


def raise_or_clear_alert(transport: Transport, report: AlertReport) -> str:
    """Apply this run's plan to the one open alert issue over the GitHub REST API."""
    issue = _open_issue(transport)
    plan = plan_alert(issue, report)
    if plan.body is None:
        return f"{report.workflow}: {report.outcome.value}; no open alert to update"
    if issue is None:
        return _create(transport, plan.body)
    return _update(transport, issue.number, plan)


def _open_issue(transport: Transport) -> OpenIssue | None:
    path = f"/repos/{REPOSITORY}/issues?state=open&labels={ALERT_LABEL}&per_page=100"
    candidates = [
        issue
        for issue in _issue_list(_expect(transport("GET", path, None), path))
        if issue.get("title") == ISSUE_TITLE and "pull_request" not in issue
    ]
    return min((_issue(entry) for entry in candidates), key=lambda i: i.number, default=None)


def _issue_list(body: str) -> list[Mapping[str, object]]:
    try:
        document: object = json.loads(body)
    except json.JSONDecodeError:
        raise AlertDeliveryError("GitHub issue list is not JSON") from None
    if not isinstance(document, list) or not all(isinstance(i, dict) for i in document):
        raise AlertDeliveryError("GitHub issue list is not an array of issues")
    return document


def _issue(entry: Mapping[str, object]) -> OpenIssue:
    number, body = entry.get("number"), entry.get("body") or ""
    if type(number) is not int or not isinstance(body, str):
        raise AlertDeliveryError("GitHub issue needs an integer number and a text body")
    return OpenIssue(number, body)


def _create(transport: Transport, body: str) -> str:
    label = {"name": ALERT_LABEL, "color": LABEL_COLOR, "description": ISSUE_TITLE}
    label_path = f"/repos/{REPOSITORY}/labels"
    status, text = transport("POST", label_path, label)
    if status != UNPROCESSABLE:
        _expect((status, text), label_path)
    issue = {"title": ISSUE_TITLE, "body": body, "labels": [ALERT_LABEL]}
    _expect(transport("POST", f"/repos/{REPOSITORY}/issues", issue), "create issue")
    return f"opened '{ISSUE_TITLE}'"


def _update(transport: Transport, number: int, plan: AlertPlan) -> str:
    path = f"/repos/{REPOSITORY}/issues/{number}"
    if plan.comment is not None:
        _expect(transport("POST", f"{path}/comments", {"body": plan.comment}), "comment")
    change: dict[str, object] = {"body": plan.body}
    if plan.close:
        change |= {"state": "closed", "state_reason": "completed"}
    _expect(transport("PATCH", path, change), "update issue")
    return f"{'closed' if plan.close else 'updated'} issue #{number}"


def _expect(response: tuple[int, str], what: str) -> str:
    status, body = response
    if not 200 <= status < 300:  # noqa: PLR2004
        raise AlertDeliveryError(f"GitHub rejected {what}: HTTP {status}")
    return body


def https_transport(token: str) -> Transport:
    """Build a JSON-over-HTTPS transport; the token only ever enters one header."""

    def send(method: str, path: str, payload: Payload) -> tuple[int, str]:
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "aml-filter-production-alert",
            "X-GitHub-Api-Version": API_VERSION,
        }
        body = None if payload is None else json.dumps(payload)
        return _send(method, path, body, headers)

    return send


def _send(method: str, path: str, body: str | None, headers: dict[str, str]) -> tuple[int, str]:
    connection = HTTPSConnection(API_HOST, timeout=TIMEOUT_SECONDS)
    try:
        connection.request(method, path, body, headers)
        response = connection.getresponse()
        return response.status, response.read().decode("utf-8")
    except (OSError, HTTPException, UnicodeDecodeError):
        raise AlertDeliveryError(f"GitHub {method} request failed") from None
    finally:
        connection.close()
