"""Regression tests for the source Electron launcher."""

from __future__ import annotations

import subprocess
import threading
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
        patch("wayper.server.launcher.threading.Thread") as thread,
    ):
        if install_error:
            install.side_effect = subprocess.CalledProcessError(1, ["npm", "ci"])
        expected = subprocess.CalledProcessError if install_error else RuntimeError
        with pytest.raises(expected):
            run_app()
    thread.assert_not_called()


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


def _marker_env(monkeypatch, tmp_path):
    from wayper.server import api, launcher

    monkeypatch.setattr(api, "port_file", lambda: tmp_path / "api.port")
    monkeypatch.setattr(launcher, "port_file", lambda: tmp_path / "api.port")
    monkeypatch.setattr(launcher.time, "sleep", lambda s: None)
    return api, launcher


def test_wait_for_api_extends_deadline_during_takeover(monkeypatch, tmp_path) -> None:
    import os
    import sys
    import time as real_time

    import pytest

    if not sys.platform.startswith("linux"):
        pytest.skip("requires /proc")
    api, launcher = _marker_env(monkeypatch, tmp_path)
    clock = [0.0]
    monkeypatch.setattr(launcher.time, "monotonic", lambda: clock[0])
    pid = os.getpid()
    api.takeover_file().write_text(
        f"pid={pid} start={api._pid_start_time(pid)} ts={int(real_time.time())}"
    )
    calls: list[float] = []

    def fake_urlopen(url, timeout):
        calls.append(clock[0])
        clock[0] += 1.0
        if clock[0] < 20:
            raise OSError("not yet")
        if api.takeover_file().exists():
            api.takeover_file().unlink()  # takeover finished; extension must stick
        if clock[0] < 22:
            raise OSError("starting")

    (tmp_path / "api.port").write_text("4321")
    monkeypatch.setattr(launcher, "urlopen", fake_urlopen)
    assert launcher._wait_for_api(timeout=10, max_timeout=30) == 4321
    assert max(calls) > 10


def test_dead_pid_takeover_marker_does_not_extend_wait(monkeypatch, tmp_path) -> None:
    import subprocess
    import sys
    import time as real_time

    api, launcher = _marker_env(monkeypatch, tmp_path)
    clock = [0.0]
    monkeypatch.setattr(launcher.time, "monotonic", lambda: clock[0])
    dead = subprocess.run(
        [sys.executable, "-c", "import os; print(os.getpid())"],
        capture_output=True,
        text=True,
        check=True,
    )
    api.takeover_file().write_text(f"pid={dead.stdout.strip()} start=1 ts={int(real_time.time())}")
    assert api.takeover_in_progress() is False

    def fake_urlopen(url, timeout):
        clock[0] += 1.0
        raise OSError("down")

    (tmp_path / "api.port").write_text("4321")
    monkeypatch.setattr(launcher, "urlopen", fake_urlopen)
    launcher._wait_for_api(timeout=10, max_timeout=30)
    assert clock[0] <= 11


def test_takeover_marker_validation(tmp_path, monkeypatch) -> None:
    import os
    import time as real_time

    api, _ = _marker_env(monkeypatch, tmp_path)
    pid, now = os.getpid(), int(real_time.time())
    start = api._pid_start_time(pid)
    path = api.takeover_file()
    assert api.takeover_in_progress() is False
    path.write_text(f"pid={pid} start={start} ts={now - 120}")
    assert api.takeover_in_progress() is False  # older than 60s
    path.write_text(f"pid={pid} start=1 ts={now}")
    assert api.takeover_in_progress() is False  # start time mismatch (PID reuse)
    api._write_takeover_marker()
    if start is not None:
        assert api.takeover_in_progress() is True
    api._clear_takeover_marker()
    assert not path.exists()


def test_backend_keeps_serving_when_electron_loses_single_instance_lock() -> None:
    import threading

    from wayper.server import launcher

    alive = threading.Thread(target=threading.Event().wait, args=(0.2,))
    alive.start()
    try:
        code = launcher.SECOND_INSTANCE_EXIT_CODE
        assert launcher._keep_serving_for_existing_window(code, alive) is True
        assert launcher._keep_serving_for_existing_window(0, alive) is False
    finally:
        alive.join()
    # No API thread (another backend owns the lock): exit as before.
    assert launcher._keep_serving_for_existing_window(code, alive) is False


