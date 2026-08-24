"""Pool management: directory helpers, blacklist, quota enforcement."""

from __future__ import annotations

import json
import logging
import random
import time
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import TypedDict

from .config import WayperConfig
from .lock import FileLock
from .state import ALL_PURITIES
from .tags import normalize_tag
from .util import atomic_write

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
ORIENTATIONS = ("landscape", "portrait")
METADATA_SCHEMA_VERSION = 2
log = logging.getLogger("wayper.pool")


class TagMetadata(TypedDict, total=False):
    id: int
    name: str
    alias: str
    category_id: int
    category: str
    purity: str
    created_at: str


class ImageMetadata(TypedDict, total=False):
    id: str
    tags: list[str]
    tag_details: list[TagMetadata]
    category: str
    purity: str
    dimension_x: int
    dimension_y: int
    resolution: str
    ratio: str
    views: int
    favorites: int
    url: str
    short_url: str
    source: str
    colors: list[str]
    file_size: int
    file_type: str
    uploader: str
    uploader_details: dict[str, object]
    created_at: str
    path: str
    thumbs: dict[str, str]
    downloaded_at: int
    metadata_fetched_at: int
    metadata_checked_at: int
    metadata_complete: bool
    metadata_unavailable: bool
    metadata_error: str
    tag_details_complete: bool
    metadata_schema_version: int


def extract_tag_names(tags: object) -> list[str]:
    """Extract tag name strings from Wallhaven's mixed tag format."""
    if not isinstance(tags, list | tuple) or not tags:
        return []
    names: list[str] = []
    for tag in tags:
        name = tag.get("name", "") if isinstance(tag, Mapping) else tag
        clean = str(name).strip()
        if clean:
            names.append(clean)
    return names


def extract_tag_details(tags: object) -> list[TagMetadata]:
    """Return the useful, JSON-safe fields from Wallhaven tag objects."""
    if not isinstance(tags, list | tuple):
        return []
    details: list[TagMetadata] = []
    for raw in tags:
        if not isinstance(raw, Mapping):
            continue
        name = str(raw.get("name", "")).strip()
        if not name:
            continue
        detail: TagMetadata = {"name": name}
        for key in ("alias", "category", "purity", "created_at"):
            value = raw.get(key)
            if value not in (None, ""):
                detail[key] = str(value)
        for key in ("id", "category_id"):
            value = raw.get(key)
            if isinstance(value, int) and not isinstance(value, bool):
                detail[key] = value
        details.append(detail)
    return details


def list_images(directory: Path) -> list[Path]:
    """List all image files in a directory."""
    if not directory.exists():
        return []
    return [f for f in directory.iterdir() if f.is_file() and f.suffix.lower() in IMAGE_EXTENSIONS]


def count_images(directory: Path) -> int:
    return len(list_images(directory))


def disk_usage_mb(config: WayperConfig) -> float:
    """Disk usage of pool + favorites images in MB (excludes trash, cache, state files)."""
    directories = (
        directory
        for purity in ALL_PURITIES
        for orientation in ORIENTATIONS
        for directory in (
            pool_dir(config, purity, orientation),
            favorites_dir(config, purity, orientation),
        )
    )
    total = sum(
        path.stat().st_size
        for directory in directories
        if directory.is_dir()
        for path in directory.iterdir()
        if path.is_file()
    )
    return total / 1024 / 1024


def pool_dir(config: WayperConfig, mode: str, orientation: str) -> Path:
    return config.download_dir / mode / orientation


def favorites_dir(config: WayperConfig, mode: str, orientation: str) -> Path:
    return config.download_dir / "favorites" / mode / orientation


def favorite_filenames(
    config: WayperConfig,
    purities: Iterable[str] | None = None,
) -> set[str]:
    """Collect favorite filenames across the requested purities."""
    if isinstance(purities, str):
        purities = (purities,)
    active = tuple(purities) if purities is not None else ALL_PURITIES
    return {
        image.name
        for purity in active
        for orientation in ORIENTATIONS
        for image in list_images(favorites_dir(config, purity, orientation))
    }


