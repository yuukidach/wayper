"""Linux backend: awww with Hyprland or Sway session discovery."""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import time
from functools import partial
from pathlib import Path

from ..config import MonitorConfig, TransitionConfig
from .base import WallpaperBackend

log = logging.getLogger("wayper")

_ROTATED_TRANSFORMS = {"1", "3", "5", "7", "90", "270", "flipped-90", "flipped-270"}


def _monitors(data: object, *, sway: bool = False) -> list[MonitorConfig]:
    monitors: list[MonitorConfig] = []
    for item in data if isinstance(data, list) else []:
        if not isinstance(item, dict) or item.get("active") is False:
            continue
        mode = item.get("current_mode") if sway else item
        physical_dimensions = isinstance(mode, dict)
        dimensions = mode if physical_dimensions else item.get("rect")
        name = item.get("name")
        if not isinstance(dimensions, dict) or not name:
            continue
        try:
            width = int(dimensions["width"])
            height = int(dimensions["height"])
        except (KeyError, TypeError, ValueError):
            continue
        transform = str(item.get("transform", "normal")).lower()
        if physical_dimensions and transform in _ROTATED_TRANSFORMS:
            width, height = height, width
        if width > 0 and height > 0:
            monitors.append(
                MonitorConfig(
                    name=str(name),
                    width=width,
                    height=height,
                    orientation="portrait" if height > width else "landscape",
                )
            )
    return monitors


def _focused_output(data: object) -> object | None:
    if isinstance(data, dict):
        return data.get("monitor")
    if isinstance(data, list):
        return next(
            (
                workspace.get("output")
                for workspace in data
                if isinstance(workspace, dict) and workspace.get("focused") is True
            ),
            None,
        )
    return None


def _session_order() -> tuple[str, str]:
    return ("sway", "hyprland") if os.environ.get("SWAYSOCK") else ("hyprland", "sway")


def _json_command(command: list[str]) -> object | None:
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=True,
        )
        return json.loads(result.stdout)
    except (subprocess.CalledProcessError, FileNotFoundError, json.JSONDecodeError):
        return None


_SESSION_QUERIES = {
    "hyprland": {
        "monitors": (["hyprctl", "monitors", "-j"], _monitors),
        "focus": (["hyprctl", "activeworkspace", "-j"], _focused_output),
    },
    "sway": {
        "monitors": (["swaymsg", "-t", "get_outputs", "-r"], partial(_monitors, sway=True)),
        "focus": (["swaymsg", "-t", "get_workspaces", "-r"], _focused_output),
    },
}


def _session_query(name: str) -> object | None:
    for session in _session_order():
        command, parse = _SESSION_QUERIES[session][name]
        if result := parse(_json_command(command)):
            return result
    return None


class LinuxBackend(WallpaperBackend):
    """Wayland backend using awww with Hyprland or Sway output discovery."""

    def detect_monitors(self) -> list[MonitorConfig]:
        monitors = _session_query("monitors")
        if isinstance(monitors, list):
            return monitors
        log.warning("Failed to detect monitors via Hyprland or Sway")
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
        try:
            result = subprocess.run(
                [
                    "awww",
                    "img",
                    str(image),
                    "--outputs",
                    monitor,
                    "--resize",
                    "crop",
                    "--filter",
                    "Lanczos3",
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
                timeout=10,
            )
        except subprocess.TimeoutExpired:
            log.warning("awww timed out setting wallpaper: %s on %s", image, monitor)
            return
        if result.returncode != 0:
            log.warning(
                "awww failed to set wallpaper (exit %d): %s on %s",
                result.returncode,
                image,
                monitor,
            )

    def get_focused_monitor(self) -> str | None:
        monitor = _session_query("focus")
        return str(monitor) if monitor else None

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
        # A CLI invocation gets a fresh backend, so a process-local replacement
        # ID cannot group notifications triggered by compositor key bindings.
        # The synchronous hint lets compatible daemons keep the grouping key
        # across processes and avoids updating an expired notification by ID.
        cmd = [
            "notify-send",
            "--app-name=wayper",
            "--transient",
            "--hint=string:synchronous:wayper",
            "--expire-time",
            str(timeout_ms),
            title,
            message,
        ]
        try:
            subprocess.run(
                cmd,
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass
