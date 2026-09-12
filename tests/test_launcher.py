"""Regression tests for the source Electron launcher."""

from __future__ import annotations

import os
import threading
import tomllib
from pathlib import Path
from unittest.mock import patch

from wayper.server.launcher import (
    _electron_command,
    _electron_dependencies_ready,
    _icon_path,
    _wait_for_api,
    run_app,
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


def test_unified_entry_point_keeps_legacy_alias() -> None:
    project_root = Path(__file__).resolve().parents[1]
    metadata = tomllib.loads((project_root / "pyproject.toml").read_text(encoding="utf-8"))

    assert metadata["project"]["scripts"]["wayper"] == "wayper.cli:cli"
    assert metadata["project"]["scripts"]["wayper-gui"] == "wayper.server.launcher:run_app"
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


def test_source_launcher_stops_api_after_electron_exits(tmp_path: Path) -> None:
    electron_dir = tmp_path / "electron"
    electron_dir.mkdir()
    api_stopped = threading.Event()

    def fake_api(stop_event: threading.Event) -> None:
        assert stop_event.wait(timeout=1)
        api_stopped.set()

    process = type(
        "FakeProcess",
        (),
        {"wait": lambda self: 0, "poll": lambda self: 0, "terminate": lambda self: None},
    )()

    with (
        patch("wayper.autostart.ensure_default_autostart"),
        patch("wayper.config.load_config"),
        patch("wayper.server.launcher.run_api", side_effect=fake_api),
        patch("wayper.server.launcher._wait_for_api", return_value=43210),
        patch("wayper.server.launcher._electron_workdir", return_value=electron_dir),
        patch("wayper.server.launcher._electron_dependencies_ready", return_value=True),
        patch("wayper.server.launcher._electron_command", return_value=["electron"]) as command,
        patch("wayper.server.launcher._icon_path", return_value=None),
        patch("wayper.server.launcher.subprocess.Popen", return_value=process),
        patch("wayper.server.launcher.signal.signal"),
    ):
        run_app(arguments=["--hidden"])

    assert api_stopped.is_set()
    command.assert_called_once_with(electron_dir, arguments=["--hidden"])
