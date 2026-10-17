"""Regression tests for packaged API server startup."""

from __future__ import annotations

import sys
import threading
from pathlib import Path

import uvicorn

from wayper.server import api


def test_api_run_does_not_require_console_streams(monkeypatch, tmp_path: Path) -> None:
    captured: dict[str, object] = {}

    def fake_run(application, **kwargs: object) -> None:
        captured.update(kwargs)
        uvicorn.Config(application, **kwargs)

    monkeypatch.setattr(api, "_find_free_port", lambda: 12345)
    monkeypatch.setattr(api, "port_file", lambda: tmp_path / "api.port")
    monkeypatch.setattr(api.log, "info", lambda *args: None)
    monkeypatch.setattr("atexit.register", lambda callback, *args: callback)
    monkeypatch.setattr(uvicorn, "run", fake_run)
    monkeypatch.setattr("wayper.logging.setup_logging", lambda: None)
    monkeypatch.setattr(sys, "stdout", None)
    monkeypatch.setattr(sys, "stderr", None)

    api.run()

    assert captured["log_config"] is None
    assert (tmp_path / "api.port").read_text() == "12345"


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


def test_api_run_honors_launcher_stop_event(monkeypatch, tmp_path: Path) -> None:
    stop_event = threading.Event()
    server_ran = threading.Event()
    captured: dict[str, object] = {}

    class FakeServer:
        def __init__(self, config: object) -> None:
            captured["config"] = config
            self.should_exit = False
            captured["server"] = self

        def run(self) -> None:
            server_ran.set()
            assert stop_event.wait(timeout=1)
            for _ in range(100):
                if self.should_exit:
                    return
                threading.Event().wait(0.001)
            raise AssertionError("API stop watcher did not request shutdown")

    monkeypatch.setattr(api, "_find_free_port", lambda: 12345)
    monkeypatch.setattr(api, "port_file", lambda: tmp_path / "api.port")
    monkeypatch.setattr(api.log, "info", lambda *args: None)
    monkeypatch.setattr("atexit.register", lambda callback, *args: callback)
    monkeypatch.setattr(uvicorn, "Server", FakeServer)
    monkeypatch.setattr("wayper.logging.setup_logging", lambda: None)

    api_thread = threading.Thread(target=api.run, args=(stop_event,))
    api_thread.start()
    assert server_ran.wait(timeout=1)
    stop_event.set()
    api_thread.join(timeout=1)

    assert not api_thread.is_alive()
    assert isinstance(captured["config"], uvicorn.Config)


def _hold_lock_in_child(lock_path: Path, recorded_pid: str):
    """Hold an flock on ``lock_path`` from a separate non-wayper process."""
    import subprocess

    code = (
        "import fcntl, os, sys, time\n"
        "fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT)\n"
        "fcntl.flock(fd, fcntl.LOCK_EX)\n"
        "os.ftruncate(fd, 0); os.write(fd, sys.argv[2].encode())\n"
        "print('ready', flush=True)\n"
        "time.sleep(30)\n"
    )
    proc = subprocess.Popen(
        [sys.executable, "-c", code, str(lock_path), recorded_pid],
        stdout=subprocess.PIPE,
        text=True,
    )
    assert proc.stdout is not None and proc.stdout.readline().strip() == "ready"
    return proc


def test_stale_api_lock_with_dead_pid_is_reclaimed(monkeypatch, tmp_path: Path) -> None:
    import pytest

    if sys.platform == "win32":
        pytest.skip("flock-based test")
    monkeypatch.setattr(api, "port_file", lambda: tmp_path / "api.port")
    monkeypatch.setattr(api, "_pid_is_wayper", lambda pid: False)
    lock_path = tmp_path / "api.lock"
    (tmp_path / "api.port").write_text("1")
    proc = _hold_lock_in_child(lock_path, "999999 1")
    try:
        lock = api._acquire_api_lock()
        assert lock is not None
        assert api._read_lock_owner(lock_path) == __import__("os").getpid()
        assert not (tmp_path / "api.port").exists()
        lock.__exit__(None, None, None)
    finally:
        proc.kill()
        proc.wait()