def pick_random(
    config: WayperConfig,
    purities: set[str],
    orientation: str,
    exclude: Path | None = None,
) -> Path | None:
    """Pick a random image: choose a random purity first (equal weight), then a random image."""
    import random as _rand

    bl = _blacklist_set(config)

    active = [p for p in ALL_PURITIES if p in purities]
    if not active:
        return None
    _rand.shuffle(active)
    for purity in active:
        images = list_images(pool_dir(config, purity, orientation))
        images += list_images(favorites_dir(config, purity, orientation))
        if exclude:
            images = [img for img in images if img != exclude]
        if bl:
            images = [img for img in images if img.name not in bl]
        if images:
            return _rand.choice(images)
    return None


def _parse_blacklist_lines(lines: list[str]) -> list[tuple[int, str]]:
    """Parse well-formed timestamped blacklist records for public listings."""
    entries = []
    for line in lines:
        parts = line.split(maxsplit=1)
        if len(parts) == 2 and parts[0].isdigit():
            entries.append((int(parts[0]), parts[1]))
    return entries


def _blacklist_filenames(lines: list[str]) -> set[str]:
    """Return filenames from the blacklist, including legacy untimestamped rows.

    Older releases only required a two-field row when deciding whether an
    image should be skipped; retaining that permissive read path prevents a
    hand-edited or partially migrated blacklist from making a wallpaper
    unexpectedly eligible again.  ``list_blacklist`` remains strict because
    its timestamp is part of the API contract.
    """
    return {parts[1] for line in lines if len(parts := line.split(maxsplit=1)) == 2}


def list_blacklist(config: WayperConfig) -> list[tuple[int, str]]:
    """Return all blacklist entries as (timestamp, filename) sorted newest-first."""
    bf = config.blacklist_file
    if not bf.exists():
        return []
    entries = _parse_blacklist_lines(bf.read_text().splitlines())
    entries.sort(key=lambda e: e[0], reverse=True)
    return entries


_bl_cache: set[str] | None = None
_bl_mtime: float = 0
_bl_path: Path | None = None


def _blacklist_set(config: WayperConfig) -> set[str]:
    """Return cached set of blacklisted filenames, refreshing on file change."""
    global _bl_cache, _bl_mtime, _bl_path
    bf = config.blacklist_file
    try:
        mtime = bf.stat().st_mtime
    except OSError:
        _bl_cache = None
        _bl_path = bf
        return set()
    if _bl_cache is None or mtime != _bl_mtime or bf != _bl_path:
        _bl_cache = _blacklist_filenames(bf.read_text().splitlines())
        _bl_mtime = mtime
        _bl_path = bf
    return _bl_cache


def is_blacklisted(config: WayperConfig, filename: str) -> bool:
    return filename in _blacklist_set(config)


def add_to_blacklist(config: WayperConfig, filename: str) -> None:
    import time

    with open(config.blacklist_file, "a") as f:
        f.write(f"{int(time.time())} {filename}\n")
    global _bl_cache, _bl_path
    _bl_cache = None
    _bl_path = None


def remove_from_blacklist(config: WayperConfig, filename: str) -> None:
    bf = config.blacklist_file
    if not bf.exists():
        return
    lines = []
    for line in bf.read_text().splitlines():
        parts = line.split(maxsplit=1)
        if not (len(parts) == 2 and parts[1] == filename):
            lines.append(line)
    atomic_write(bf, "\n".join(lines) + "\n" if lines else "")
    global _bl_cache, _bl_path
    _bl_cache = None
    _bl_path = None


def prune_blacklist(config: WayperConfig) -> None:
    """Remove blacklist entries older than TTL. TTL of 0 means never expire."""
    import time

    if config.blacklist_ttl_days == 0:
        return

    bf = config.blacklist_file
    if not bf.exists():
        return
    cutoff = int(time.time()) - config.blacklist_ttl_days * 86400
    lines = []
    for line in bf.read_text().splitlines():
        parts = line.split(maxsplit=1)
        if len(parts) == 2 and parts[0].isdigit() and int(parts[0]) >= cutoff:
            lines.append(line)
    atomic_write(bf, "\n".join(lines) + "\n" if lines else "")
    # The file was rewritten even when its timestamp happens to have the
    # same filesystem resolution as the cached value.  Invalidate explicitly
    # so the next rotation cannot use an expired entry from memory.
    global _bl_cache, _bl_path
    _bl_cache = None
    _bl_path = None


