from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

from wayper.process import windows_no_window_kwargs
from wayper.server import api as _api
from wayper.server.api import port_file, takeover_in_progress
from wayper.server.api import run as run_api


def _electron_workdir(src: Path) -> Path:
    """Return a writable dir to build/run the Electron front-end in.

    Uses the bundled ``electron/`` dir if it's writable (dev checkout), else
    mirrors it into ``$XDG_CACHE_HOME`` so ``npm install`` works on read-only
    system installs.
    """
    if os.access(src, os.W_OK):
        return src

    cache = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "wayper" / "electron"
    cache.mkdir(parents=True, exist_ok=True)

    # If the installed lockfile differs from the cached copy (e.g. after an
    # upgrade), drop the stale node_modules so deps get reinstalled below.
    src_lock = src / "package-lock.json"
    cache_lock = cache / "package-lock.json"
    if src_lock.is_file() and cache_lock.is_file():
        if src_lock.read_bytes() != cache_lock.read_bytes():
            shutil.rmtree(cache / "node_modules", ignore_errors=True)

    for item in src.iterdir():
        if item.name == "node_modules":
            continue
        dest = cache / item.name
        if item.is_dir():
            shutil.copytree(item, dest, dirs_exist_ok=True)
        else:
            shutil.copy2(item, dest)

    return cache


def _npm_executable(platform: str | None = None) -> str:
    """Return the npm launcher appropriate for the current platform."""
    platform = platform or sys.platform
    return "npm.cmd" if platform == "win32" else "npm"


def _icon_path() -> Path | None:
    """Find an icon that Electron can use for source and wheel launches."""
    candidates = [
        Path(__file__).resolve().parents[2] / "assets" / "icon-256.png",
        Path(sys.prefix) / "share" / "icons" / "hicolor" / "256x256" / "apps" / "wayper.png",
    ]
    return next((candidate for candidate in candidates if candidate.is_file()), None)


def _hide_windows_console_for_gui_entry() -> None:
    """Hide the console allocated by the resilient Windows GUI entry point."""
    if sys.platform != "win32" or Path(sys.argv[0]).stem.lower() not in {"wayper", "wayper-gui"}:
        return
    try:
        import ctypes

        console = ctypes.windll.kernel32.GetConsoleWindow()
        if console:
            ctypes.windll.user32.ShowWindow(console, 0)
    except (AttributeError, OSError):
        pass


def _electron_command(
    electron_dir: Path,
    platform: str | None = None,
    arguments: list[str] | None = None,
) -> list[str]:
    """Build a directly executable Electron command for development launches."""
    platform = platform or sys.platform
    arguments = arguments or []
    if platform == "win32":
        # node_modules/.bin/electron is a POSIX shell script even on Windows.
        # CreateProcess cannot execute it and raises WinError 193, so use the
        # native binary installed by the electron package instead.
        electron_bin = electron_dir / "node_modules" / "electron" / "dist" / "electron.exe"
    else:
        electron_bin = electron_dir / "node_modules" / ".bin" / "electron"

    if electron_bin.exists():
        return [str(electron_bin), ".", *arguments]
    command = [_npm_executable(platform), "start"]
    return [*command, "--", *arguments] if arguments else command


def _electron_dependencies_ready(electron_dir: Path) -> bool:
    """Require both current dependencies and a complete Electron installation.

    npm can successfully install the JS package while blocking its postinstall
    script. The lock and .bin shim then exist, but the actual runtime does not.
    """
    try:
        installed = electron_dir / "node_modules" / ".package-lock.json"
        source = electron_dir / "package-lock.json"
        if installed.stat().st_mtime_ns < source.stat().st_mtime_ns:
            return False
        package = electron_dir / "node_modules" / "electron"
        relative_binary = (package / "path.txt").read_text(encoding="utf-8").strip()
        binary = package / "dist" / relative_binary
        version = json.loads((package / "package.json").read_text(encoding="utf-8"))["version"]
        installed_version = (package / "dist" / "version").read_text(encoding="utf-8").strip()
        return (
            bool(relative_binary)
            and binary.resolve().is_relative_to((package / "dist").resolve())
            and binary.is_file()
            and installed_version.removeprefix("v") == version
        )
    except (OSError, ValueError, KeyError, TypeError):
        return False


TAKEOVER_WAIT_TIMEOUT = 30.0
# Electron exits with this code when another Wayper window already holds the
# single-instance lock (see main.js). That window still needs our backend.
SECOND_INSTANCE_EXIT_CODE = 75


ADOPTED_REGISTER_TIMEOUT = 60.0
ADOPTED_POLL_SECONDS = 2.0


def _serve_adopted_window(
    api_thread: threading.Thread,
    stop_event: threading.Event,
    *,
    register_timeout: float = ADOPTED_REGISTER_TIMEOUT,
    poll: float = ADOPTED_POLL_SECONDS,
) -> None:
    """Serve the window that adopted this backend until its process exits.

    The existing Electron app registers its main-process pid (+ start time)
    via ``POST /api/client`` when it reconnects. Shut down like a normal
    close once that process is gone, or if nobody registers in time.
    Independent of request traffic, so tray mode and suspend are safe.
    """
    started = time.monotonic()
    while api_thread.is_alive():
        api_thread.join(poll)
        if not api_thread.is_alive():
            return
        client = _api.adopted_client()
        if client is None:
            if time.monotonic() - started < register_timeout:
                continue
            print("No Wayper window adopted this backend; shutting down")
        elif _api.adopted_client_alive(client):
            continue
        else:
            print(f"Wayper window process {client[0]} exited; shutting down")
        stop_event.set()
        api_thread.join()
        return


