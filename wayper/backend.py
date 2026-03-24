"""Wallpaper backend: swww and hyprctl wrappers, shared utilities."""

from __future__ import annotations

import fcntl
import json
import os
import re
import subprocess
from pathlib import Path

from .config import MonitorConfig, TransitionConfig, WayperConfig

LOCK_PATH = Path("/tmp/wayper.lock")


class FileLock:
    """Simple flock-based file lock for state-modifying commands."""

    def __init__(self, *, blocking: bool = True) -> None:
        self._fd: int | None = None
        self._blocking = blocking

    def __enter__(self) -> "FileLock":
        self._fd = os.open(str(LOCK_PATH), os.O_WRONLY | os.O_CREAT)
        try:
            flags = fcntl.LOCK_EX if self._blocking else fcntl.LOCK_EX | fcntl.LOCK_NB
            fcntl.flock(self._fd, flags)
        except OSError:
            os.close(self._fd)
            self._fd = None
            raise SystemExit(0)
        return self

    def __exit__(self, *_: object) -> None:
        if self._fd is not None:
            os.close(self._fd)


def set_wallpaper(monitor: str, image: Path, transition: TransitionConfig) -> None:
    """Set wallpaper on a specific monitor via swww."""
    subprocess.run(
        [
            "swww", "img", str(image),
            "--outputs", monitor,
            "--transition-type", transition.type,
            "--transition-duration", str(transition.duration),
            "--transition-fps", str(transition.fps),
        ],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def query_current() -> dict[str, Path | None]:
    """Parse swww query output. Returns {monitor_name: image_path}."""
    result = subprocess.run(
        ["swww", "query"], capture_output=True, text=True, check=False,
    )
    current: dict[str, Path | None] = {}
    for line in result.stdout.strip().splitlines():
        # Format: ": DP-1: 2560x1440, scale: 1.5, currently displaying: image: /path/to/img"
        m = re.match(r":\s*(\S+):\s.*image:\s*(.*)", line)
        if m:
            monitor = m.group(1).rstrip(":")
            img_path = m.group(2).strip()
            current[monitor] = Path(img_path) if img_path else None
    return current


def get_focused_monitor() -> str | None:
    """Get the focused monitor name from hyprctl."""
    try:
        result = subprocess.run(
            ["hyprctl", "activeworkspace", "-j"],
            capture_output=True, text=True, check=True,
        )
        data = json.loads(result.stdout)
        return data.get("monitor")
    except Exception:
        return None


def find_monitor(config: WayperConfig, name: str | None) -> MonitorConfig | None:
    """Find monitor config by name."""
    if name is None:
        return None
    for m in config.monitors:
        if m.name == name:
            return m
    return None


def get_context(config: WayperConfig):
    """Get focused monitor, its config, and current image."""
    monitor = get_focused_monitor()
    mon_cfg = find_monitor(config, monitor)
    current = query_current()
    img = current.get(monitor) if monitor else None
    return monitor, mon_cfg, img
