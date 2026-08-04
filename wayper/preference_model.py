"""Local preference ranking trained from Wallhaven metadata.

The primary model remains an explainable sparse FTRL ranker.  When the optional
semantic extra is installed, an additional local text head generalizes across
related tags.  Neither path reads image pixels.
"""

from __future__ import annotations

import json
import logging
import math
import os
import secrets
import subprocess
import sys
import time
from collections.abc import Iterable
from pathlib import Path

from .config import WayperConfig
from .lock import FileLock
from .preference.model import (
    _CONTEXT_FIELDS,
    _NON_PREFERENCE_FEATURE_TAGS,
    _PAIR_SEPARATOR,
    DEFAULT_COMBO_MIN_SUPPORT,
    DEFAULT_EPOCHS,
    DEFAULT_FAVORITE_WEIGHT,
    DEFAULT_FEATURE_NORMALIZATION,
    DEFAULT_MAX_COMBO_FEATURES,
    DEFAULT_RECENCY_HALF_LIFE_DAYS,
    DEFAULT_REVIEW_DISLIKE_BOOST,
    DEFAULT_REVIEW_THRESHOLD,
    DEFAULT_THRESHOLD,
    DEFAULT_UPLOADER_MIN_SUPPORT,
    LEGACY_MODEL_SCHEMA_VERSION,
    MIN_TRAINING_PER_CLASS,
    MIN_VALIDATION_PER_CLASS,
    MODEL_SCHEMA_VERSION,
    FeatureSpace,
    PreferenceExample,
    PreferenceModel,
    PreferencePrediction,
    PreferenceTrainingSnapshot,
    _active_feature_values,
    _active_features,
    _combo_feature,
    _context_min_support,
    _contribution_direction,
    _display_context_feature,
    _format_pair,
    _ftrl_weight,
    _is_eligible_tag,
    _model_context_features,
    _model_tags,
    _normalize_context_features,
    _pair_is_eligible,
    _pair_keys,
    _sigmoid,
    _storage_feature_key,
    preference_review_candidate,
    preference_review_decision_score,
    preference_review_score,
    preference_review_threshold,
)
from .preference.semantic import (
    DEFAULT_SEMANTIC_BLEND,
    DEFAULT_SEMANTIC_MODEL,
    DEFAULT_SEMANTIC_RANK_WEIGHT,
)
from .preference.training import (
    REVIEW_CALIBRATION_VERSION,
    _build_feature_space,
    _evaluate,
    _fit,
    _fit_ftrl,
    _has_both_classes,
    _metadata_timestamp,
    _recency_weight,
    _roc_auc,
    _sample_weights,
    _temporal_split,
    _training_data_signature,
    _training_example_ids,
    _training_example_payload,
    _validate_training_examples,
    _wilson_lower_bound,
    train_preference_model,
)
from .process import windows_no_window_kwargs
from .tags import normalize_tag
from .util import atomic_write

# Preserve the original module's import surface while implementation details
# live in focused model and training modules.
__all__ = [
    "MODEL_SCHEMA_VERSION",
    "LEGACY_MODEL_SCHEMA_VERSION",
    "DEFAULT_COMBO_MIN_SUPPORT",
    "DEFAULT_MAX_COMBO_FEATURES",
    "DEFAULT_UPLOADER_MIN_SUPPORT",
    "DEFAULT_EPOCHS",
    "DEFAULT_THRESHOLD",
    "DEFAULT_FAVORITE_WEIGHT",
    "DEFAULT_RECENCY_HALF_LIFE_DAYS",
    "DEFAULT_FEATURE_NORMALIZATION",
    "DEFAULT_SEMANTIC_MODEL",
    "DEFAULT_SEMANTIC_BLEND",
    "DEFAULT_SEMANTIC_RANK_WEIGHT",
    "MIN_TRAINING_PER_CLASS",
    "MIN_VALIDATION_PER_CLASS",
    "AUTO_SKIP_MIN_PRECISION",
    "AUTO_SKIP_MIN_PREDICTIONS",
    "AUTO_SKIP_MIN_PRECISION_LOWER_BOUND",
    "DEFAULT_REVIEW_MIN_FEATURE_SCORE",
    "DEFAULT_REVIEW_MIN_SEMANTIC_SCORE",
    "DEFAULT_REVIEW_DISLIKE_BOOST",
    "DEFAULT_REVIEW_THRESHOLD",
    "DEFAULT_REVIEW_LIMIT",
    "DEFAULT_REVIEW_REASON_LIMIT",
    "AUTO_RETRAIN_MIN_FEEDBACK",
    "AUTO_RETRAIN_MIN_CHANGED_EXAMPLES",
    "AUTO_RETRAIN_DELAY_SECONDS",
    "AUTO_RETRAIN_WORKER_STALE_SECONDS",
    "normalize_tag",
    "FeatureSpace",
    "PreferenceExample",
    "PreferenceModel",
    "PreferencePrediction",
    "PreferenceTrainingSnapshot",
    "_CONTEXT_FIELDS",
    "_NON_PREFERENCE_FEATURE_TAGS",
    "_PAIR_SEPARATOR",
    "_active_feature_values",
    "_active_features",
    "_build_feature_space",
    "_combo_feature",
    "_context_min_support",
    "_contribution_direction",
    "_display_context_feature",
    "_evaluate",
    "_fit",
    "_fit_ftrl",
    "_format_pair",
    "_ftrl_weight",
    "_has_both_classes",
    "_is_eligible_tag",
    "_normalize_context_features",
    "_pair_is_eligible",
    "_pair_keys",
    "_roc_auc",
    "_sample_weights",
    "_sigmoid",
    "_storage_feature_key",
    "_temporal_split",
    "_training_example_payload",
    "_validate_training_examples",
    "_wilson_lower_bound",
    "train_preference_model",
    "preference_model_path",
    "preference_feedback_path",
    "preference_historical_bans_path",
    "load_preference_historical_bans",
    "save_preference_model",
    "load_preference_model",
    "load_preference_feedback",
    "record_preference_feedback",
    "build_training_examples",
    "collect_preference_training_snapshot",
    "train_local_preference_model",
    "train_and_save_local_preference_model",
    "model_report",
    "auto_skip_ready",
    "auto_filter_status",
    "auto_filter_prediction",
    "preference_learning_status",
    "preference_deletion_suggestions",
    "schedule_preference_model_retrain",
    "run_scheduled_preference_model_retrain",
]

AUTO_SKIP_MIN_PRECISION = 0.95
AUTO_SKIP_MIN_PREDICTIONS = 20
AUTO_SKIP_MIN_PRECISION_LOWER_BOUND = 0.80
# Legacy diagnostic exports retained for callers that inspected the former
# two-part recall gate. Binary Review decisions now use the learned combined
# boundary exposed as ``DEFAULT_REVIEW_THRESHOLD``.
DEFAULT_REVIEW_MIN_FEATURE_SCORE = -0.2
DEFAULT_REVIEW_MIN_SEMANTIC_SCORE = 0.006
DEFAULT_REVIEW_LIMIT = 24
DEFAULT_REVIEW_REASON_LIMIT = 2
AUTO_RETRAIN_MIN_FEEDBACK = 10
AUTO_RETRAIN_MIN_CHANGED_EXAMPLES = 12
AUTO_RETRAIN_DELAY_SECONDS = 5
AUTO_RETRAIN_WORKER_STALE_SECONDS = 30 * 60
_FEEDBACK_SCHEMA_VERSION = 2
_LEGACY_FEEDBACK_SCHEMA_VERSION = 1
_HISTORICAL_BAN_SCHEMA_VERSION = 1
_FEEDBACK_ACTIONS = frozenset({"ban", "dislike", "unban", "favorite", "unfavorite", "keep"})

