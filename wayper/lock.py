"""Cross-platform file lock for state-modifying operations."""

from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

if sys.platform == "win32":
    import msvcrt
else:
    import fcntl

LOCK_PATH = Path(tempfile.gettempdir()) / "wayper.lock"


class FileLock:
    """Simple cross-platform exclusive file lock."""

    def __init__(self, *, blocking: bool = True) -> None:
        self._fd: int | None = None
        self._blocking = blocking

    def __enter__(self) -> FileLock:
        self._fd = os.open(str(LOCK_PATH), os.O_WRONLY | os.O_CREAT)
        if sys.platform == "win32":
            self._lock_windows()
            return self

        try:
            flags = fcntl.LOCK_EX if self._blocking else fcntl.LOCK_EX | fcntl.LOCK_NB
            fcntl.flock(self._fd, flags)
        except OSError:
            print("Failed to acquire lock (OSError). Exiting.")
            os.close(self._fd)
            self._fd = None
            raise SystemExit(0)
        return self

    def __exit__(self, *_: object) -> None:
        if self._fd is None:
            return
        if sys.platform == "win32":
            try:
                os.lseek(self._fd, 0, os.SEEK_SET)
                msvcrt.locking(self._fd, msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
        os.close(self._fd)
        self._fd = None

    def _lock_windows(self) -> None:
        if self._fd is None:
            return
        try:
            if os.path.getsize(LOCK_PATH) == 0:
                os.write(self._fd, b"0")
            while True:
                try:
                    os.lseek(self._fd, 0, os.SEEK_SET)
                    mode = msvcrt.LK_LOCK if self._blocking else msvcrt.LK_NBLCK
                    msvcrt.locking(self._fd, mode, 1)
                    return
                except OSError:
                    if not self._blocking:
                        raise
                    time.sleep(0.1)
        except OSError:
            print("Failed to acquire lock (OSError). Exiting.")
            os.close(self._fd)
            self._fd = None
            raise SystemExit(0)
