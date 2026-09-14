"""Tests for shared file utilities."""

from __future__ import annotations

import os

from wayper import util


def test_atomic_write_uses_utf8(tmp_path):
    path = tmp_path / "config.toml"

    util.atomic_write(path, 'download_dir = "壁纸 🌄"\n', encoding="utf-8")

    assert path.read_text(encoding="utf-8") == 'download_dir = "壁纸 🌄"\n'


def test_windows_atomic_write_retries_transient_replace_failure(tmp_path, monkeypatch):
    path = tmp_path / "config.toml"
    real_replace = os.replace
    attempts = 0

    def transient_replace(source, destination):
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise PermissionError("sharing violation")
        real_replace(source, destination)

    monkeypatch.setattr(util, "_IS_WINDOWS", True)
    monkeypatch.setattr(util.os, "replace", transient_replace)
    monkeypatch.setattr(util.time, "sleep", lambda _delay: None)

    util.atomic_write(path, 'filter_strategy = "model"\n')

    assert attempts == 3
    assert path.read_text(encoding="utf-8") == 'filter_strategy = "model"\n'
