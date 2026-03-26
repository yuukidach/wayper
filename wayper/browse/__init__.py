"""Wallpaper browser — platform dispatch."""

from __future__ import annotations

import sys

from ..config import WayperConfig


def run(config: WayperConfig, category: str = "favorites") -> None:
    if sys.platform == "darwin":
        from .macos import run as _run
    else:
        from .gtk import run as _run
    _run(config, category)
