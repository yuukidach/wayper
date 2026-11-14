"""Regression tests for the source Electron launcher."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from wayper.server.launcher import (
    _electron_command,
    _electron_dependencies_ready,
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


@pytest.mark.parametrize("missing", ["path.txt", "dist/electron", "dist/version"])
def test_current_lock_does_not_hide_incomplete_electron(tmp_path: Path, missing: str) -> None:
    _touch(tmp_path / "package-lock.json")
    _touch(tmp_path / "node_modules" / ".package-lock.json")
    package = tmp_path / "node_modules" / "electron"
    _touch(package / "dist" / "electron")
    (package / "path.txt").write_text("electron")
    (package / "package.json").write_text('{"version":"41.1.0"}')
    (package / "dist" / "version").write_text("41.1.0")
    assert _electron_dependencies_ready(tmp_path)
    (package / missing).unlink()
    assert not _electron_dependencies_ready(tmp_path)


@pytest.mark.parametrize("install_error", [False, True])
def test_failed_electron_install_does_not_start_backend(
    tmp_path: Path, install_error: bool
) -> None:
    with (
        patch("wayper.autostart.ensure_default_autostart"),
        patch("wayper.config.load_config"),
        patch("wayper.server.launcher._electron_workdir", return_value=tmp_path),
        patch("wayper.server.launcher._electron_dependencies_ready", return_value=False),
        patch("wayper.server.launcher.subprocess.check_call") as install,
        patch("wayper.server.launcher.subprocess.Popen") as launch,
    ):
        if install_error:
            install.side_effect = subprocess.CalledProcessError(1, ["npm", "ci"])
        expected = subprocess.CalledProcessError if install_error else RuntimeError
        with pytest.raises(expected):
            run_app()
    launch.assert_not_called()


def test_source_launcher_delegates_backend_to_electron(tmp_path: Path) -> None:
    electron_dir = tmp_path / "electron"
    electron_dir.mkdir()
    process = type(
        "FakeProcess",
        (),
        {"wait": lambda self: 0, "poll": lambda self: 0, "terminate": lambda self: None},
    )()

    with (
        patch("wayper.autostart.ensure_default_autostart"),
        patch("wayper.config.load_config"),
        patch("wayper.server.launcher._electron_workdir", return_value=electron_dir),
        patch("wayper.server.launcher._electron_dependencies_ready", return_value=True),
        patch("wayper.server.launcher._electron_command", return_value=["electron"]) as command,
        patch("wayper.server.launcher._icon_path", return_value=None),
        patch("wayper.server.launcher.subprocess.Popen", return_value=process) as launch,
        patch("wayper.server.launcher.signal.signal"),
    ):
        run_app(arguments=["--hidden"])

    command.assert_called_once_with(electron_dir, arguments=["--hidden"])
    launch.assert_called_once()
    assert launch.call_args.args[0] == ["electron"]
    env = launch.call_args.kwargs["env"]
    assert env["WAYPER_PYTHON"] == sys.executable
    assert env["PYTHONPATH"].split(os.pathsep)[0] == str(Path(__file__).resolve().parents[1])
