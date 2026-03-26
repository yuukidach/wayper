"""Linux backend: swww + hyprctl."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from ..config import TransitionConfig
from .base import WallpaperBackend


class LinuxBackend(WallpaperBackend):
    """Wayland backend using swww and hyprctl."""

    def set_wallpaper(self, monitor: str, image: Path, transition: TransitionConfig) -> None:
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

    def get_focused_monitor(self) -> str | None:
        try:
            result = subprocess.run(
                ["hyprctl", "activeworkspace", "-j"],
                capture_output=True, text=True, check=True,
            )
            data = json.loads(result.stdout)
            return data.get("monitor")
        except Exception:
            return None

    def query_current(self) -> dict[str, Path | None]:
        result = subprocess.run(
            ["swww", "query"], capture_output=True, text=True, check=False,
        )
        current: dict[str, Path | None] = {}
        for line in result.stdout.strip().splitlines():
            m = re.match(r":\s*(\S+):\s.*image:\s*(.*)", line)
            if m:
                monitor = m.group(1).rstrip(":")
                img_path = m.group(2).strip()
                current[monitor] = Path(img_path) if img_path else None
        return current

    def notify(self, title: str, message: str, timeout_ms: int = 2000) -> None:
        subprocess.Popen(
            ["notify-send", "-t", str(timeout_ms), title, message],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
