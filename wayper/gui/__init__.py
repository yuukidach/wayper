"""Wayper GUI application."""

from __future__ import annotations

import os
import sys

def run_app() -> None:
    # Use NiceGUI Web/Native UI by default as per user request for cross-platform solution
    # Fallback to legacy native UIs only if explicitly requested via WAYPER_GUI=legacy

    gui_mode = os.environ.get("WAYPER_GUI", "native")

    if gui_mode == "electron":
        from wayper.web.launcher import run_app as run_electron_app
        run_electron_app()
        return

    from ..config import load_config
    config = load_config()

    if sys.platform == "darwin":
        from .macos.app import WayperApp
        WayperApp.launch(config)
    else:
        from .gtk.app import run
        run(config)