log = logging.getLogger("wayper.preference_model")


def preference_model_path(config: WayperConfig) -> Path:
    """Return the local, per-download-directory model path."""
    return config.preference_model_file


def preference_feedback_path(config: WayperConfig) -> Path:
    """Return the append-only local preference feedback ledger path."""
    return config.preference_events_file


def preference_historical_bans_path(config: WayperConfig) -> Path:
    """Return compact bootstrap labels for bans predating the feedback ledger."""
    return config.download_dir / ".preference_historical_bans.json"


def load_preference_historical_bans(config: WayperConfig) -> dict[str, int]:
    """Load old ban labels retained after normal blacklist TTL pruning."""
    path = preference_historical_bans_path(config)
    try:
        raw = json.loads(path.read_text())
    except (OSError, ValueError, json.JSONDecodeError):
        return {}
    if not isinstance(raw, dict) or raw.get("schema_version") != _HISTORICAL_BAN_SCHEMA_VERSION:
        return {}
    records = raw.get("bans")
    if not isinstance(records, list):
        return {}
    bans: dict[str, int] = {}
    for record in records:
        if (
            not isinstance(record, list)
            or len(record) != 2
            or not isinstance(record[0], int)
            or not isinstance(record[1], str)
        ):
            continue
        filename = Path(record[1]).name
        if filename:
            bans[filename] = max(record[0], bans.get(filename, 0))
    return bans


