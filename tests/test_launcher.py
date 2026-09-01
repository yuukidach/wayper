"""Regression tests for the source Electron launcher."""

from __future__ import annotations

import os
import tomllib
from pathlib import Path
from unittest.mock import patch

from wayper.server.launcher import (
    _electron_command,
    _electron_dependencies_ready,
    _icon_path,
    _wait_for_api,
)


def _touch(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch()
    return path


def test_windows_uses_native_electron_binary(tmp_path: Path) -> None:
    native_binary = _touch(tmp_path / "node_modules" / "electron" / "dist" / "electron.exe")
    _touch(tmp_path / "node_modules" / ".bin" / "electron")

    assert _electron_command(tmp_path, platform="win32") == [str(native_binary), "."]


def test_posix_uses_node_modules_shim(tmp_path: Path) -> None:
    shim = _touch(tmp_path / "node_modules" / ".bin" / "electron")

    assert _electron_command(tmp_path, platform="linux") == [str(shim), "."]


def test_missing_electron_falls_back_to_platform_npm(tmp_path: Path) -> None:
    assert _electron_command(tmp_path, platform="win32") == ["npm.cmd", "start"]
    assert _electron_command(tmp_path, platform="linux") == ["npm", "start"]


def test_hidden_argument_is_forwarded_to_electron(tmp_path: Path) -> None:
    shim = _touch(tmp_path / "node_modules" / ".bin" / "electron")

    assert _electron_command(tmp_path, platform="linux", arguments=["--hidden"]) == [
        str(shim),
        ".",
        "--hidden",
    ]


def test_hidden_argument_is_forwarded_through_npm(tmp_path: Path) -> None:
    assert _electron_command(tmp_path, platform="linux", arguments=["--hidden"]) == [
        "npm",
        "start",
        "--",
        "--hidden",
    ]


def test_electron_dependencies_follow_current_package_lock(tmp_path: Path) -> None:
    source_lock = _touch(tmp_path / "package-lock.json")
    installed_lock = _touch(tmp_path / "node_modules" / ".package-lock.json")

    os.utime(installed_lock, ns=(1_000_000_000, 1_000_000_000))
    os.utime(source_lock, ns=(2_000_000_000, 2_000_000_000))
    assert not _electron_dependencies_ready(tmp_path)

    os.utime(installed_lock, ns=(3_000_000_000, 3_000_000_000))
    assert _electron_dependencies_ready(tmp_path)

    installed_lock.unlink()
    assert not _electron_dependencies_ready(tmp_path)


def test_wayper_gui_uses_windowed_entry_point() -> None:
    project_root = Path(__file__).resolve().parents[1]
    metadata = tomllib.loads((project_root / "pyproject.toml").read_text(encoding="utf-8"))

    assert metadata["project"]["scripts"]["wayper-gui"] == ("wayper.server.launcher:run_app")
    assert "gui-scripts" not in metadata["project"]


def test_source_launcher_finds_repository_icon() -> None:
    assert _icon_path() is not None


def test_api_readiness_probe_uses_lightweight_config_route(tmp_path: Path) -> None:
    port_path = tmp_path / "api.port"
    port_path.write_text("43210")

    with (
        patch("wayper.server.launcher.port_file", return_value=port_path),
        patch("wayper.server.launcher.urlopen") as urlopen,
    ):
        port = _wait_for_api(timeout=1)

    assert port == 43210
    urlopen.assert_called_once_with("http://127.0.0.1:43210/api/config", timeout=1)
