"""Unified business logic for wallpaper operations.

All state-modifying operations live here. CLI, API, and MCP are thin wrappers.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from .backend import find_monitor, get_context, get_focused_monitor, query_current, set_wallpaper
from .config import NO_TRANSITION, WayperConfig
from .history import go_prev, pick_next
from .history import push as push_history
from .lock import FileLock
from .pool import (
    add_to_blacklist,
    favorites_dir,
    pick_random,
    pool_dir,
    remove_from_blacklist,
)
from .state import (
    orientation_from_path,
    pop_undo,
    purity_from_path,
    push_undo,
    read_mode,
    record_wallpaper_change,
    restore_from_trash,
)

log = logging.getLogger("wayper.core")


@dataclass
class CoreResult:
    """Result of a core wallpaper operation."""

    action: str
    ok: bool = True
    monitor: str | None = None
    image: Path | None = None
    status: str | None = None
    error: str | None = None
    extra: dict = field(default_factory=dict)


def _record_preference_feedback(
    config: WayperConfig,
    action: str,
    filename: str,
    *,
    context: str = "core",
    model: dict[str, object] | None = None,
    already_locked: bool = False,
) -> None:
    """Persist local feedback without making a wallpaper action fail on telemetry."""
    try:
        from .preference_model import record_preference_feedback

        record_preference_feedback(
            config,
            action,
            filename,
            source="core",
            context=context,
            model=model,
            already_locked=already_locked,
        )
        if not already_locked:
            _schedule_preference_model_retrain(config)
    except Exception:
        log.warning("Could not record preference feedback for %s", filename, exc_info=True)


def _schedule_preference_model_retrain(config: WayperConfig) -> None:
    """Request a non-blocking refresh after the state lock has been released."""
    try:
        from .preference_model import schedule_preference_model_retrain

        schedule_preference_model_retrain(config)
    except Exception:
        log.warning("Could not schedule preference model refresh", exc_info=True)


def _resolve_monitor(
    config: WayperConfig,
    monitor: str | None,
    *,
    include_current: bool = True,
) -> tuple[str | None, object | None, Path | None]:
    """Resolve monitor name to (monitor, mon_cfg, current_img)."""
    if monitor is None:
        return get_context(config)
    mon_cfg = find_monitor(config, monitor)
    if not include_current:
        return monitor, mon_cfg, None
    current = query_current()
    return monitor, mon_cfg, current.get(monitor)


def _update_monitors_for_moved_image(config: WayperConfig, old_path: Path, new_path: Path) -> None:
    """If any monitor is showing old_path, update it to new_path (no transition)."""
    try:
        current = query_current()
    except Exception:
        return
    for mon_name, cur in current.items():
        if cur and cur.resolve() == old_path.resolve():
            set_wallpaper(mon_name, new_path, NO_TRANSITION)


def _replace_on_all_monitors(
    config: WayperConfig,
    banned_img: Path,
    purities: set[str],
    *,
    exclude: Path | None = None,
) -> dict[str, Path]:
    """Replace banned_img on any monitor currently showing it."""
    replacements: dict[str, Path] = {}
    try:
        current = query_current()
    except Exception:
        return replacements
    for mon in config.monitors:
        cur = current.get(mon.name)
        if cur and cur.resolve() == banned_img.resolve():
            next_img = pick_random(config, purities, mon.orientation, exclude=exclude or banned_img)
            if next_img:
                set_wallpaper(mon.name, next_img, config.transition)
                push_history(config, mon.name, next_img)
                replacements[mon.name] = next_img
    return replacements


def do_set_wallpaper(config: WayperConfig, monitor: str, image: Path) -> CoreResult:
    """Set a specific wallpaper on a monitor."""
    mon_cfg = find_monitor(config, monitor)
    if not mon_cfg:
        return CoreResult(action="set", ok=False, error="Monitor not found")

    with FileLock():
        set_wallpaper(monitor, image, config.transition)
        record_wallpaper_change(config)

    return CoreResult(action="set", monitor=monitor, image=image)


def do_next(config: WayperConfig, monitor: str | None = None) -> CoreResult:
    """Switch to next wallpaper (forward history or random pick)."""
    t0 = time.monotonic()
    with FileLock():
        monitor, mon_cfg, _ = _resolve_monitor(config, monitor, include_current=False)
        t_resolve = time.monotonic() - t0
        if not mon_cfg:
            log.warning("next: no monitor config found (%.0fms)", t_resolve * 1000)
            return CoreResult(action="next", ok=False, error="No monitor config found")

        img = pick_next(config, monitor, mon_cfg.orientation)
        t_pick = time.monotonic() - t0
        if not img:
            log.warning("next: no images available for %s (%.0fms)", monitor, t_pick * 1000)
            return CoreResult(action="next", ok=False, error="No images available")

        set_wallpaper(monitor, img, config.transition)
        record_wallpaper_change(config)

    t_total = time.monotonic() - t0
    log.info(
        "next: %s → %s (resolve=%.0fms pick=%.0fms total=%.0fms)",
        monitor,
        img.name,
        t_resolve * 1000,
        (t_pick - t_resolve) * 1000,
        t_total * 1000,
    )
    return CoreResult(action="next", monitor=monitor, image=img)


def do_prev(config: WayperConfig, monitor: str | None = None) -> CoreResult:
    """Go back to previous wallpaper in history."""
    with FileLock():
        monitor, mon_cfg, _ = _resolve_monitor(config, monitor, include_current=False)
        if not mon_cfg:
            log.warning("prev: no monitor config found")
            return CoreResult(action="prev", ok=False, error="No monitor config found")

        img = go_prev(config, monitor)
        if not img:
            return CoreResult(action="prev", ok=True, status="at_oldest")

        set_wallpaper(monitor, img, config.transition)
        record_wallpaper_change(config)

    log.info("prev: %s → %s", monitor, img.name)
    return CoreResult(action="prev", monitor=monitor, image=img)


def do_fav(
    config: WayperConfig,
    monitor: str | None = None,
    open_url: bool = False,
    *,
    image: Path | None = None,
    wait_remote: bool = True,
) -> CoreResult:
    """Favorite a wallpaper.

    If `image` is given, operate on that path directly.
    Otherwise, operate on the current wallpaper of `monitor`.
    """
    with FileLock():
        if image is not None:
            img = image
        else:
            monitor, mon_cfg, img = _resolve_monitor(config, monitor)
            if not img or not mon_cfg:
                return CoreResult(action="fav", ok=False, error="No current wallpaper")

        if "favorites" in str(img):
            return CoreResult(action="fav", ok=True, status="already_favorite")

        purity = purity_from_path(config, img)
        orientation = orientation_from_path(config, img)
        dest_dir = favorites_dir(config, purity, orientation)
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / img.name
        img.rename(dest)

        # Update wallpaper display if this image is currently shown
        if image is not None:
            _update_monitors_for_moved_image(config, img, dest)
        else:
            set_wallpaper(monitor, dest, NO_TRANSITION)

        _record_preference_feedback(config, "favorite", dest.name, already_locked=True)

    _schedule_preference_model_retrain(config)

    from .wallhaven_web import wallhaven_web_fav

    remote_sync = wallhaven_web_fav(config, dest.name, wait=wait_remote)

    if open_url:
        import webbrowser

        from .wallhaven import wallhaven_url

        webbrowser.open(wallhaven_url(img))

    return CoreResult(
        action="fav",
        monitor=monitor,
        image=dest,
        extra={"opened": open_url, "remote_sync": remote_sync},
    )


def do_unfav(
    config: WayperConfig,
    monitor: str | None = None,
    *,
    image: Path | None = None,
    wait_remote: bool = True,
) -> CoreResult:
    """Remove a wallpaper from favorites.

    If `image` is given, operate on that path directly.
    Otherwise, operate on the current wallpaper of `monitor`.
    """
    with FileLock():
        if image is not None:
            img = image
        else:
            monitor, mon_cfg, img = _resolve_monitor(config, monitor)
            if not img or not mon_cfg:
                return CoreResult(action="unfav", ok=False, error="No current wallpaper")

        if "favorites" not in str(img):
            return CoreResult(action="unfav", ok=True, status="not_favorite")

        purity = purity_from_path(config, img)
        orientation = orientation_from_path(config, img)
        dest_dir = pool_dir(config, purity, orientation)
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / img.name
        img.rename(dest)

        if image is not None:
            _update_monitors_for_moved_image(config, img, dest)
        else:
            set_wallpaper(monitor, dest, NO_TRANSITION)

        _record_preference_feedback(config, "unfavorite", dest.name, already_locked=True)

    _schedule_preference_model_retrain(config)

    from .wallhaven_web import wallhaven_web_unfav

    remote_sync = wallhaven_web_unfav(config, dest.name, wait=wait_remote)

    return CoreResult(
        action="unfav",
        monitor=monitor,
        image=dest,
        extra={"remote_sync": remote_sync},
    )


def _do_block(
    config: WayperConfig,
    monitor: str | None = None,
    clear_thumbnail: Callable[[str], None] | None = None,
    *,
    action: str,
    feedback_action: str,
    image: Path | None = None,
    wait_remote: bool = True,
    preference_context: str = "core",
    preference_model: dict[str, object] | None = None,
) -> CoreResult:
    """Remove a wallpaper through the shared blacklist/trash/undo workflow.

    If `image` is given, operate on that path directly and replace it on
    any monitor currently showing it.
    Otherwise, operate on the current wallpaper of `monitor`.
    """
    replacement_img: Path | None = None
    replacements: dict[str, Path] = {}
    with FileLock():
        if image is not None:
            img = image
        else:
            monitor, mon_cfg, img = _resolve_monitor(config, monitor)
            if not img or not mon_cfg:
                return CoreResult(action=action, ok=False, error="No current wallpaper")

        if not img.is_file():
            return CoreResult(action=action, ok=False, error="Image is no longer available")

        shown_img = img

        # If in favorites, move back to pool first
        if "favorites" in str(img):
            purity = purity_from_path(config, img)
            orientation = orientation_from_path(config, img)
            dest_dir = pool_dir(config, purity, orientation)
            dest_dir.mkdir(parents=True, exist_ok=True)
            dest = dest_dir / img.name
            img.rename(dest)
            img = dest

        # Replace on affected monitors
        purities = read_mode(config)
        if image is not None:
            replacements = _replace_on_all_monitors(config, shown_img, purities, exclude=img)
            if replacements:
                record_wallpaper_change(config)
        else:
            next_img = pick_random(config, purities, mon_cfg.orientation, exclude=img)
            if next_img:
                set_wallpaper(monitor, next_img, config.transition)
                push_history(config, monitor, next_img)
                record_wallpaper_change(config)
                replacement_img = next_img

        add_to_blacklist(config, img.name)
        push_undo(config, img.name, img.parent)

        if clear_thumbnail:
            try:
                rel = img.relative_to(config.download_dir)
                clear_thumbnail(str(rel))
            except ValueError:
                pass

        _record_preference_feedback(
            config,
            feedback_action,
            img.name,
            context=preference_context,
            model=preference_model,
            already_locked=True,
        )

    _schedule_preference_model_retrain(config)

    from .wallhaven_web import wallhaven_web_unfav

    remote_sync = wallhaven_web_unfav(config, img.name, wait=wait_remote)

    log.info("%s: %s → trashed %s", action, monitor, img.name)
    extra = {"remote_sync": remote_sync}
    if replacement_img:
        extra["replacement_image"] = replacement_img
    if replacements:
        extra["replacement_images"] = replacements
    return CoreResult(action=action, monitor=monitor, image=img, extra=extra)


def do_ban(
    config: WayperConfig,
    monitor: str | None = None,
    clear_thumbnail: Callable[[str], None] | None = None,
    *,
    image: Path | None = None,
    wait_remote: bool = True,
    preference_context: str = "core",
    preference_model: dict[str, object] | None = None,
) -> CoreResult:
    """Ban a wallpaper; ordinary bans are not preference-training labels."""
    return _do_block(
        config,
        monitor,
        clear_thumbnail,
        action="ban",
        # Review used "ban" as its historical wire action, but it represents
        # an explicit dislike rather than an ordinary exact-image block.
        feedback_action="dislike" if preference_context == "model_review" else "ban",
        image=image,
        wait_remote=wait_remote,
        preference_context=preference_context,
        preference_model=preference_model,
    )


def do_dislike(
    config: WayperConfig,
    monitor: str | None = None,
    clear_thumbnail: Callable[[str], None] | None = None,
    *,
    image: Path | None = None,
    wait_remote: bool = True,
) -> CoreResult:
    """Mark a wallpaper as disliked, remove it, and teach the preference model."""
    return _do_block(
        config,
        monitor,
        clear_thumbnail,
        action="dislike",
        feedback_action="dislike",
        image=image,
        wait_remote=wait_remote,
        preference_context="manual_dislike",
    )


def do_unban(config: WayperConfig, monitor: str | None = None) -> CoreResult:
    """Undo the last ban: restore from trash, remove from blacklist."""
    with FileLock():
        entry = pop_undo(config)
        if not entry:
            return CoreResult(action="unban", ok=True, status="nothing_to_undo")

        filename, orig_dir = entry
        restored = restore_from_trash(config, filename, orig_dir)
        remove_from_blacklist(config, filename)

        if restored:
            if monitor is None:
                monitor = get_focused_monitor()
            if monitor:
                set_wallpaper(monitor, restored, config.transition)
                record_wallpaper_change(config)
            result = CoreResult(action="unban", monitor=monitor, image=restored)
        else:
            result = CoreResult(
                action="unban",
                ok=True,
                status="file_missing",
                extra={"note": "blacklist entry removed but file not found in trash"},
            )

        _record_preference_feedback(config, "unban", filename, already_locked=True)

    _schedule_preference_model_retrain(config)
    return result


def _metadata_backfill_filenames(
    config: WayperConfig,
    *,
    include_history: bool,
) -> set[str]:
    """Return filenames whose metadata can affect the live application or model."""
    from .pool import favorites_dir, list_images, load_metadata, pool_dir
    from .state import ALL_PURITIES

    filenames = {
        image.name
        for purity in ALL_PURITIES
        for orientation in ("landscape", "portrait")
        for directory in (
            pool_dir(config, purity, orientation),
            favorites_dir(config, purity, orientation),
            config.model_review_dir / purity / orientation,
        )
        for image in list_images(directory)
    }
    try:
        from .preference_model import load_preference_feedback

        filenames.update(
            str(event["filename"])
            for event in load_preference_feedback(config)["events"]
            if isinstance(event, dict) and isinstance(event.get("filename"), str)
        )
    except Exception:
        log.warning("Could not include preference feedback in metadata backfill", exc_info=True)
    if include_history:
        filenames.update(load_metadata(config))
    return filenames


def _metadata_backfill_sort_key(
    record: object,
    filename: str,
) -> tuple[int, int, int, int, str]:
    """Prioritize absent records and missing recommendation inputs/details."""
    tags = record.get("tags") if isinstance(record, dict) else None
    details = record.get("tag_details") if isinstance(record, dict) else None
    missing_detail_count = max(
        0,
        (len(tags) if isinstance(tags, list | tuple) else 0)
        - (len(details) if isinstance(details, list | tuple) else 0),
    )
    return (
        0 if not isinstance(record, dict) else 1,
        0 if not isinstance(record, dict) or not record.get("tags") else 1,
        0 if not isinstance(record, dict) or not record.get("tag_details") else 1,
        -missing_detail_count,
        filename,
    )


def metadata_backfill_status(
    config: WayperConfig,
    *,
    include_history: bool = False,
) -> dict[str, int]:
    """Summarize metadata completeness for the same scope used by backfill."""
    from .pool import load_metadata

    metadata = load_metadata(config)
    filenames = _metadata_backfill_filenames(config, include_history=include_history)
    missing_records = sum(not isinstance(metadata.get(filename), dict) for filename in filenames)
    missing_tags = sum(
        isinstance(metadata.get(filename), dict) and not metadata[filename].get("tags")
        for filename in filenames
    )
    incomplete = sum(
        isinstance(metadata.get(filename), dict)
        and metadata[filename].get("metadata_complete") is not True
        for filename in filenames
    )
    unavailable = sum(
        isinstance(metadata.get(filename), dict)
        and metadata[filename].get("metadata_unavailable") is True
        for filename in filenames
    )
    tag_details_complete = sum(
        isinstance(metadata.get(filename), dict)
        and bool(metadata[filename].get("tags"))
        and metadata[filename].get("tag_details_complete") is True
        for filename in filenames
    )
    partial_tag_details = sum(
        isinstance(metadata.get(filename), dict)
        and bool(metadata[filename].get("tags"))
        and bool(metadata[filename].get("tag_details"))
        and metadata[filename].get("tag_details_complete") is not True
        for filename in filenames
    )
    missing_tag_details = sum(
        isinstance(metadata.get(filename), dict)
        and bool(metadata[filename].get("tags"))
        and not metadata[filename].get("tag_details")
        for filename in filenames
    )
    return {
        "records": len(filenames),
        "missing_records": missing_records,
        "missing_tags": missing_tags,
        "missing_tag_inputs": missing_records + missing_tags,
        "incomplete_records": missing_records + incomplete,
        "complete_records": len(filenames) - missing_records - incomplete,
        "unavailable_records": unavailable,
        "tag_details_complete_records": tag_details_complete,
        "partial_tag_detail_records": partial_tag_details,
        "missing_tag_detail_records": missing_tag_details,
    }


async def do_backfill_metadata(
    config: WayperConfig,
    *,
    include_history: bool = False,
    missing_tags_only: bool = False,
    limit: int | None = None,
    delay_seconds: float = 1.4,
    batch_size: int = 20,
    progress: Callable[[dict[str, int]], None] | None = None,
) -> CoreResult:
    """Fetch complete Wallhaven metadata for relevant local records.

    The default delay stays below Wallhaven's documented 45-request/minute
    limit. Successful batches are committed atomically so interruption is safe
    and a later invocation resumes from ``metadata_complete`` markers.
    """
    from .pool import hydrate_tag_details, load_metadata, save_metadata_batch
    from .wallhaven import WallhavenClient, wallhaven_id

    metadata = load_metadata(config)
    filenames = _metadata_backfill_filenames(config, include_history=include_history)

    def needs_fetch(filename: str) -> bool:
        record = metadata.get(filename)
        if not isinstance(record, dict):
            return True
        if missing_tags_only:
            return not bool(record.get("tags"))
        return record.get("metadata_complete") is not True

    eligible_targets = sorted(
        (filename for filename in filenames if needs_fetch(filename)),
        key=lambda filename: _metadata_backfill_sort_key(metadata.get(filename), filename),
    )
    targets = eligible_targets
    if limit is not None:
        targets = targets[: max(0, limit)]
    total = len(targets)
    if not targets:
        hydration = await asyncio.to_thread(hydrate_tag_details, config)
        remaining = len(eligible_targets)
        return CoreResult(
            action="metadata_backfill",
            status="complete" if not remaining else "partial",
            extra={
                "targeted": 0,
                "updated": 0,
                "failed": 0,
                "remaining": remaining,
                "tag_hydration": hydration,
            },
        )

    client = WallhavenClient(config)
    pending: dict[str, dict[str, object]] = {}
    unavailable: dict[str, dict[str, object]] = {}
    attempted = updated = failed = 0

    async def commit() -> None:
        nonlocal updated
        if not pending:
            return
        batch = dict(pending)
        await asyncio.to_thread(save_metadata_batch, config, batch, complete=True)
        updated += len(batch)
        pending.clear()

    async def commit_unavailable() -> None:
        if not unavailable:
            return
        batch = dict(unavailable)
        await asyncio.to_thread(save_metadata_batch, config, batch, complete=False)
        unavailable.clear()

    try:
        for index, filename in enumerate(targets):
            detail = await client.wallpaper_info(wallhaven_id(filename), retries=1)
            attempted += 1
            if detail:
                pending[filename] = detail
            else:
                failed += 1
                unavailable[filename] = {
                    "id": wallhaven_id(filename),
                    "metadata_unavailable": True,
                    "metadata_error": "unavailable_or_request_failed",
                    "metadata_checked_at": int(time.time()),
                }
            if len(pending) + len(unavailable) >= max(1, batch_size):
                await commit()
                await commit_unavailable()
            if progress is not None and (attempted == total or attempted % 10 == 0):
                progress(
                    {
                        "targeted": total,
                        "attempted": attempted,
                        "updated": updated + len(pending),
                        "failed": failed,
                    }
                )
            if index + 1 < total and delay_seconds > 0:
                await asyncio.sleep(delay_seconds)
    finally:
        await commit()
        await commit_unavailable()
        await client.close()

    hydration = await asyncio.to_thread(hydrate_tag_details, config)
    remaining = max(0, len(eligible_targets) - updated)
    return CoreResult(
        action="metadata_backfill",
        status="complete" if not remaining else "partial",
        extra={
            "targeted": total,
            "attempted": attempted,
            "updated": updated,
            "failed": failed,
            "remaining": remaining,
            "tag_hydration": hydration,
        },
    )
