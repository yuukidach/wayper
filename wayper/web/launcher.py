import subprocess
import time
import os
import sys
import threading
import signal
from pathlib import Path
from wayper.web.api import run as run_api

def run_app():
    # Start API in a separate thread
    api_thread = threading.Thread(target=run_api, daemon=True)
    api_thread.start()

    # Wait a bit for API to start
    time.sleep(1)

    # Electron directory
    electron_dir = Path(__file__).parent.parent / "gui" / "electron"

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
