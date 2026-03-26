"""Wayper GUI application."""

from __future__ import annotations

import sys


def run_app() -> None:
    from ..config import load_config

    config = load_config()

    if sys.platform == "darwin":
        from .macos.app import WayperApp
        WayperApp.launch(config)
    else:
        from .gtk.app import run
        run(config)
