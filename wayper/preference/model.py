"""Preference model data types and feature extraction."""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass
from dataclasses import field as dataclass_field

from ..tags import normalize_tag

# Schema 4 adds a bounded, persisted content-neighbour head.  Keep the older
# values named explicitly: model files are user data and must remain readable
# across upgrades so a background refresh can replace them safely.
MODEL_SCHEMA_VERSION = 4
LEGACY_MODEL_SCHEMA_VERSION = 1
SPARSE_MODEL_SCHEMA_VERSION = 2
CALIBRATED_MODEL_SCHEMA_VERSION = 3
DEFAULT_COMBO_MIN_SUPPORT = 20
DEFAULT_MAX_COMBO_FEATURES = 0
DEFAULT_UPLOADER_MIN_SUPPORT = 10
DEFAULT_EPOCHS = 6
DEFAULT_THRESHOLD = 0.98
# Review decisions are recoverable, but false positives still create manual
# work.  New models replace this fallback with a boundary learned from held-out
# Keep/Dislike decisions.
DEFAULT_REVIEW_THRESHOLD = 0.20
DEFAULT_REVIEW_DISLIKE_BOOST = 1.5
DEFAULT_NEIGHBOR_K = 35
DEFAULT_NEIGHBOR_MAX_PROTOTYPES = 2048
DEFAULT_NEIGHBOR_MIN_SIMILARITY = 0.15
DEFAULT_RECOMMENDATION_THRESHOLD = 0.50
# This is a probability boundary, unlike DEFAULT_REVIEW_THRESHOLD which is a
# legacy sparse-logit margin.  It is deliberately conservative and is replaced
# by a held-out boundary when enough explicit feedback exists.
DEFAULT_AUTO_FILTER_NEIGHBOR_THRESHOLD = 0.80
NEIGHBOR_HEAD_SCHEMA_VERSION = 1
DEFAULT_FAVORITE_WEIGHT = 4.0
DEFAULT_RECENCY_HALF_LIFE_DAYS = 90
DEFAULT_FEATURE_NORMALIZATION = "field_l2"
MIN_TRAINING_PER_CLASS = 10
MIN_VALIDATION_PER_CLASS = 5

_PAIR_SEPARATOR = "\x1f"
_CONTEXT_FIELDS = frozenset({"color", "category", "purity", "uploader"})
_BROAD_REVIEW_FEATURE_TYPES = frozenset({"color", "purity"})
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
    is_explicit_ban: bool = False


@dataclass(frozen=True)
class PreferenceTrainingSnapshot:
    """A stable local view of labels used to fit or refresh a model."""

    examples: tuple[PreferenceExample, ...]
    feedback_revision: int
    data_signature: str
    favorite_files: int
    # ``legacy`` bootstraps an installation before the user has reviewed any
    # candidates; once curated feedback exists, snapshots switch to explicit
    # Review and manual-Dislike labels.
    label_source: str = "legacy"


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
    strongest_review_dislike_score: float = 0.0
    strongest_review_dislike: dict[str, object] | None = None
    strongest_review_keep_score: float = 0.0
    strongest_review_keep: dict[str, object] | None = None
    semantic_score: float | None = None
    semantic_probability: float | None = None
    semantic_available: bool = False
    # The content-neighbour head is intentionally separate from the sparse
    # logistic explanation above.  ``neighbor_probability`` is a weighted vote
    # over explicit Keep/Dislike prototypes, not a pixel or embedding score.
    neighbor_probability: float | None = None
    neighbor_available: bool = False
    neighbor_count: int = 0
    neighbor_dislike_count: int = 0
    neighbor_keep_count: int = 0
    neighbor_similarity_sum: float = 0.0
    neighbor_max_similarity: float = 0.0
    neighbor_nearest_dislike: dict[str, object] | None = None
    neighbor_nearest_keep: dict[str, object] | None = None

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
            "strongest_review_dislike_score": round(
                self.strongest_review_dislike_score,
                4,
            ),
            "strongest_review_dislike": self.strongest_review_dislike,
            "strongest_review_keep_score": round(self.strongest_review_keep_score, 4),
            "strongest_review_keep": self.strongest_review_keep,
            "semantic_score": (
                round(self.semantic_score, 4) if self.semantic_score is not None else None
            ),
            "semantic_probability": (
                round(self.semantic_probability, 4)
                if self.semantic_probability is not None
                else None
            ),
            "semantic_available": self.semantic_available,
            "neighbor_probability": (
                round(self.neighbor_probability, 4)
                if self.neighbor_probability is not None
                else None
            ),
            "neighbor_available": self.neighbor_available,
            "neighbor_count": self.neighbor_count,
            "neighbor_dislike_count": self.neighbor_dislike_count,
            "neighbor_keep_count": self.neighbor_keep_count,
            "neighbor_similarity_sum": round(self.neighbor_similarity_sum, 4),
            "neighbor_max_similarity": round(self.neighbor_max_similarity, 4),
            "neighbor_nearest_dislike": self.neighbor_nearest_dislike,
            "neighbor_nearest_keep": self.neighbor_nearest_keep,
        }


