"""Metadata-only embeddings for the two-stage preference model.

Only Wallhaven tag text is embedded. Image pixels and thumbnails are never
opened. The exact/global feature head remains explainable, but no action is
taken when the semantic runtime is unavailable.
"""

from __future__ import annotations

import hashlib
import math
import os
import sqlite3
import threading
from collections import OrderedDict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

from .model import PreferenceExample, _model_tags, _sigmoid

DEFAULT_SEMANTIC_MODEL = "BAAI/bge-small-en-v1.5"
DEFAULT_SEMANTIC_BLEND = 0.65
SEMANTIC_MIN_EXAMPLES = 20
SEMANTIC_DIMENSION = 384
SEMANTIC_EPOCHS = 160
SEMANTIC_CACHE_SIZE = 8192
SEMANTIC_MAX_BATCH_TEXTS = 256
SEMANTIC_MAX_BATCH_RECORDS = 256
SEMANTIC_MAX_TAGS = 32
SEMANTIC_COARSE_PER_CLASS = 48
SEMANTIC_EXACT_PER_CLASS = 32
SEMANTIC_FINE_PER_CLASS = 16
SEMANTIC_SIMILARITY_FLOOR = 0.65
SEMANTIC_EXACT_WEIGHT = 0.45
SEMANTIC_TAG_WEIGHT = 0.45
SEMANTIC_CONTEXT_WEIGHT = 0.10


class SemanticUnavailable(RuntimeError):
    """Raised when the optional local embedding runtime cannot be loaded."""


@dataclass(frozen=True)
class SemanticHead:
    """A persisted dense logistic head over a fixed text embedding model."""

    model_name: str
    bias: float
    weights: tuple[float, ...]
    blend: float = DEFAULT_SEMANTIC_BLEND
    examples: int = 0
    positives: int = 0
    negatives: int = 0

    @property
    def dimension(self) -> int:
        return len(self.weights)

    def to_dict(self) -> dict[str, object]:
        return {
            "model_name": self.model_name,
            "bias": round(self.bias, 8),
            "weights": [round(value, 8) for value in self.weights],
            "blend": round(self.blend, 6),
            "examples": self.examples,
            "positives": self.positives,
            "negatives": self.negatives,
        }


@dataclass(frozen=True)
class SemanticTagSet:
    """One wallpaper represented by individual tag vectors and their centroid."""

    items: tuple[tuple[str, str], ...]
    matrix: object
    pooled: object


def semantic_tag_text(name: object, detail: object = None) -> str:
    """Build a short, stable embedding prompt for one Wallhaven tag."""
    clean_name = " ".join(str(name).strip().split())
    if not clean_name:
        return ""
    parts = [clean_name]
    if isinstance(detail, dict):
        alias = " ".join(str(detail.get("alias", "")).strip().split())[:240]
        category = " ".join(str(detail.get("category", "")).strip().split())[:120]
        if alias and normalize_text(alias) != normalize_text(clean_name):
            parts.append(f"aliases: {alias}")
        if category:
            parts.append(f"category: {category}")
    return "; ".join(parts)


def normalize_text(value: object) -> str:
    """Normalize display text only for equality checks in embedding prompts."""
    return " ".join(str(value).strip().casefold().split())


def semantic_tag_items(
    tags: Iterable[object] | None,
    metadata: dict[str, object] | None = None,
) -> tuple[tuple[str, str], ...]:
    """Return ``(normalized tag, embedding text)`` pairs for one wallpaper."""
    override = metadata.get("_semantic_tag_items") if isinstance(metadata, dict) else None
    if isinstance(override, list | tuple):
        items: list[tuple[str, str]] = []
        seen: set[str] = set()
        for raw in override:
            if not isinstance(raw, list | tuple) or len(raw) != 2:
                continue
            key = normalize_text(raw[0])
            text = " ".join(str(raw[1]).strip().split())
            if key and text and key not in seen:
                seen.add(key)
                items.append((key, text))
            if len(items) >= SEMANTIC_MAX_TAGS:
                break
        if items:
            return tuple(items)
    normalized_tags = _model_tags(tags)[:SEMANTIC_MAX_TAGS]
    details_by_name: dict[str, dict[str, object]] = {}
    raw_details = metadata.get("tag_details", ()) if isinstance(metadata, dict) else ()
    if isinstance(raw_details, list | tuple):
        for raw in raw_details:
            if not isinstance(raw, dict):
                continue
            key = normalize_text(raw.get("name", ""))
            if key:
                details_by_name[key] = raw
    return tuple(
        (
            tag,
            semantic_tag_text(tag, details_by_name.get(normalize_text(tag))),
        )
        for tag in normalized_tags
    )


