from __future__ import annotations

import json
import subprocess
from pathlib import Path

from wayper import trash
from wayper.config import WayperConfig


def test_windows_recycle_bin_lookup_and_token_share_snapshot(tmp_path, monkeypatch) -> None:
    payload = json.dumps(
        [
            {"Name": "wanted.jpg", "Path": r"C:\$Recycle.Bin\sid\$R1.jpg"},
            {"Name": "other.png", "Path": r"C:\$Recycle.Bin\sid\$R2.png"},
        ]
    )
    calls = 0

    def fake_run(*args, **kwargs):
        nonlocal calls
        calls += 1
        return subprocess.CompletedProcess(args[0], 0, payload, "")

    monkeypatch.setattr(trash.sys, "platform", "win32")
    monkeypatch.setattr(trash.subprocess, "run", fake_run)
    monkeypatch.setattr(trash, "_windows_recycle_cache", None)
    config = WayperConfig(download_dir=tmp_path)

    token = trash.trash_state_token(config)
    found = trash.find_many_in_trash(config, {"wanted.jpg", "missing.jpg"})

    assert token[1] != 0
    assert found == {"wanted.jpg": Path(r"C:\$Recycle.Bin\sid\$R1.jpg")}
    assert trash.find_in_trash(config, "other.png") == Path(r"C:\$Recycle.Bin\sid\$R2.png")
    assert calls == 1


def test_windows_recycle_bin_lookup_tolerates_invalid_output(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(trash.sys, "platform", "win32")
    monkeypatch.setattr(
        trash.subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, "not-json", ""),
    )
    monkeypatch.setattr(trash, "_windows_recycle_cache", None)

    assert trash.find_many_in_trash(WayperConfig(download_dir=tmp_path), {"image.jpg"}) == {}
