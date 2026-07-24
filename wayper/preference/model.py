"""Preference model data types and feature extraction."""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass
from dataclasses import field as dataclass_field

from ..tags import normalize_tag

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
MIN_TRAINING_PER_CLASS = 10
MIN_VALIDATION_PER_CLASS = 5

_PAIR_SEPARATOR = "\x1f"
_CONTEXT_FIELDS = frozenset({"color", "category", "purity", "uploader"})
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
    # Keep additions after the v1 positional fields for source compatibility.
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
    """Persisted sparse logistic model."""

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
        """Return a local dislike margin and feature-level explanation."""
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

        ordered = sorted(contributions, key=lambda item: (-abs(item[2]), item[0], item[1]))[:top_n]
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
                    5
                    if schema_version == LEGACY_MODEL_SCHEMA_VERSION
                    else DEFAULT_COMBO_MIN_SUPPORT,
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
        for namespace, name, _ in _active_feature_values(tags, (), feature_space, "none")
    )


def _model_tags(tags: Iterable[object] | None) -> tuple[str, ...]:
    if tags is None:
        return ()
    if isinstance(tags, str):
        tags = (tags,)
    normalized = {
        tag for raw_tag in tags if (tag := normalize_tag(raw_tag)) and _is_eligible_tag(tag)
    }
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


def _sigmoid(value: float) -> float:
    if value >= 35:
        return 1.0
    if value <= -35:
        return 0.0
    return 1 / (1 + math.exp(-value))
