"""Quarantine and review state for automatic preference-model filtering.

The preference model is deliberately conservative at the download boundary:
an image that clears the model's validated dislike threshold is downloaded to a
small, per-library quarantine instead of being silently deleted or blacklisted.
Only an explicit Keep or Ban action changes the normal library state and emits
the feedback event used for retraining.
"""

from __future__ import annotations

import json
import logging
import math
import shutil
import time
from collections.abc import Iterable
from pathlib import Path

from .config import WayperConfig, normalize_filter_strategy
from .lock import FileLock
from .pool import add_to_blacklist, pool_dir
from .state import ALL_PURITIES
from .trash import _trash_file
from .util import atomic_write

log = logging.getLogger("wayper.model_review")

MODEL_REVIEW_SCHEMA_VERSION = 1
_STATUSES = frozenset({"pending", "keep", "ban"})


def _empty_state() -> dict[str, object]:
    return {"schema_version": MODEL_REVIEW_SCHEMA_VERSION, "items": {}}


def _clean_record(value: object) -> dict[str, object] | None:
    if not isinstance(value, dict):
        return None
    filename = Path(str(value.get("name", value.get("filename", "")))).name
    path = value.get("path")
    status = value.get("status", "pending")
    if not filename or not isinstance(path, str) or status not in _STATUSES:
        return None
    # Normalize indexes written by a Windows build before comparing them with
    # the browser/API's URL-style paths.
    path = path.replace("\\", "/")
    # Keep the index bounded to JSON-safe primitive values.  Model evidence is
    # copied into the record for auditability, but arbitrary client payloads
    # never enter this file.
    clean: dict[str, object] = {
        "name": filename,
        "path": path,
        "status": status,
    }
    for key in (
        "purity",
        "orientation",
        "strategy",
        "created_at",
        "resolved_at",
        "feedback_recorded",
    ):
        item = value.get(key)
        if isinstance(item, str | int | float | bool):
            clean[key] = item
    model = value.get("model")
    if isinstance(model, dict):
        clean_model: dict[str, object] = {}
        for key, item in model.items():
            if isinstance(item, str | int | float | bool) and not (
                isinstance(item, float) and not math.isfinite(item)
            ):
                clean_model[str(key)] = item
            elif key in {"neighbor_nearest_dislike", "neighbor_nearest_keep"} and isinstance(
                item, dict
            ):
                neighbor = {
                    str(k): v
                    for k, v in item.items()
                    if isinstance(v, str | int | float | bool)
                    and not (isinstance(v, float) and not math.isfinite(v))
                }
                if neighbor:
                    clean_model[key] = neighbor
            elif key in {"dislike_evidence", "keep_evidence", "contributions"} and isinstance(
                item, list
            ):
                # Evidence entries are generated locally.  Retain only their
                # primitive fields so the review screen can explain a hit.
                evidence: list[dict[str, object]] = []
                for entry in item[:20]:
                    if not isinstance(entry, dict):
                        continue
                    clean_entry = {
                        str(k): v
                        for k, v in entry.items()
                        if isinstance(v, str | int | float | bool)
                    }
                    if clean_entry:
                        evidence.append(clean_entry)
                if evidence:
                    clean_model[key] = evidence
        if clean_model:
            clean["model"] = clean_model
    return clean


def load_model_review_state(config: WayperConfig) -> dict[str, object]:
    """Load the review index, tolerating an interrupted or old write."""
    try:
        raw = json.loads(config.model_review_file.read_text())
    except (OSError, ValueError, json.JSONDecodeError):
        return _empty_state()
    if not isinstance(raw, dict) or raw.get("schema_version") != MODEL_REVIEW_SCHEMA_VERSION:
        return _empty_state()
    raw_items = raw.get("items", {})
    if not isinstance(raw_items, dict):
        return _empty_state()
    items: dict[str, dict[str, object]] = {}
    for key, value in raw_items.items():
        record = _clean_record(value)
        if record is None:
            continue
        items[str(key)] = record
    return {"schema_version": MODEL_REVIEW_SCHEMA_VERSION, "items": items}


def _save_model_review_state(config: WayperConfig, state: dict[str, object]) -> None:
    config.model_review_file.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(config.model_review_file, json.dumps(state, ensure_ascii=False, indent=2) + "\n")


def _relative_path(config: WayperConfig, image: Path) -> str:
    """Return a stable, URL-safe path relative to the library root."""
    resolved = image.resolve()
    root = config.download_dir.resolve()
    if not resolved.is_relative_to(root):
        raise ValueError("model review image must be inside the download directory")
    # The API exposes this value to the browser as a relative URL.  Always use
    # forward slashes so indexes created on Windows remain portable.
    return resolved.relative_to(root).as_posix()


def _review_path(config: WayperConfig, raw_path: str) -> Path:
    """Resolve a queue path and reject traversal/non-quarantine files."""
    root = config.download_dir.resolve()
    candidate = (root / raw_path).resolve()
    review_root = config.model_review_dir.resolve()
    if not candidate.is_relative_to(review_root):
        raise ValueError("model review path must point inside the quarantine")
    return candidate


