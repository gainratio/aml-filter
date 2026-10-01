"""Small, typed release policies shared by Dagger entrypoints."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from enum import StrEnum
from typing import Final

FALLBACK_DAYS: Final = 7
CARRIED_LIST_CEILING_DAYS: Final = 7
SAFE_VERSION: Final = re.compile(r"^[A-Za-z0-9._-]+$")
SOURCE_SHA: Final = re.compile(r"^[0-9a-f]{40}$")
RUN_ID: Final = re.compile(r"^[0-9]+$")


class InvalidReleaseIdentityError(ValueError):
    pass


class ReleaseKind(StrEnum):
    CODE = "code"
    WATCHLIST = "watchlist"


@dataclass(frozen=True)
class ReleaseIdentity:
    source_sha: str
    run_id: str


# The only trigger that may ship without the dev-tool audit: the nightly sanctions refresh.
DATA_ONLY_EVENT: Final = "schedule"


def requires_full_green(kind: ReleaseKind, event: str) -> bool:
    """Whether this release must also pass the dev-tool audit (a fully green main).

    Code deploys, post-merge publishes, and manual publishes always do. Only the
    scheduled watchlist refresh is gated on the Dagger check alone (quality, runtime
    dependency audit, secret scan) plus signing, verification, live smoke and
    rollback, so an advisory in build tooling cannot freeze the sanctions data.
    Any other or unknown event fails closed.
    """
    return not (kind is ReleaseKind.WATCHLIST and event == DATA_ONLY_EVENT)


def whole_bundle_fallback_days(kind: ReleaseKind) -> int:
    """Return the code-deploy fallback bound; nightly refreshes must fail."""
    if kind is ReleaseKind.WATCHLIST:
        raise InvalidReleaseIdentityError("watchlist publish forbids whole-bundle fallback")
    return FALLBACK_DAYS


def carried_list_ceiling_days() -> int:
    """Return how long ONE list may be re-served after its upstream fails.

    Unlike the whole-bundle fallback, this applies to every release kind --
    especially WATCHLIST, which is the nightly refresh that carried UK_OFSI
    forward every day from 2026-09-01 while the pipeline stayed green.
    """
    return CARRIED_LIST_CEILING_DAYS


def release_version(stamp: str, today: date) -> str:
    """Validate a caller stamp or use the UTC run date."""
    version = stamp or today.isoformat()
    if SAFE_VERSION.fullmatch(version) is None:
        raise InvalidReleaseIdentityError("version contains unsafe characters")
    return version


def release_identity(source_sha: str, run_id: str) -> ReleaseIdentity:
    """Validate exact immutable source and hosted-run identifiers."""
    if SOURCE_SHA.fullmatch(source_sha) is None:
        raise InvalidReleaseIdentityError("source SHA must be 40 lowercase hex characters")
    if RUN_ID.fullmatch(run_id) is None:
        raise InvalidReleaseIdentityError("run id must be numeric")
    return ReleaseIdentity(source_sha, run_id)


def parse_release_identity(stamp: str) -> ReleaseIdentity:
    source_sha, separator, run_id = stamp.partition(":")
    if separator == "":
        raise InvalidReleaseIdentityError("release identity must separate SHA and run id")
    return release_identity(source_sha, run_id)