def _keep_serving_for_existing_window(returncode: int | None, api_thread: threading.Thread) -> bool:
    """True when our Electron lost the single-instance lock but we own the API."""
    return returncode == SECOND_INSTANCE_EXIT_CODE and api_thread.is_alive()


class _ApiDeadline:
    """Base deadline that is extended (stickily) once a takeover is seen."""

    def __init__(self, timeout: float, max_timeout: float) -> None:
        self._start = time.monotonic()
        self._timeout = timeout
        self._max_timeout = max(timeout, max_timeout)
        self._extended = False

    def expired(self) -> bool:
        now = time.monotonic()
        if now < self._start + self._timeout:
            return False
        if not self._extended and takeover_in_progress():
            self._extended = True
        return not self._extended or now >= self._start + self._max_timeout


def _read_port(pf: Path) -> int:
    try:
        return int(pf.read_text().strip())
    except (OSError, ValueError):
        return 0


def _wait_for_api(timeout: float = 10, max_timeout: float = TAKEOVER_WAIT_TIMEOUT) -> int:
    """Poll API port file and then the API until it responds. Returns the port.

    The base ``timeout`` is extended up to ``max_timeout`` (total) when a
    backend is taking over the API lock from a hung instance (``api.takeover``).
    """
    pf = port_file()
    deadline = _ApiDeadline(timeout, max_timeout)
    port = 0
    while not deadline.expired():
        port = _read_port(pf)
        if port > 0:
            break
        time.sleep(0.2)

    if port <= 0:
        print("Warning: API port file not found within timeout, launching Electron anyway")
        return 0

    # Readiness must stay cheap.  ``/api/status`` inspects the wallpaper
    # library and model-review state, so retrying it while startup is still
    # busy can stack several expensive requests in the server thread pool.
    # Re-read the port file each round: a takeover replaces a hung backend's port.
    while not deadline.expired():
        port = _read_port(pf) or port
        try:
            urlopen(f"http://127.0.0.1:{port}/api/config", timeout=1)
            return port
        except (URLError, OSError):
            time.sleep(0.2)
    print("Warning: API did not respond within timeout, launching Electron anyway")
    return port


def run_app(arguments: list[str] | None = None) -> None:
    _hide_windows_console_for_gui_entry()

    # Autostart defaults on. The first manual launch installs the platform login
    # entry for subsequent sessions; an explicit false setting is left alone.
    try:
        from wayper.autostart import AutostartError, ensure_default_autostart
        from wayper.config import load_config

        ensure_default_autostart(load_config())
    except AutostartError as error:
        print(f"Warning: could not install Wayper autostart: {error}")

    # Validate the desktop runtime before starting a non-daemon API thread.
    # Installation errors must not leave an invisible backend running forever.
    electron_dir = _electron_workdir(Path(__file__).parent.parent / "electron")
    if not _electron_dependencies_ready(electron_dir):
        print("Installing dependencies...")
        subprocess.check_call(
            [_npm_executable(), "ci"],
            cwd=electron_dir,
            **windows_no_window_kwargs(),
        )
        if not _electron_dependencies_ready(electron_dir):
            raise RuntimeError(
                "Electron installation is incomplete. Its install script may have been blocked. "
                f"Run 'npm rebuild electron' in {electron_dir} and try again."
            )

    # Keep the source-mode API in this process, but give it an explicit shutdown
    # signal.  Letting a daemon server thread outlive Electron starts Python's
    # interpreter shutdown while Uvicorn is still serving requests, leaving a
    # stale backend whose asyncio executor can no longer run rotation work.
    api_stop_event = threading.Event()
    api_thread = threading.Thread(
        target=run_api,
        args=(api_stop_event,),
        name="wayper-api",
    )
    api_thread.start()

    port = _wait_for_api()

    print(f"Starting Electron in {electron_dir}...")

    # Run Electron directly where possible so cleanup tracks the actual app PID.
    cmd = _electron_command(
        electron_dir, arguments=sys.argv[1:] if arguments is None else arguments
    )

    # Pass API port to Electron so preload.js can pick it up
    env = {**os.environ, "WAYPER_DEV": "1"}
    if port > 0:
        env["WAYPER_API_PORT"] = str(port)
    if icon_path := _icon_path():
        env["WAYPER_ICON_PATH"] = str(icon_path)

    # Start Electron
    proc = subprocess.Popen(
        cmd,
        cwd=electron_dir,
        env=env,
        **windows_no_window_kwargs(),
    )

    def cleanup(signum, frame):
        print("Cleaning up...")
        if proc.poll() is None:
            proc.terminate()
        sys.exit(0)

    # Register signal handlers
    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)

    try:
        returncode = proc.wait()
        if _keep_serving_for_existing_window(returncode, api_thread):
            # E.g. right after taking over from a hung backend: the original
            # window reconnects to this API, so stay up until signalled.
            print("Another Wayper window is running; keeping the API server alive for it")
            _serve_adopted_window(api_thread, api_stop_event)
    except KeyboardInterrupt:
        cleanup(None, None)
    finally:
        if proc.poll() is None:
            proc.terminate()
        api_stop_event.set()
        api_thread.join()


if __name__ == "__main__":
    run_app()