def test_live_wayper_api_lock_is_respected(monkeypatch, tmp_path: Path) -> None:
    import pytest

    if sys.platform == "win32":
        pytest.skip("flock-based test")
    monkeypatch.setattr(api, "port_file", lambda: tmp_path / "api.port")
    monkeypatch.setattr(api, "_pid_is_wayper", lambda pid: True)
    lock_path = tmp_path / "api.lock"
    proc = _hold_lock_in_child(lock_path, "4242 5555")
    try:
        assert api._acquire_api_lock() is None
        assert lock_path.exists()
    finally:
        proc.kill()
        proc.wait()


def test_lock_owner_parsing_and_liveness(tmp_path: Path) -> None:
    import os

    path = tmp_path / "api.lock"
    assert api._read_lock_owner(path) is None
    path.write_text("")
    assert api._read_lock_owner(path) is None
    path.write_text("123 4567\n")
    assert api._read_lock_owner(path) == 123
    assert api._pid_is_alive(os.getpid())
    assert not api._pid_is_alive(0)


def _spawn_fake_wayper_owner(lock_path: Path, record: str, *, ignore_term: bool = False):
    """Hold the API lock from a live process whose cmdline contains 'wayper'."""
    import subprocess

    code = (
        "import fcntl, os, signal, sys, time\n"
        "if sys.argv[3] == '1': signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
        "fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT)\n"
        "fcntl.flock(fd, fcntl.LOCK_EX)\n"
        "st = open(f'/proc/{os.getpid()}/stat').read().rsplit(')', 1)[1].split()[19]\n"
        "rec = sys.argv[2].replace('PID', f'pid={os.getpid()}').replace('START', f'start={st}')\n"
        "os.ftruncate(fd, 0); os.write(fd, rec.encode())\n"
        "print('ready', flush=True)\n"
        "time.sleep(60)\n"
    )
    proc = subprocess.Popen(
        [sys.executable, "-c", code, str(lock_path), record, "1" if ignore_term else "0", "wayper"],
        stdout=subprocess.PIPE,
        text=True,
    )
    assert proc.stdout is not None and proc.stdout.readline().strip() == "ready"
    return proc


