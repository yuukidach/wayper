"""Regression tests for packaged API server startup."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest
import uvicorn
from fastapi.testclient import TestClient

from wayper.server import api


def test_api_run_does_not_require_console_streams(monkeypatch, tmp_path: Path) -> None:
    captured: dict[str, object] = {}

    def fake_run(application, **kwargs: object) -> None:
        captured.update(kwargs)
        uvicorn.Config(application, **kwargs)
        assert (tmp_path / "api.port").read_text() == "12345"

    monkeypatch.setattr(api, "_find_free_port", lambda: 12345)
    monkeypatch.setattr(api, "port_file", lambda: tmp_path / "api.port")
    monkeypatch.setattr(api.log, "info", lambda *args: None)
    monkeypatch.setattr(uvicorn, "run", fake_run)
    monkeypatch.setattr("wayper.logging.setup_logging", lambda: None)
    monkeypatch.setattr(sys, "stdout", None)
    monkeypatch.setattr(sys, "stderr", None)

    api.run()

    assert captured["log_config"] is None
    assert not (tmp_path / "api.port").exists()


def test_api_run_skips_a_second_backend(monkeypatch, tmp_path: Path) -> None:
    run_calls: list[object] = []

    monkeypatch.setattr(api, "port_file", lambda: tmp_path / "api.port")
    monkeypatch.setattr(api, "_acquire_api_lock", lambda: None)
    monkeypatch.setattr(api.log, "info", lambda *args: None)
    monkeypatch.setattr(uvicorn, "run", lambda application, **kwargs: run_calls.append(application))
    monkeypatch.setattr("wayper.logging.setup_logging", lambda: None)

    api.run()

    assert run_calls == []
    assert not (tmp_path / "api.port").exists()


def test_api_port_cleanup_does_not_remove_another_instances_file(tmp_path: Path) -> None:
    port_path = tmp_path / "api.port"
    port_path.write_text("54321")

    api._remove_owned_port_file(port_path, 12345)

    assert port_path.read_text() == "54321"

    port_path.write_text("12345")
    api._remove_owned_port_file(port_path, 12345)

    assert not port_path.exists()


def test_failed_server_cleans_up_before_releasing_lock(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(api, "_find_free_port", lambda: 12345)
    monkeypatch.setattr(api, "port_file", lambda: tmp_path / "api.port")
    monkeypatch.setattr("wayper.logging.setup_logging", lambda: None)

    def fail(*args, **kwargs):
        assert api._acquire_api_lock() is None
        raise RuntimeError("startup failed")

    monkeypatch.setattr(uvicorn, "run", fail)
    with pytest.raises(RuntimeError, match="startup failed"):
        api.run()

    assert not api.port_file().exists()
    lock = api._acquire_api_lock()
    assert lock is not None
    try:
        assert api._acquire_api_lock() is None
    finally:
        lock.__exit__(None, None, None)


def test_health_does_not_load_wallpaper_or_config(monkeypatch) -> None:
    def unexpected():
        raise AssertionError("health must not load application state")

    monkeypatch.setattr(api, "get_config", unexpected)
    response = TestClient(api.app).get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"service": "wayper"}


def test_killed_owner_releases_same_lock_file(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(api, "port_file", lambda: tmp_path / "api.port")
    lock_path = tmp_path / "api.lock"
    # Contents left by old versions do not confer ownership of an OS lock.
    lock_path.write_text("pid=999999 port=12345 start=1")
    code = (
        "import sys\n"
        "from pathlib import Path\n"
        "from wayper.lock import FileLock\n"
        "with FileLock(blocking=False, path=Path(sys.argv[1])):\n"
        "    print('ready', flush=True)\n"
        "    sys.stdin.read()\n"
    )
    child = subprocess.Popen(
        [sys.executable, "-c", code, str(lock_path)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        assert child.stdout.readline().strip() == "ready"
        inode = lock_path.stat().st_ino
        assert api._acquire_api_lock() is None
        child.kill()
        child.wait(timeout=5)

        lock = api._acquire_api_lock()
        assert lock is not None
        try:
            assert lock_path.stat().st_ino == inode
            assert api._acquire_api_lock() is None
        finally:
            lock.__exit__(None, None, None)
        assert lock_path.read_text() == "pid=999999 port=12345 start=1"
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)
        child.stdin.close()
        child.stdout.close()


def test_simultaneous_launches_share_one_lock(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(api, "port_file", lambda: tmp_path / "api.port")
    lock_path = tmp_path / "api.lock"
    code = (
        "import sys\n"
        "from pathlib import Path\n"
        "from wayper.lock import FileLock\n"
        "sys.stdin.readline()\n"
        "try:\n"
        "    with FileLock(blocking=False, path=Path(sys.argv[1])):\n"
        "        print('owner', flush=True)\n"
        "        sys.stdin.read()\n"
        "except SystemExit:\n"
        "    print('busy', flush=True)\n"
    )
    children = []
    try:
        for _ in range(4):
            children.append(
                subprocess.Popen(
                    [sys.executable, "-c", code, str(lock_path)],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    text=True,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
            )
        for child in children:
            child.stdin.write("go\n")
            child.stdin.flush()
        outcomes = [child.stdout.readline().strip() for child in children]
        assert outcomes.count("owner") == 1
        assert outcomes.count("busy") == 3
        # An empty/legacy lock record must not bypass the actual OS owner.
        assert api._acquire_api_lock() is None
    finally:
        for child in children:
            child.stdin.close()
            child.wait(timeout=5)
            child.stdout.close()
