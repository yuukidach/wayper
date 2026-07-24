"""Small, local preference ranking model trained from wallpaper metadata.

The recommended v2 model uses normalized tag unigrams plus a few low-cardinality
metadata fields (colors, category, purity, and supported uploaders).  Optional
tag pairs remain available for experiments, but are disabled by default.  The
explainable sparse FTRL implementation uses only the standard library, so it
does not pull in an embedding model or a heavyweight ML runtime.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import random
import secrets
import subprocess
import sys
import time
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass
from dataclasses import field as dataclass_field
from datetime import UTC, datetime
from pathlib import Path

from .config import WayperConfig
from .lock import FileLock
from .process import windows_no_window_kwargs
from .suggestions import normalize_tag
from .util import atomic_write

MODEL_SCHEMA_VERSION = 2
LEGACY_MODEL_SCHEMA_VERSION = 1
DEFAULT_COMBO_MIN_SUPPORT = 20
DEFAULT_MAX_COMBO_FEATURES = 0
DEFAULT_UPLOADER_MIN_SUPPORT = 10
DEFAULT_EPOCHS = 6
DEFAULT_THRESHOLD = 0.98
DEFAULT_FAVORITE_WEIGHT = 4.0
DEFAULT_RECENCY_HALF_LIFE_DAYS = 90
DEFAULT_FEATURE_NORMALIZATION = "field_l2"
AUTO_SKIP_MIN_PRECISION = 0.95
AUTO_SKIP_MIN_PREDICTIONS = 20
AUTO_SKIP_MIN_PRECISION_LOWER_BOUND = 0.80
# Review is a relative ranking over the current pool.  An item must have net
# learned dislike evidence; uncalibrated sigmoid output is never used as a
# probability gate.
DEFAULT_REVIEW_MIN_FEATURE_SCORE = 0.0
# Kept as a read-time compatibility constant for integrations that imported
# the v1 setting.  v2 never uses a fixed probability threshold for review.
DEFAULT_REVIEW_THRESHOLD = 0.82
DEFAULT_REVIEW_LIMIT = 24
AUTO_RETRAIN_MIN_FEEDBACK = 10
AUTO_RETRAIN_MIN_CHANGED_EXAMPLES = 12
AUTO_RETRAIN_DELAY_SECONDS = 5
AUTO_RETRAIN_WORKER_STALE_SECONDS = 30 * 60
MIN_TRAINING_PER_CLASS = 10
MIN_VALIDATION_PER_CLASS = 5
_PAIR_SEPARATOR = "\x1f"
_FEEDBACK_SCHEMA_VERSION = 2
_LEGACY_FEEDBACK_SCHEMA_VERSION = 1
_HISTORICAL_BAN_SCHEMA_VERSION = 1
_FEEDBACK_ACTIONS = frozenset({"ban", "unban", "favorite", "unfavorite", "keep"})

log = logging.getLogger("wayper.preference_model")

# Display geometry is already selected before suggestions are scored, so using
# it as a model feature only teaches the current monitor shape.  Subject tags,
# on the other hand, are useful signals in a local, user-owned wallpaper model
# and must remain available for explicit personal preferences.
_NON_PREFERENCE_FEATURE_TAGS = frozenset(
    {
        "portrait",
        "landscape",
        "portrait display",
        "landscape display",
        "vertical",
        "horizontal",
    }
)


@dataclass(frozen=True)
class PreferenceExample:
    """One labelled metadata record used during fitting."""

    filename: str
    tags: tuple[str, ...]
    label: int
    base_weight: float
    timestamp: int
    is_favorite: bool = False
    is_explicit_keep: bool = False
    temporal_label_known: bool = True
    # New fields are kept after the v1 positional fields so integrations that
    # construct examples directly remain source-compatible.
    context_features: tuple[str, ...] = ()
    is_control: bool = False


@dataclass(frozen=True)
class PreferenceTrainingSnapshot:
    """A stable local view of labels used to fit or refresh a model."""

    examples: tuple[PreferenceExample, ...]
    feedback_revision: int
    data_signature: str
    favorite_files: int


@dataclass(frozen=True)
class FeatureSpace:
    """Controlled vocabulary shared by training and prediction."""

    tags: frozenset[str]
    combos: frozenset[str]
    context: frozenset[str] = frozenset()


@dataclass(frozen=True)
class PreferencePrediction:
    """A score and its strongest explainable feature contributions."""

    probability: float
    score: float
    contributions: tuple[dict[str, object], ...]
    positive_evidence_count: int = 0
    feature_score: float = 0.0
    calibrated: bool = False

    def to_dict(self) -> dict[str, object]:
        dislike_evidence = [
            item for item in self.contributions if _contribution_direction(item) == "dislike"
        ]
        keep_evidence = [
            item for item in self.contributions if _contribution_direction(item) == "keep"
        ]
        return {
            "probability": round(self.probability, 4),
            "score": round(self.score, 4),
            "feature_score": round(self.feature_score, 4),
            "contributions": list(self.contributions),
            "dislike_evidence": dislike_evidence,
            "keep_evidence": keep_evidence,
            "positive_evidence_count": self.positive_evidence_count,
            "calibrated": self.calibrated,
        }


def _contribution_direction(value: object) -> str | None:
    """Read an explanation direction while tolerating legacy string items."""
    if isinstance(value, dict):
        direction = value.get("direction")
        return direction if direction in {"dislike", "keep"} else None
    return "dislike" if isinstance(value, str) else None


@dataclass
class PreferenceModel:
    """Persisted sparse logistic model.

    The fitted margin is useful for local ranking.  ``probability`` is retained
    for API compatibility, but should only be described as a probability after
    an explicit calibration pass has been recorded in ``validation``.
    """

    bias: float
    prior_log_odds: float
    tag_weights: dict[str, float]
    combo_weights: dict[str, float]
    threshold: float
    trained_at: str
    training_summary: dict[str, object]
    validation: dict[str, object]
    combo_min_support: int
    max_combo_features: int
    # Keep v1's positional constructor intact; v2 additions are optional for
    # callers that build an in-memory model rather than loading JSON.
    context_weights: dict[str, float] = dataclass_field(default_factory=dict)
    schema_version: int = MODEL_SCHEMA_VERSION
    feature_normalization: str = DEFAULT_FEATURE_NORMALIZATION

    @property
    def feature_space(self) -> FeatureSpace:
        return FeatureSpace(
            frozenset(self.tag_weights),
            frozenset(self.combo_weights),
            frozenset(self.context_weights),
        )

    def predict(
        self,
        tags: Iterable[object],
        *,
        metadata: dict[str, object] | None = None,
        context_features: Iterable[object] | None = None,
        top_n: int = 8,
    ) -> PreferencePrediction:
        """Return a local dislike margin and feature-level explanation.

        ``probability`` remains available for CLI/API compatibility, but it is
        uncalibrated unless the validation report explicitly says otherwise.
        Model review ranks by ``feature_score`` instead.
        """
        normalized = _model_tags(tags)
        normalized_context = (
            _normalize_context_features(context_features)
            if context_features is not None
            else _model_context_features(metadata)
        )
        score = self.bias + self.prior_log_odds
        feature_score = 0.0
        contributions: list[tuple[str, str, float, float]] = []
        for namespace, name, value in _active_feature_values(
            normalized,
            normalized_context,
            self.feature_space,
            self.feature_normalization,
        ):
            if namespace == "tag":
                weight = self.tag_weights[name]
                feature_type = "tag"
                display_name = name
            elif namespace == "combo":
                weight = self.combo_weights[name]
                feature_type = "combo"
                display_name = _format_pair(name)
            else:
                weight = self.context_weights[name]
                feature_type, display_name = _display_context_feature(name)
            contribution = weight * value
            score += contribution
            feature_score += contribution
            contributions.append((feature_type, display_name, contribution, weight))

        ordered = sorted(
            contributions,
            key=lambda item: (-abs(item[2]), item[0], item[1]),
        )[:top_n]
        explanation = tuple(
            {
                "type": feature_type,
                "feature": name,
                "weight": round(contribution, 4),
                "coefficient": round(coefficient, 4),
                "direction": "dislike" if contribution > 0 else "keep",
            }
            for feature_type, name, contribution, coefficient in ordered
        )
        return PreferencePrediction(
            probability=_sigmoid(score),
            score=score,
            feature_score=feature_score,
            contributions=explanation,
            positive_evidence_count=sum(item[2] > 0 for item in contributions),
            calibrated=self.validation.get("calibrated") is True,
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "trained_at": self.trained_at,
            "threshold": self.threshold,
            "bias": self.bias,
            "prior_log_odds": self.prior_log_odds,
            "tag_weights": self.tag_weights,
            "combo_weights": self.combo_weights,
            "context_weights": self.context_weights,
            "combo_min_support": self.combo_min_support,
            "max_combo_features": self.max_combo_features,
            "feature_normalization": self.feature_normalization,
            "training_summary": self.training_summary,
            "validation": self.validation,
        }

    @classmethod
    def from_dict(cls, raw: object) -> PreferenceModel:
        """Deserialize a saved model, rejecting incompatible data."""
        if not isinstance(raw, dict):
            raise ValueError("Unsupported preference model file")
        raw_schema_version = raw.get("schema_version")
        if isinstance(raw_schema_version, bool) or raw_schema_version not in {
            LEGACY_MODEL_SCHEMA_VERSION,
            MODEL_SCHEMA_VERSION,
        }:
            raise ValueError("Unsupported preference model file")
        schema_version = int(raw_schema_version)

        def weights(key: str) -> dict[str, float]:
            values = raw.get(key, {})
            if not isinstance(values, dict):
                raise ValueError(f"Invalid preference model {key}")
            return {str(name): float(weight) for name, weight in values.items()}

        summary = raw.get("training_summary", {})
        validation = raw.get("validation", {})
        if not isinstance(summary, dict) or not isinstance(validation, dict):
            raise ValueError("Invalid preference model summary")
        return cls(
            bias=float(raw["bias"]),
            prior_log_odds=float(raw["prior_log_odds"]),
            tag_weights=weights("tag_weights"),
            combo_weights=weights("combo_weights"),
            context_weights=weights("context_weights"),
            threshold=float(raw.get("threshold", DEFAULT_THRESHOLD)),
            trained_at=str(raw.get("trained_at", "")),
            training_summary=summary,
            validation=validation,
            combo_min_support=int(
                raw.get(
                    "combo_min_support",
                    (
                        5
                        if schema_version == LEGACY_MODEL_SCHEMA_VERSION
                        else DEFAULT_COMBO_MIN_SUPPORT
                    ),
                )
            ),
            max_combo_features=int(raw.get("max_combo_features", DEFAULT_MAX_COMBO_FEATURES)),
            schema_version=schema_version,
            feature_normalization=str(
                raw.get(
                    "feature_normalization",
                    "none"
                    if schema_version == LEGACY_MODEL_SCHEMA_VERSION
                    else DEFAULT_FEATURE_NORMALIZATION,
                )
            ),
        )


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
        "score",
        "feature_score",
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
        if action == "ban":
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
                )
            )
        elif filename in retained:
            is_favorite = filename in favorites
            feedback = latest_feedback.get(filename)
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
    examples = tuple(
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
    return PreferenceTrainingSnapshot(
        examples=examples,
        feedback_revision=int(feedback["revision"]),
        data_signature=_training_data_signature(examples),
        favorite_files=len(favorites),
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
    )
    model.training_summary["favorite_files"] = snapshot.favorite_files
    model.training_summary["favorites_without_usable_metadata"] = snapshot.favorite_files - int(
        model.training_summary["favorites"]
    )
    return model, snapshot


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
            if current.data_signature != snapshot.data_signature:
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
        )
        if _save_manual_preference_model(config, model, snapshot):
            return model, snapshot
    raise OSError("Wallpaper labels changed while training; please run model train again")


def train_preference_model(
    examples: list[PreferenceExample],
    *,
    combo_min_support: int = DEFAULT_COMBO_MIN_SUPPORT,
    max_combo_features: int = DEFAULT_MAX_COMBO_FEATURES,
    threshold: float = DEFAULT_THRESHOLD,
    epochs: int = DEFAULT_EPOCHS,
    validation_days: int = 14,
    feedback_revision: int = 0,
    retrain_mode: str = "manual",
) -> PreferenceModel:
    """Fit the lightweight explainable preference ranking model."""
    examples = sorted(
        examples,
        key=lambda example: (
            example.timestamp,
            example.filename,
            example.label,
            example.tags,
            example.context_features,
            example.is_favorite,
            example.is_explicit_keep,
            example.is_control,
            example.temporal_label_known,
        ),
    )
    _validate_training_examples(examples)
    if combo_min_support < 2:
        raise ValueError("combo_min_support must be at least 2")
    if max_combo_features < 0:
        raise ValueError("max_combo_features cannot be negative")
    if not 0 < threshold < 1:
        raise ValueError("threshold must be between 0 and 1")
    if epochs < 1:
        raise ValueError("epochs must be positive")

    implicit_retained_excluded = sum(
        example.label == 0 and (example.is_control or not example.temporal_label_known)
        for example in examples
    )
    training, holdout = _temporal_split(examples, validation_days)
    validation: dict[str, object] = {
        "available": False,
        "calibrated": False,
        "reason": "not enough temporally observed labelled data",
        "excluded_implicit_retained": implicit_retained_excluded,
        "excluded_controls": implicit_retained_excluded,
    }
    if _has_both_classes(training, MIN_VALIDATION_PER_CLASS) and _has_both_classes(
        holdout, MIN_VALIDATION_PER_CLASS
    ):
        validation_model = _fit(
            training,
            combo_min_support=combo_min_support,
            max_combo_features=max_combo_features,
            threshold=threshold,
            epochs=epochs,
        )
        validation = _evaluate(validation_model, holdout, threshold)
        validation["available"] = True
        validation["holdout_days"] = validation_days
        validation["excluded_implicit_retained"] = implicit_retained_excluded
        validation["excluded_controls"] = implicit_retained_excluded

    model = _fit(
        examples,
        combo_min_support=combo_min_support,
        max_combo_features=max_combo_features,
        threshold=threshold,
        epochs=epochs,
    )
    model.validation = validation
    model.training_summary.update(
        {
            "feedback_revision": feedback_revision,
            "training_data_signature": _training_data_signature(examples),
            "example_ids": _training_example_ids(examples),
            "validation_days": validation_days,
            "retrain_mode": retrain_mode,
            "explicit_keeps": sum(example.is_explicit_keep for example in examples),
            "controls": sum(example.is_control for example in examples),
        }
    )
    return model


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
            "pending_feedback": snapshot.feedback_revision,
            "changed_examples": len(snapshot.examples),
            "weight_refresh_due": False,
            "minimum_feedback": AUTO_RETRAIN_MIN_FEEDBACK,
            "due": False,
        }

    upgrade_due = (
        model.schema_version != MODEL_SCHEMA_VERSION
        or model.feature_normalization != DEFAULT_FEATURE_NORMALIZATION
    )
    summary = model.training_summary
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


def preference_deletion_suggestions(
    config: WayperConfig,
    *,
    purities: Iterable[str] | None = None,
    orientation: str | None = None,
    limit: int = DEFAULT_REVIEW_LIMIT,
) -> dict[str, object]:
    """Return ranked pool images for human review only.

    This function never alters the blacklist or filesystem.  Favorites,
    blacklisted files, explicit positive corrections, metadata-only records,
    and candidates without net learned dislike evidence are excluded.
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
            "review_strategy": "net_feature_rank",
        }

    if model.schema_version != MODEL_SCHEMA_VERSION:
        return {
            "status": "upgrade_pending",
            "items": [],
            "learning": learning,
            "model": model_report(model, model_path, learning=learning),
            "review_strategy": "net_feature_rank",
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
    scored: list[dict[str, object]] = []
    pool_images = 0
    metadata_images = 0
    scored_images = 0
    positive_evidence_images = 0
    best_score: float | None = None
    for purity in active_purities:
        for orient in orientations:
            for image in list_images(pool_dir(config, purity, orient)):
                pool_images += 1
                filename = image.name
                if (
                    filename in blacklisted
                    or filename in favorites
                    or _has_explicit_positive_feedback(latest_feedback.get(filename))
                ):
                    continue
                meta = metadata.get(filename)
                if not meta or not meta.get("tags"):
                    continue
                metadata_images += 1
                prediction = model.predict(meta["tags"], metadata=meta, top_n=20)
                scored_images += 1
                if prediction.positive_evidence_count > 0:
                    positive_evidence_images += 1
                    if best_score is None or prediction.feature_score > best_score:
                        best_score = prediction.feature_score
                if (
                    prediction.feature_score <= DEFAULT_REVIEW_MIN_FEATURE_SCORE
                    or prediction.positive_evidence_count == 0
                ):
                    continue
                scored.append(
                    {
                        "path": str(image.relative_to(config.download_dir)),
                        "name": filename,
                        "prediction": prediction,
                    }
                )

    ranked_all = sorted(
        scored,
        key=lambda item: (-item["prediction"].feature_score, str(item["name"])),
    )
    candidates: list[dict[str, object]] = []
    for rank, item in enumerate(ranked_all, 1):
        prediction = item["prediction"]
        all_rank = rank
        candidates.append(
            {
                "path": item["path"],
                "name": item["name"],
                "score": round(prediction.score, 4),
                "feature_score": round(prediction.feature_score, 4),
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
        "items": candidates[: max(1, limit)],
        "learning": learning,
        "model": model_report(model, model_path, learning=learning),
        "review_strategy": "net_feature_rank",
        "diagnostics": {
            "pool_images": pool_images,
            "metadata_images": metadata_images,
            "scored_images": scored_images,
            "positive_evidence_images": positive_evidence_images,
            "candidate_count": len(candidates),
            "best_feature_score": round(best_score, 4) if best_score is not None else None,
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


def _pid_is_running(pid: int) -> bool:
    if pid <= 0:
        return False
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
            if current.data_signature != snapshot.data_signature:
                return False
            current_model = load_preference_model(path)
            if (
                current_model is not None
                and current_model.training_summary.get("training_data_signature")
                == current.data_signature
            ):
                # A manual fit (or another worker) already covered exactly the
                # same snapshot. Preserve its chosen hyperparameters.
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
        )
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


def _training_example_payload(example: PreferenceExample, *, include_weight: bool) -> str:
    """Serialize one example for stable data or label identity fingerprints."""
    values: list[object] = [
        example.filename,
        list(example.tags),
        example.label,
        example.timestamp,
        example.is_favorite,
        example.is_explicit_keep,
        example.is_control,
        example.temporal_label_known,
        list(example.context_features),
    ]
    if include_weight:
        # The snapshot is day-stable. Rounding avoids insignificant platform
        # floating-point noise while still noticing deliberate recency decay.
        values.append(round(example.base_weight, 10))
    return json.dumps(
        values,
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _training_example_ids(examples: Iterable[PreferenceExample]) -> list[str]:
    return sorted(
        hashlib.blake2b(
            _training_example_payload(example, include_weight=False).encode(), digest_size=8
        ).hexdigest()
        for example in examples
    )


def _training_data_signature(examples: Iterable[PreferenceExample]) -> str:
    digest = hashlib.sha256()
    for payload in sorted(
        _training_example_payload(example, include_weight=True) for example in examples
    ):
        digest.update(payload.encode())
        digest.update(b"\n")
    return digest.hexdigest()


def _fit(
    examples: list[PreferenceExample],
    *,
    combo_min_support: int,
    max_combo_features: int,
    threshold: float,
    epochs: int,
) -> PreferenceModel:
    feature_space = _build_feature_space(examples, combo_min_support, max_combo_features)
    sample_weights, _historical_prior = _sample_weights(examples)
    bias, weights = _fit_ftrl(
        examples,
        feature_space,
        sample_weights,
        epochs,
        normalization=DEFAULT_FEATURE_NORMALIZATION,
    )
    tag_weights = {tag: weight for tag in feature_space.tags if (weight := weights.get(tag, 0.0))}
    combo_weights = {
        pair: weight
        for pair in feature_space.combos
        if (weight := weights.get(_storage_feature_key("combo", pair), 0.0))
    }
    context_weights = {
        token: weight
        for token in feature_space.context
        if (weight := weights.get(_storage_feature_key("context", token), 0.0))
    }
    summary = {
        "examples": len(examples),
        "banned": sum(example.label == 1 for example in examples),
        "retained": sum(example.label == 0 for example in examples),
        "controls": sum(example.is_control for example in examples),
        "favorites": sum(example.is_favorite for example in examples),
        "tag_features": len(tag_weights),
        "combo_features": len(combo_weights),
        "context_features": len(context_weights),
        "combo_min_support": combo_min_support,
        "max_combo_features": max_combo_features,
        "feature_normalization": DEFAULT_FEATURE_NORMALIZATION,
        "epochs": epochs,
    }
    return PreferenceModel(
        bias=bias,
        # The ban/control ratio is a sampling artifact: bans accumulate while
        # the live pool is quota-limited. Keep the ranking intercept neutral.
        prior_log_odds=0.0,
        tag_weights=tag_weights,
        combo_weights=combo_weights,
        context_weights=context_weights,
        threshold=threshold,
        trained_at=datetime.now(UTC).isoformat(),
        training_summary=summary,
        validation={},
        combo_min_support=combo_min_support,
        max_combo_features=max_combo_features,
        schema_version=MODEL_SCHEMA_VERSION,
        feature_normalization=DEFAULT_FEATURE_NORMALIZATION,
    )


def _build_feature_space(
    examples: Iterable[PreferenceExample], combo_min_support: int, max_combo_features: int
) -> FeatureSpace:
    tag_counts: Counter[str] = Counter()
    pair_counts: Counter[str] = Counter()
    context_counts: Counter[str] = Counter()
    for example in examples:
        tags = _model_tags(example.tags)
        tag_counts.update(tags)
        # Pair extraction is quadratic in tag count.  The recommended v2
        # model disables pairs, so do not pay that cost merely to discard the
        # resulting vocabulary afterward.
        if max_combo_features:
            pair_counts.update(_pair_keys(tags))
        context_counts.update(_normalize_context_features(example.context_features))

    tags = frozenset(tag for tag, count in tag_counts.items() if count >= 2)
    ordered_pairs = sorted(
        (
            pair
            for pair, count in pair_counts.items()
            if count >= combo_min_support and _pair_is_eligible(pair)
        ),
        key=lambda pair: (-pair_counts[pair], pair),
    )
    if max_combo_features:
        ordered_pairs = ordered_pairs[:max_combo_features]
    else:
        ordered_pairs = []
    context = frozenset(
        token for token, count in context_counts.items() if count >= _context_min_support(token)
    )
    return FeatureSpace(tags, frozenset(ordered_pairs), context)


def _fit_ftrl(
    examples: list[PreferenceExample],
    feature_space: FeatureSpace,
    sample_weights: list[float],
    epochs: int,
    *,
    normalization: str = DEFAULT_FEATURE_NORMALIZATION,
) -> tuple[float, dict[str, float]]:
    """Fit sparse logistic weights with deterministic FTRL-Proximal updates."""
    alpha = 0.12
    beta = 1.0
    l1 = 0.08
    l2 = 0.15
    z: dict[str, float] = {}
    n: dict[str, float] = {}
    bias_z = 0.0
    bias_n = 0.0
    order = list(range(len(examples)))
    random.Random(0).shuffle(order)

    for _ in range(epochs):
        for index in order:
            example = examples[index]
            feature_values = _active_feature_values(
                example.tags,
                example.context_features,
                feature_space,
                normalization,
            )
            bias = _ftrl_weight(bias_z, bias_n, alpha, beta, 0.0, l2)
            score = bias + sum(
                _ftrl_weight(
                    z.get(_storage_feature_key(namespace, name), 0.0),
                    n.get(_storage_feature_key(namespace, name), 0.0),
                    alpha,
                    beta,
                    l1,
                    l2,
                )
                * value
                for namespace, name, value in feature_values
            )
            gradient = (_sigmoid(score) - example.label) * sample_weights[index]

            sigma = (math.sqrt(bias_n + gradient * gradient) - math.sqrt(bias_n)) / alpha
            bias_z += gradient - sigma * bias
            bias_n += gradient * gradient
            for namespace, name, value in feature_values:
                storage_name = _storage_feature_key(namespace, name)
                old_n = n.get(storage_name, 0.0)
                old_z = z.get(storage_name, 0.0)
                weight = _ftrl_weight(old_z, old_n, alpha, beta, l1, l2)
                feature_gradient = gradient * value
                sigma = (
                    math.sqrt(old_n + feature_gradient * feature_gradient) - math.sqrt(old_n)
                ) / alpha
                z[storage_name] = old_z + feature_gradient - sigma * weight
                n[storage_name] = old_n + feature_gradient * feature_gradient

    weights = {
        name: weight
        for name, z_value in z.items()
        if (weight := _ftrl_weight(z_value, n[name], alpha, beta, l1, l2)) != 0.0
    }
    return _ftrl_weight(bias_z, bias_n, alpha, beta, 0.0, l2), weights


def _sample_weights(examples: list[PreferenceExample]) -> tuple[list[float], float]:
    positive_total = sum(example.base_weight for example in examples if example.label == 1)
    negative_total = sum(example.base_weight for example in examples if example.label == 0)
    if not positive_total or not negative_total:
        raise ValueError("Need both banned and retained examples")
    target = (positive_total + negative_total) / 2
    positive_factor = target / positive_total
    negative_factor = target / negative_total
    weights = [
        example.base_weight * (positive_factor if example.label else negative_factor)
        for example in examples
    ]
    return weights, math.log(positive_total / negative_total)


def _evaluate(
    model: PreferenceModel, examples: Iterable[PreferenceExample], threshold: float
) -> dict[str, object]:
    predicted = [
        (
            model.predict(
                example.tags,
                context_features=example.context_features,
            ).probability,
            example.label,
        )
        for example in examples
    ]
    true_positive = sum(probability >= threshold and label == 1 for probability, label in predicted)
    false_positive = sum(
        probability >= threshold and label == 0 for probability, label in predicted
    )
    false_negative = sum(probability < threshold and label == 1 for probability, label in predicted)
    predicted_at_threshold = true_positive + false_positive
    total = len(predicted)
    correct = sum((probability >= 0.5) == bool(label) for probability, label in predicted)
    roc_auc = _roc_auc(predicted)
    return {
        "examples": total,
        # A time split measures ranking/threshold behavior only.  No external
        # calibration set is available yet, so callers must not present this
        # sigmoid as a trustworthy probability.
        "calibrated": False,
        "precision_at_threshold": round(true_positive / (true_positive + false_positive), 3)
        if predicted_at_threshold
        else None,
        "predicted_at_threshold": predicted_at_threshold,
        "precision_lower_bound": round(
            _wilson_lower_bound(true_positive, predicted_at_threshold), 3
        )
        if predicted_at_threshold
        else None,
        "recall_at_threshold": round(true_positive / (true_positive + false_negative), 3)
        if true_positive + false_negative
        else None,
        "roc_auc": round(roc_auc, 3) if roc_auc is not None else None,
        "accuracy_at_0_5": round(correct / total, 3) if total else None,
    }


def _roc_auc(predicted: list[tuple[float, int]]) -> float | None:
    """Compute ROC AUC with average ranks, without a numeric dependency."""
    positives = sum(label == 1 for _, label in predicted)
    negatives = sum(label == 0 for _, label in predicted)
    if not positives or not negatives:
        return None
    ordered = sorted(predicted, key=lambda item: item[0])
    positive_rank_sum = 0.0
    index = 0
    while index < len(ordered):
        end = index + 1
        score = ordered[index][0]
        while end < len(ordered) and ordered[end][0] == score:
            end += 1
        average_rank = (index + 1 + end) / 2
        positive_rank_sum += average_rank * sum(label == 1 for _, label in ordered[index:end])
        index = end
    return (positive_rank_sum - positives * (positives + 1) / 2) / (positives * negatives)


def _wilson_lower_bound(successes: int, total: int, z: float = 1.96) -> float:
    """Return a conservative 95% lower bound for a binomial precision."""
    if total <= 0:
        return 0.0
    proportion = successes / total
    denominator = 1 + z * z / total
    center = proportion + z * z / (2 * total)
    margin = z * math.sqrt((proportion * (1 - proportion) + z * z / (4 * total)) / total)
    return max(0.0, (center - margin) / denominator)


def _temporal_split(
    examples: list[PreferenceExample], validation_days: int
) -> tuple[list[PreferenceExample], list[PreferenceExample]]:
    if validation_days <= 0 or not examples:
        return examples, []
    temporally_observed = [example for example in examples if example.temporal_label_known]
    if not temporally_observed:
        return [], []
    newest = max(example.timestamp for example in temporally_observed)
    cutoff = newest - validation_days * 86400
    training = [example for example in temporally_observed if example.timestamp < cutoff]
    holdout = [example for example in temporally_observed if example.timestamp >= cutoff]
    return training, holdout


def _has_both_classes(examples: Iterable[PreferenceExample], minimum: int) -> bool:
    counts = Counter(example.label for example in examples)
    return counts[0] >= minimum and counts[1] >= minimum


_CONTEXT_FIELDS = frozenset({"color", "category", "purity", "uploader"})


def _normalize_context_features(features: Iterable[object] | None) -> tuple[str, ...]:
    if features is None:
        return ()
    if isinstance(features, str):
        features = (features,)
    normalized: set[str] = set()
    for raw in features:
        prefix, separator, value = str(raw).partition(":")
        if not separator or prefix not in _CONTEXT_FIELDS:
            continue
        clean_value = normalize_tag(value)
        if clean_value:
            normalized.add(f"{prefix}:{clean_value}")
    return tuple(sorted(normalized))


def _model_context_features(metadata: dict[str, object] | None) -> tuple[str, ...]:
    if not isinstance(metadata, dict):
        return ()
    values: list[str] = []
    colors = metadata.get("colors", ())
    if isinstance(colors, str):
        colors = (colors,)
    if isinstance(colors, list | tuple | set):
        values.extend(f"color:{color}" for color in colors)
    for field in ("category", "purity", "uploader"):
        value = metadata.get(field)
        if value not in (None, ""):
            values.append(f"{field}:{value}")
    return _normalize_context_features(values)


def _context_min_support(token: str) -> int:
    return DEFAULT_UPLOADER_MIN_SUPPORT if token.startswith("uploader:") else 2


def _display_context_feature(token: str) -> tuple[str, str]:
    prefix, _, value = token.partition(":")
    return prefix, f"{prefix}: {value}"


def _storage_feature_key(namespace: str, name: str) -> str:
    if namespace == "combo":
        return _combo_feature(name)
    if namespace == "context":
        return f"context:{name}"
    return name


def _active_feature_values(
    tags: tuple[str, ...],
    context_features: Iterable[object] | None,
    feature_space: FeatureSpace,
    normalization: str,
) -> tuple[tuple[str, str, float], ...]:
    normalized_tags = _model_tags(tags)
    active_tags = [tag for tag in normalized_tags if tag in feature_space.tags]
    active_pairs = (
        [pair for pair in _pair_keys(normalized_tags) if pair in feature_space.combos]
        if feature_space.combos
        else []
    )
    active_context = [
        token
        for token in _normalize_context_features(context_features)
        if token in feature_space.context
    ]
    values: list[tuple[str, str, float]] = []
    tag_scale = (
        1.0 / math.sqrt(len(active_tags))
        if normalization == DEFAULT_FEATURE_NORMALIZATION and active_tags
        else 1.0
    )
    values.extend(("tag", tag, tag_scale) for tag in active_tags)
    pair_scale = (
        1.0 / math.sqrt(len(active_pairs))
        if normalization == DEFAULT_FEATURE_NORMALIZATION and active_pairs
        else 1.0
    )
    values.extend(("combo", pair, pair_scale) for pair in active_pairs)

    by_field: dict[str, list[str]] = {}
    for token in active_context:
        field, _, _ = token.partition(":")
        by_field.setdefault(field, []).append(token)
    for field, tokens in by_field.items():
        scale = (
            1.0 / math.sqrt(len(tokens))
            if field == "color" and normalization == DEFAULT_FEATURE_NORMALIZATION and tokens
            else 1.0
        )
        values.extend(("context", token, scale) for token in tokens)
    return tuple(values)


def _active_features(tags: tuple[str, ...], feature_space: FeatureSpace) -> tuple[str, ...]:
    """Return legacy storage keys for callers that inspect the feature space."""
    return tuple(
        _storage_feature_key(namespace, name)
        for namespace, name, _ in _active_feature_values(
            tags,
            (),
            feature_space,
            "none",
        )
    )


def _model_tags(tags: Iterable[object] | None) -> tuple[str, ...]:
    if tags is None:
        return ()
    if isinstance(tags, str):
        tags = (tags,)
    normalized: set[str] = set()
    for raw_tag in tags:
        tag = normalize_tag(raw_tag)
        if tag and _is_eligible_tag(tag):
            normalized.add(tag)
    return tuple(sorted(normalized))


def _is_eligible_tag(tag: str) -> bool:
    return bool(tag) and tag not in _NON_PREFERENCE_FEATURE_TAGS


def _pair_keys(tags: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(
        _PAIR_SEPARATOR.join((first, second))
        for index, first in enumerate(tags)
        for second in tags[index + 1 :]
    )


def _pair_is_eligible(pair: str) -> bool:
    first, second = pair.split(_PAIR_SEPARATOR, 1)
    return _is_eligible_tag(first) and _is_eligible_tag(second)


def _combo_feature(pair: str) -> str:
    return f"combo:{pair}"


def _format_pair(pair: str) -> str:
    return pair.replace(_PAIR_SEPARATOR, " + ")


def _ftrl_weight(z: float, n: float, alpha: float, beta: float, l1: float, l2: float) -> float:
    if abs(z) <= l1:
        return 0.0
    return -(z - math.copysign(l1, z)) / ((beta + math.sqrt(n)) / alpha + l2)


def _recency_weight(timestamp: int, now: int, half_life_days: int) -> float:
    if half_life_days <= 0:
        return 1.0
    age_days = max(0, now - timestamp) / 86400
    # Retain some value for older deliberate bans while prioritising current taste.
    return 0.25 + 0.75 * 0.5 ** (age_days / half_life_days)


def _metadata_timestamp(meta: dict, fallback: int) -> int:
    try:
        return int(meta.get("downloaded_at", fallback))
    except (TypeError, ValueError):
        return fallback


def _sigmoid(value: float) -> float:
    if value >= 35:
        return 1.0
    if value <= -35:
        return 0.0
    return 1 / (1 + math.exp(-value))


def _validate_training_examples(examples: Iterable[PreferenceExample]) -> None:
    values = list(examples)
    if not _has_both_classes(values, MIN_TRAINING_PER_CLASS):
        raise ValueError(
            f"Need at least {MIN_TRAINING_PER_CLASS} banned and retained metadata examples"
        )
