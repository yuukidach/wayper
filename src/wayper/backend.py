"""Wallpaper backend: swww and hyprctl wrappers."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from .config import MonitorConfig, TransitionConfig, WayperConfig


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
