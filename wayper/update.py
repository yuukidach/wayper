"""Update checking against GitHub Releases."""

from __future__ import annotations

import logging
import re
import threading
import time
from dataclasses import asdict, dataclass
from datetime import UTC, datetime

import httpx

from . import __version__
from .config import WayperConfig

log = logging.getLogger("wayper.update")

GITHUB_LATEST_RELEASE_URL = "https://api.github.com/repos/yuukidach/wayper/releases/latest"
RELEASES_URL = "https://github.com/yuukidach/wayper/releases/latest"
USER_AGENT = f"wayper/{__version__}"
DEFAULT_CACHE_TTL = 6 * 60 * 60

_VERSION_PART_RE = re.compile(r"(\d+|[a-zA-Z]+)")
_cache_lock = threading.Lock()
_cached_result: dict | None = None
_cached_at = 0.0


@dataclass(frozen=True)
class UpdateCheckResult:
    current_version: str
    latest_version: str | None
    update_available: bool
    release_url: str
    release_name: str | None = None
    published_at: str | None = None
    checked_at: str | None = None
    error: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def _normalize_version(version: str) -> str:
    version = version.strip()
    if version.startswith(("v", "V")):
        return version[1:]
    return version


def _version_key(version: str) -> tuple:
    """Return a sortable key for simple release versions such as v1.6.8."""
    normalized = _normalize_version(version)
    core = normalized.split("+", 1)[0]
    base, prerelease = (core.split("-", 1) + [""])[:2] if "-" in core else (core, "")

    parts: list[tuple[int, int | str]] = []
    for chunk in base.split("."):
        for part in _VERSION_PART_RE.findall(chunk):
            if part.isdigit():
                parts.append((1, int(part)))
            else:
                parts.append((0, part.lower()))

    while len(parts) < 3:
        parts.append((1, 0))

    prerelease_weight = 0 if prerelease else 1
    prerelease_parts: list[tuple[int, int | str]] = []
    if prerelease:
        for part in _VERSION_PART_RE.findall(prerelease):
            if part.isdigit():
                prerelease_parts.append((1, int(part)))
            else:
                prerelease_parts.append((0, part.lower()))

    return (tuple(parts), prerelease_weight, tuple(prerelease_parts))


def is_newer_version(candidate: str, current: str = __version__) -> bool:
    return _version_key(candidate) > _version_key(current)


def check_for_updates(
    config: WayperConfig | None = None,
    *,
    force: bool = False,
    cache_ttl: int = DEFAULT_CACHE_TTL,
) -> dict:
    """Check whether a newer Wayper release is available."""
    global _cached_at, _cached_result

    now = time.monotonic()
    if not force:
        with _cache_lock:
            if (
                _cached_result is not None
                and not _cached_result.get("error")
                and now - _cached_at < cache_ttl
            ):
                return dict(_cached_result)

    checked_at = datetime.now(UTC).isoformat()
    result = _fetch_latest_release(config, checked_at=checked_at)

    payload = result.to_dict()
    if not result.error:
        with _cache_lock:
            _cached_result = payload
            _cached_at = now
    return dict(payload)


def _fetch_latest_release(
    config: WayperConfig | None,
    *,
    checked_at: str,
) -> UpdateCheckResult:
    proxy = config.proxy if config else None
    try:
        with httpx.Client(
            proxy=proxy,
            timeout=httpx.Timeout(8, connect=4),
            follow_redirects=True,
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": USER_AGENT,
            },
        ) as client:
            resp = client.get(GITHUB_LATEST_RELEASE_URL)
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        log.debug("Update check failed: %s", e)
        return UpdateCheckResult(
            current_version=__version__,
            latest_version=None,
            update_available=False,
            release_url=RELEASES_URL,
            checked_at=checked_at,
            error=str(e),
        )

    latest = str(data.get("tag_name") or "").strip()
    release_url = str(data.get("html_url") or RELEASES_URL)
    update_available = bool(latest and is_newer_version(latest))
    return UpdateCheckResult(
        current_version=__version__,
        latest_version=latest or None,
        update_available=update_available,
        release_url=release_url,
        release_name=data.get("name"),
        published_at=data.get("published_at"),
        checked_at=checked_at,
    )
