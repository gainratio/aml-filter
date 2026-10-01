"""Behavioral contracts for release policy at the Dagger boundary."""

from __future__ import annotations

from datetime import date
from typing import Final

import pytest

from aml_filter.policy import (
    InvalidReleaseIdentityError,
    ReleaseKind,
    carried_list_ceiling_days,
    parse_release_identity,
    release_identity,
    release_version,
    requires_full_green,
    whole_bundle_fallback_days,
)

EXPECTED_FALLBACK_DAYS: Final = 7


def test_should_bound_fallback_when_code_deploy() -> None:
    # Given
    kind = ReleaseKind.CODE

    # When
    days = whole_bundle_fallback_days(kind)

    # Then
    assert days == EXPECTED_FALLBACK_DAYS


def test_should_forbid_fallback_when_watchlist_publish() -> None:
    # Given
    kind = ReleaseKind.WATCHLIST

    # When / Then
    with pytest.raises(InvalidReleaseIdentityError, match="watchlist publish"):
        whole_bundle_fallback_days(kind)


def test_should_default_version_when_stamp_is_empty() -> None:
    # Given
    today = date(2026, 8, 25)

    # When
    version = release_version("", today)

    # Then
    assert version == "2026-08-25"


@pytest.mark.parametrize("stamp", ["bad stamp", "oops/branch", "$(unsafe)"])
def test_should_reject_version_when_stamp_is_unsafe(stamp: str) -> None:
    # Given
    today = date(2026, 8, 25)

    # When / Then
    with pytest.raises(InvalidReleaseIdentityError, match="version"):
        release_version(stamp, today)


def test_should_bind_identity_when_source_and_run_are_exact() -> None:
    # Given
    source_sha = "a" * 40

    # When
    identity = release_identity(source_sha, "123456")

    # Then
    assert identity.source_sha == source_sha
    assert identity.run_id == "123456"


@pytest.mark.parametrize("source_sha", ["abc", "A" * 40, "g" * 40])
def test_should_reject_identity_when_source_sha_is_not_exact(source_sha: str) -> None:
    # Given
    run_id = "123456"

    # When / Then
    with pytest.raises(InvalidReleaseIdentityError, match="source SHA"):
        release_identity(source_sha, run_id)


def test_should_parse_identity_when_ingress_binds_sha_and_run() -> None:
    # Given
    stamp = f"{'a' * 40}:123456"

    # When
    identity = parse_release_identity(stamp)

    # Then
    assert identity.source_sha == "a" * 40
    assert identity.run_id == "123456"


EXPECTED_CARRIED_CEILING_DAYS: Final = 7


def test_should_cap_how_long_one_list_may_be_carried_forward() -> None:
    # A list re-served because upstream failed is the last good copy, not a
    # licence to serve it forever. UK_OFSI was carried every day from
    # 2026-09-01 under a green pipeline because nothing capped it.
    # Given / When
    days = carried_list_ceiling_days()

    # Then
    assert days == EXPECTED_CARRIED_CEILING_DAYS


def test_should_cap_carried_lists_on_watchlist_publishes_too() -> None:
    # whole-bundle fallback is forbidden for a watchlist publish; the per-list
    # ceiling is not — it must apply precisely to the nightly refresh, which is
    # the run that silently carried UK forward.
    # Given / When
    days = carried_list_ceiling_days()

    # Then
    assert days > 0


def test_should_let_only_the_scheduled_watchlist_refresh_skip_dev_tool_audit() -> None:
    # Given / When / Then: the nightly data refresh needs only the Dagger gates.
    assert requires_full_green(ReleaseKind.WATCHLIST, "schedule") is False


@pytest.mark.parametrize("event", ["schedule", "workflow_run", "workflow_dispatch", "", "push"])
def test_should_require_full_green_main_when_code_deploys(event: str) -> None:
    # Given / When / Then: a code deploy never skips the dev-tool audit, whatever the event.
    assert requires_full_green(ReleaseKind.CODE, event) is True


@pytest.mark.parametrize(
    "event", ["workflow_run", "workflow_dispatch", "", "Schedule", " schedule", "push"]
)
def test_should_require_full_green_main_when_watchlist_publish_is_not_the_nightly(
    event: str,
) -> None:
    # Given / When / Then: post-merge and manual publishes ship main-head code, so
    # they stay fully gated; unknown or empty events fail closed.
    assert requires_full_green(ReleaseKind.WATCHLIST, event) is True


@pytest.mark.parametrize(
    ("stamp", "message"),
    [(f"{'a' * 40}:12x", "run id must be numeric"), ("a" * 40, "separate SHA and run id")],
)
def test_should_refuse_a_release_identity_without_an_exact_run(stamp: str, message: str) -> None:
    # Given / When / Then
    with pytest.raises(InvalidReleaseIdentityError, match=message):
        parse_release_identity(stamp)