def enforce_quota(config: WayperConfig) -> None:
    """Delete oldest non-favorite images until under quota."""
    for purity in ALL_PURITIES:
        pdir = config.download_dir / purity
        if not pdir.exists():
            continue
        quota_bytes = config.quota_mb * 1024 * 1024 // len(ALL_PURITIES)

        all_images = sorted(
            [f for f in pdir.rglob("*") if f.is_file() and f.suffix.lower() in IMAGE_EXTENSIONS],
            key=lambda f: f.stat().st_mtime,
        )
        total = sum(f.stat().st_size for f in all_images)

        for img in all_images:
            if total <= quota_bytes:
                break
            size = img.stat().st_size
            img.unlink()
            total -= size


def should_download(config: WayperConfig, purities: set[str]) -> dict[str, bool]:
    """Return dict of {purity: needs_download} for each active purity."""
    result = {}
    for purity in purities:
        needs = False
        for orient in ORIENTATIONS:
            if count_images(pool_dir(config, purity, orient)) < 30:
                needs = True
                break
        if not needs:
            needs = random.random() < 0.2
        result[purity] = needs
    return result


def _metadata_record(
    item: Mapping[str, object],
    previous: Mapping[str, object] | None,
    *,
    complete: bool | None,
    fetched_at: int,
) -> ImageMetadata:
    """Merge one API payload without discarding fields unknown to older clients."""
    previous = previous if isinstance(previous, Mapping) else {}
    # API responses are JSON objects. Keeping their top-level fields makes new
    # Wallhaven additions available without another schema migration, while the
    # compatibility fields below retain the old wayper shape.
    record: dict[str, object] = {**previous, **item}
    raw_tags = item.get("tags")
    tag_names = extract_tag_names(raw_tags)
    tag_details = extract_tag_details(raw_tags)
    if tag_names or "tags" in item:
        record["tags"] = tag_names
    else:
        record["tags"] = extract_tag_names(previous.get("tags"))
    if tag_details:
        record["tag_details"] = tag_details
    elif "tag_details" in previous:
        record["tag_details"] = previous["tag_details"]
    if "tags" in item:
        record["tag_details_complete"] = len(tag_details) == len(tag_names)
    elif "tag_details_complete" in previous:
        record["tag_details_complete"] = bool(previous["tag_details_complete"])

    uploader = item.get("uploader")
    if isinstance(uploader, Mapping):
        record["uploader"] = str(uploader.get("username", "")).strip()
        record["uploader_details"] = dict(uploader)
    elif uploader is not None:
        record["uploader"] = str(uploader).strip()
    else:
        record["uploader"] = str(previous.get("uploader", "")).strip()

    downloaded_at = previous.get("downloaded_at", fetched_at)
    record["downloaded_at"] = (
        downloaded_at
        if isinstance(downloaded_at, int) and not isinstance(downloaded_at, bool)
        else fetched_at
    )
    if complete is None:
        complete = bool(tag_details)
    was_complete = previous.get("metadata_complete") is True
    record["metadata_complete"] = was_complete or complete
    if complete:
        record["metadata_fetched_at"] = fetched_at
        record.pop("metadata_unavailable", None)
        record.pop("metadata_error", None)
        record.pop("metadata_checked_at", None)
    elif "metadata_fetched_at" in previous:
        record["metadata_fetched_at"] = previous["metadata_fetched_at"]
    record["metadata_schema_version"] = METADATA_SCHEMA_VERSION
    return record  # type: ignore[return-value]


