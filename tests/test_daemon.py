"""Regression tests for background daemon process selection."""

from __future__ import annotations

from pathlib import Path

from wayper.daemon import daemon_command


def test_windows_daemon_uses_windowed_python(tmp_path: Path) -> None:
    python = tmp_path / "python.exe"
    pythonw = tmp_path / "pythonw.exe"
    python.touch()
    pythonw.touch()

    assert daemon_command(executable=str(python), platform="nt", frozen=False) == [
        str(pythonw),
        "-m",
        "wayper.cli",
        "daemon",
    ]


def test_windows_daemon_falls_back_when_pythonw_is_missing(tmp_path: Path) -> None:
    python = tmp_path / "python.exe"
    python.touch()

    assert daemon_command(executable=str(python), platform="nt", frozen=False) == [
        str(python),
        "-m",
        "wayper.cli",
        "daemon",
    ]


def test_frozen_daemon_keeps_packaged_executable(tmp_path: Path) -> None:
    executable = tmp_path / "wayper-backend.exe"
    executable.touch()
    (tmp_path / "pythonw.exe").touch()

    assert daemon_command(executable=str(executable), platform="nt", frozen=True) == [
        str(executable),
        "daemon",
    ]