def semantic_items_with_context(
    items: Sequence[tuple[str, str]],
    context_features: Iterable[object] | None,
) -> tuple[tuple[str, str], ...]:
    """Add the low-cardinality category only to the global dense head."""
    category = next(
        (
            str(token).partition(":")[2]
            for token in (context_features or ())
            if str(token).startswith("category:")
        ),
        "",
    )
    if not category:
        return tuple(items)
    return (*items, (f"__category__:{category}", f"Wallpaper category: {category}."))


_embedder: object | None = None
_embedder_name: str | None = None
_embedder_error: str | None = None
_embedder_lock = threading.Lock()
_embedding_cache: OrderedDict[tuple[str, str], object] = OrderedDict()
_embedding_cache_lock = threading.Lock()


def semantic_cache_dir() -> Path:
    """Return a user cache path without putting model files in the project."""
    configured = os.environ.get("WAYPER_SEMANTIC_CACHE", "").strip()
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".cache" / "wayper" / "semantic"


def _load_embedder(model_name: str) -> object:
    global _embedder, _embedder_name, _embedder_error
    with _embedder_lock:
        if _embedder is not None and _embedder_name == model_name:
            return _embedder
        if _embedder_error is not None and _embedder_name == model_name:
            raise SemanticUnavailable(_embedder_error)
        try:
            from fastembed import TextEmbedding

            _embedder = TextEmbedding(
                model_name=model_name,
                cache_dir=str(semantic_cache_dir()),
                threads=max(1, min(4, os.cpu_count() or 1)),
            )
        except Exception as exc:  # pragma: no cover - depends on local optional runtime
            _embedder = None
            _embedder_name = model_name
            _embedder_error = f"{type(exc).__name__}: {exc}"
            raise SemanticUnavailable(_embedder_error) from exc
        _embedder_name = model_name
        _embedder_error = None
        return _embedder


def _normalize_rows(values: object) -> list[object]:
    """Convert a batch to compact float32 unit vectors."""
    try:
        import numpy as np

        array = np.asarray(values, dtype=np.float32)
        if array.ndim != 2 or not array.shape[0]:
            return []
        norms = np.linalg.norm(array, axis=1, keepdims=True)
        norms[norms == 0] = 1
        array = array / norms
        return [row.copy() for row in array]
    except ImportError as exc:  # pragma: no cover - fastembed itself requires numpy
        raise SemanticUnavailable("numpy is required by fastembed") from exc


def _disk_cache_path() -> Path:
    return semantic_cache_dir() / "embeddings.sqlite3"


def _disk_cache_key(model_name: str, text: str) -> str:
    return hashlib.blake2b(
        f"{model_name}\x00{text}".encode(),
        digest_size=16,
    ).hexdigest()


def _load_disk_embeddings(
    model_name: str,
    texts: Sequence[str],
) -> dict[str, object]:
    """Read persisted vectors; cache failures must never block ranking."""
    if not texts:
        return {}
    try:
        path = _disk_cache_path()
        if not path.exists():
            return {}
        keys = {_disk_cache_key(model_name, text): text for text in texts}
        rows: list[tuple[str, bytes]] = []
        key_values = tuple(keys)
        with sqlite3.connect(path, timeout=2.0) as connection:
            for start in range(0, len(key_values), 500):
                chunk = key_values[start : start + 500]
                rows.extend(
                    connection.execute(
                        "SELECT cache_key, vector FROM embeddings WHERE model_name = ? "
                        "AND cache_key IN ({})".format(",".join("?" * len(chunk))),
                        (model_name, *chunk),
                    ).fetchall()
                )
        import numpy as np

        result: dict[str, object] = {}
        for key, blob in rows:
            if len(blob) % 4:
                continue
            result[keys[str(key)]] = np.frombuffer(blob, dtype="<f4").copy()
        return result
    except (OSError, sqlite3.Error, ValueError):
        return {}


