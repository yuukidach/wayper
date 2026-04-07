from __future__ import annotations

import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

from wayper.server.api import port_file
from wayper.server.api import run as run_api


def _wait_for_api(timeout: float = 10) -> int:
    """Poll API port file and then the API until it responds. Returns the port."""
    pf = port_file()
    deadline = time.monotonic() + timeout
    port = 0
    while time.monotonic() < deadline:
        try:
            port = int(pf.read_text().strip())
            if port > 0:
                break
        except (FileNotFoundError, ValueError):
            pass
        time.sleep(0.2)

    if port <= 0:
        print("Warning: API port file not found within timeout, launching Electron anyway")
        return 0

    url = f"http://127.0.0.1:{port}/api/status"
    while time.monotonic() < deadline:
        try:
            urlopen(url, timeout=1)
            return port
        except (URLError, OSError):
            time.sleep(0.2)
    print("Warning: API did not respond within timeout, launching Electron anyway")
    return port


def run_app():
    import os

    # Start API in a separate thread
    api_thread = threading.Thread(target=run_api, daemon=True)
    api_thread.start()

    port = _wait_for_api()

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

    # Pass API port to Electron so preload.js can pick it up
    env = {**os.environ, "WAYPER_DEV": "1"}
    if port > 0:
        env["WAYPER_API_PORT"] = str(port)

    # Start Electron
    proc = subprocess.Popen(cmd, cwd=electron_dir, env=env)

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