def save_metadata_batch(
    config: WayperConfig,
    items: Mapping[str, Mapping[str, object]],
    *,
    complete: bool | None = None,
    fetched_at: int | None = None,
) -> int:
    """Atomically merge a batch of Wallhaven metadata records."""
    if not items:
        return 0
    timestamp = int(time.time()) if fetched_at is None else int(fetched_at)
    mf = config.metadata_file
    with FileLock():
        data = _read_metadata_file(mf)
        for raw_filename, item in items.items():
            filename = Path(raw_filename).name
            if not filename or not isinstance(item, Mapping):
                continue
            data[filename] = _metadata_record(
                item,
                data.get(filename),
                complete=complete,
                fetched_at=timestamp,
            )
        atomic_write(mf, json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    return len(items)


def save_metadata(
    config: WayperConfig,
    filename: str,
    item: Mapping[str, object],
    *,
    complete: bool | None = None,
    fetched_at: int | None = None,
) -> None:
    """Persist one Wallhaven metadata payload without losing full API details."""
    save_metadata_batch(
        config,
        {filename: item},
        complete=complete,
        fetched_at=fetched_at,
    )


def hydrate_tag_details(config: WayperConfig) -> dict[str, int]:
    """Propagate known Wallhaven tag objects to legacy records with the same tag names."""
    mf = config.metadata_file
    with FileLock():
        data = _read_metadata_file(mf)
        catalog: dict[str, TagMetadata] = {}
        for record in data.values():
            if not isinstance(record, Mapping):
                continue
            details = extract_tag_details(record.get("tag_details"))
            for detail in details:
                key = normalize_tag(detail.get("name"))
                if key:
                    catalog[key] = {**catalog.get(key, {}), **detail}

        changed_records = complete_records = 0
        for record in data.values():
            if not isinstance(record, dict):
                continue
            tags = extract_tag_names(record.get("tags"))
            if not tags:
                continue
            current = {
                normalize_tag(detail.get("name")): detail
                for detail in extract_tag_details(record.get("tag_details"))
            }
            hydrated: list[TagMetadata | None] = []
            for tag in tags:
                key = normalize_tag(tag)
                known = catalog.get(key)
                existing = current.get(key)
                if known and existing:
                    hydrated.append({**known, **existing})
                else:
                    hydrated.append(existing or known)
            available = [detail for detail in hydrated if detail is not None]
            is_complete = len(available) == len(tags)
            record_changed = False
            if available and record.get("tag_details") != available:
                record["tag_details"] = available
                record["metadata_schema_version"] = METADATA_SCHEMA_VERSION
                record_changed = True
            if record.get("tag_details_complete") != is_complete:
                record["tag_details_complete"] = is_complete
                record_changed = True
            changed_records += int(record_changed)
            complete_records += int(is_complete)
        if changed_records:
            atomic_write(mf, json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    return {
        "known_tags": len(catalog),
        "tag_complete_records": complete_records,
        "changed_records": changed_records,
    }


def _read_metadata_file(path: Path) -> dict:
    """Read metadata JSON, tolerating trailing junk from interrupted concurrent writes."""
    if not path.exists():
        return {}
    text = path.read_text()
    if not text.strip():
        return {}

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        decoder = json.JSONDecoder()
        try:
            data, end = decoder.raw_decode(text)
        except json.JSONDecodeError:
            log.warning("Metadata file is invalid; ignoring %s", path, exc_info=True)
            return {}
        if text[end:].strip():
            log.warning("Metadata file has trailing data; ignoring extra bytes in %s", path)

    if not isinstance(data, dict):
        log.warning("Metadata file does not contain a JSON object: %s", path)
        return {}
    return data


def load_metadata(config: WayperConfig) -> dict[str, ImageMetadata]:
    """Load all saved metadata."""
    return _read_metadata_file(config.metadata_file)


def ensure_directories(config: WayperConfig) -> None:
    """Create all required directories."""
    for purity in ALL_PURITIES:
        for orient in ORIENTATIONS:
            pool_dir(config, purity, orient).mkdir(parents=True, exist_ok=True)
            favorites_dir(config, purity, orient).mkdir(parents=True, exist_ok=True)
    # System trash is managed by the OS — no need to create trash directories