@dataclass(frozen=True)
class PreferenceNeighborPrototype:
    """One unit-normalized explicit example for content k-nearest-neighbours."""

    filename: str
    label: int
    timestamp: int
    features: tuple[tuple[str, float], ...]


def preference_review_score(prediction: PreferencePrediction) -> float:
    """Return the sparse review margin after a guarded dislike boost.

    Several individually mild keep signals may otherwise erase one learned
    veto.  The strongest comparable keep signal reduces the boost first, so a
    stronger keep pattern still protects the image.
    """
    dislike = prediction.strongest_review_dislike_score
    keep = prediction.strongest_review_keep_score
    boost = DEFAULT_REVIEW_DISLIKE_BOOST * max(0.0, dislike - keep)
    return prediction.feature_score + boost


def preference_review_decision_score(
    model: PreferenceModel,
    prediction: PreferencePrediction,
) -> float:
    """Return the score used by the conservative automatic boundary.

    New models use the calibrated content-neighbour probability whenever the
    query has neighbour coverage.  Legacy/cold-start predictions retain the
    explainable sparse margin so old callers and models continue to work.
    """
    if prediction.neighbor_available and prediction.neighbor_probability is not None:
        return prediction.neighbor_probability
    semantic = (
        model.semantic_blend * prediction.semantic_score
        if prediction.semantic_available and prediction.semantic_score is not None
        else 0.0
    )
    return preference_review_score(prediction) + semantic


def preference_review_threshold(model: PreferenceModel) -> float:
    """Return the automatic boundary (legacy name retained for API clients)."""
    value = model.training_summary.get("auto_filter_threshold")
    if not isinstance(value, int | float) or isinstance(value, bool) or not math.isfinite(value):
        value = model.training_summary.get("review_threshold")
    if isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value):
        boundary = float(value)
        return (
            max(DEFAULT_RECOMMENDATION_THRESHOLD, boundary)
            if model.neighbor_head_ready
            else boundary
        )
    return (
        DEFAULT_AUTO_FILTER_NEIGHBOR_THRESHOLD
        if model.neighbor_head_ready
        else DEFAULT_REVIEW_THRESHOLD
    )


def preference_review_has_dislike_evidence(prediction: PreferencePrediction) -> bool:
    """Require concrete evidence for the conservative automatic boundary."""
    if prediction.neighbor_available:
        return (
            prediction.neighbor_max_similarity >= DEFAULT_NEIGHBOR_MIN_SIMILARITY
            and prediction.neighbor_dislike_count > 0
            and bool(prediction.neighbor_probability is not None)
        )
    return prediction.strongest_review_dislike_score > 0 or bool(
        prediction.semantic_available
        and prediction.semantic_score is not None
        and prediction.semantic_score > 0
    )


