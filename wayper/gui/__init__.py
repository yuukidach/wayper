"""Wayper GUI application."""

from __future__ import annotations


def run_app() -> None:
    from ..config import load_config
    from .app import WayperApp

    WayperApp.launch(load_config())