def test_run_app_waits_for_api_thread_after_second_instance_exit(tmp_path) -> None:
    import threading
    from unittest.mock import patch

    from wayper.server import launcher
    from wayper.server.launcher import run_app

    served: list[str] = []

    def fake_api(stop_event):
        # Serve until the launcher is signalled; a short sleep simulates that.
        served.append("start")
        stop_event.wait(0.3)
        served.append("stopped" if stop_event.is_set() else "still-serving")

    process = type(
        "FakeProcess",
        (),
        {
            "wait": lambda self: launcher.SECOND_INSTANCE_EXIT_CODE,
            "poll": lambda self: launcher.SECOND_INSTANCE_EXIT_CODE,
            "terminate": lambda self: None,
        },
    )()
    with (
        patch("wayper.autostart.ensure_default_autostart"),
        patch("wayper.config.load_config"),
        patch("wayper.server.launcher.run_api", side_effect=fake_api),
        patch("wayper.server.launcher._wait_for_api", return_value=43210),
        patch("wayper.server.launcher._electron_workdir", return_value=tmp_path),
        patch("wayper.server.launcher._electron_dependencies_ready", return_value=True),
        patch("wayper.server.launcher._electron_command", return_value=["electron"]),
        patch("wayper.server.launcher._icon_path", return_value=None),
        patch("wayper.server.launcher.subprocess.Popen", return_value=process),
        patch("wayper.server.launcher.signal.signal"),
    ):
        run_app(arguments=[])

    # The stop event was not set when Electron exited with the second-instance code.
    assert served == ["start", "still-serving"]
    assert threading.active_count() >= 1


def _adopted_harness(monkeypatch, client_fn, alive_fn):
    import threading

    from wayper.server import launcher

    stop = threading.Event()
    api_thread = threading.Thread(target=stop.wait)
    api_thread.start()
    monkeypatch.setattr(launcher._api, "adopted_client", client_fn)
    monkeypatch.setattr(launcher._api, "adopted_client_alive", alive_fn)
    return launcher, stop, api_thread


def test_adopted_backend_stays_up_while_registered_pid_alive(monkeypatch) -> None:
    alive = {"value": True}
    launcher, stop, api_thread = _adopted_harness(
        monkeypatch, lambda: (1234, 99), lambda client: alive["value"]
    )
    import threading
    import time

    worker = threading.Thread(
        target=launcher._serve_adopted_window,
        args=(api_thread, stop),
        kwargs={"register_timeout": 0.05, "poll": 0.02},
    )
    worker.start()
    time.sleep(0.3)  # well past the registration timeout
    assert not stop.is_set() and worker.is_alive()
    alive["value"] = False  # the adopting Electron exits
    worker.join(2)
    assert stop.is_set() and not worker.is_alive()


def test_adopted_backend_stops_when_nobody_registers(monkeypatch) -> None:
    import time

    launcher, stop, api_thread = _adopted_harness(monkeypatch, lambda: None, lambda c: True)
    begun = time.monotonic()
    launcher._serve_adopted_window(api_thread, stop, register_timeout=0.2, poll=0.02)
    assert stop.is_set()
    assert time.monotonic() - begun >= 0.2


def test_client_registration_endpoint_records_pid_and_start(monkeypatch) -> None:
    import os
    import subprocess
    import sys

    from fastapi.testclient import TestClient

    from wayper.server import api

    monkeypatch.setattr(api, "_adopted_client", None)
    client = TestClient(api.app)
    pid = os.getpid()
    start = api._pid_start_time(pid)
    assert client.post("/api/client", json={"pid": pid, "start": start}).status_code == 200
    assert api.adopted_client() == (pid, start)
    assert api.adopted_client_alive(api.adopted_client())
    if start is not None:
        bad = client.post("/api/client", json={"pid": pid, "start": start + 1})
        assert bad.status_code == 400
        assert not api.adopted_client_alive((pid, start + 1))
    dead = int(
        subprocess.run(
            [sys.executable, "-c", "import os; print(os.getpid())"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    )
    assert client.post("/api/client", json={"pid": dead}).status_code == 400
    assert not api.adopted_client_alive((dead, None))
