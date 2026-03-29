"""Centralized logging configuration with file rotation."""

from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler

from .config import CONFIG_DIR

LOG_FILE = CONFIG_DIR / "wayper.log"
_configured = False


def setup_logging(*, verbose: bool = False) -> None:
    """Configure the 'wayper' logger with file rotation and console output.

    Safe to call multiple times — only the first call takes effect.
    File handler: DEBUG level, 5 MB × 3 backups.
    Console handler: INFO level.
    """
    global _configured
    if _configured:
        return
    _configured = True

    logger = logging.getLogger("wayper")
    logger.setLevel(logging.DEBUG if verbose else logging.INFO)

    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    fh = RotatingFileHandler(
        LOG_FILE,
        maxBytes=5 * 1024 * 1024,
        backupCount=3,
        encoding="utf-8",
    )
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(
        logging.Formatter(
            "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    logger.addHandler(fh)

    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    ch.setFormatter(
        logging.Formatter(
            "%(asctime)s [%(levelname)s] %(message)s",
            datefmt="%H:%M:%S",
        )
    )
    logger.addHandler(ch)
