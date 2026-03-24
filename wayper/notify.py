"""Desktop notifications via notify-send."""

from __future__ import annotations

import subprocess


def notify(title: str, message: str, timeout_ms: int = 2000) -> None:
    subprocess.Popen(
        ["notify-send", "-t", str(timeout_ms), title, message],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
