"""Optional metadata-only semantic preference head.

The sparse FTRL model is deliberately kept as the primary, explainable model.
This module adds a small text-embedding head trained from explicit metadata
feedback.  It never opens an image or a thumbnail: only Wallhaven tags and the
low-cardinality category field are sent to the local embedding runtime.

``fastembed`` is an optional dependency.  A missing runtime (or a failed model
download) simply disables this head and leaves the sparse model usable.
"""

from __future__ import annotations

import hashlib
import math
import os
import sqlite3
import struct
import threading
from collections import OrderedDict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

from .model import PreferenceExample, _model_tags, _normalize_context_features, _sigmoid

DEFAULT_SEMANTIC_MODEL = "BAAI/bge-small-en-v1.5"
DEFAULT_SEMANTIC_BLEND = 0.65
DEFAULT_SEMANTIC_RANK_WEIGHT = 0.65
SEMANTIC_MIN_EXAMPLES = 20
SEMANTIC_DIMENSION = 384
SEMANTIC_EPOCHS = 160
SEMANTIC_CACHE_SIZE = 8192
SEMANTIC_MAX_BATCH_TEXTS = 256
SEMANTIC_MAX_TAGS = 32


class SemanticUnavailable(RuntimeError):
    """Raised when the optional local embedding runtime cannot be loaded."""


@dataclass(frozen=True)
class SemanticHead:
    """A persisted dense logistic head over a fixed text embedding model."""

    model_name: str
    bias: float
    weights: tuple[float, ...]
    blend: float = DEFAULT_SEMANTIC_BLEND
    rank_weight: float = DEFAULT_SEMANTIC_RANK_WEIGHT
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
            "rank_weight": round(self.rank_weight, 6),
            "examples": self.examples,
            "positives": self.positives,
            "negatives": self.negatives,
        }


_embedder: object | None = None
_embedder_name: str | None = None
_embedder_error: str | None = None
_embedder_lock = threading.Lock()
_embedding_cache: OrderedDict[tuple[str, str], tuple[float, ...]] = OrderedDict()
_embedding_cache_lock = threading.Lock()


def semantic_cache_dir() -> Path:
    """Return a user cache path without putting model files in the project."""
    configured = os.environ.get("WAYPER_SEMANTIC_CACHE", "").strip()
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".cache" / "wayper" / "semantic"


def semantic_text(
    tags: Iterable[object] | None,
    context_features: Iterable[object] | None = None,
) -> str:
    """Build a deterministic text-only representation of wallpaper metadata."""
    normalized_tags = _model_tags(tags)[:SEMANTIC_MAX_TAGS]
    context = _normalize_context_features(context_features)
    category = next(
        (token.partition(":")[2] for token in context if token.startswith("category:")),
        "",
    )
    tag_text = ", ".join(normalized_tags)
    if category:
        return f"wallpaper category: {category}; tags: {tag_text}"
    return f"wallpaper tags: {tag_text}"


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


def _normalize_rows(values: object) -> list[tuple[float, ...]]:
    """Convert an embedding batch to deterministic unit vectors."""
    try:
        import numpy as np

        array = np.asarray(values, dtype=np.float32)
        if array.ndim != 2 or not array.shape[0]:
            return []
        norms = np.linalg.norm(array, axis=1, keepdims=True)
        norms[norms == 0] = 1
        array = array / norms
        return [tuple(float(item) for item in row) for row in array]
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
) -> dict[str, tuple[float, ...]]:
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
        result: dict[str, tuple[float, ...]] = {}
        for key, blob in rows:
            values = struct.unpack(f"{len(blob) // 4}f", blob)
            result[keys[str(key)]] = tuple(float(value) for value in values)
        return result
    except (OSError, sqlite3.Error, struct.error, ValueError):
        return {}


def _save_disk_embeddings(
    model_name: str,
    values: Sequence[tuple[str, tuple[float, ...]]],
) -> None:
    if not values:
        return
    try:
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
                        struct.pack(f"{len(vector)}f", *vector),
                    )
                    for text, vector in values
                ],
            )
    except (OSError, sqlite3.Error, struct.error, ValueError):
        return


def embed_texts(
    texts: Sequence[str],
    *,
    model_name: str = DEFAULT_SEMANTIC_MODEL,
    batch_size: int = 64,
) -> list[tuple[float, ...]]:
    """Embed text in batches with process-local and persistent caches."""
    if not texts:
        return []
    result: list[tuple[float, ...] | None] = [None] * len(texts)
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
        embedded: list[tuple[float, ...]] = []
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
    return [vector if vector is not None else () for vector in result]


def embed_metadata(
    records: Sequence[tuple[Iterable[object], Iterable[object] | None]],
    *,
    model_name: str,
) -> list[tuple[float, ...]]:
    """Embed ``(tags, context_features)`` records without touching image files."""
    return embed_texts(
        [semantic_text(tags, context) for tags, context in records],
        model_name=model_name,
    )


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
    """Fit from explicit Ban/Keep/Favorite metadata, or return ``None``.

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
    records = [(example.tags, example.context_features) for example in explicit]
    vectors = embed_metadata(records, model_name=model_name)
    if not vectors or not vectors[0]:
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
    values = tuple(float(value) for value in embedding)
    if len(values) != head.dimension:
        return 0.0
    return head.bias + sum(coefficient * value for coefficient, value in zip(head.weights, values))


def score_metadata(
    head: SemanticHead,
    tags: Iterable[object],
    context_features: Iterable[object] | None = None,
) -> float:
    """Embed and score one metadata record."""
    embedding = embed_metadata([(tags, context_features)], model_name=head.model_name)[0]
    return score_embedding(head, embedding)


def semantic_probability(score: float) -> float:
    return _sigmoid(score)


def clear_semantic_runtime_cache() -> None:
    """Clear test/runtime caches after a model or cache-directory change."""
    global _embedder, _embedder_name, _embedder_error
    with _embedder_lock:
        _embedder = None
        _embedder_name = None
        _embedder_error = None
    with _embedding_cache_lock:
        _embedding_cache.clear()