def _fast_probes(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(api, "port_file", lambda: tmp_path / "api.port")
    monkeypatch.setattr(api, "API_PROBE_ATTEMPTS", 3)
    monkeypatch.setattr(api, "API_PROBE_INTERVAL", 0.05)
    monkeypatch.setattr(api, "OWNER_TERM_TIMEOUT", 0.5)


def _linux_only() -> None:
    import pytest

    if not sys.platform.startswith("linux"):
        pytest.skip("requires /proc and flock")


def test_hung_wayper_owner_with_dead_port_is_terminated(monkeypatch, tmp_path: Path) -> None:
    _linux_only()
    _fast_probes(monkeypatch, tmp_path)
    dead_port = api._find_free_port()
    lock_path = tmp_path / "api.lock"
    (tmp_path / "api.port").write_text(str(dead_port))
    proc = _spawn_fake_wayper_owner(lock_path, f"PID port={dead_port} START", ignore_term=True)
    try:
        lock = api._acquire_api_lock()
        assert lock is not None
        assert proc.wait(timeout=5) is not None  # SIGKILLed after ignoring SIGTERM
        assert not api.takeover_file().exists()  # marker removed after takeover
        assert api._read_lock_owner(lock_path) == __import__("os").getpid()
        assert not (tmp_path / "api.port").exists()
        lock.__exit__(None, None, None)
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()


def test_responsive_wayper_owner_is_reused(monkeypatch, tmp_path: Path) -> None:
    from http.server import BaseHTTPRequestHandler, HTTPServer

    _linux_only()
    _fast_probes(monkeypatch, tmp_path)

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(200)
            self.end_headers()

        def log_message(self, *args: object) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    lock_path = tmp_path / "api.lock"
    proc = _spawn_fake_wayper_owner(lock_path, f"PID port={port} START")
    try:
        assert api._acquire_api_lock() is None
        assert proc.poll() is None
        assert not api.takeover_file().exists()
    finally:
        server.shutdown()
        proc.kill()
        proc.wait()


def test_starting_wayper_owner_within_timeout_is_respected(monkeypatch, tmp_path: Path) -> None:
    import os

    _linux_only()
    _fast_probes(monkeypatch, tmp_path)
    lock_path = tmp_path / "api.lock"
    proc = _spawn_fake_wayper_owner(lock_path, "PID START")
    try:
        assert api._acquire_api_lock() is None
        assert proc.poll() is None
        # Once the startup window has passed without a port, it counts as hung.
        old = lock_path.stat().st_mtime - api.API_STARTUP_TIMEOUT - 5
        os.utime(lock_path, (old, old))
        lock = api._acquire_api_lock()
        assert lock is not None
        assert proc.wait(timeout=5) is not None
        lock.__exit__(None, None, None)
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()


def test_never_signals_unverified_pid(monkeypatch) -> None:
    sent: list[int] = []
    monkeypatch.setattr(api, "_pid_verified_wayper", lambda pid, start=None: False)
    monkeypatch.setattr(api.os, "kill", lambda pid, sig: sent.append(pid))
    assert api._terminate_hung_owner(4242, 1) is False
    assert sent == []


def test_start_time_mismatch_blocks_takeover(monkeypatch, tmp_path: Path) -> None:
    _linux_only()
    _fast_probes(monkeypatch, tmp_path)
    dead_port = api._find_free_port()
    lock_path = tmp_path / "api.lock"
    proc = _spawn_fake_wayper_owner(lock_path, f"PID port={dead_port} start=1")
    try:
        assert api._acquire_api_lock() is None
        assert proc.poll() is None
    finally:
        proc.kill()
        proc.wait()


def test_lock_record_includes_start_time(tmp_path: Path) -> None:
    import os

    path = tmp_path / "api.lock"
    api._write_lock_owner(path, 5555)
    fields = api._read_lock_fields(path)
    assert fields["pid"] == os.getpid() and fields["port"] == 5555
    if sys.platform.startswith("linux"):
        assert fields["start"] == api._pid_start_time(os.getpid())


def test_stale_takeover_marker_is_removed_on_startup(monkeypatch, tmp_path: Path) -> None:
    import os
    import subprocess
    import time

    monkeypatch.setattr(api, "port_file", lambda: tmp_path / "api.port")
    marker = api.takeover_file()
    now = int(time.time())
    dead = subprocess.run(
        [sys.executable, "-c", "import os; print(os.getpid())"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    for content in (
        f"pid={dead} start=1 ts={now}",  # dead pid
        f"pid={os.getpid()} start=1 ts={now}",  # start-time mismatch
        f"pid={os.getpid()} start={api._pid_start_time(os.getpid())} ts={now - 120}",  # old
    ):
        marker.write_text(content)
        lock = api._acquire_api_lock()
        assert lock is not None
        assert not marker.exists(), content
        lock.__exit__(None, None, None)


def test_valid_takeover_marker_is_kept_on_startup(monkeypatch, tmp_path: Path) -> None:
    import os
    import time

    if not sys.platform.startswith("linux"):
        import pytest

        pytest.skip("requires /proc")
    monkeypatch.setattr(api, "port_file", lambda: tmp_path / "api.port")
    marker = api.takeover_file()
    pid = os.getpid()
    marker.write_text(f"pid={pid} start={api._pid_start_time(pid)} ts={int(time.time())}")
    api._remove_stale_takeover_marker()
    assert marker.exists()
