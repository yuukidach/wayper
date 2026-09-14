"""Shared utilities."""

from __future__ import annotations

import os
import tempfile
import time
from pathlib import Path

_WINDOWS_REPLACE_ATTEMPTS = 5
_WINDOWS_REPLACE_RETRY_DELAY = 0.025
_IS_WINDOWS = os.name == "nt"


def _replace_file(source: Path, destination: Path) -> None:
    """Replace *destination*, tolerating transient Windows sharing violations."""
    attempts = _WINDOWS_REPLACE_ATTEMPTS if _IS_WINDOWS else 1
    for attempt in range(attempts):
        try:
            os.replace(source, destination)
            return
        except PermissionError:
            if attempt + 1 >= attempts:
                raise
            time.sleep(_WINDOWS_REPLACE_RETRY_DELAY * (attempt + 1))


def atomic_write(path: Path, content: str, *, encoding: str | None = None) -> None:
    """Write content atomically via temp file + os.replace."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    tmp = Path(tmp_name)
    try:
        # Callers migrating a format to UTF-8 must update its readers too.
        # Preserve existing state-file encodings until each migration is ready.
        with os.fdopen(fd, "w", encoding=encoding) as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        _replace_file(tmp, path)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise
