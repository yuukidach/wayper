"""Shared utilities."""

from __future__ import annotations

import os
from pathlib import Path


def atomic_write(path: Path, content: str) -> None:
    """Write content atomically via temp file + os.replace."""
    tmp = path.with_suffix(".tmp")
    tmp.write_text(content)
    os.replace(tmp, path)