def _save_disk_embeddings(
    model_name: str,
    values: Sequence[tuple[str, object]],
) -> None:
    if not values:
        return
    try:
        import numpy as np

        path = _disk_cache_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path, timeout=5.0) as connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS embeddings ("
                "model_name TEXT NOT NULL, cache_key TEXT NOT NULL, "
                "vector BLOB NOT NULL, PRIMARY KEY (model_name, cache_key))"
            )
            connection.executemany(
                "INSERT OR REPLACE INTO embeddings(model_name, cache_key, vector) VALUES (?, ?, ?)",
                [
                    (
                        model_name,
                        _disk_cache_key(model_name, text),
                        np.asarray(vector, dtype="<f4").tobytes(),
                    )
                    for text, vector in values
                ],
            )
    except (OSError, sqlite3.Error, ValueError):
        return


def embed_texts(
    texts: Sequence[str],
    *,
    model_name: str = DEFAULT_SEMANTIC_MODEL,
    batch_size: int = 64,
) -> list[object]:
    """Embed text in batches with process-local and persistent caches."""
    if not texts:
        return []
    result: list[object | None] = [None] * len(texts)
    pending: dict[str, list[int]] = {}
    with _embedding_cache_lock:
        for index, text in enumerate(texts):
            key = (model_name, text)
            cached = _embedding_cache.get(key)
            if cached is not None:
                _embedding_cache.move_to_end(key)
                result[index] = cached
            if result[index] is None:
                pending.setdefault(text, []).append(index)

    disk_values = _load_disk_embeddings(model_name, tuple(pending))
    if disk_values:
        with _embedding_cache_lock:
            for text, vector in disk_values.items():
                _embedding_cache[(model_name, text)] = vector
                _embedding_cache.move_to_end((model_name, text))
                for index in pending.pop(text, ()):
                    result[index] = vector

    missing = list(pending)
    if missing:
        embedder = _load_embedder(model_name)
        embedded: list[object] = []
        # Keep the generator's internal token matrix bounded.  A wallpaper
        # pool can contain many thousands of metadata records, while the
        # embedding runtime may otherwise retain the whole input list.
        for start in range(0, len(missing), SEMANTIC_MAX_BATCH_TEXTS):
            batch = missing[start : start + SEMANTIC_MAX_BATCH_TEXTS]
            embedded.extend(_normalize_rows(list(embedder.embed(batch, batch_size=batch_size))))
        if len(embedded) != len(missing):
            raise SemanticUnavailable("embedding runtime returned an incomplete batch")
        _save_disk_embeddings(model_name, tuple(zip(missing, embedded, strict=True)))
        with _embedding_cache_lock:
            for text, vector in zip(missing, embedded, strict=True):
                key = (model_name, text)
                _embedding_cache[key] = vector
                _embedding_cache.move_to_end(key)
                for index in pending[text]:
                    result[index] = vector
            while len(_embedding_cache) > SEMANTIC_CACHE_SIZE:
                _embedding_cache.popitem(last=False)
    if any(vector is None for vector in result):
        raise SemanticUnavailable("embedding cache returned an incomplete batch")
    return [vector for vector in result if vector is not None]


def semantic_idf(
    records: Sequence[Sequence[tuple[str, str]]],
) -> dict[str, float]:
    """Return smoothed inverse-document-frequency weights for tag keys."""
    document_count = len(records)
    if not document_count:
        return {}
    frequencies: dict[str, int] = {}
    for record in records:
        for key in {key for key, _ in record}:
            frequencies[key] = frequencies.get(key, 0) + 1
    return {
        key: min(5.0, 1.0 + math.log((document_count + 1) / (count + 1)))
        for key, count in frequencies.items()
    }


def _pooled_vector(
    items: Sequence[tuple[str, str]],
    matrix: object,
    idf: dict[str, float] | None,
) -> object:
    import numpy as np

    values = np.asarray(matrix, dtype=np.float32)
    if not items or values.ndim != 2 or len(items) != values.shape[0] or not values.shape[1]:
        return np.empty(0, dtype=np.float32)
    default_idf = max(idf.values(), default=1.0) if idf is not None else 1.0
    weights = np.asarray(
        [
            max(0.05, float(idf.get(key, default_idf))) if idf is not None else 1.0
            for key, _ in items
        ],
        dtype=np.float32,
    )
    pooled = np.average(values, axis=0, weights=weights)
    norm = float(np.linalg.norm(pooled))
    return pooled / norm if norm > 0 else np.empty(0, dtype=np.float32)


