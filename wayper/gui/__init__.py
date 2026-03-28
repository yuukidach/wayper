"""Wayper GUI application."""

from __future__ import annotations


def run_app() -> None:
    from wayper.web.launcher import run_app as run_electron_app

    run_electron_app()
