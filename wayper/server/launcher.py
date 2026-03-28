from __future__ import annotations

import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

from wayper.server.api import run as run_api


def _wait_for_api(url: str = "http://127.0.0.1:8080/api/status", timeout: float = 10) -> None:
    """Poll API until it responds or timeout."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            urlopen(url, timeout=1)
            return
        except (URLError, OSError):
            time.sleep(0.2)
    print("Warning: API did not respond within timeout, launching Electron anyway")


def run_app():
    # Start API in a separate thread
    api_thread = threading.Thread(target=run_api, daemon=True)
    api_thread.start()

    _wait_for_api()

    # Electron directory
    electron_dir = Path(__file__).parent.parent / "electron"

    # Check dependencies first
    if not (electron_dir / "node_modules").exists():
        print("Installing dependencies...")
        subprocess.check_call(["npm", "install"], cwd=electron_dir)

    print(f"Starting Electron in {electron_dir}...")

    # Find electron executable to run directly (avoiding npm -> node -> electron chain)
    # This ensures we have the PID of the actual app to kill it later
    electron_bin = electron_dir / "node_modules" / ".bin" / "electron"

    if not electron_bin.exists():
        # Fallback to npm start if binary not found
        cmd = ["npm", "start"]
    else:
        cmd = [str(electron_bin), "."]

    # Start Electron
    proc = subprocess.Popen(cmd, cwd=electron_dir)

    def cleanup(signum, frame):
        print("Cleaning up...")
        if proc.poll() is None:
            proc.terminate()
        sys.exit(0)

    # Register signal handlers
    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)

    try:
        proc.wait()
    except KeyboardInterrupt:
        cleanup(None, None)
    finally:
        if proc.poll() is None:
            proc.terminate()


if __name__ == "__main__":
    run_app()