def embed_tag_sets(
    records: Sequence[Sequence[tuple[str, str]]],
    *,
    model_name: str,
    idf: dict[str, float] | None = None,
) -> list[SemanticTagSet]:
    """Embed individual tag texts once, then build one weighted centroid per image."""
    materialized = [tuple(record) for record in records]
    unique_texts = tuple(
        dict.fromkeys(text for record in materialized for _, text in record if text)
    )
    vectors = embed_texts(unique_texts, model_name=model_name)
    by_text = dict(zip(unique_texts, vectors, strict=True))
    import numpy as np

    results: list[SemanticTagSet] = []
    for record in materialized:
        clean_items = tuple((key, text) for key, text in record if text in by_text)
        matrix = np.asarray([by_text[text] for _, text in clean_items], dtype=np.float32)
        results.append(
            SemanticTagSet(
                items=clean_items,
                matrix=matrix,
                pooled=_pooled_vector(clean_items, matrix, idf),
            )
        )
    return results


def embed_pooled_tag_sets(
    records: Sequence[Sequence[tuple[str, str]]],
    *,
    model_name: str,
    idf: dict[str, float] | None = None,
) -> object:
    """Build a compact coarse-retrieval matrix without retaining per-tag vectors."""
    import numpy as np

    rows: list[object] = []
    dimension = 0
    for start in range(0, len(records), SEMANTIC_MAX_BATCH_RECORDS):
        batch = embed_tag_sets(
            records[start : start + SEMANTIC_MAX_BATCH_RECORDS],
            model_name=model_name,
            idf=idf,
        )
        if not dimension:
            dimension = next((len(tag_set.pooled) for tag_set in batch if len(tag_set.pooled)), 0)
        rows.extend(
            tag_set.pooled
            if dimension and len(tag_set.pooled) == dimension
            else np.zeros(dimension, dtype=np.float32)
            for tag_set in batch
        )
    if not dimension:
        return np.empty((len(records), 0), dtype=np.float32)
    return np.asarray(rows, dtype=np.float32)


def _directional_maxsim(
    left: SemanticTagSet,
    right: SemanticTagSet,
    idf: dict[str, float],
) -> tuple[float, tuple[tuple[str, str, float], ...]]:
    if not left.items or not right.items:
        return 0.0, ()
    default_idf = max(idf.values(), default=1.0)
    import numpy as np

    similarities = left.matrix @ right.matrix.T
    best_indices = np.argmax(similarities, axis=1)
    best_scores = similarities[np.arange(len(left.items)), best_indices]
    weights = np.asarray(
        [max(0.05, idf.get(key, default_idf)) for key, _ in left.items],
        dtype=np.float32,
    )
    score = float(np.dot(weights, best_scores) / max(float(weights.sum()), 1e-12))
    matches = tuple(
        (
            left.items[index][0],
            right.items[int(best_index)][0],
            float(best_scores[index]),
        )
        for index, best_index in enumerate(best_indices)
    )
    return score, matches


def tag_maxsim(
    left: SemanticTagSet,
    right: SemanticTagSet,
    idf: dict[str, float],
    *,
    floor: float = SEMANTIC_SIMILARITY_FLOOR,
) -> tuple[float, tuple[tuple[str, str, float], ...]]:
    """Return symmetric, floor-adjusted late-interaction tag similarity."""
    forward, matches = _directional_maxsim(left, right, idf)
    reverse, _ = _directional_maxsim(right, left, idf)
    raw = (forward + reverse) / 2
    adjusted = max(0.0, min(1.0, (raw - floor) / max(1e-9, 1.0 - floor)))
    strongest = tuple(sorted(matches, key=lambda item: (-item[2], item[0], item[1]))[:4])
    return adjusted, strongest


def weighted_tag_jaccard(
    left: Sequence[tuple[str, str]],
    right: Sequence[tuple[str, str]],
    idf: dict[str, float],
) -> float:
    """Return an IDF-weighted exact-tag overlap in the 0..1 range."""
    left_keys = {key for key, _ in left}
    right_keys = {key for key, _ in right}
    union = left_keys | right_keys
    if not union:
        return 0.0
    default_idf = max(idf.values(), default=1.0)
    denominator = sum(idf.get(key, default_idf) for key in union)
    numerator = sum(idf.get(key, default_idf) for key in left_keys & right_keys)
    return numerator / max(denominator, 1e-12)


def _balanced_weights(examples: Sequence[PreferenceExample]) -> list[float]:
    totals = {
        label: sum(example.base_weight for example in examples if example.label == label)
        for label in (0, 1)
    }
    if not totals[0] or not totals[1]:
        raise SemanticUnavailable("semantic head needs both explicit feedback classes")
    target = (totals[0] + totals[1]) / 2
    return [example.base_weight * target / totals[example.label] for example in examples]