def preference_recommendation_candidate(
    model: PreferenceModel,
    prediction: PreferencePrediction,
) -> bool:
    """Return whether a prediction belongs in the human Recommended lane.

    Recommended is an active-learning queue: a bounded rank is useful even
    when it would not clear an unattended-action boundary.  A neighbour head
    therefore uses a modest majority vote and requires at least one explicit
    Dislike neighbour.  Queries with no neighbour coverage use the sparse
    explainable head as a cold-start fallback, with the fixed recoverable
    margin rather than the high-precision automatic threshold.
    """
    if prediction.neighbor_available and prediction.neighbor_probability is not None:
        return (
            prediction.neighbor_dislike_count > 0
            and prediction.neighbor_max_similarity >= DEFAULT_NEIGHBOR_MIN_SIMILARITY
            and prediction.neighbor_probability >= DEFAULT_RECOMMENDATION_THRESHOLD
        )
    return (
        prediction.strongest_review_dislike_score > 0
        or bool(
            prediction.semantic_available
            and prediction.semantic_score is not None
            and prediction.semantic_score > 0
        )
    ) and preference_review_decision_score(model, prediction) >= DEFAULT_REVIEW_THRESHOLD


def preference_review_candidate(
    model: PreferenceModel,
    prediction: PreferencePrediction,
) -> bool:
    """Classify one prediction with the conservative automatic boundary.

    This compatibility entry point is used by download filtering.  Human
    recommendations must call :func:`preference_recommendation_candidate`.
    """
    # Once a persisted neighbour head exists, an uncovered query must fail
    # open.  Falling back to the sparse margin here would silently turn the
    # recommendation cold-start path into an automatic action.
    if model.neighbor_head_ready and not prediction.neighbor_available:
        return False
    return preference_review_has_dislike_evidence(prediction) and (
        preference_review_decision_score(model, prediction) >= preference_review_threshold(model)
    )


def _contribution_direction(value: object) -> str | None:
    """Read an explanation direction while tolerating legacy string items."""
    if isinstance(value, dict):
        direction = value.get("direction")
        return direction if direction in {"dislike", "keep"} else None
    return "dislike" if isinstance(value, str) else None


