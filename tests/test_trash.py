from __future__ import annotations

import json
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

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


@pytest.mark.parametrize("failure", [None, "timeout", "invalid", "exit"])
def test_slow_recycle_scan_is_cached_from_completion(tmp_path, monkeypatch, failure):
    clock = [0.0]
    calls = []

    def scan(*args, **kwargs):
        calls.append(args)
        clock[0] += 15.0
        if failure == "timeout":
            raise subprocess.TimeoutExpired("powershell", 15)
        output = (
            "invalid"
            if failure == "invalid"
            else json.dumps(
                [
                    {"Name": "image.jpg", "Path": str(tmp_path / "recycled.jpg")},
                ]
            )
        )
        return subprocess.CompletedProcess(args[0], 1 if failure == "exit" else 0, output, "")

    monkeypatch.setattr(trash, "_windows_recycle_cache", None)
    monkeypatch.setattr(trash.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(trash.subprocess, "run", scan)
    first = trash._windows_recycle_bin_items()
    assert bool(first) is (failure is None)
    assert trash._windows_recycle_bin_items() == first
    assert len(calls) == 1

    clock[0] += 2
    trash._windows_recycle_bin_items()
    assert len(calls) == 2, "even failed scans should be retried after expiry"


def test_concurrent_recycle_requests_share_one_scan(tmp_path, monkeypatch):
    started = threading.Event()
    release = threading.Event()
    both_calling = threading.Barrier(2)
    calls = []

    def scan(*args, **kwargs):
        calls.append(args)
        started.set()
        assert release.wait(5)
        return subprocess.CompletedProcess(args[0], 0, "[]", "")

    def lookup():
        both_calling.wait(timeout=5)
        return trash._windows_recycle_bin_items()

    monkeypatch.setattr(trash, "_windows_recycle_cache", None)
    monkeypatch.setattr(trash.subprocess, "run", scan)
    with ThreadPoolExecutor(max_workers=2) as executor:
        requests = [executor.submit(lookup) for _ in range(2)]
        try:
            assert started.wait(5)
        finally:
            release.set()
        assert [request.result(timeout=5) for request in requests] == [{}, {}]
    assert len(calls) == 1

    trash._invalidate_windows_recycle_cache()
    trash._windows_recycle_bin_items()
    assert len(calls) == 2
