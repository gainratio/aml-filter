"""The hseshadr/ci fleet policy must be able to parse every authored module.

The fleet scanner reads this repo's `.dagger` Python and parses it with Python 3.13
(`python:3.13` in hseshadr/ci). Syntax newer than 3.13 crashes the whole fleet scan,
so authored modules must stay parseable at that grammar even though this module runs
on 3.14.
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import Final

import pytest

PROJECT: Final = Path(__file__).resolve().parents[1]
FLEET_SCANNER_GRAMMAR: Final = (3, 13)
AUTHORED: Final = sorted((PROJECT / "src").rglob("*.py"))


def test_should_find_authored_modules_when_fleet_scan_collects_sources() -> None:
    assert AUTHORED, "no authored Dagger modules found under .dagger/src"


@pytest.mark.parametrize("module", AUTHORED, ids=lambda path: path.name)
def test_should_parse_with_fleet_grammar_when_ci_scans_module(module: Path) -> None:
    ast.parse(module.read_text(), filename=str(module), feature_version=FLEET_SCANNER_GRAMMAR)