@dataclass
class PreferenceModel:
    """Persisted sparse logistic model with an optional content-neighbour head."""

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
    semantic_model: str = ""
    semantic_bias: float = 0.0
    semantic_weights: tuple[float, ...] = ()
    semantic_blend: float = 0.0
    semantic_rank_weight: float = 0.0
    neighbor_k: int = DEFAULT_NEIGHBOR_K
    neighbor_prototypes: tuple[PreferenceNeighborPrototype, ...] = ()
    _neighbor_feature_index: dict[str, tuple[tuple[int, float], ...]] | None = dataclass_field(
        default=None, init=False, repr=False, compare=False
    )

    @property
    def feature_space(self) -> FeatureSpace:
        return FeatureSpace(
            frozenset(self.tag_weights),
            frozenset(self.combo_weights),
            frozenset(self.context_weights),
        )

    @property
    def semantic_enabled(self) -> bool:
        """Whether this model contains a persisted semantic preference head."""
        return bool(self.semantic_model and self.semantic_weights)

    @property
    def neighbor_head_ready(self) -> bool:
        """Whether explicit prototypes cover both sides of the preference."""
        labels = {prototype.label for prototype in self.neighbor_prototypes}
        return labels == {0, 1} and self.neighbor_k > 0

    def _neighbor_index(self) -> dict[str, tuple[tuple[int, float], ...]]:
        """Build a reusable sparse inverted index for cosine overlap."""
        if self._neighbor_feature_index is not None:
            return self._neighbor_feature_index
        postings: dict[str, list[tuple[int, float]]] = {}
        for index, prototype in enumerate(self.neighbor_prototypes):
            for feature, value in prototype.features:
                postings.setdefault(feature, []).append((index, value))
        self._neighbor_feature_index = {
            feature: tuple(values) for feature, values in postings.items()
        }
        return self._neighbor_feature_index

    def _predict_neighbors(
        self,
        tags: Iterable[object],
        context_features: Iterable[object] | None,
    ) -> dict[str, object]:
        """Return a similarity-weighted explicit-label vote for one query."""
        if not self.neighbor_head_ready:
            return {}
        query = _neighbor_feature_values(tags, context_features)
        if not query:
            return {}
        scores: dict[int, float] = {}
        postings = self._neighbor_index()
        for feature, query_value in query:
            for prototype_index, prototype_value in postings.get(feature, ()):
                scores[prototype_index] = (
                    scores.get(prototype_index, 0.0) + query_value * prototype_value
                )
        neighbors = sorted(
            (
                (min(1.0, similarity), self.neighbor_prototypes[index])
                for index, similarity in scores.items()
                if similarity > 0
            ),
            key=lambda item: (
                -item[0],
                -item[1].timestamp,
                item[1].filename,
                item[1].label,
            ),
        )[: self.neighbor_k]
        if not neighbors:
            return {}
        similarity_sum = sum(similarity for similarity, _ in neighbors)
        if similarity_sum <= 0:
            return {}
        dislike_similarity = sum(
            similarity for similarity, prototype in neighbors if prototype.label == 1
        )
        dislike_neighbors = [item for item in neighbors if item[1].label == 1]
        keep_neighbors = [item for item in neighbors if item[1].label == 0]

        def evidence(
            item: tuple[float, PreferenceNeighborPrototype] | None,
        ) -> dict[str, object] | None:
            if item is None:
                return None
            similarity, prototype = item
            return {
                "filename": prototype.filename,
                "label": "dislike" if prototype.label else "keep",
                "similarity": round(similarity, 4),
            }

        return {
            "probability": dislike_similarity / similarity_sum,
            "count": len(neighbors),
            "dislike_count": len(dislike_neighbors),
            "keep_count": len(keep_neighbors),
            "similarity_sum": similarity_sum,
            "max_similarity": neighbors[0][0],
            "nearest_dislike": evidence(dislike_neighbors[0] if dislike_neighbors else None),
            "nearest_keep": evidence(keep_neighbors[0] if keep_neighbors else None),
        }

    def predict(
        self,
        tags: Iterable[object],
        *,
        metadata: dict[str, object] | None = None,
        context_features: Iterable[object] | None = None,
        top_n: int = 8,
        _semantic_embedding: Iterable[float] | None = None,
        _semantic_embedding_failed: bool = False,
    ) -> PreferencePrediction:
        """Return a local dislike margin and feature-level explanation."""
        normalized = _model_tags(tags)
        normalized_context = (
            _normalize_context_features(context_features)
            if context_features is not None
            else _model_context_features(metadata)
        )
        neighbor = self._predict_neighbors(normalized, normalized_context)
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

        sparse_positive_evidence_count = sum(item[2] > 0 for item in contributions)
        semantic_score: float | None = None
        semantic_probability: float | None = None
        semantic_available = False
        if self.semantic_enabled and not _semantic_embedding_failed:
            try:
                from .semantic import embed_metadata, score_embedding
                from .semantic import semantic_probability as _probability

                embedding = _semantic_embedding
                if embedding is None:
                    embedding = embed_metadata(
                        [(normalized, normalized_context)],
                        model_name=self.semantic_model,
                    )[0]
                semantic_score = score_embedding(
                    _semantic_head(self),
                    embedding,
                )
                semantic_probability = _probability(semantic_score)
                semantic_available = True
                semantic_contribution = self.semantic_blend * semantic_score
                score += semantic_contribution
                if semantic_contribution:
                    contributions.append(
                        (
                            "semantic",
                            "metadata semantic head",
                            semantic_contribution,
                            semantic_score,
                        )
                    )
            except Exception:
                # The optional runtime may be absent or its model cache may be
                # unavailable.  Exact metadata scoring must remain usable.
                semantic_score = None
                semantic_probability = None
                semantic_available = False

        def explain(item: tuple[str, str, float, float]) -> dict[str, object]:
            feature_type, name, contribution, coefficient = item
            return {
                "type": feature_type,
                "feature": name,
                "weight": round(contribution, 4),
                "coefficient": round(coefficient, 4),
                "direction": "dislike" if contribution > 0 else "keep",
            }

        ordered = sorted(contributions, key=lambda item: (-abs(item[2]), item[0], item[1]))[:top_n]
        explanation = tuple(explain(item) for item in ordered)
        review_dislike = max(
            (
                item
                for item in contributions
                if item[2] > 0 and item[0] not in _BROAD_REVIEW_FEATURE_TYPES
            ),
            key=lambda item: (item[2], item[0], item[1]),
            default=None,
        )
        review_keep = min(
            (
                item
                for item in contributions
                if item[2] < 0 and item[0] not in _BROAD_REVIEW_FEATURE_TYPES
            ),
            key=lambda item: (item[2], item[0], item[1]),
            default=None,
        )
        return PreferencePrediction(
            probability=_sigmoid(score),
            score=score,
            feature_score=feature_score,
            contributions=explanation,
            positive_evidence_count=sparse_positive_evidence_count,
            calibrated=self.validation.get("calibrated") is True,
            strongest_review_dislike_score=review_dislike[2] if review_dislike else 0.0,
            strongest_review_dislike=explain(review_dislike) if review_dislike else None,
            strongest_review_keep_score=-review_keep[2] if review_keep else 0.0,
            strongest_review_keep=explain(review_keep) if review_keep else None,
            semantic_score=semantic_score,
            semantic_probability=semantic_probability,
            semantic_available=semantic_available,
            neighbor_probability=(
                float(neighbor["probability"]) if "probability" in neighbor else None
            ),
            neighbor_available=bool(neighbor),
            neighbor_count=int(neighbor.get("count", 0)),
            neighbor_dislike_count=int(neighbor.get("dislike_count", 0)),
            neighbor_keep_count=int(neighbor.get("keep_count", 0)),
            neighbor_similarity_sum=float(neighbor.get("similarity_sum", 0.0)),
            neighbor_max_similarity=float(neighbor.get("max_similarity", 0.0)),
            neighbor_nearest_dislike=(
                neighbor.get("nearest_dislike")
                if isinstance(neighbor.get("nearest_dislike"), dict)
                else None
            ),
            neighbor_nearest_keep=(
                neighbor.get("nearest_keep")
                if isinstance(neighbor.get("nearest_keep"), dict)
                else None
            ),
        )

    def predict_many(
        self,
        records: Iterable[
            tuple[
                Iterable[object],
                dict[str, object] | None,
                Iterable[object] | None,
            ]
        ],
        *,
        top_n: int = 8,
    ) -> tuple[PreferencePrediction, ...]:
        """Score metadata records in one embedding batch when enabled."""
        materialized = tuple(
            (
                _model_tags(tags),
                metadata,
                (
                    (context,)
                    if isinstance(context, str)
                    else tuple(context)
                    if context is not None
                    else None
                ),
            )
            for tags, metadata, context in records
        )
        embeddings: list[tuple[float, ...] | None]
        semantic_embedding_failed = False
        if self.semantic_enabled and materialized:
            try:
                from .semantic import embed_metadata

                embeddings = [
                    tuple(vector)
                    for vector in embed_metadata(
                        [
                            (
                                tags,
                                context if context is not None else _model_context_features(meta),
                            )
                            for tags, meta, context in materialized
                        ],
                        model_name=self.semantic_model,
                    )
                ]
            except Exception:
                embeddings = [None] * len(materialized)
                semantic_embedding_failed = True
        else:
            embeddings = [None] * len(materialized)
        return tuple(
            self.predict(
                tags,
                metadata=metadata,
                context_features=context,
                top_n=top_n,
                _semantic_embedding=embedding,
                _semantic_embedding_failed=semantic_embedding_failed,
            )
            for (tags, metadata, context), embedding in zip(
                materialized,
                embeddings,
                strict=True,
            )
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
            "semantic_head": (
                {
                    "model_name": self.semantic_model,
                    "bias": self.semantic_bias,
                    "weights": list(self.semantic_weights),
                    "blend": self.semantic_blend,
                    "rank_weight": self.semantic_rank_weight,
                }
                if self.semantic_enabled
                else {}
            ),
            "neighbor_head": {
                "version": NEIGHBOR_HEAD_SCHEMA_VERSION,
                "k": self.neighbor_k,
                "prototypes": [
                    {
                        "filename": prototype.filename,
                        "label": prototype.label,
                        "timestamp": prototype.timestamp,
                        "features": [list(feature) for feature in prototype.features],
                    }
                    for prototype in self.neighbor_prototypes
                ],
            },
        }

    @classmethod
    def from_dict(cls, raw: object) -> PreferenceModel:
        """Deserialize a saved model, rejecting incompatible data."""
        if not isinstance(raw, dict):
            raise ValueError("Unsupported preference model file")
        raw_schema_version = raw.get("schema_version")
        if isinstance(raw_schema_version, bool) or raw_schema_version not in {
            LEGACY_MODEL_SCHEMA_VERSION,
            SPARSE_MODEL_SCHEMA_VERSION,
            CALIBRATED_MODEL_SCHEMA_VERSION,
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
        semantic_raw = raw.get("semantic_head", {})
        if semantic_raw is None:
            semantic_raw = {}
        if not isinstance(semantic_raw, dict):
            raise ValueError("Invalid preference model semantic head")
        semantic_weights = semantic_raw.get("weights", [])
        if not isinstance(semantic_weights, list | tuple):
            raise ValueError("Invalid preference model semantic weights")
        neighbor_raw = raw.get("neighbor_head", {})
        if neighbor_raw is None:
            neighbor_raw = {}
        if not isinstance(neighbor_raw, dict):
            raise ValueError("Invalid preference model neighbor head")
        neighbor_version = neighbor_raw.get("version", NEIGHBOR_HEAD_SCHEMA_VERSION)
        if (
            isinstance(neighbor_version, bool)
            or not isinstance(neighbor_version, int)
            or neighbor_version != NEIGHBOR_HEAD_SCHEMA_VERSION
        ):
            raise ValueError("Invalid preference model neighbor head version")
        neighbor_k = neighbor_raw.get("k", DEFAULT_NEIGHBOR_K)
        if (
            isinstance(neighbor_k, bool)
            or not isinstance(neighbor_k, int)
            or not 1 <= neighbor_k <= DEFAULT_NEIGHBOR_MAX_PROTOTYPES
        ):
            raise ValueError("Invalid preference model neighbor k")
        raw_prototypes = neighbor_raw.get("prototypes", [])
        if not isinstance(raw_prototypes, list | tuple):
            raise ValueError("Invalid preference model neighbor prototypes")
        if len(raw_prototypes) > DEFAULT_NEIGHBOR_MAX_PROTOTYPES:
            raise ValueError("Preference model neighbor head is too large")
        neighbor_prototypes: list[PreferenceNeighborPrototype] = []
        for raw_prototype in raw_prototypes:
            if not isinstance(raw_prototype, dict):
                raise ValueError("Invalid preference model neighbor prototype")
            label = raw_prototype.get("label")
            timestamp = raw_prototype.get("timestamp")
            filename = raw_prototype.get("filename")
            raw_features = raw_prototype.get("features")
            if (
                isinstance(label, bool)
                or label not in {0, 1}
                or isinstance(timestamp, bool)
                or not isinstance(timestamp, int)
                or not isinstance(filename, str)
                or not filename
                or not isinstance(raw_features, list | tuple)
            ):
                raise ValueError("Invalid preference model neighbor prototype")
            features: list[tuple[str, float]] = []
            if len(raw_features) > 512:
                raise ValueError("Preference model neighbor prototype is too large")
            for raw_feature in raw_features:
                if not isinstance(raw_feature, list | tuple) or len(raw_feature) != 2:
                    raise ValueError("Invalid preference model neighbor feature")
                feature, raw_value = raw_feature
                if not isinstance(feature, str) or not feature:
                    raise ValueError("Invalid preference model neighbor feature")
                value = float(raw_value)
                if not math.isfinite(value) or value <= 0:
                    raise ValueError("Invalid preference model neighbor feature")
                features.append((feature, value))
            if features:
                neighbor_prototypes.append(
                    PreferenceNeighborPrototype(
                        filename=filename,
                        label=int(label),
                        timestamp=timestamp,
                        features=tuple(features),
                    )
                )
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
            semantic_model=str(semantic_raw.get("model_name", "")),
            semantic_bias=float(semantic_raw.get("bias", 0.0)),
            semantic_weights=tuple(float(value) for value in semantic_weights),
            semantic_blend=float(semantic_raw.get("blend", 0.0)),
            semantic_rank_weight=float(semantic_raw.get("rank_weight", 0.0)),
            neighbor_k=neighbor_k,
            neighbor_prototypes=tuple(neighbor_prototypes),
        )


