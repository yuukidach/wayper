"""Release metadata regression tests."""

from __future__ import annotations

import json
import tomllib
from pathlib import Path

from wayper import __version__

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def test_release_versions_stay_in_sync() -> None:
    project = tomllib.loads((PROJECT_ROOT / "pyproject.toml").read_text())
    package = json.loads((PROJECT_ROOT / "wayper/electron/package.json").read_text())
    package_lock = json.loads((PROJECT_ROOT / "wayper/electron/package-lock.json").read_text())

    assert project["project"]["version"] == __version__
    assert package["version"] == __version__
    assert package_lock["version"] == __version__
    assert package_lock["packages"][""]["version"] == __version__


def test_python_build_excludes_electron_artifacts() -> None:
    project = tomllib.loads((PROJECT_ROOT / "pyproject.toml").read_text())
    excludes = set(project["tool"]["hatch"]["build"]["exclude"])

    assert "/wayper/electron/node_modules" in excludes
    assert "/wayper/electron/dist" in excludes
