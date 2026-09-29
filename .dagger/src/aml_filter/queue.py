"""A no-drop FIFO turnstile in front of the production concurrency group.

GitHub keeps at most one *pending* run per concurrency group and cancels it when a third
run arrives. Both production writers (deploy.yml, publish-watchlist.yml) therefore wait
here, outside the group, until every older run of either writer has completed. A run only
enters the group once nothing older is still alive, so the group never holds a pending run
that a newcomer could cancel. The group itself stays the mutex: this turnstile orders
entry, it never grants concurrent writes.
"""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from http import HTTPStatus
from http.client import HTTPException, HTTPSConnection
from typing import Final

DELIVERY_WORKFLOW_FILES: Final = ("deploy.yml", "publish-watchlist.yml")
COMPLETED: Final = "completed"
GITHUB_API_HOST: Final = "api.github.com"
GITHUB_API_VERSION: Final = "2022-11-28"
HTTP_TIMEOUT_SECONDS: Final = 30.0
POSITIVE_ID: Final = re.compile(r"^[1-9][0-9]*$")

Fetcher = Callable[[str], Awaitable[str]]
Sleeper = Callable[[float], Awaitable[None]]


class MalformedRunListError(ValueError):
    """GitHub returned something that is not an exact workflow-run list."""


class RunListUnavailableError(RuntimeError):
    """GitHub could not be asked; never proceed on an unknown queue."""


class ReleaseTurnTimeoutError(TimeoutError):
    """An older production write never finished; fail loudly instead of skipping it."""


@dataclass(frozen=True)
class WorkflowRun:
    run_id: int
    status: str
    workflow_file: str


@dataclass(frozen=True)
class TurnPolicy:
    poll_seconds: int
    max_wait_seconds: int

    def __post_init__(self) -> None:
        if self.poll_seconds <= 0 or self.max_wait_seconds < 0:
            raise ValueError("turn policy needs a positive poll and a non-negative wait")

    @property
    def attempts(self) -> int:
        return self.max_wait_seconds // self.poll_seconds + 1


def parse_run_id(raw: str) -> int:
    if POSITIVE_ID.fullmatch(raw) is None:
        raise MalformedRunListError("run id must be a positive integer")
    return int(raw)


def runs_path(repository: str, workflow_file: str) -> str:
    return f"/repos/{repository}/actions/workflows/{workflow_file}/runs?per_page=100"


def _headers(token: str) -> Mapping[str, str]:
    return {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "User-Agent": "aml-filter-release-turn",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
    }


def _get(path: str, token: str) -> tuple[int, bytes]:
    connection = HTTPSConnection(GITHUB_API_HOST, timeout=HTTP_TIMEOUT_SECONDS)
    try:
        connection.request("GET", path, headers=dict(_headers(token)))
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def fetch_runs(repository: str, token: str, workflow_file: str) -> str:
    """Read one writer's recent runs over HTTPS; the token never reaches an error."""
    unavailable = RunListUnavailableError(f"cannot list runs of {workflow_file}")
    try:
        status, body = _get(runs_path(repository, workflow_file), token)
        text = body.decode("utf-8")
    except (OSError, HTTPException, UnicodeDecodeError):
        raise unavailable from None
    if status != HTTPStatus.OK:
        raise unavailable
    return text


def _run(entry: object, workflow_file: str) -> WorkflowRun:
    if not isinstance(entry, dict):
        raise MalformedRunListError("workflow run must be an object")
    run_id, status = entry.get("id"), entry.get("status")
    if type(run_id) is not int or not isinstance(status, str) or not status:
        raise MalformedRunListError("workflow run needs an integer id and a status")
    return WorkflowRun(run_id, status, workflow_file)


def parse_runs(body: str, workflow_file: str) -> tuple[WorkflowRun, ...]:
    try:
        document: object = json.loads(body)
    except json.JSONDecodeError as error:
        raise MalformedRunListError("run list is not JSON") from error
    entries = document.get("workflow_runs") if isinstance(document, dict) else None
    if not isinstance(entries, list):
        raise MalformedRunListError("run list needs a workflow_runs array")
    return tuple(_run(entry, workflow_file) for entry in entries)


def runs_ahead(runs: tuple[WorkflowRun, ...], own_run_id: int) -> tuple[int, ...]:
    """Older runs of either writer that have not completed, oldest first."""
    ahead = {run.run_id for run in runs if run.run_id < own_run_id and run.status != COMPLETED}
    return tuple(sorted(ahead))


async def _pending_ahead(fetch: Fetcher, own_run_id: int) -> tuple[int, ...]:
    runs: tuple[WorkflowRun, ...] = ()
    for workflow_file in DELIVERY_WORKFLOW_FILES:
        runs += parse_runs(await fetch(workflow_file), workflow_file)
    return runs_ahead(runs, own_run_id)


async def wait_for_turn(
    fetch: Fetcher, own_run_id: int, policy: TurnPolicy, sleep: Sleeper
) -> tuple[int, ...]:
    """Return the older runs waited on once none is still alive; raise at the deadline."""
    waited: set[int] = set()
    ahead: tuple[int, ...] = ()
    for attempt in range(policy.attempts):
        ahead = await _pending_ahead(fetch, own_run_id)
        if not ahead:
            return tuple(sorted(waited))
        waited.update(ahead)
        if attempt + 1 < policy.attempts:
            await sleep(policy.poll_seconds)
    raise ReleaseTurnTimeoutError(f"older production runs still active: {ahead}")


def run_path(repository: str, run_id: int) -> str:
    return f"/repos/{repository}/actions/runs/{run_id}"


def fetch_run_event(repository: str, token: str, run_id: int) -> str:
    """Return the event GitHub recorded for this exact run (e.g. ``schedule``)."""
    unavailable = RunListUnavailableError(f"cannot read run {run_id}")
    try:
        status, body = _get(run_path(repository, run_id), token)
        text = body.decode("utf-8")
    except (OSError, HTTPException, UnicodeDecodeError):
        raise unavailable from None
    if status != HTTPStatus.OK:
        raise unavailable
    return parse_run_event(text, run_id)


def _run_record(body: str, run_id: int) -> Mapping[str, object]:
    try:
        document: object = json.loads(body)
    except json.JSONDecodeError as error:
        raise MalformedRunListError("run record is not JSON") from error
    if not isinstance(document, dict) or document.get("id") != run_id:
        raise MalformedRunListError("run record is not this run")
    return document


def parse_run_event(body: str, run_id: int) -> str:
    event = _run_record(body, run_id).get("event")
    if not isinstance(event, str) or not event:
        raise MalformedRunListError("run record has no event")
    return event