def pending_model_review_count(
    config: WayperConfig,
    *,
    purities: Iterable[str] | None = None,
    orientation: str | None = None,
) -> int:
    """Count existing pending files, optionally scoped like the review API."""
    active = set(purities or ALL_PURITIES) & set(ALL_PURITIES)
    if not active:
        active = {"sfw"}
    state = load_model_review_state(config)
    items = state.get("items", {})
    if not isinstance(items, dict):
        return 0
    count = 0
    for value in items.values():
        record = _clean_record(value)
        if record is None or record.get("status") != "pending":
            continue
        raw_path = record.get("path")
        if not isinstance(raw_path, str):
            continue
        if str(record.get("purity", "sfw")) not in active:
            continue
        if orientation and record.get("orientation") != orientation:
            continue
        try:
            if _review_path(config, raw_path).is_file():
                count += 1
        except ValueError:
            continue
    return count


def list_model_review_items(
    config: WayperConfig,
    *,
    purities: Iterable[str] | None = None,
    orientation: str | None = None,
    limit: int = 100,
    include_resolved: bool = False,
) -> list[dict[str, object]]:
    """Return queue records whose files still exist, newest/model-first."""
    active = set(purities or ALL_PURITIES) & set(ALL_PURITIES)
    if not active:
        active = {"sfw"}
    state = load_model_review_state(config)
    raw_items = state.get("items", {})
    if not isinstance(raw_items, dict):
        return []
    result: list[dict[str, object]] = []
    for value in raw_items.values():
        record = _clean_record(value)
        if record is None:
            continue
        if not include_resolved and record.get("status") != "pending":
            continue
        purity = str(record.get("purity", "sfw"))
        if purity not in active:
            continue
        if orientation and record.get("orientation") != orientation:
            continue
        raw_path = record.get("path")
        if not isinstance(raw_path, str):
            continue
        try:
            image = _review_path(config, raw_path)
        except ValueError:
            continue
        if record.get("status") == "pending" and not image.is_file():
            continue
        item = dict(record)
        item["path"] = raw_path
        item["name"] = str(record.get("name", image.name))
        item["review_only"] = True
        item["auto_filtered"] = True
        model = item.get("model")
        if isinstance(model, dict):
            for key in (
                "probability",
                "calibrated",
                "score",
                "feature_score",
                "review_score",
                "hybrid_score",
                "semantic_score",
                "semantic_probability",
                "semantic_available",
                "neighbor_probability",
                "neighbor_available",
                "neighbor_count",
                "neighbor_dislike_count",
                "neighbor_keep_count",
                "neighbor_similarity_sum",
                "neighbor_max_similarity",
                "neighbor_nearest_dislike",
                "neighbor_nearest_keep",
                "threshold",
                "contributions",
                "dislike_evidence",
                "keep_evidence",
            ):
                if key in model:
                    item[key] = model[key]
        result.append(item)

    def sort_key(item: dict[str, object]) -> tuple[float, float, str]:
        model = item.get("model")
        score = 0.0
        if isinstance(model, dict):
            neighbor_score = model.get("neighbor_probability")
            if isinstance(neighbor_score, int | float):
                score = float(neighbor_score)
            else:
                for key in ("probability", "review_score", "feature_score"):
                    value = model.get(key)
                    if isinstance(value, int | float):
                        score = max(score, float(value))
        created = item.get("created_at", 0)
        return (
            -score,
            -float(created) if isinstance(created, int | float) else 0.0,
            str(item["name"]),
        )

    result.sort(key=sort_key)
    return result[: max(1, min(500, int(limit)))]


def queue_model_review_item(
    config: WayperConfig,
    image: Path,
    *,
    purity: str,
    orientation: str,
    prediction: dict[str, object],
    strategy: str,
) -> dict[str, object]:
    """Register one downloaded model hit as a pending review item."""
    if purity not in ALL_PURITIES or orientation not in {"landscape", "portrait"}:
        raise ValueError("Invalid model review location")
    if not image.is_file():
        raise FileNotFoundError(image)
    clean_strategy = normalize_filter_strategy(strategy)
    path = _relative_path(config, image)
    now = int(time.time())
    clean_model = _clean_record(
        {
            "name": image.name,
            "path": path,
            "status": "pending",
            "model": prediction,
        }
    )
    # _clean_record validates the envelope; extract its bounded model payload.
    bounded_model = clean_model.get("model", {}) if clean_model else {}
    record: dict[str, object] = {
        "name": image.name,
        "path": path,
        "purity": purity,
        "orientation": orientation,
        "strategy": clean_strategy,
        "status": "pending",
        "created_at": now,
        "model": bounded_model,
    }
    with FileLock():
        state = load_model_review_state(config)
        items = state.setdefault("items", {})
        assert isinstance(items, dict)
        # Index by the canonical relative path.  Older versions used only a
        # basename, which could overwrite two same-named files in separate
        # purity/orientation queues.  Remove a legacy entry for this exact
        # path while preserving all unrelated records.
        for key, value in list(items.items()):
            existing = _clean_record(value)
            if existing and existing.get("path") == path and str(key) != path:
                del items[key]
        items[path] = record
        _save_model_review_state(config, state)
    return dict(record, review_only=True, auto_filtered=True)


