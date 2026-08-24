"""Preference model data types and feature extraction."""

from __future__ import annotations

import heapq
import math
from collections import OrderedDict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from dataclasses import field as dataclass_field

from ..tags import normalize_tag

# Schema 4 adds a bounded, persisted content-neighbour head. Schema 5 retains
# normalized tag text on each prototype for two-stage semantic retrieval. Schema 6
# removes the old exact-only and sparse fallback decisions and uses one calibrated
# boundary for the semantic two-stage strategy. Older model files remain readable so
# the background refresh can replace them safely, but they are never used for actions.
MODEL_SCHEMA_VERSION = 6
LEGACY_MODEL_SCHEMA_VERSION = 1
SPARSE_MODEL_SCHEMA_VERSION = 2
CALIBRATED_MODEL_SCHEMA_VERSION = 3
CONTENT_NEIGHBOR_MODEL_SCHEMA_VERSION = 4
TAG_SEMANTIC_MODEL_SCHEMA_VERSION = 5
DEFAULT_COMBO_MIN_SUPPORT = 20
DEFAULT_MAX_COMBO_FEATURES = 0
DEFAULT_UPLOADER_MIN_SUPPORT = 10
DEFAULT_EPOCHS = 6
DEFAULT_NEIGHBOR_K = 35
DEFAULT_TRAINING_MAX_EXAMPLES = 2048
DEFAULT_NEIGHBOR_MIN_SIMILARITY = 0.15
# New models replace this conservative fallback with a boundary calibrated on
# unseen Keep/Dislike decisions.
DEFAULT_DECISION_THRESHOLD = 0.80
# The class-balanced MaxSim vote remains the primary signal. A small share of
# the global sparse+dense probability recovers consistent preference evidence
# that no single local neighbour expresses.
DEFAULT_SEMANTIC_NEIGHBOR_VOTE_WEIGHT = 0.80
NEIGHBOR_HEAD_SCHEMA_VERSION = 2
LEGACY_NEIGHBOR_HEAD_SCHEMA_VERSION = 1
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
    is_explicit_ban: bool = False
    # ``(normalized tag, embedding text)`` pairs retain aliases/categories
    # without changing the stable exact-tag feature space.
    semantic_tags: tuple[tuple[str, str], ...] = ()


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
    favorite_metadata_files: int = 0


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
    neighbor_exact_max_similarity: float = 0.0
    neighbor_semantic_max_similarity: float = 0.0
    neighbor_preference_gap: float = 0.0

    def to_dict(self) -> dict[str, object]:
        dislike_evidence = [
            item for item in self.contributions if item.get("direction") == "dislike"
        ]
        keep_evidence = [item for item in self.contributions if item.get("direction") == "keep"]
        return {
            "probability": round(self.probability, 4),
            "score": round(self.score, 4),
            "feature_score": round(self.feature_score, 4),
            "contributions": list(self.contributions),
            "dislike_evidence": dislike_evidence,
            "keep_evidence": keep_evidence,
            "positive_evidence_count": self.positive_evidence_count,
            "calibrated": self.calibrated,
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
            "neighbor_exact_max_similarity": round(
                self.neighbor_exact_max_similarity,
                4,
            ),
            "neighbor_semantic_max_similarity": round(
                self.neighbor_semantic_max_similarity,
                4,
            ),
            "neighbor_preference_gap": round(self.neighbor_preference_gap, 4),
        }


@dataclass(frozen=True)
class PreferenceNeighborPrototype:
    """One unit-normalized explicit example for content k-nearest-neighbours."""

    filename: str
    label: int
    timestamp: int
    features: tuple[tuple[str, float], ...]
    tags: tuple[str, ...] = ()
    context_features: tuple[str, ...] = ()
    semantic_tags: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class _SemanticNeighborRuntime:
    """Process-local dense data derived from persisted prototype tag text."""

    idf: dict[str, float]
    items: tuple[tuple[tuple[str, str], ...], ...]
    pooled_matrix: object
    label_indices: tuple[object, object]
    tiebreak_rank: object
    fine_sets: OrderedDict[int, object]


