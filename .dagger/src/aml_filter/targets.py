"""Validated identities for AML Filter's public Pages delivery."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Final, Self, cast

# The repository may move from the hseshadr user to the gainratio org. A run reports its own
# identity (``$GITHUB_REPOSITORY``); only these exact two names may deploy, publish, or alert.
ALLOWED_REPOSITORIES: Final = ("hseshadr/aml-filter", "gainratio/aml-filter")
DEFAULT_REPOSITORY: Final = ALLOWED_REPOSITORIES[0]
_PLACEMENT: Final = ("aml-filter", "main", "aml-filter.com")
_SHA_LENGTH: Final = 40
_MALFORMED_EVIDENCE: Final = "serialized green-main evidence is malformed"


class UnknownRepositoryError(ValueError):
    """The run's repository is not this project under an allowed owner."""


def validated_repository(repository: str) -> str:
    """Return ``repository`` only when it exactly names an allowed aml-filter repository."""
    if repository not in ALLOWED_REPOSITORIES:
        raise UnknownRepositoryError(
            f"{repository!r} is not an allowed aml-filter repository: {ALLOWED_REPOSITORIES}"
        )
    return repository


@dataclass(frozen=True)
class AmlTarget:
    """The repository, Pages project, branch, and domain for production."""

    repository: str
    project: str
    branch: str
    domain: str

    def __post_init__(self) -> None:
        allowed = self.repository in ALLOWED_REPOSITORIES
        if not allowed or (self.project, self.branch, self.domain) != _PLACEMENT:
            raise ValueError("AML delivery target must use the validated production values")

    @classmethod
    def production(cls, repository: str = DEFAULT_REPOSITORY) -> Self:
        """Return the immutable production delivery target for the run's repository."""
        return cls(validated_repository(repository), *_PLACEMENT)


@dataclass(frozen=True)
class GreenMainEvidence:
    """Exact source and workflow attempt authorized by Foundation."""

    commit_sha: str
    workflow_run_id: str
    run_attempt: int


@dataclass(frozen=True)
class ProviderIdentity:
    """Non-secret provider deployment fields safe for hosted output."""

    deployment_id: str
    deployment_url: str


def parse_green_main(serialization: str, repository: str = DEFAULT_REPOSITORY) -> GreenMainEvidence:
    """Parse only exact AML production evidence for the run's repository from Foundation."""
    expected = validated_repository(repository)
    values = _evidence_values(serialization)
    if not _valid_evidence(values, expected):
        raise ValueError(_MALFORMED_EVIDENCE)
    commit_sha, workflow_run_id, run_attempt, _, _ = values
    return GreenMainEvidence(
        cast(str, commit_sha), cast(str, workflow_run_id), cast(int, run_attempt)
    )


def _evidence_values(serialization: str) -> tuple[object, object, object, object, object]:
    try:
        value = cast(object, json.loads(serialization))
    except json.JSONDecodeError as error:
        raise ValueError(_MALFORMED_EVIDENCE) from error
    if not isinstance(value, dict):
        raise ValueError(_MALFORMED_EVIDENCE)
    payload = cast(dict[str, object], value)
    return (
        payload.get("commit_sha"),
        payload.get("workflow_run_id"),
        payload.get("run_attempt"),
        payload.get("repository"),
        payload.get("branch"),
    )


def _valid_evidence(values: tuple[object, object, object, object, object], expected: str) -> bool:
    commit_sha, workflow_run_id, run_attempt, repository, branch = values
    return (
        _valid_source(commit_sha, branch)
        and repository == expected
        and _valid_attempt(workflow_run_id, run_attempt)
    )


def _valid_source(commit_sha: object, branch: object) -> bool:
    return isinstance(commit_sha, str) and _is_sha(commit_sha) and branch == _PLACEMENT[1]


def _valid_attempt(workflow_run_id: object, run_attempt: object) -> bool:
    return _valid_workflow_run_id(workflow_run_id) and _valid_run_attempt(run_attempt)


def _is_sha(value: str) -> bool:
    return len(value) == _SHA_LENGTH and all(char in "0123456789abcdef" for char in value)


def _valid_workflow_run_id(value: object) -> bool:
    return isinstance(value, str) and value.isascii() and value.isdecimal() and int(value) > 0


def _valid_run_attempt(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0