def _semantic_head(model: PreferenceModel):
    """Construct the optional runtime head lazily to keep imports lightweight."""
    from .semantic import SemanticHead

    return SemanticHead(
        model_name=model.semantic_model,
        bias=model.semantic_bias,
        weights=model.semantic_weights,
        blend=model.semantic_blend,
        rank_weight=model.semantic_rank_weight,
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


def _neighbor_feature_values(
    tags: Iterable[object] | None,
    context_features: Iterable[object] | None,
) -> tuple[tuple[str, float], ...]:
    """Return a deterministic unit vector for metadata content similarity.

    Tags and each context field first receive equal total mass, matching the
    sparse model's field normalization.  A final L2 normalization makes the
    dot product an ordinary cosine similarity without NumPy or SciPy.
    """
    normalized_tags = _model_tags(tags)
    normalized_context = _normalize_context_features(context_features)
    values: list[tuple[str, float]] = []
    if normalized_tags:
        tag_scale = 1.0 / math.sqrt(len(normalized_tags))
        values.extend((f"tag:{tag}", tag_scale) for tag in normalized_tags)
    by_field: dict[str, list[str]] = {}
    for token in normalized_context:
        field, _, _ = token.partition(":")
        by_field.setdefault(field, []).append(token)
    for field in sorted(by_field):
        tokens = by_field[field]
        scale = 1.0 / math.sqrt(len(tokens))
        values.extend((f"context:{token}", scale) for token in tokens)
    norm = math.sqrt(sum(value * value for _, value in values))
    if norm <= 0:
        return ()
    return tuple((feature, value / norm) for feature, value in sorted(values))


def build_neighbor_prototypes(
    examples: Iterable[PreferenceExample],
    *,
    max_prototypes: int = DEFAULT_NEIGHBOR_MAX_PROTOTYPES,
) -> tuple[PreferenceNeighborPrototype, ...]:
    """Build a recent, class-balanced prototype set from explicit feedback."""
    if max_prototypes < 2:
        return ()
    explicit = [
        example
        for example in examples
        if example.is_explicit_ban or example.is_explicit_keep or example.is_favorite
    ]
    grouped = {
        label: sorted(
            (example for example in explicit if example.label == label),
            key=lambda example: (-example.timestamp, example.filename),
        )
        for label in (0, 1)
    }
    if not grouped[0] or not grouped[1]:
        return ()

    # Reserve half for each class so a long run of one action cannot erase the
    # opposing preference.  Any unused slots are filled by the newest remaining
    # explicit examples regardless of class.
    per_class = max_prototypes // 2
    selected = [*grouped[0][:per_class], *grouped[1][:per_class]]
    selected_ids = {id(example) for example in selected}
    remainder = sorted(
        (example for example in explicit if id(example) not in selected_ids),
        key=lambda example: (-example.timestamp, example.filename, example.label),
    )
    selected.extend(remainder[: max(0, max_prototypes - len(selected))])

    prototypes: list[PreferenceNeighborPrototype] = []
    for example in sorted(
        selected,
        key=lambda item: (item.timestamp, item.filename, item.label),
    ):
        features = _neighbor_feature_values(example.tags, example.context_features)
        if features:
            prototypes.append(
                PreferenceNeighborPrototype(
                    filename=example.filename,
                    label=example.label,
                    timestamp=example.timestamp,
                    features=features,
                )
            )
    if {prototype.label for prototype in prototypes} != {0, 1}:
        return ()
    return tuple(prototypes)


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