def _bootstrap_historical_preference_bans(config: WayperConfig) -> int:
    """Persist pre-ledger blacklist labels without inflating feedback revisions.

    Existing users can have years of blacklist history when preference feedback
    is introduced. Copying only entries with no explicit ledger action gives
    those labels durable storage while later ban/unban/keep actions remain the
    source of truth and the feedback threshold stays meaningful.
    """
    from .pool import list_blacklist

    path = preference_historical_bans_path(config)
    with FileLock():
        historical = load_preference_historical_bans(config)
        latest_feedback = _latest_feedback_by_filename(load_preference_feedback(config)["events"])
        changed = False
        for timestamp, raw_filename in list_blacklist(config):
            filename = Path(raw_filename).name
            if not filename or filename in latest_feedback:
                continue
            if timestamp > historical.get(filename, 0):
                historical[filename] = timestamp
                changed = True
        if changed:
            path.parent.mkdir(parents=True, exist_ok=True)
            atomic_write(
                path,
                json.dumps(
                    {
                        "schema_version": _HISTORICAL_BAN_SCHEMA_VERSION,
                        "bans": [
                            [timestamp, filename]
                            for filename, timestamp in sorted(historical.items())
                        ],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
            )
    return len(historical)


def _preference_model_lock_path(path: Path) -> Path:
    """Return the lock dedicated to one persisted model file."""
    return path.with_name(f"{path.name}.lock")


def _write_preference_model_unlocked(model: PreferenceModel, path: Path) -> None:
    """Atomically write a model while its dedicated write lock is held."""
    atomic_write(path, json.dumps(model.to_dict(), ensure_ascii=False, indent=2) + "\n")


def save_preference_model(model: PreferenceModel, path: Path) -> None:
    """Persist a model atomically, serializing manual and automatic writers."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with FileLock(path=_preference_model_lock_path(path)):
        _write_preference_model_unlocked(model, path)


def load_preference_model(path: Path) -> PreferenceModel | None:
    """Load a model if present; malformed or obsolete files are ignored."""
    if not path.exists():
        return None
    try:
        return PreferenceModel.from_dict(json.loads(path.read_text()))
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError):
        return None


def load_preference_feedback(config: WayperConfig) -> dict[str, object]:
    """Load merged v1 JSON and v2 JSONL feedback without rewriting either file."""
    events_by_revision: dict[int, dict[str, object]] = {}
    declared_revision = 0

    legacy_path = config.preference_feedback_file
    try:
        raw = json.loads(legacy_path.read_text())
    except (OSError, ValueError, json.JSONDecodeError):
        raw = None
    if isinstance(raw, dict) and raw.get("schema_version") == _LEGACY_FEEDBACK_SCHEMA_VERSION:
        revision = raw.get("revision")
        if isinstance(revision, int) and revision >= 0:
            declared_revision = revision
        raw_events = raw.get("events")
        if isinstance(raw_events, list):
            for event in raw_events:
                if _is_feedback_event(event):
                    clean_event = dict(event)
                    clean_event.setdefault("schema_version", _LEGACY_FEEDBACK_SCHEMA_VERSION)
                    clean_event["filename"] = Path(str(event["filename"])).name
                    events_by_revision[int(event["revision"])] = clean_event

    path = preference_feedback_path(config)
    try:
        lines = path.read_text().splitlines()
    except OSError:
        lines = []
    for line in lines:
        try:
            event = json.loads(line)
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        if _is_feedback_event(event) and event.get("schema_version") == _FEEDBACK_SCHEMA_VERSION:
            revision = int(event["revision"])
            clean_event = dict(event)
            clean_event["filename"] = Path(str(event["filename"])).name
            events_by_revision[revision] = clean_event
            declared_revision = max(declared_revision, revision)

    clean_events = [events_by_revision[key] for key in sorted(events_by_revision)]
    return {
        "schema_version": _FEEDBACK_SCHEMA_VERSION,
        "revision": max(declared_revision, max(events_by_revision, default=0)),
        "events": clean_events,
    }


def _preference_image_id(filename: str) -> str:
    stem = Path(filename).stem
    if stem.startswith("wallhaven-") and len(stem) > len("wallhaven-"):
        return f"wallhaven:{stem.removeprefix('wallhaven-')}"
    return f"file:{Path(filename).name}"


def _clean_model_feedback(model: dict[str, object] | None) -> dict[str, object] | None:
    if not isinstance(model, dict):
        return None
    allowed = {
        "schema_version",
        "feature_normalization",
        "trained_at",
        "threshold",
        "review_threshold",
        "semantic_threshold",
        "filter_strategy",
        "score",
        "feature_score",
        "review_score",
        "decision_score",
        "strongest_review_dislike_score",
        "strongest_review_keep_score",
        "hybrid_score",
        "semantic_score",
        "semantic_probability",
        "semantic_available",
        "probability",
        "calibrated",
        "percentile",
        "rank",
    }
    clean = {
        str(key): value
        for key, value in model.items()
        if key in allowed
        and isinstance(value, str | int | float | bool)
        and not (isinstance(value, float) and not math.isfinite(value))
    }
    return clean or None


def record_preference_feedback(
    config: WayperConfig,
    action: str,
    filename: str,
    *,
    source: str = "user",
    context: str | None = None,
    model: dict[str, object] | None = None,
    timestamp: int | None = None,
    already_locked: bool = False,
) -> int:
    """Append one explicit preference action and return its persistent revision.

    The ledger makes retraining survive CLI/API process restarts.  It records
    actions only; candidate display itself is never treated as a label.
    """
    if action not in _FEEDBACK_ACTIONS:
        raise ValueError(f"Unsupported preference feedback action: {action}")
    clean_filename = Path(filename).name
    if not clean_filename:
        raise ValueError("Preference feedback needs a filename")

    def append_event() -> int:
        state = load_preference_feedback(config)
        revision = int(state["revision"]) + 1
        event: dict[str, object] = {
            "schema_version": _FEEDBACK_SCHEMA_VERSION,
            "revision": revision,
            "timestamp": int(time.time()) if timestamp is None else int(timestamp),
            "image_id": _preference_image_id(clean_filename),
            "filename": clean_filename,
            "action": action,
            "source": source,
            "context": context or source,
            "explicit": action != "unfavorite",
        }
        clean_model = _clean_model_feedback(model)
        if clean_model is not None:
            event["model"] = clean_model
        path = preference_feedback_path(config)
        path.parent.mkdir(parents=True, exist_ok=True)
        needs_separator = False
        try:
            needs_separator = path.stat().st_size > 0 and not path.read_bytes().endswith(b"\n")
        except OSError:
            pass
        with path.open("a", encoding="utf-8") as stream:
            if needs_separator:
                stream.write("\n")
            stream.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        return revision

    if already_locked:
        return append_event()
    with FileLock():
        return append_event()


def build_training_examples(
    metadata: dict[str, dict],
    blacklist_entries: Iterable[tuple[int, str]],
    favorites: set[str],
    retained_files: set[str] | None = None,
    *,
    historical_bans: Iterable[tuple[int, str]] = (),
    feedback_events: Iterable[dict[str, object]] = (),
    now: int | None = None,
    favorite_weight: float = DEFAULT_FAVORITE_WEIGHT,
    recency_half_life_days: int = DEFAULT_RECENCY_HALF_LIFE_DAYS,
    review_only: bool = False,
) -> list[PreferenceExample]:
    """Build dislike, explicit-keep, and background-control examples.

    Metadata left behind by quota eviction is deliberately ignored unless a
    caller explicitly includes it in ``retained_files``. A ban timestamp is
    used as a recency signal; favorites are retained examples with stronger
    positive weight. Explicit "keep" feedback is also a strong positive and
    uses the action time rather than a potentially old download timestamp.

    A live file without an explicit decision is a background control, not a
    claim that the user likes it. Controls help learn a case-control ranking but
    are excluded from temporal validation and reported separately.
    """
    now = int(time.time()) if now is None else now
    if review_only:
        return _build_curated_preference_examples(
            metadata,
            feedback_events,
            now=now,
            favorite_weight=favorite_weight,
            recency_half_life_days=recency_half_life_days,
        )
    latest_bans: dict[str, int] = {}
    for entries in (blacklist_entries, historical_bans):
        for timestamp, filename in entries:
            if filename in metadata:
                latest_bans[filename] = max(timestamp, latest_bans.get(filename, 0))

    latest_feedback = _latest_feedback_by_filename(feedback_events)
    for filename, feedback in latest_feedback.items():
        if filename not in metadata:
            continue
        action = feedback["action"]
        if action in {"ban", "dislike"}:
            # The feedback ledger outlives blacklist TTL pruning. Its latest
            # action is the durable, reversible record of this preference.
            latest_bans[filename] = int(feedback["timestamp"])
        else:
            # Any later non-ban action supersedes a historical ban.  In
            # particular, unfavorite clears old state without becoming a new
            # positive label.
            latest_bans.pop(filename, None)

    retained = set(metadata) - set(latest_bans) if retained_files is None else set(retained_files)
    retained &= set(metadata)
    examples: list[PreferenceExample] = []
    for filename in sorted(metadata):
        meta = metadata[filename]
        tags = _model_tags(meta.get("tags", []))
        if not tags:
            continue
        context_features = _model_context_features(meta)
        feedback = latest_feedback.get(filename)
        is_explicit_ban = bool(
            isinstance(feedback, dict) and feedback.get("action") in {"ban", "dislike"}
        )
        if filename in latest_bans:
            timestamp = latest_bans[filename]
            examples.append(
                PreferenceExample(
                    filename=filename,
                    tags=tags,
                    label=1,
                    base_weight=_recency_weight(timestamp, now, recency_half_life_days),
                    timestamp=timestamp,
                    context_features=context_features,
                    temporal_label_known=True,
                    is_explicit_ban=is_explicit_ban,
                )
            )
        elif filename in retained:
            is_favorite = filename in favorites
            is_explicit_keep = not is_favorite and _is_explicit_keep(feedback)
            explicit_positive = is_favorite or _has_explicit_positive_feedback(feedback)
            temporal_label_known = _has_explicit_positive_feedback(feedback)
            timestamp = _positive_label_timestamp(meta, feedback, now)
            examples.append(
                PreferenceExample(
                    filename=filename,
                    tags=tags,
                    label=0,
                    base_weight=favorite_weight if explicit_positive else 1.0,
                    timestamp=timestamp,
                    context_features=context_features,
                    is_favorite=is_favorite,
                    is_explicit_keep=is_explicit_keep,
                    is_control=not explicit_positive,
                    temporal_label_known=temporal_label_known,
                )
            )
    return examples


def _is_curated_preference_feedback(event: object) -> bool:
    """Whether an event is an intentional label for preference training."""
    if not isinstance(event, dict):
        return False
    if event.get("action") == "dislike":
        return True
    if event.get("action") not in {"ban", "keep"}:
        return False
    return event.get("context") == "model_review" or event.get("source") in {
        "model_review",
        "model_suggestion",
    }


def _curated_preference_labels(
    events: Iterable[dict[str, object]],
) -> dict[str, tuple[str, int]]:
    """Resolve the latest curated review label for each filename.

    Ordinary gallery actions are intentionally ignored. An explicit unban
    after a curated dislike clears that label, allowing the user to correct an
    earlier decision from the blocklist view. Legacy Review bans remain valid.
    """
    ordered = sorted(
        (event for event in events if _is_feedback_event(event)),
        key=lambda event: int(event["revision"]),
    )
    labels: dict[str, tuple[str, int]] = {}
    for event in ordered:
        filename = str(event["filename"])
        if _is_curated_preference_feedback(event):
            labels[filename] = (str(event["action"]), int(event["timestamp"]))
        elif event.get("action") == "unban" and labels.get(filename, (None, 0))[0] in {
            "ban",
            "dislike",
        }:
            labels.pop(filename, None)
    return labels


def _build_curated_preference_examples(
    metadata: dict[str, dict],
    feedback_events: Iterable[dict[str, object]],
    *,
    now: int,
    favorite_weight: float,
    recency_half_life_days: int,
) -> list[PreferenceExample]:
    """Build labels from deliberate Review decisions and manual dislikes."""
    labels = _curated_preference_labels(feedback_events)
    examples: list[PreferenceExample] = []
    for filename, (action, timestamp) in sorted(labels.items()):
        meta = metadata.get(filename)
        if not isinstance(meta, dict):
            continue
        tags = _model_tags(meta.get("tags", []))
        if not tags:
            continue
        context_features = _model_context_features(meta)
        if action in {"ban", "dislike"}:
            examples.append(
                PreferenceExample(
                    filename=filename,
                    tags=tags,
                    label=1,
                    base_weight=_recency_weight(timestamp, now, recency_half_life_days),
                    timestamp=timestamp,
                    context_features=context_features,
                    temporal_label_known=True,
                    is_explicit_ban=True,
                )
            )
        else:  # keep
            examples.append(
                PreferenceExample(
                    filename=filename,
                    tags=tags,
                    label=0,
                    base_weight=favorite_weight,
                    timestamp=timestamp,
                    context_features=context_features,
                    temporal_label_known=True,
                    is_explicit_keep=True,
                )
            )
    return examples


def collect_preference_training_snapshot(config: WayperConfig) -> PreferenceTrainingSnapshot:
    """Collect current local labels and a stable fingerprint for retraining.

    Only live pool/favorite files become positive examples.  Historical metadata
    that survived quota eviction stays out of the positive class.
    """
    from .pool import favorites_dir, list_blacklist, list_images, load_metadata, pool_dir
    from .state import ALL_PURITIES

    metadata = load_metadata(config)
    favorites: set[str] = set()
    retained: set[str] = set()
    for purity in ALL_PURITIES:
        for orientation in ("landscape", "portrait"):
            pool_images = {
                image.name for image in list_images(pool_dir(config, purity, orientation))
            }
            favorite_images = {
                image.name for image in list_images(favorites_dir(config, purity, orientation))
            }
            retained |= pool_images | favorite_images
            favorites |= favorite_images

    feedback = load_preference_feedback(config)
    historical_bans = load_preference_historical_bans(config)
    snapshot_now = int(time.time() // 86400) * 86400
    legacy_examples = tuple(
        build_training_examples(
            metadata,
            list_blacklist(config),
            favorites,
            retained,
            historical_bans=(
                (timestamp, filename) for filename, timestamp in historical_bans.items()
            ),
            feedback_events=feedback["events"],
            now=snapshot_now,
        )
    )
    curated_examples = tuple(
        build_training_examples(
            metadata,
            (),
            set(),
            set(),
            feedback_events=feedback["events"],
            now=snapshot_now,
            review_only=True,
        )
    )
    has_curated_feedback = any(
        _is_curated_preference_feedback(event) for event in feedback["events"]
    )
    examples = curated_examples if has_curated_feedback else legacy_examples
    # Keep the persisted source name stable for existing model files. It now
    # covers both Review decisions and manual Dislike actions.
    label_source = "model_review" if has_curated_feedback else "legacy"
    return PreferenceTrainingSnapshot(
        examples=examples,
        feedback_revision=int(feedback["revision"]),
        data_signature=_training_data_signature(examples),
        favorite_files=len(favorites),
        label_source=label_source,
    )


def train_local_preference_model(
    config: WayperConfig,
    *,
    combo_min_support: int = DEFAULT_COMBO_MIN_SUPPORT,
    max_combo_features: int = DEFAULT_MAX_COMBO_FEATURES,
    threshold: float = DEFAULT_THRESHOLD,
    epochs: int = DEFAULT_EPOCHS,
    validation_days: int = 14,
    retrain_mode: str = "manual",
    semantic_model: str | None = DEFAULT_SEMANTIC_MODEL,
) -> tuple[PreferenceModel, PreferenceTrainingSnapshot]:
    """Fit one model from a consistent local snapshot without writing it yet."""
    _bootstrap_historical_preference_bans(config)
    snapshot = collect_preference_training_snapshot(config)
    model = train_preference_model(
        list(snapshot.examples),
        combo_min_support=combo_min_support,
        max_combo_features=max_combo_features,
        threshold=threshold,
        epochs=epochs,
        validation_days=validation_days,
        feedback_revision=snapshot.feedback_revision,
        retrain_mode=retrain_mode,
        semantic_model=semantic_model,
        label_source=snapshot.label_source,
    )
    _warm_semantic_cache(model, snapshot)
    model.training_summary["favorite_files"] = snapshot.favorite_files
    model.training_summary["favorites_without_usable_metadata"] = snapshot.favorite_files - int(
        model.training_summary["favorites"]
    )
    return model, snapshot


def _warm_semantic_cache(
    model: PreferenceModel,
    snapshot: PreferenceTrainingSnapshot,
) -> None:
    """Pre-embed live retained metadata so review requests stay responsive."""
    if not model.semantic_enabled:
        return
    try:
        from .preference.semantic import embed_metadata

        retained = [
            (example.tags, example.context_features)
            for example in snapshot.examples
            if example.label == 0
        ]
        embed_metadata(retained, model_name=model.semantic_model)
        model.training_summary["semantic_cached_records"] = len(retained)
        model.training_summary["semantic_cache_status"] = "ready"
    except Exception as exc:  # pragma: no cover - optional runtime/environment dependent
        model.training_summary["semantic_cache_status"] = f"unavailable: {type(exc).__name__}"


def _save_manual_preference_model(
    config: WayperConfig,
    model: PreferenceModel,
    snapshot: PreferenceTrainingSnapshot,
) -> bool:
    """Commit a manual fit only if its source snapshot is still current."""
    path = preference_model_path(config)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Keep the same lock order as automatic commits: model first, then shared
    # state. This lets a manual train retry rather than overwrite a newer
    # automatic fit whose feedback arrived while the manual fit was running.
    with FileLock(path=_preference_model_lock_path(path)):
        with FileLock():
            current = collect_preference_training_snapshot(config)
            if (
                current.data_signature != snapshot.data_signature
                or current.label_source != snapshot.label_source
            ):
                return False
            _write_preference_model_unlocked(model, path)
            return True


def train_and_save_local_preference_model(
    config: WayperConfig,
    *,
    combo_min_support: int = DEFAULT_COMBO_MIN_SUPPORT,
    max_combo_features: int = DEFAULT_MAX_COMBO_FEATURES,
    threshold: float = DEFAULT_THRESHOLD,
    epochs: int = DEFAULT_EPOCHS,
    validation_days: int = 14,
    semantic_model: str | None = DEFAULT_SEMANTIC_MODEL,
) -> tuple[PreferenceModel, PreferenceTrainingSnapshot]:
    """Fit and commit a manual model, retrying once if labels changed mid-fit."""
    for _ in range(2):
        model, snapshot = train_local_preference_model(
            config,
            combo_min_support=combo_min_support,
            max_combo_features=max_combo_features,
            threshold=threshold,
            epochs=epochs,
            validation_days=validation_days,
            retrain_mode="manual",
            semantic_model=semantic_model,
        )
        if _save_manual_preference_model(config, model, snapshot):
            return model, snapshot
    raise OSError("Wallpaper labels changed while training; please run model train again")


def model_report(
    model: PreferenceModel,
    path: Path | None = None,
    *,
    learning: dict[str, object] | None = None,
) -> dict[str, object]:
    """Return compact, JSON-safe status information for UI or CLI callers."""
    training = {key: value for key, value in model.training_summary.items() if key != "example_ids"}
    report: dict[str, object] = {
        "schema_version": model.schema_version,
        "feature_normalization": model.feature_normalization,
        "trained_at": model.trained_at,
        "threshold": model.threshold,
        "tag_features": len(model.tag_weights),
        "combo_features": len(model.combo_weights),
        "context_features": len(model.context_weights),
        "semantic_enabled": model.semantic_enabled,
        "semantic_model": model.semantic_model or None,
        "semantic_dimension": len(model.semantic_weights) or None,
        "semantic_blend": model.semantic_blend if model.semantic_enabled else None,
        "review_threshold": preference_review_threshold(model),
        "review_calibration": model.training_summary.get("review_calibration"),
        "label_source": model.training_summary.get("label_source", "legacy"),
        "training": training,
        "validation": model.validation,
        "auto_skip_ready": auto_skip_ready(model),
    }
    if path and path.exists():
        report["path"] = str(path)
        report["size_bytes"] = path.stat().st_size
    if learning is not None:
        report["learning"] = learning
    return report


def auto_skip_ready(model: PreferenceModel) -> bool:
    """Return whether recent time-split precision clears the safety gate."""
    if (
        model.schema_version != MODEL_SCHEMA_VERSION
        or model.validation.get("available") is not True
        or model.validation.get("calibrated") is not True
    ):
        return False
    precision = model.validation.get("precision_at_threshold")
    predicted = model.validation.get("predicted_at_threshold")
    lower_bound = model.validation.get("precision_lower_bound")
    return (
        isinstance(precision, int | float)
        and precision >= AUTO_SKIP_MIN_PRECISION
        and isinstance(predicted, int)
        and predicted >= AUTO_SKIP_MIN_PREDICTIONS
        and isinstance(lower_bound, int | float)
        and lower_bound >= AUTO_SKIP_MIN_PRECISION_LOWER_BOUND
    )


def auto_filter_status(
    config: WayperConfig,
    model: PreferenceModel | None = None,
) -> dict[str, object]:
    """Describe whether the model can quarantine downloads for human review.

    A model hit is recoverable: it is downloaded into the Model review queue
    and requires an explicit Keep or Ban decision.  The high-precision
    validation gate therefore remains relevant only to unattended deletion,
    not to this human-reviewed boundary.
    """
    path = preference_model_path(config)
    model = model or load_preference_model(path)
    if model is None:
        return {
            "status": "untrained",
            "ready": False,
            "reason": "Train a preference model and review enough candidates first.",
            "threshold": None,
            "model": None,
        }
    review_calibration = model.training_summary.get("review_calibration")
    calibration_ready = not isinstance(review_calibration, dict) or (
        review_calibration.get("available") is True
    )
    schema_ready = model.schema_version == MODEL_SCHEMA_VERSION
    ready = schema_ready and calibration_ready
    unattended_skip_ready = auto_skip_ready(model)
    if ready:
        status = "ready"
        reason = "Model filtering is active. Likely blocks are held for your review."
    elif schema_ready:
        status = "calibration_pending"
        reason = "More Keep/Dislike decisions are needed before accurate model filtering can start."
    else:
        status = "upgrade_pending"
        reason = "Retrain the local model before using it to filter new downloads."
    return {
        "status": status,
        "ready": ready,
        "reason": reason,
        "threshold": preference_review_threshold(model),
        "threshold_kind": "calibrated_review_score",
        "review_calibration": review_calibration,
        "unattended_skip_ready": unattended_skip_ready,
        "model": model_report(model, path),
    }


def auto_filter_prediction(
    model: PreferenceModel,
    metadata: dict[str, object],
) -> tuple[bool, PreferencePrediction]:
    """Score one download for the recoverable, human-reviewed quarantine."""
    raw_tags = metadata.get("tags", [])
    if isinstance(raw_tags, str):
        tags: list[object] = [raw_tags]
    elif isinstance(raw_tags, list | tuple | set):
        tags = [tag.get("name", "") if isinstance(tag, dict) else tag for tag in raw_tags]
    else:
        tags = []
    model_metadata = dict(metadata)
    model_metadata["tags"] = tags
    uploader = model_metadata.get("uploader")
    if isinstance(uploader, dict):
        model_metadata["uploader"] = uploader.get("username", "")
    prediction = model.predict(tags, metadata=model_metadata, top_n=12)
    is_candidate = model.schema_version == MODEL_SCHEMA_VERSION and preference_review_candidate(
        model, prediction
    )
    return is_candidate, prediction


def preference_learning_status(
    config: WayperConfig,
    model: PreferenceModel | None = None,
    snapshot: PreferenceTrainingSnapshot | None = None,
) -> dict[str, object]:
    """Describe whether enough new local feedback has accumulated to refresh."""
    snapshot = snapshot or collect_preference_training_snapshot(config)
    model = model or load_preference_model(preference_model_path(config))
    if model is None:
        return {
            "status": "untrained",
            "stale": True,
            "label_source": snapshot.label_source,
            "label_source_changed": False,
            "pending_feedback": snapshot.feedback_revision,
            "changed_examples": len(snapshot.examples),
            "weight_refresh_due": False,
            "minimum_feedback": AUTO_RETRAIN_MIN_FEEDBACK,
            "due": False,
        }

    summary = model.training_summary
    stored_label_source = summary.get("label_source", "legacy")
    label_source_changed = stored_label_source != snapshot.label_source
    review_threshold = summary.get("review_threshold")
    review_calibration = summary.get("review_calibration")
    review_boundary_upgrade_due = (
        not isinstance(review_threshold, int | float)
        or isinstance(review_threshold, bool)
        or not math.isfinite(review_threshold)
        or not isinstance(review_calibration, dict)
        or review_calibration.get("version") != REVIEW_CALIBRATION_VERSION
    )
    upgrade_due = (
        model.schema_version != MODEL_SCHEMA_VERSION
        or model.feature_normalization != DEFAULT_FEATURE_NORMALIZATION
        or label_source_changed
        or review_boundary_upgrade_due
    )
    previous_revision = summary.get("feedback_revision", 0)
    if not isinstance(previous_revision, int):
        previous_revision = 0
    stored_signature = summary.get("training_data_signature")
    stale = (
        upgrade_due
        or not isinstance(stored_signature, str)
        or stored_signature != snapshot.data_signature
    )
    stored_ids = summary.get("example_ids")
    if isinstance(stored_ids, list):
        changed_examples = len(
            set(str(item) for item in stored_ids) ^ set(_training_example_ids(snapshot.examples))
        )
    else:
        changed_examples = len(snapshot.examples) if stale else 0
    pending_feedback = max(0, snapshot.feedback_revision - previous_revision)
    weight_refresh_due = stale and isinstance(stored_ids, list) and changed_examples == 0
    return {
        "status": "upgrade_pending" if upgrade_due else "ready",
        "stale": stale,
        "upgrade_due": upgrade_due,
        "label_source": snapshot.label_source,
        "label_source_changed": label_source_changed,
        "review_boundary_upgrade_due": review_boundary_upgrade_due,
        "pending_feedback": pending_feedback,
        "changed_examples": changed_examples,
        "weight_refresh_due": weight_refresh_due,
        "minimum_feedback": AUTO_RETRAIN_MIN_FEEDBACK,
        "due": upgrade_due
        or stale
        and (
            pending_feedback >= AUTO_RETRAIN_MIN_FEEDBACK
            or changed_examples >= AUTO_RETRAIN_MIN_CHANGED_EXAMPLES
            or weight_refresh_due
        ),
    }


def _preference_review_score(prediction: PreferencePrediction) -> float:
    """Compatibility wrapper for the shared Review score implementation."""
    return preference_review_score(prediction)


def _diversify_preference_review_rank(
    ranked: list[dict[str, object]],
) -> list[dict[str, object]]:
    """Limit one learned reason from monopolizing the first review page."""
    if len(ranked) <= DEFAULT_REVIEW_LIMIT:
        return ranked
    head: list[dict[str, object]] = []
    deferred: list[dict[str, object]] = []
    reason_counts: dict[tuple[str, str], int] = {}
    for item in ranked:
        prediction = item.get("prediction")
        evidence = (
            prediction.strongest_review_dislike
            if isinstance(prediction, PreferencePrediction)
            else None
        )
        reason = (
            str(evidence.get("type", "")) if isinstance(evidence, dict) else "",
            str(evidence.get("feature", "")) if isinstance(evidence, dict) else "",
        )
        if (
            len(head) < DEFAULT_REVIEW_LIMIT
            and reason_counts.get(reason, 0) < DEFAULT_REVIEW_REASON_LIMIT
        ):
            head.append(item)
            reason_counts[reason] = reason_counts.get(reason, 0) + 1
        else:
            deferred.append(item)

    if len(head) < min(DEFAULT_REVIEW_LIMIT, len(ranked)):
        needed = min(DEFAULT_REVIEW_LIMIT, len(ranked)) - len(head)
        head.extend(deferred[:needed])
    selected = {id(item) for item in head}
    # Diversity decides first-page membership, not the meaning of rank. Keep
    # the selected page and the remainder in their original score order.
    return [item for item in ranked if id(item) in selected] + [
        item for item in ranked if id(item) not in selected
    ]


def _descending_percentiles(items: list[dict[str, object]], key: str) -> list[float]:
    """Return deterministic 0..1 rank percentiles for one score field."""
    if not items:
        return []
    ordered = sorted(
        range(len(items)),
        key=lambda index: (
            -float(items[index].get(key, 0.0)),
            str(items[index].get("name", "")),
        ),
    )
    values = [0.0] * len(items)
    denominator = max(1, len(items) - 1)
    for rank, index in enumerate(ordered):
        values[index] = 1.0 - rank / denominator
    return values


def preference_deletion_suggestions(
    config: WayperConfig,
    *,
    purities: Iterable[str] | None = None,
    orientation: str | None = None,
    limit: int = DEFAULT_REVIEW_LIMIT,
) -> dict[str, object]:
    """Return ranked pool images for human review only.

    This function never alters the blacklist or filesystem. Favorites,
    blacklisted files, explicit positive corrections, and metadata-only records
    are excluded. When available, a local text head is fused with the exact
    sparse review score; no image pixels are inspected.
    """
    from .pool import favorites_dir, list_blacklist, list_images, load_metadata, pool_dir
    from .state import ALL_PURITIES

    model_path = preference_model_path(config)
    model = load_preference_model(model_path)
    snapshot = collect_preference_training_snapshot(config)
    learning = preference_learning_status(config, model, snapshot)
    if model is None:
        return {
            "status": "untrained",
            "items": [],
            "learning": learning,
            "review_strategy": "boosted_dislike_rank",
        }

    if model.schema_version != MODEL_SCHEMA_VERSION:
        return {
            "status": "upgrade_pending",
            "items": [],
            "learning": learning,
            "model": model_report(model, model_path, learning=learning),
            "review_strategy": "boosted_dislike_rank",
        }

    active_purities = tuple(
        purity for purity in (purities or ALL_PURITIES) if purity in ALL_PURITIES
    )
    if not active_purities:
        active_purities = ("sfw",)
    orientations = (
        (orientation,)
        if orientation in {"landscape", "portrait"}
        else (
            "landscape",
            "portrait",
        )
    )
    metadata = load_metadata(config)
    blacklisted = {filename for _, filename in list_blacklist(config)}
    favorites = {
        image.name
        for purity in ALL_PURITIES
        for orient in ("landscape", "portrait")
        for image in list_images(favorites_dir(config, purity, orient))
    }
    latest_feedback = _latest_feedback_by_filename(load_preference_feedback(config)["events"])
    records: list[tuple[Path, str, dict[str, object]]] = []
    pool_images = 0
    metadata_images = 0
    for purity in active_purities:
        for orient in orientations:
            for image in list_images(pool_dir(config, purity, orient)):
                filename = image.name
                if (
                    filename in blacklisted
                    or filename in favorites
                    or _has_explicit_positive_feedback(latest_feedback.get(filename))
                ):
                    continue
                pool_images += 1
                meta = metadata.get(filename)
                if not meta or not meta.get("tags"):
                    continue
                metadata_images += 1
                records.append((image, filename, meta))

    predictions = model.predict_many(
        [(meta.get("tags", []), meta, None) for _, _, meta in records],
        top_n=20,
    )
    scored_images = len(records)
    positive_evidence_images = 0
    semantic_evidence_images = 0
    semantic_scored_images = 0
    best_score: float | None = None
    best_review_score: float | None = None
    best_decision_score: float | None = None
    best_semantic_score: float | None = None
    scored: list[dict[str, object]] = []
    for (image, filename, _meta), prediction in zip(records, predictions, strict=True):
        if prediction.positive_evidence_count > 0:
            positive_evidence_images += 1
            if best_score is None or prediction.feature_score > best_score:
                best_score = prediction.feature_score
        if prediction.semantic_available and prediction.semantic_score is not None:
            semantic_scored_images += 1
            if prediction.semantic_score > 0:
                semantic_evidence_images += 1
            if best_semantic_score is None or prediction.semantic_score > best_semantic_score:
                best_semantic_score = prediction.semantic_score
        review_score = preference_review_score(prediction)
        decision_score = preference_review_decision_score(model, prediction)
        if best_review_score is None or review_score > best_review_score:
            best_review_score = review_score
        if best_decision_score is None or decision_score > best_decision_score:
            best_decision_score = decision_score
        if not preference_review_candidate(model, prediction):
            continue
        scored.append(
            {
                "path": str(image.relative_to(config.download_dir)),
                "name": filename,
                "prediction": prediction,
                "review_score": review_score,
                "decision_score": decision_score,
                "semantic_score": prediction.semantic_score or 0.0,
            }
        )

    semantic_enabled = model.semantic_enabled and semantic_scored_images > 0
    if semantic_enabled:
        base_percentiles = _descending_percentiles(
            [{"name": item["name"], "review_score": item["review_score"]} for item in scored],
            "review_score",
        )
        semantic_percentiles = _descending_percentiles(scored, "semantic_score")
        semantic_rank_weight = min(1.0, max(0.0, model.semantic_rank_weight or 0.65))
        for index, item in enumerate(scored):
            item["hybrid_score"] = (1.0 - semantic_rank_weight) * base_percentiles[
                index
            ] + semantic_rank_weight * semantic_percentiles[index]
    else:
        for item in scored:
            item["hybrid_score"] = float(item["review_score"])

    ranked_all = _diversify_preference_review_rank(
        sorted(
            scored,
            key=lambda item: (
                -float(item["hybrid_score"]),
                -float(item["decision_score"]),
                -item["prediction"].feature_score,
                str(item["name"]),
            ),
        ),
    )
    ranked_pool_count = len(ranked_all)
    ranked_page = ranked_all[: max(1, limit)]
    candidates: list[dict[str, object]] = []
    for rank, item in enumerate(ranked_page, 1):
        prediction = item["prediction"]
        all_rank = rank
        candidates.append(
            {
                "path": item["path"],
                "name": item["name"],
                "score": round(prediction.score, 4),
                "feature_score": round(prediction.feature_score, 4),
                "review_score": round(float(item["review_score"]), 4),
                "decision_score": round(float(item["decision_score"]), 4),
                "hybrid_score": round(float(item["hybrid_score"]), 4),
                "semantic_score": (
                    round(prediction.semantic_score, 4)
                    if prediction.semantic_score is not None
                    else None
                ),
                "semantic_probability": (
                    round(prediction.semantic_probability, 4)
                    if prediction.semantic_probability is not None
                    else None
                ),
                "semantic_available": prediction.semantic_available,
                "strongest_review_dislike_score": round(
                    prediction.strongest_review_dislike_score,
                    4,
                ),
                "strongest_review_dislike": prediction.strongest_review_dislike,
                "strongest_review_keep_score": round(
                    prediction.strongest_review_keep_score,
                    4,
                ),
                "strongest_review_keep": prediction.strongest_review_keep,
                "probability": round(prediction.probability, 4),
                "calibrated": prediction.calibrated,
                "rank": all_rank,
                "percentile": round(
                    100.0 * (1.0 - (all_rank - 1) / max(1, scored_images - 1)),
                    1,
                ),
                "contributions": list(prediction.contributions),
                "dislike_evidence": [
                    contribution
                    for contribution in prediction.contributions
                    if contribution.get("direction") == "dislike"
                ],
                "keep_evidence": [
                    contribution
                    for contribution in prediction.contributions
                    if contribution.get("direction") == "keep"
                ],
                "positive_evidence_count": prediction.positive_evidence_count,
            }
        )
    candidates.sort(key=lambda item: (int(item["rank"]), str(item["name"])))
    return {
        "status": "ready",
        "items": candidates,
        "learning": learning,
        "model": model_report(model, model_path, learning=learning),
        "review_threshold": preference_review_threshold(model),
        "review_strategy": "hybrid_semantic_rank" if semantic_enabled else "boosted_dislike_rank",
        "diagnostics": {
            "pool_images": pool_images,
            "metadata_images": metadata_images,
            "scored_images": scored_images,
            "positive_evidence_images": positive_evidence_images,
            "semantic_evidence_images": semantic_evidence_images,
            "semantic_scored_images": semantic_scored_images,
            "candidate_count": ranked_pool_count,
            "returned_count": len(candidates),
            "ranked_pool_count": ranked_pool_count,
            "best_feature_score": round(best_score, 4) if best_score is not None else None,
            "best_review_score": round(best_review_score, 4)
            if best_review_score is not None
            else None,
            "best_decision_score": round(best_decision_score, 4)
            if best_decision_score is not None
            else None,
            "review_threshold": preference_review_threshold(model),
            "best_semantic_score": round(best_semantic_score, 4)
            if best_semantic_score is not None
            else None,
        },
    }


def _auto_retrain_lease_path(config: WayperConfig) -> Path:
    """Return the persistent lease for a detached retraining worker."""
    return config.download_dir / ".preference_retrain.worker.json"


def _auto_retrain_lease_lock_path(config: WayperConfig) -> Path:
    return config.download_dir / ".preference_retrain.worker.lock"


def _read_auto_retrain_lease(config: WayperConfig) -> dict[str, object] | None:
    path = _auto_retrain_lease_path(config)
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or not isinstance(value.get("token"), str):
        return None
    if not isinstance(value.get("created_at"), int | float):
        return None
    return value


def _windows_pid_is_running(pid: int) -> bool:
    """Check a Windows process without sending it a signal.

    ``os.kill(pid, 0)`` is not a harmless existence probe on Windows: Python
    implements non-console signals with ``TerminateProcess``.  Using it here
    could therefore terminate the worker (or the caller when a mocked PID is
    the current process).  Query the process exit code through the Win32 API
    instead.
    """
    import ctypes
    from ctypes import wintypes

    process_query_limited_information = 0x1000
    error_access_denied = 5
    still_active = 259
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
    if not handle:
        # An access-denied result still means that a process with this PID
        # exists; this matches the conservative behavior of the POSIX branch.
        return ctypes.get_last_error() == error_access_denied
    try:
        exit_code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            return False
        return exit_code.value == still_active
    finally:
        kernel32.CloseHandle(handle)


def _pid_is_running(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        return _windows_pid_is_running(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # The process exists but belongs to another user/session.
        return True
    except OSError:
        return False
    return True


def _auto_retrain_lease_is_stale(lease: dict[str, object], *, now: float | None = None) -> bool:
    now = time.time() if now is None else now
    created_at = lease.get("created_at")
    if not isinstance(created_at, int | float):
        return True
    requested_at = lease.get("requested_at")
    last_activity = requested_at if isinstance(requested_at, int | float) else created_at
    pid = lease.get("pid")
    if isinstance(pid, int) and not isinstance(pid, bool) and pid > 0:
        if not _pid_is_running(pid):
            return True
        return now - last_activity > AUTO_RETRAIN_WORKER_STALE_SECONDS
    # A caller that dies between reserving the lease and spawning its child
    # must not block later feedback for the full worker timeout.
    return now - last_activity > max(AUTO_RETRAIN_DELAY_SECONDS * 2, 10)


def _claim_or_touch_auto_retrain_worker(config: WayperConfig) -> str | None:
    """Create one durable worker lease or extend the active worker debounce."""
    lease_path = _auto_retrain_lease_path(config)
    now = time.time()
    with FileLock(path=_auto_retrain_lease_lock_path(config)):
        lease = _read_auto_retrain_lease(config)
        if lease is not None and not _auto_retrain_lease_is_stale(lease, now=now):
            lease["requested_at"] = now
            atomic_write(lease_path, json.dumps(lease, ensure_ascii=False) + "\n")
            return None
        if lease_path.exists():
            try:
                lease_path.unlink()
            except OSError:
                log.warning("Could not clear stale preference retrain lease: %s", lease_path)
                return None
        token = secrets.token_hex(16)
        atomic_write(
            lease_path,
            json.dumps(
                {
                    "token": token,
                    "created_at": now,
                    "requested_at": now,
                    "pid": None,
                },
                ensure_ascii=False,
            )
            + "\n",
        )
        return token


def _set_auto_retrain_worker_pid(config: WayperConfig, token: str, pid: int) -> None:
    """Record the detached worker PID if it still owns this lease."""
    if pid <= 0:
        return
    lease_path = _auto_retrain_lease_path(config)
    with FileLock(path=_auto_retrain_lease_lock_path(config)):
        lease = _read_auto_retrain_lease(config)
        if lease is None or lease.get("token") != token:
            return
        lease["pid"] = pid
        atomic_write(lease_path, json.dumps(lease, ensure_ascii=False) + "\n")


def _release_auto_retrain_worker(config: WayperConfig, token: str) -> None:
    """Remove this worker's lease without disturbing a newer worker."""
    lease_path = _auto_retrain_lease_path(config)
    with FileLock(path=_auto_retrain_lease_lock_path(config)):
        lease = _read_auto_retrain_lease(config)
        if lease is None or lease.get("token") != token:
            return
        try:
            lease_path.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            log.warning("Could not clear preference retrain lease: %s", lease_path)


def _auto_retrain_worker_command(config: WayperConfig, token: str) -> list[str]:
    arguments = [
        "model",
        "refresh",
        "--download-dir",
        str(config.download_dir.resolve()),
        "--lease-token",
        token,
    ]
    if getattr(sys, "frozen", False):
        return [sys.executable, *arguments]
    return [sys.executable, "-m", "wayper.cli", *arguments]


def _spawn_auto_retrain_worker(config: WayperConfig, token: str) -> None:
    """Launch a background worker detached from a CLI/MCP/API caller."""
    popen_kwargs: dict[str, object] = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
    }
    if os.name == "nt":
        popen_kwargs.update(
            windows_no_window_kwargs(getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
        )
    else:
        popen_kwargs["start_new_session"] = True
    process = subprocess.Popen(_auto_retrain_worker_command(config, token), **popen_kwargs)
    if isinstance(process.pid, int):
        _set_auto_retrain_worker_pid(config, token, process.pid)


def _has_pending_preference_feedback_refresh(config: WayperConfig) -> bool:
    """Cheaply decide whether feedback alone has crossed the refresh threshold."""
    model = load_preference_model(preference_model_path(config))
    if model is None:
        return False
    previous_revision = model.training_summary.get("feedback_revision", 0)
    if not isinstance(previous_revision, int):
        previous_revision = 0
    feedback_revision = int(load_preference_feedback(config)["revision"])
    return feedback_revision - previous_revision >= AUTO_RETRAIN_MIN_FEEDBACK


def schedule_preference_model_retrain(config: WayperConfig, *, force: bool = False) -> None:
    """Request a detached, debounced full refresh without blocking the caller.

    A ``threading.Timer`` dies with a short-lived CLI or stdio MCP process.
    The on-disk lease is therefore the hand-off point: a detached process owns
    it, coalesces feedback for a few seconds, and refreshes from the complete
    local snapshot only after the normal safety threshold is reached. Ordinary
    feedback calls use the persisted revision as a cheap gate, avoiding a full
    metadata scan and subprocess for every sub-threshold click. ``force`` is
    reserved for callers that already calculated a due filesystem/weight
    refresh.
    """
    if not preference_model_path(config).exists():
        return
    if not force and not _has_pending_preference_feedback_refresh(config):
        return
    token = _claim_or_touch_auto_retrain_worker(config)
    if token is None:
        return
    try:
        _spawn_auto_retrain_worker(config, token)
    except Exception:
        _release_auto_retrain_worker(config, token)
        log.warning("Could not start detached preference model refresh", exc_info=True)


def _wait_for_auto_retrain_quiet(config: WayperConfig, token: str, delay_seconds: float) -> bool:
    """Wait until no new feedback has touched this worker's debounce lease."""
    while True:
        lease = _read_auto_retrain_lease(config)
        if lease is None or lease.get("token") != token:
            return False
        requested_at = lease.get("requested_at", lease.get("created_at"))
        if not isinstance(requested_at, int | float):
            return False
        remaining = delay_seconds - (time.time() - requested_at)
        if remaining <= 0:
            return True
        time.sleep(min(remaining, 1.0))


def run_scheduled_preference_model_retrain(
    config: WayperConfig,
    token: str,
    *,
    delay_seconds: float = AUTO_RETRAIN_DELAY_SECONDS,
) -> None:
    """Run the detached worker entry point and leave no stranded live lease."""
    _set_auto_retrain_worker_pid(config, token, os.getpid())
    outcome: str | None = None
    try:
        if _wait_for_auto_retrain_quiet(config, token, delay_seconds):
            outcome = _run_auto_retrain(config)
    except Exception:
        log.warning("Automatic preference model refresh failed", exc_info=True)
        outcome = "failed"
    finally:
        _release_auto_retrain_worker(config, token)

    # Feedback can arrive while this worker is fitting. Once our lease is
    # gone, make a fresh detached hand-off only if the latest snapshot is due.
    if outcome in {"settled", "retry"}:
        try:
            model = load_preference_model(preference_model_path(config))
            snapshot = collect_preference_training_snapshot(config)
            if preference_learning_status(config, model, snapshot).get("due"):
                schedule_preference_model_retrain(config, force=True)
        except Exception:
            log.warning("Could not check for a follow-up preference model refresh", exc_info=True)


def _save_automatic_preference_model(
    config: WayperConfig,
    model: PreferenceModel,
    snapshot: PreferenceTrainingSnapshot,
) -> bool:
    """Commit only a still-current automatic fit under the model write lock.

    Lock ordering is deliberately model lock then shared state lock. Manual
    commits use the same order, so automatic and manual saves cannot race or
    corrupt the shared temporary model file.
    """
    path = preference_model_path(config)
    path.parent.mkdir(parents=True, exist_ok=True)
    with FileLock(path=_preference_model_lock_path(path)):
        with FileLock():
            current = collect_preference_training_snapshot(config)
            if (
                current.data_signature != snapshot.data_signature
                or current.label_source != snapshot.label_source
            ):
                return False
            current_model = load_preference_model(path)
            current_summary = current_model.training_summary if current_model is not None else {}
            current_threshold = current_summary.get("review_threshold")
            current_calibration = current_summary.get("review_calibration")
            review_boundary_current = (
                isinstance(current_threshold, int | float)
                and not isinstance(current_threshold, bool)
                and math.isfinite(current_threshold)
                and isinstance(current_calibration, dict)
                and current_calibration.get("version") == REVIEW_CALIBRATION_VERSION
            )
            if (
                current_model is not None
                and current_summary.get("training_data_signature") == current.data_signature
                and current_summary.get("label_source", "legacy") == current.label_source
                and review_boundary_current
            ):
                # A manual fit (or another worker) already covered exactly the
                # same snapshot and calibration. Preserve its hyperparameters.
                return True
            _write_preference_model_unlocked(model, path)
            return True


def _run_auto_retrain(config: WayperConfig) -> str:
    """Train and conditionally commit one automatic refresh.

    ``retry`` means state changed while fitting. ``failed`` deliberately does
    not self-reschedule forever; the next user action can request a fresh run.
    """
    model = load_preference_model(preference_model_path(config))
    if model is None:
        return "failed"
    try:
        _bootstrap_historical_preference_bans(config)
        snapshot = collect_preference_training_snapshot(config)
        learning = preference_learning_status(config, model, snapshot)
        if not learning["due"]:
            return "settled"
        epochs = int(model.training_summary.get("epochs", DEFAULT_EPOCHS))
        validation_days = int(
            model.training_summary.get("validation_days", model.validation.get("holdout_days", 14))
        )
        upgrading = bool(learning.get("upgrade_due"))
        refreshed = train_preference_model(
            list(snapshot.examples),
            combo_min_support=(DEFAULT_COMBO_MIN_SUPPORT if upgrading else model.combo_min_support),
            max_combo_features=(
                DEFAULT_MAX_COMBO_FEATURES if upgrading else model.max_combo_features
            ),
            threshold=DEFAULT_THRESHOLD if upgrading else model.threshold,
            epochs=max(1, epochs),
            validation_days=max(0, validation_days),
            feedback_revision=snapshot.feedback_revision,
            retrain_mode="automatic",
            semantic_model=(model.semantic_model or DEFAULT_SEMANTIC_MODEL),
            label_source=snapshot.label_source,
        )
        _warm_semantic_cache(refreshed, snapshot)
        refreshed.training_summary["favorite_files"] = snapshot.favorite_files
        refreshed.training_summary["favorites_without_usable_metadata"] = (
            snapshot.favorite_files - int(refreshed.training_summary["favorites"])
        )

        if _save_automatic_preference_model(config, refreshed, snapshot):
            log.info(
                "Preference model refreshed after %d feedback events (%d changed examples)",
                learning["pending_feedback"],
                learning["changed_examples"],
            )
            return "settled"
        return "retry"
    except Exception:
        log.warning("Automatic preference model refresh failed", exc_info=True)
        return "failed"


def _is_feedback_event(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    schema_version = value.get("schema_version", _LEGACY_FEEDBACK_SCHEMA_VERSION)
    return (
        not isinstance(schema_version, bool)
        and schema_version in {_LEGACY_FEEDBACK_SCHEMA_VERSION, _FEEDBACK_SCHEMA_VERSION}
        and isinstance(value.get("revision"), int)
        and not isinstance(value.get("revision"), bool)
        and isinstance(value.get("timestamp"), int)
        and not isinstance(value.get("timestamp"), bool)
        and isinstance(value.get("filename"), str)
        and bool(str(value.get("filename")).strip())
        and value.get("action") in _FEEDBACK_ACTIONS
    )


def _latest_feedback_by_filename(
    events: Iterable[dict[str, object]],
) -> dict[str, dict[str, object]]:
    latest: dict[str, dict[str, object]] = {}
    for event in events:
        if not _is_feedback_event(event):
            continue
        filename = str(event["filename"])
        existing = latest.get(filename)
        if existing is None or int(event["revision"]) >= int(existing["revision"]):
            latest[filename] = event
    return latest


def _is_explicit_keep(event: dict[str, object] | None) -> bool:
    return event is not None and event.get("action") == "keep"


def _has_explicit_positive_feedback(event: dict[str, object] | None) -> bool:
    """Return whether the current retained label has a dated user action."""
    return event is not None and event.get("action") in {
        "favorite",
        "unban",
        "keep",
    }


def _positive_label_timestamp(meta: dict, event: dict[str, object] | None, fallback: int) -> int:
    if _has_explicit_positive_feedback(event):
        try:
            return int(event["timestamp"])
        except (KeyError, TypeError, ValueError):
            pass
    return _metadata_timestamp(meta, fallback)