def _fit_dense_logistic(
    embeddings: object,
    labels: object,
    sample_weights: object,
    *,
    epochs: int = SEMANTIC_EPOCHS,
) -> tuple[float, tuple[float, ...]]:
    """Fit a small deterministic dense logistic head using NumPy + Adam."""
    try:
        import numpy as np
    except ImportError as exc:  # pragma: no cover - fastembed itself requires numpy
        raise SemanticUnavailable("numpy is required by the semantic head") from exc

    x = np.asarray(embeddings, dtype=np.float64)
    y = np.asarray(labels, dtype=np.float64)
    weights = np.asarray(sample_weights, dtype=np.float64)
    if x.ndim != 2 or not len(x) or len(x) != len(y) or len(y) != len(weights):
        raise SemanticUnavailable("invalid semantic training matrix")
    weight_total = float(weights.sum())
    weights = weights / max(weight_total / len(weights), 1e-12)
    dimension = int(x.shape[1])
    coefficients = np.zeros(dimension, dtype=np.float64)
    bias = 0.0
    first = np.zeros_like(coefficients)
    second = np.zeros_like(coefficients)
    first_bias = 0.0
    second_bias = 0.0
    # This regularization is intentionally strong: the semantic head should
    # generalize tag meaning, while exact learned vetoes remain in FTRL.
    regularization = 0.08
    learning_rate = 0.035
    beta1, beta2 = 0.9, 0.999
    epsilon = 1e-8
    for step in range(1, epochs + 1):
        logits = np.clip(x @ coefficients + bias, -35, 35)
        probabilities = 1.0 / (1.0 + np.exp(-logits))
        residual = (probabilities - y) * weights / max(float(len(y)), 1.0)
        gradient = x.T @ residual + regularization * coefficients
        gradient_bias = float(residual.sum())
        first = beta1 * first + (1 - beta1) * gradient
        second = beta2 * second + (1 - beta2) * gradient * gradient
        first_bias = beta1 * first_bias + (1 - beta1) * gradient_bias
        second_bias = beta2 * second_bias + (1 - beta2) * gradient_bias * gradient_bias
        correction1 = 1 - beta1**step
        correction2 = 1 - beta2**step
        coefficients -= (
            learning_rate * (first / correction1) / (np.sqrt(second / correction2) + epsilon)
        )
        bias -= (
            learning_rate
            * (first_bias / correction1)
            / (math.sqrt(second_bias / correction2) + epsilon)
        )
    return float(bias), tuple(float(value) for value in coefficients)


def fit_semantic_head(
    examples: Sequence[PreferenceExample],
    *,
    model_name: str = DEFAULT_SEMANTIC_MODEL,
) -> SemanticHead | None:
    """Fit from explicit Dislike/Keep/Favorite metadata, or return ``None``.

    Background retained files are deliberately excluded: their presence is not
    evidence that the user likes the image, and treating them as negatives made
    the old model overfit the download pool.
    """
    explicit = [
        example
        for example in examples
        if example.is_explicit_ban or example.is_explicit_keep or example.is_favorite
    ]
    if len(explicit) < SEMANTIC_MIN_EXAMPLES:
        return None
    counts = {label: sum(example.label == label for example in explicit) for label in (0, 1)}
    if min(counts.values()) < SEMANTIC_MIN_EXAMPLES // 2:
        return None
    semantic_records = [
        semantic_items_with_context(
            example.semantic_tags or semantic_tag_items(example.tags),
            example.context_features,
        )
        for example in explicit
    ]
    vectors = [
        tag_set.pooled for tag_set in embed_tag_sets(semantic_records, model_name=model_name)
    ]
    if not vectors or not len(vectors[0]):
        return None
    bias, coefficients = _fit_dense_logistic(
        vectors,
        [example.label for example in explicit],
        _balanced_weights(explicit),
    )
    return SemanticHead(
        model_name=model_name,
        bias=bias,
        weights=coefficients,
        examples=len(explicit),
        positives=counts[1],
        negatives=counts[0],
    )


def score_embedding(head: SemanticHead, embedding: Iterable[float]) -> float:
    """Return the semantic logit for one already embedded record."""
    import numpy as np

    values = np.asarray(embedding, dtype=np.float32)
    if values.ndim != 1 or len(values) != head.dimension:
        return 0.0
    return head.bias + float(np.asarray(head.weights, dtype=np.float32) @ values)


def semantic_probability(score: float) -> float:
    return _sigmoid(score)