def _record_feedback_unlocked(
    config: WayperConfig,
    action: str,
    filename: str,
    model: dict[str, object],
) -> None:
    from .preference_model import record_preference_feedback

    record_preference_feedback(
        config,
        "dislike" if action == "ban" else action,
        filename,
        source="model_filter",
        context="model_review",
        model=model,
        already_locked=True,
    )


def resolve_model_review_item(
    config: WayperConfig,
    raw_path: str,
    action: str,
) -> dict[str, object]:
    """Apply an explicit Keep/Dislike decision and return the resolved record."""
    if action not in {"keep", "ban"}:
        raise ValueError("Model review action must be keep or ban")

    with FileLock():
        image = _review_path(config, raw_path)
        state = load_model_review_state(config)
        items = state.get("items", {})
        if not isinstance(items, dict):
            raise FileNotFoundError("Model review item is no longer available")
        canonical_path = _relative_path(config, image)
        key: str | None = None
        record: dict[str, object] | None = None
        # Match by path rather than basename.  This supports legacy
        # basename-keyed indexes while preventing a same-named image in a
        # different queue from being resolved accidentally.
        for candidate_key, candidate_value in items.items():
            cleaned = _clean_record(candidate_value)
            if cleaned and cleaned.get("path") == canonical_path:
                key = str(candidate_key)
                record = candidate_value if isinstance(candidate_value, dict) else cleaned
                break
        if (
            key is None
            or not isinstance(record, dict)
            or record.get("status") != "pending"
            or record.get("path") != canonical_path
        ):
            raise FileNotFoundError("Model review item is no longer pending")
        if not image.is_file():
            raise FileNotFoundError("Model review image is no longer available")

        purity = str(record.get("purity", "sfw"))
        orientation = str(record.get("orientation", "landscape"))
        if purity not in ALL_PURITIES or orientation not in {"landscape", "portrait"}:
            raise ValueError("Model review item has an invalid library location")
        destination_dir = pool_dir(config, purity, orientation)
        destination_dir.mkdir(parents=True, exist_ok=True)
        destination = destination_dir / image.name
        if destination.exists():
            raise FileExistsError(f"A library image named {image.name} already exists")
        shutil.move(str(image), str(destination))

        model = dict(record.get("model")) if isinstance(record.get("model"), dict) else {}
        model["filter_strategy"] = str(record.get("strategy", "model"))
        if action == "ban":
            # Use the same system trash and undo contract as a normal ban, but
            # keep the original pool location in the undo log so an unban is a
            # usable correction rather than restoring into hidden quarantine.
            add_to_blacklist(config, destination.name)
            _trash_file(config, destination)
            with config.undo_file.open("a", encoding="utf-8") as stream:
                stream.write(f"{destination.name} {destination_dir}\n")
        feedback_recorded = True
        try:
            _record_feedback_unlocked(config, action, destination.name, model)
        except Exception:
            feedback_recorded = False
            log.warning(
                "Could not record model-review feedback for %s",
                destination.name,
                exc_info=True,
            )

        record["status"] = action
        record["resolved_at"] = int(time.time())
        record["feedback_recorded"] = feedback_recorded
        record["path"] = canonical_path
        assert key is not None
        items[key] = record
        _save_model_review_state(config, state)
        result = dict(record)
        result["new_path"] = (
            str(destination.relative_to(config.download_dir)) if action == "keep" else None
        )

    try:
        from .preference_model import schedule_preference_model_retrain

        schedule_preference_model_retrain(config)
    except Exception:
        log.warning("Could not schedule model refresh after %s", action, exc_info=True)
    return result


def model_review_status(
    config: WayperConfig,
    *,
    purities: Iterable[str] | None = None,
    orientation: str | None = None,
    include_learning: bool = True,
) -> dict[str, object]:
    """Return queue and model readiness details for status/API consumers.

    ``purities`` and ``orientation`` scope the pending queue count to the
    same library slice shown by the caller.  The model readiness metadata is
    global to the download directory and is intentionally left unchanged.
    Omitting both arguments preserves the historical global count.
    """
    from .preference_model import (
        auto_filter_status,
        load_preference_model,
        preference_learning_status,
        preference_model_path,
    )

    model = load_preference_model(preference_model_path(config))
    status = auto_filter_status(config, model=model)
    # Keep learning metadata alongside the gate state.  The review page is a
    # feedback loop, so showing only "ready" leaves users unable to tell
    # whether their latest Keep/Dislike decisions will trigger a refresh.
    if include_learning:
        try:
            status["learning"] = preference_learning_status(config, model=model)
        except Exception:
            log.debug("Could not read preference learning status", exc_info=True)
            status["learning"] = None
    status["pending_count"] = pending_model_review_count(
        config,
        purities=purities,
        orientation=orientation,
    )
    return status


__all__ = [
    "MODEL_REVIEW_SCHEMA_VERSION",
    "list_model_review_items",
    "load_model_review_state",
    "model_review_status",
    "pending_model_review_count",
    "queue_model_review_item",
    "resolve_model_review_item",
]