def preference_decision_score(
    model: PreferenceModel,
    prediction: PreferencePrediction,
) -> float:
    """Blend the validated local MaxSim vote with the global preference score."""
    if not prediction.neighbor_available or prediction.neighbor_probability is None:
        return 0.0
    return (
        DEFAULT_SEMANTIC_NEIGHBOR_VOTE_WEIGHT * prediction.neighbor_probability
        + (1.0 - DEFAULT_SEMANTIC_NEIGHBOR_VOTE_WEIGHT) * prediction.probability
    )


def preference_decision_threshold(model: PreferenceModel) -> float:
    """Return the one calibrated boundary shared by review and filtering."""
    value = model.training_summary.get("decision_threshold")
    if isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value):
        return min(1.0, max(0.0, float(value)))
    return DEFAULT_DECISION_THRESHOLD


def _has_dislike_neighbor_evidence(prediction: PreferencePrediction) -> bool:
    """Require concrete two-stage evidence before applying the boundary."""
    return (
        prediction.neighbor_available
        and prediction.neighbor_probability is not None
        and prediction.neighbor_max_similarity >= DEFAULT_NEIGHBOR_MIN_SIMILARITY
        and prediction.neighbor_dislike_count > 0
    )


def preference_candidate(
    model: PreferenceModel,
    prediction: PreferencePrediction,
) -> bool:
    """Apply the sole semantic two-stage decision policy."""
    return _has_dislike_neighbor_evidence(prediction) and (
        preference_decision_score(model, prediction) >= preference_decision_threshold(model)
    )


