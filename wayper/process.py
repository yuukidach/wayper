"""Subprocess helpers shared by platform-specific integrations."""

from __future__ import annotations

import os
import subprocess


def windows_no_window_kwargs(*extra_flags: int) -> dict[str, int]:
    """Return subprocess kwargs that prevent transient console windows on Windows."""
    if os.name != "nt":
        return {}

    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    for flag in extra_flags:
        flags |= flag
    return {"creationflags": flags} if flags else {}
