"""Regression tests for the source Electron launcher."""

from __future__ import annotations

from pathlib import Path

from wayper.server.launcher import _electron_command


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