@dataclass
class PreferenceModel:
    """Persisted sparse logistic model with an optional content-neighbour head."""

    bias: float
    prior_log_odds: float
    tag_weights: dict[str, float]
    combo_weights: dict[str, float]
    trained_at: str
    training_summary: dict[str, object]
    combo_min_support: int
    max_combo_features: int
    context_weights: dict[str, float] = dataclass_field(default_factory=dict)
    schema_version: int = MODEL_SCHEMA_VERSION
    feature_normalization: str = DEFAULT_FEATURE_NORMALIZATION
    semantic_model: str = ""
    semantic_bias: float = 0.0
    semantic_weights: tuple[float, ...] = ()
    semantic_blend: float = 0.0
    neighbor_k: int = DEFAULT_NEIGHBOR_K
    neighbor_prototypes: tuple[PreferenceNeighborPrototype, ...] = ()
    _neighbor_feature_index: dict[str, tuple[object, object]] | None = dataclass_field(
        default=None, init=False, repr=False, compare=False
    )
    _semantic_neighbor_runtime: _SemanticNeighborRuntime | None = dataclass_field(
        default=None,
        init=False,
        repr=False,
        compare=False,
    )
    _semantic_neighbor_failed: bool = dataclass_field(
        default=False,
        init=False,
        repr=False,
        compare=False,
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

    def _neighbor_index(self) -> dict[str, tuple[object, object]]:
        """Build compact full-label postings for exact-overlap retrieval."""
        if self._neighbor_feature_index is not None:
            return self._neighbor_feature_index
        import numpy as np

        postings: dict[str, list[tuple[int, float]]] = {}
        for index, prototype in enumerate(self.neighbor_prototypes):
            for feature, value in prototype.features:
                postings.setdefault(feature, []).append((index, value))
        self._neighbor_feature_index = {
            feature: (
                np.fromiter(
                    (index for index, _ in entries),
                    dtype=np.int32,
                    count=len(entries),
                ),
                np.fromiter(
                    (value for _, value in entries),
                    dtype=np.float64,
                    count=len(entries),
                ),
            )
            for feature, entries in postings.items()
        }
        return self._neighbor_feature_index

    def _exact_neighbor_scores(
        self,
        tags: Iterable[object],
        context_features: Iterable[object] | None,
    ) -> object | None:
        """Return full-label exact cosine scores in a compact NumPy vector."""
        if not self.neighbor_head_ready:
            return None
        query = _neighbor_feature_values(tags, context_features)
        if not query:
            return None
        import numpy as np

        scores = np.zeros(len(self.neighbor_prototypes), dtype=np.float64)
        postings = self._neighbor_index()
        for feature, query_value in query:
            posting = postings.get(feature)
            if posting is None:
                continue
            prototype_indices, prototype_values = posting
            scores[prototype_indices] += query_value * prototype_values
        return scores

    def _semantic_runtime(self) -> _SemanticNeighborRuntime:
        """Build and cache prototype tag vectors for two-stage retrieval."""
        if self._semantic_neighbor_runtime is not None:
            return self._semantic_neighbor_runtime
        if self._semantic_neighbor_failed:
            raise RuntimeError("semantic neighbour runtime is unavailable")
        try:
            from .semantic import embed_pooled_tag_sets, semantic_idf, semantic_tag_text

            records = [
                tuple(prototype.semantic_tags)
                or tuple((tag, semantic_tag_text(tag)) for tag in prototype.tags)
                for prototype in self.neighbor_prototypes
            ]
            idf = semantic_idf(records)
            pooled_matrix = embed_pooled_tag_sets(
                records,
                model_name=self.semantic_model,
                idf=idf,
            )
            if len(pooled_matrix.shape) != 2 or not pooled_matrix.shape[1]:
                raise RuntimeError("semantic prototypes produced no vectors")
            import numpy as np

            labels = np.asarray(
                [prototype.label for prototype in self.neighbor_prototypes],
                dtype=np.int8,
            )
            tiebreak_order = sorted(
                range(len(self.neighbor_prototypes)),
                key=lambda index: (
                    -self.neighbor_prototypes[index].timestamp,
                    self.neighbor_prototypes[index].filename,
                ),
            )
            tiebreak_rank = np.empty(len(tiebreak_order), dtype=np.int32)
            tiebreak_rank[tiebreak_order] = np.arange(len(tiebreak_order), dtype=np.int32)
            self._semantic_neighbor_runtime = _SemanticNeighborRuntime(
                idf=idf,
                items=tuple(records),
                pooled_matrix=pooled_matrix,
                label_indices=(np.flatnonzero(labels == 0), np.flatnonzero(labels == 1)),
                tiebreak_rank=tiebreak_rank,
                fine_sets=OrderedDict(),
            )
            return self._semantic_neighbor_runtime
        except Exception:
            self._semantic_neighbor_failed = True
            raise

    def _predict_semantic_neighbors_many(
        self,
        records: Sequence[
            tuple[
                tuple[str, ...],
                dict[str, object] | None,
                tuple[str, ...],
            ]
        ],
    ) -> list[tuple[dict[str, object] | None, object | None]]:
        """Run both semantic stages and return each reusable pooled query vector."""
        if not records or not self.semantic_enabled or not self.neighbor_head_ready:
            return [(None, None)] * len(records)
        try:
            from .semantic import embed_tag_sets, semantic_items_with_context, semantic_tag_items

            runtime = self._semantic_runtime()
            query_items = [semantic_tag_items(tags, metadata) for tags, metadata, _ in records]
            dense_items = [
                semantic_items_with_context(semantic_tag_items(tags), context)
                for tags, _, context in records
            ]
            embedded_sets = embed_tag_sets(
                [*query_items, *dense_items],
                model_name=self.semantic_model,
                idf=runtime.idf,
            )
            query_sets = embedded_sets[: len(query_items)]
            dense_sets = embedded_sets[len(query_items) :]
            prototype_rows = runtime.pooled_matrix
            import numpy as np

            dimension = int(prototype_rows.shape[1])
            query_matrix = np.asarray(
                [
                    query_set.pooled
                    if len(query_set.pooled) == dimension
                    else np.zeros(dimension, dtype=np.float32)
                    for query_set in query_sets
                ],
                dtype=np.float32,
            )
            coarse_scores = query_matrix @ prototype_rows.T
            return [
                (
                    self._fine_semantic_neighbor_vote(
                        query_set,
                        context,
                        self._exact_neighbor_scores(tags, context),
                        coarse_scores[index],
                        runtime,
                    ),
                    dense_set.pooled,
                )
                for index, ((tags, _, context), query_set, dense_set) in enumerate(
                    zip(records, query_sets, dense_sets, strict=True)
                )
            ]
        except Exception:
            self._semantic_neighbor_failed = True
            return [(None, None)] * len(records)

    def _fine_semantic_neighbor_vote(
        self,
        query_set: object,
        query_context: tuple[str, ...],
        exact_scores: object | None,
        coarse_scores: object,
        runtime: _SemanticNeighborRuntime,
    ) -> dict[str, object] | None:
        """Fuse exact overlap, tag MaxSim, and context for class-balanced voting."""
        import numpy as np

        from .semantic import (
            SEMANTIC_COARSE_PER_CLASS,
            SEMANTIC_CONTEXT_WEIGHT,
            SEMANTIC_EXACT_PER_CLASS,
            SEMANTIC_EXACT_WEIGHT,
            SEMANTIC_FINE_CACHE_SIZE,
            SEMANTIC_FINE_PER_CLASS,
            SEMANTIC_TAG_WEIGHT,
            embed_tag_sets,
            tag_maxsim,
            weighted_tag_jaccard,
        )

        semantic_values = np.asarray(coarse_scores, dtype=np.float32)
        exact_values = (
            np.asarray(exact_scores, dtype=np.float64) if exact_scores is not None else None
        )
        candidate_indices: set[int] = set()
        for label in (0, 1):
            label_indices = runtime.label_indices[label]
            positive_indices = label_indices[semantic_values[label_indices] > 0]
            if len(positive_indices) > SEMANTIC_COARSE_PER_CLASS:
                local_scores = semantic_values[positive_indices]
                top_positions = np.argpartition(
                    local_scores,
                    -SEMANTIC_COARSE_PER_CLASS,
                )[-SEMANTIC_COARSE_PER_CLASS:]
                positive_indices = positive_indices[top_positions]
            semantic_rank = sorted(
                (int(index) for index in positive_indices),
                key=lambda index: (
                    -float(semantic_values[index]),
                    -self.neighbor_prototypes[index].timestamp,
                    self.neighbor_prototypes[index].filename,
                ),
            )[:SEMANTIC_COARSE_PER_CLASS]
            exact_rank: list[int] = []
            if exact_values is not None:
                positive_exact = label_indices[exact_values[label_indices] > 0]
                exact_rank = self._top_exact_neighbors(
                    exact_values,
                    positive_exact,
                    runtime.tiebreak_rank,
                    SEMANTIC_EXACT_PER_CLASS,
                )
            candidate_indices.update(semantic_rank)
            candidate_indices.update(exact_rank)

        ordered_indices = sorted(candidate_indices)
        missing_indices = [index for index in ordered_indices if index not in runtime.fine_sets]
        if missing_indices:
            missing_sets = embed_tag_sets(
                [runtime.items[index] for index in missing_indices],
                model_name=self.semantic_model,
                idf=runtime.idf,
            )
            for index, tag_set in zip(missing_indices, missing_sets, strict=True):
                runtime.fine_sets[index] = tag_set
        for index in ordered_indices:
            runtime.fine_sets.move_to_end(index)
        while len(runtime.fine_sets) > SEMANTIC_FINE_CACHE_SIZE:
            runtime.fine_sets.popitem(last=False)
        tag_sets_by_index = {index: runtime.fine_sets[index] for index in ordered_indices}
        fine: list[dict[str, object]] = []
        for index in ordered_indices:
            prototype = self.neighbor_prototypes[index]
            prototype_set = tag_sets_by_index[index]
            semantic_score, matches = tag_maxsim(query_set, prototype_set, runtime.idf)
            exact_score = weighted_tag_jaccard(
                query_set.items,
                prototype_set.items,
                runtime.idf,
            )
            context_score = _semantic_context_similarity(
                query_context,
                prototype.context_features,
            )
            similarity = (
                SEMANTIC_EXACT_WEIGHT * exact_score
                + SEMANTIC_TAG_WEIGHT * semantic_score
                + SEMANTIC_CONTEXT_WEIGHT * context_score
            )
            if similarity <= 0.12:
                continue
            fine.append(
                {
                    "prototype": prototype,
                    "similarity": min(1.0, similarity),
                    "exact_similarity": exact_score,
                    "semantic_similarity": semantic_score,
                    "context_similarity": context_score,
                    "matches": matches,
                }
            )

        selected_by_label: dict[int, list[dict[str, object]]] = {}
        for label in (0, 1):
            selected_by_label[label] = sorted(
                (item for item in fine if item["prototype"].label == label),
                key=lambda item: (
                    -float(item["similarity"]),
                    -item["prototype"].timestamp,
                    item["prototype"].filename,
                ),
            )[:SEMANTIC_FINE_PER_CLASS]
        dislike_neighbors = selected_by_label[1]
        keep_neighbors = selected_by_label[0]
        if not dislike_neighbors and not keep_neighbors:
            return None

        def evidence_mass(items: list[dict[str, object]]) -> float:
            if not items:
                return 0.0
            return sum(max(0.0, float(item["similarity"]) - 0.12) ** 2 for item in items) / len(
                items
            )

        dislike_mass = evidence_mass(dislike_neighbors)
        keep_mass = evidence_mass(keep_neighbors)
        mass_total = dislike_mass + keep_mass
        if mass_total <= 0:
            return None

        def evidence(item: dict[str, object] | None) -> dict[str, object] | None:
            if item is None:
                return None
            prototype = item["prototype"]
            return {
                "filename": prototype.filename,
                "label": "dislike" if prototype.label else "keep",
                "similarity": round(float(item["similarity"]), 4),
                "exact_similarity": round(float(item["exact_similarity"]), 4),
                "semantic_similarity": round(float(item["semantic_similarity"]), 4),
                "context_similarity": round(float(item["context_similarity"]), 4),
                "tag_matches": [
                    {
                        "query": left,
                        "prototype": right,
                        "similarity": round(score, 4),
                    }
                    for left, right, score in item["matches"]
                ],
            }

        combined = dislike_neighbors + keep_neighbors
        max_similarity = max(float(item["similarity"]) for item in combined)
        exact_max = max(float(item["exact_similarity"]) for item in combined)
        semantic_max = max(float(item["semantic_similarity"]) for item in combined)
        dislike_best = float(dislike_neighbors[0]["similarity"]) if dislike_neighbors else 0.0
        keep_best = float(keep_neighbors[0]["similarity"]) if keep_neighbors else 0.0
        return {
            "probability": dislike_mass / mass_total,
            "count": len(combined),
            "dislike_count": len(dislike_neighbors),
            "keep_count": len(keep_neighbors),
            "similarity_sum": sum(float(item["similarity"]) for item in combined),
            "max_similarity": max_similarity,
            "nearest_dislike": evidence(dislike_neighbors[0] if dislike_neighbors else None),
            "nearest_keep": evidence(keep_neighbors[0] if keep_neighbors else None),
            "exact_max_similarity": exact_max,
            "semantic_max_similarity": semantic_max,
            "preference_gap": dislike_best - keep_best,
        }

    def _top_exact_neighbors(
        self,
        scores: object,
        positive_indices: object,
        tiebreak_rank: object,
        limit: int,
    ) -> list[int]:
        """Select an exact Top-K in linear time while preserving stable ties."""
        import numpy as np

        indices = np.asarray(positive_indices, dtype=np.int32)
        values = np.asarray(scores, dtype=np.float64)
        ranks = np.asarray(tiebreak_rank, dtype=np.int32)
        if len(indices) > limit:
            local_values = values[indices]
            boundary = np.partition(local_values, len(local_values) - limit)[
                len(local_values) - limit
            ]
            higher = indices[local_values > boundary]
            tied = indices[local_values == boundary]
            needed = limit - len(higher)
            if len(tied) > needed:
                tied_positions = np.argpartition(ranks[tied], needed - 1)[:needed]
                tied = tied[tied_positions]
            indices = np.concatenate((higher, tied))
        return sorted(
            (int(index) for index in indices),
            key=lambda index: (
                -float(values[index]),
                int(ranks[index]),
            ),
        )[:limit]

    def predict(
        self,
        tags: Iterable[object],
        *,
        metadata: dict[str, object] | None = None,
        context_features: Iterable[object] | None = None,
        top_n: int = 8,
        _semantic_embedding: Iterable[float] | None = None,
        _neighbor_prediction: dict[str, object] | None = None,
    ) -> PreferencePrediction:
        """Return a local dislike margin and feature-level explanation."""
        normalized = _model_tags(tags)
        normalized_context = (
            _normalize_context_features(context_features)
            if context_features is not None
            else _model_context_features(metadata)
        )
        neighbor = _neighbor_prediction
        semantic_embedding = _semantic_embedding
        if neighbor is None and self.semantic_enabled:
            neighbor, pooled = self._predict_semantic_neighbors_many(
                [(normalized, metadata, normalized_context)]
            )[0]
            if semantic_embedding is None:
                semantic_embedding = pooled
        neighbor = neighbor or {}
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
        if self.semantic_enabled and semantic_embedding is not None:
            try:
                from .semantic import score_embedding
                from .semantic import semantic_probability as _probability

                semantic_score = score_embedding(
                    _semantic_head(self),
                    semantic_embedding,
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
                # A semantic runtime failure must fail open; the old exact-only
                # classifier is deliberately no longer an action fallback.
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
        return PreferencePrediction(
            probability=_sigmoid(score),
            score=score,
            feature_score=feature_score,
            contributions=explanation,
            positive_evidence_count=sparse_positive_evidence_count,
            calibrated=(
                isinstance(self.training_summary.get("decision_calibration"), dict)
                and self.training_summary["decision_calibration"].get("available") is True
            ),
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
            neighbor_exact_max_similarity=float(neighbor.get("exact_max_similarity", 0.0)),
            neighbor_semantic_max_similarity=float(neighbor.get("semantic_max_similarity", 0.0)),
            neighbor_preference_gap=float(neighbor.get("preference_gap", 0.0)),
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
        neighbor_records = [
            (
                tags,
                metadata,
                (
                    _normalize_context_features(context)
                    if context is not None
                    else _model_context_features(metadata)
                ),
            )
            for tags, metadata, context in materialized
        ]
        semantic_results = self._predict_semantic_neighbors_many(neighbor_records)
        return tuple(
            self.predict(
                tags,
                metadata=metadata,
                context_features=context,
                top_n=top_n,
                _semantic_embedding=embedding,
                _neighbor_prediction=neighbor,
            )
            for (tags, metadata, context), (neighbor, embedding) in zip(
                materialized,
                semantic_results,
                strict=True,
            )
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "trained_at": self.trained_at,
            "bias": self.bias,
            "prior_log_odds": self.prior_log_odds,
            "tag_weights": self.tag_weights,
            "combo_weights": self.combo_weights,
            "context_weights": self.context_weights,
            "combo_min_support": self.combo_min_support,
            "max_combo_features": self.max_combo_features,
            "feature_normalization": self.feature_normalization,
            "training_summary": self.training_summary,
            "semantic_head": (
                {
                    "model_name": self.semantic_model,
                    "bias": self.semantic_bias,
                    "weights": list(self.semantic_weights),
                    "blend": self.semantic_blend,
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
                        "tags": list(prototype.tags),
                        "context_features": list(prototype.context_features),
                        "semantic_tags": [list(item) for item in prototype.semantic_tags],
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
            CONTENT_NEIGHBOR_MODEL_SCHEMA_VERSION,
            TAG_SEMANTIC_MODEL_SCHEMA_VERSION,
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
        if not isinstance(summary, dict):
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
            or neighbor_version
            not in {LEGACY_NEIGHBOR_HEAD_SCHEMA_VERSION, NEIGHBOR_HEAD_SCHEMA_VERSION}
        ):
            raise ValueError("Invalid preference model neighbor head version")
        neighbor_k = neighbor_raw.get("k", DEFAULT_NEIGHBOR_K)
        if (
            isinstance(neighbor_k, bool)
            or not isinstance(neighbor_k, int)
            or not 1 <= neighbor_k <= 512
        ):
            raise ValueError("Invalid preference model neighbor k")
        raw_prototypes = neighbor_raw.get("prototypes", [])
        if not isinstance(raw_prototypes, list | tuple):
            raise ValueError("Invalid preference model neighbor prototypes")
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
                raw_tags = raw_prototype.get("tags", ())
                raw_context = raw_prototype.get("context_features", ())
                raw_semantic_tags = raw_prototype.get("semantic_tags", ())
                if not isinstance(raw_tags, list | tuple) or not isinstance(
                    raw_context, list | tuple
                ):
                    raise ValueError("Invalid preference model neighbor metadata")
                if not isinstance(raw_semantic_tags, list | tuple):
                    raise ValueError("Invalid preference model semantic tags")
                tags = _model_tags(raw_tags)
                context_features = _normalize_context_features(raw_context)
                if neighbor_version == LEGACY_NEIGHBOR_HEAD_SCHEMA_VERSION:
                    tags = tuple(
                        feature.removeprefix("tag:")
                        for feature, _ in features
                        if feature.startswith("tag:")
                    )
                    context_features = tuple(
                        feature.removeprefix("context:")
                        for feature, _ in features
                        if feature.startswith("context:")
                    )
                semantic_tags: list[tuple[str, str]] = []
                for raw_item in raw_semantic_tags:
                    if not isinstance(raw_item, list | tuple) or len(raw_item) != 2:
                        raise ValueError("Invalid preference model semantic tag")
                    key = normalize_tag(raw_item[0])
                    text = str(raw_item[1]).strip()
                    if key and text:
                        semantic_tags.append((key, text))
                if not semantic_tags:
                    semantic_tags = [(tag, tag) for tag in tags]
                neighbor_prototypes.append(
                    PreferenceNeighborPrototype(
                        filename=filename,
                        label=int(label),
                        timestamp=timestamp,
                        features=tuple(features),
                        tags=tags,
                        context_features=context_features,
                        semantic_tags=tuple(semantic_tags),
                    )
                )
        return cls(
            bias=float(raw["bias"]),
            prior_log_odds=float(raw["prior_log_odds"]),
            tag_weights=weights("tag_weights"),
            combo_weights=weights("combo_weights"),
            context_weights=weights("context_weights"),
            trained_at=str(raw.get("trained_at", "")),
            training_summary=summary,
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


def _semantic_context_similarity(
    left: Iterable[object] | None,
    right: Iterable[object] | None,
) -> float:
    """Return a bounded weak similarity for category, palette, and purity."""
    grouped: list[dict[str, list[str]]] = []
    for values in (left, right):
        fields: dict[str, list[str]] = {}
        for token in _normalize_context_features(values):
            field, _, value = token.partition(":")
            fields.setdefault(field, []).append(value)
        grouped.append(fields)
    left_fields, right_fields = grouped
    weighted = total = 0.0
    for field, weight in (("category", 0.50), ("color", 0.35), ("purity", 0.15)):
        left_values = left_fields.get(field, ())
        right_values = right_fields.get(field, ())
        if not left_values or not right_values:
            continue
        if field == "color":
            score = _palette_similarity(left_values, right_values)
        else:
            score = 1.0 if set(left_values) & set(right_values) else 0.0
        weighted += weight * score
        total += weight
    return weighted / total if total else 0.0


def _palette_similarity(left: Sequence[str], right: Sequence[str]) -> float:
    """Compare two small Wallhaven hex palettes with symmetric nearest colours."""

    def rgb(value: str) -> tuple[int, int, int] | None:
        clean = value.removeprefix("#")
        if len(clean) != 6:
            return None
        try:
            return tuple(int(clean[index : index + 2], 16) for index in (0, 2, 4))  # type: ignore[return-value]
        except ValueError:
            return None

    left_rgb = tuple(color for value in left if (color := rgb(value)) is not None)
    right_rgb = tuple(color for value in right if (color := rgb(value)) is not None)
    if not left_rgb or not right_rgb:
        return 0.0
    maximum = math.sqrt(3 * 255**2)

    def directional(first: Sequence[tuple[int, int, int]], second: Sequence[tuple[int, int, int]]):
        return sum(
            1.0
            - min(
                math.sqrt(sum((channel_a - channel_b) ** 2 for channel_a, channel_b in zip(a, b)))
                / maximum
                for b in second
            )
            for a in first
        ) / len(first)

    return (directional(left_rgb, right_rgb) + directional(right_rgb, left_rgb)) / 2


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


def select_preference_examples(
    examples: Iterable[PreferenceExample],
    *,
    limit: int = DEFAULT_TRAINING_MAX_EXAMPLES,
    explicit_only: bool = False,
) -> tuple[PreferenceExample, ...]:
    """Select a recent class-balanced fitting set in O(n log limit) time."""
    if limit < 2:
        return ()
    candidates = [
        example
        for example in examples
        if not explicit_only
        or example.is_explicit_ban
        or example.is_explicit_keep
        or example.is_favorite
    ]

    def recency_key(example: PreferenceExample) -> tuple[int, str, int]:
        return example.timestamp, example.filename, example.label

    per_class = limit // 2
    grouped = {
        label: heapq.nlargest(
            per_class,
            (example for example in candidates if example.label == label),
            key=recency_key,
        )
        for label in (0, 1)
    }
    if not grouped[0] or not grouped[1]:
        return ()
    selected = [*grouped[0], *grouped[1]]
    selected_ids = {id(example) for example in selected}
    remainder = heapq.nlargest(
        max(0, limit - len(selected)),
        (example for example in candidates if id(example) not in selected_ids),
        key=recency_key,
    )
    selected.extend(remainder)
    return tuple(sorted(selected, key=recency_key))


def build_neighbor_prototypes(
    examples: Iterable[PreferenceExample],
) -> tuple[PreferenceNeighborPrototype, ...]:
    """Build one semantic KNN prototype for every explicit Keep/Dislike label."""
    selected = sorted(
        (
            example
            for example in examples
            if example.is_explicit_ban or example.is_explicit_keep or example.is_favorite
        ),
        key=lambda example: (example.timestamp, example.filename, example.label),
    )
    if not selected:
        return ()

    prototypes: list[PreferenceNeighborPrototype] = []
    for example in selected:
        features = _neighbor_feature_values(example.tags, example.context_features)
        if features:
            prototypes.append(
                PreferenceNeighborPrototype(
                    filename=example.filename,
                    label=example.label,
                    timestamp=example.timestamp,
                    features=features,
                    tags=_model_tags(example.tags),
                    context_features=_normalize_context_features(example.context_features),
                    semantic_tags=(
                        example.semantic_tags
                        or tuple((tag, tag) for tag in _model_tags(example.tags))
                    ),
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
