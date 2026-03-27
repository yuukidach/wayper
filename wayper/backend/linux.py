"""Linux backend: awww + hyprctl."""

from __future__ import annotations

import json
import logging
import re
import subprocess
import time
from pathlib import Path

from ..config import MonitorConfig, TransitionConfig
from .base import WallpaperBackend

log = logging.getLogger("wayper")


class LinuxBackend(WallpaperBackend):
    """Wayland backend using awww and hyprctl."""

    def detect_monitors(self) -> list[MonitorConfig]:
        try:
            result = subprocess.run(
                ["hyprctl", "monitors", "-j"],
                capture_output=True,
                text=True,
                check=True,
            )
            data = json.loads(result.stdout)
            monitors = []
            for m in data:
                # Transform: 0=normal, 1=90, 2=180, 3=270, 4=flip, 5=flip+90, 6=flip+180, 7=flip+270
                # 0, 2, 4, 6 -> landscape (width > height usually, but check transform)
                # 1, 3, 5, 7 -> portrait (swapped)

                # However, hyprctl reports width/height as configured (ignoring transform?)
                # Actually transform rotates the output.
                # If transform is odd, width and height are swapped for orientation purposes.

                width = m["width"]
                height = m["height"]
                transform = m["transform"]

                if transform in (1, 3, 5, 7):
                    width, height = height, width

                orientation = "portrait" if height > width else "landscape"

                monitors.append(
                    MonitorConfig(
                        name=m["name"],
                        width=width,
                        height=height,
                        orientation=orientation,
                    )
                )
            return monitors
        except (subprocess.CalledProcessError, FileNotFoundError, json.JSONDecodeError):
            log.warning("Failed to detect monitors via hyprctl")
            return []

    def ensure_ready(self) -> None:
        """Start awww-daemon if it is not already running."""
        if self._daemon_running():
            return
        log.info("Starting awww-daemon...")
        subprocess.Popen(
            ["awww-daemon"],
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        for _ in range(10):
            time.sleep(0.5)
            if self._daemon_running():
                log.info("awww-daemon is ready")
                return
        log.warning("awww-daemon may not be ready yet")

    def _daemon_running(self) -> bool:
        result = subprocess.run(
            ["awww", "query"],
            capture_output=True,
            check=False,
        )
        return result.returncode == 0

    def set_wallpaper(self, monitor: str, image: Path, transition: TransitionConfig) -> None:
        subprocess.run(
            [
                "awww",
                "img",
                str(image),
                "--outputs",
                monitor,
                "--transition-type",
                transition.type,
                "--transition-duration",
                str(transition.duration),
                "--transition-fps",
                str(transition.fps),
            ],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def get_focused_monitor(self) -> str | None:
        try:
            result = subprocess.run(
                ["hyprctl", "activeworkspace", "-j"],
                capture_output=True,
                text=True,
                check=True,
            )
            data = json.loads(result.stdout)
            return data.get("monitor")
        except Exception:
            return None

    def query_current(self) -> dict[str, Path | None]:
        result = subprocess.run(
            ["awww", "query"],
            capture_output=True,
            text=True,
            check=False,
        )
        current: dict[str, Path | None] = {}
        for line in result.stdout.strip().splitlines():
            m = re.match(r":\s*(\S+):\s.*image:\s*(.*)", line)
            if m:
                monitor = m.group(1).rstrip(":")
                img_path = m.group(2).strip()
                current[monitor] = Path(img_path) if img_path else None
        return current

    def is_locked(self) -> bool:
        """Check if the session is locked."""
        lockers = ["hyprlock", "swaylock", "gtklock", "waylock", "i3lock"]
        for locker in lockers:
            try:
                res = subprocess.run(
                    ["pgrep", "-x", locker],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
                if res.returncode == 0:
                    return True
            except FileNotFoundError:
                continue
        return False

    def notify(self, title: str, message: str, timeout_ms: int = 2000) -> None:
        subprocess.Popen(
            ["notify-send", "-t", str(timeout_ms), title, message],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
