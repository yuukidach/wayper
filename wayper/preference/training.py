"""Deterministic fitting and evaluation for the local preference model."""

from __future__ import annotations

import hashlib
import json
import math
import random
from collections import Counter
from collections.abc import Iterable
from datetime import UTC, datetime

from .model import (
    DEFAULT_COMBO_MIN_SUPPORT,
    DEFAULT_EPOCHS,
    DEFAULT_FEATURE_NORMALIZATION,
    DEFAULT_MAX_COMBO_FEATURES,
    DEFAULT_REVIEW_THRESHOLD,
    DEFAULT_THRESHOLD,
    MIN_TRAINING_PER_CLASS,
    MIN_VALIDATION_PER_CLASS,
    MODEL_SCHEMA_VERSION,
    FeatureSpace,
    PreferenceExample,
    PreferenceModel,
    _active_feature_values,
    _context_min_support,
    _ftrl_weight,
    _model_tags,
    _normalize_context_features,
    _pair_is_eligible,
    _pair_keys,
    _sigmoid,
    _storage_feature_key,
    preference_review_decision_score,
    preference_review_has_dislike_evidence,
)

REVIEW_CALIBRATION_FRACTION = 0.20
REVIEW_TARGET_PRECISION = 0.80
REVIEW_CALIBRATION_VERSION = 2
REVIEW_CALIBRATION_OBJECTIVE = "precision_at_least_0_80"


def _attach_semantic_head(
    model: PreferenceModel,
    examples: list[PreferenceExample],
    semantic_model: str | None,
) -> tuple[str, object | None]:
    """Fit and attach the optional semantic head without making it mandatory."""
    if semantic_model is None:
        return "disabled", None
    try:
        from .semantic import fit_semantic_head

        semantic_head = fit_semantic_head(examples, model_name=semantic_model)
    except Exception as exc:  # pragma: no cover - optional runtime/environment dependent
        return f"unavailable: {type(exc).__name__}", None
    if semantic_head is None:
        return "insufficient_feedback", None
    model.semantic_model = semantic_head.model_name
    model.semantic_bias = semantic_head.bias
    model.semantic_weights = semantic_head.weights
    model.semantic_blend = semantic_head.blend
    model.semantic_rank_weight = semantic_head.rank_weight
    return "trained", semantic_head


def _review_calibration_split(
    examples: list[PreferenceExample],
) -> tuple[list[PreferenceExample], list[PreferenceExample]]:
    """Reserve the most recent 20% of each explicit class for Review calibration."""
    explicit = [
        example
        for example in examples
        if example.is_explicit_ban or example.is_explicit_keep or example.is_favorite
    ]
    grouped = {
        label: [example for example in explicit if example.label == label] for label in (0, 1)
    }
    if any(len(group) < MIN_TRAINING_PER_CLASS * 2 for group in grouped.values()):
        return [], []

    training: list[PreferenceExample] = []
    holdout: list[PreferenceExample] = []
    for label in (0, 1):
        ordered = sorted(
            grouped[label],
            key=lambda example: (example.timestamp, example.filename),
        )
        holdout_count = max(
            MIN_VALIDATION_PER_CLASS,
            round(len(ordered) * REVIEW_CALIBRATION_FRACTION),
        )
        holdout_count = min(holdout_count, len(ordered) - MIN_TRAINING_PER_CLASS)
        training.extend(ordered[:-holdout_count])
        holdout.extend(ordered[-holdout_count:])
    return training, holdout


def _calibrate_review_boundary(
    model: PreferenceModel,
    holdout: list[PreferenceExample],
) -> dict[str, object]:
    """Select a precision-weighted binary boundary from unseen decisions."""
    predictions = model.predict_many(
        [(example.tags, None, example.context_features) for example in holdout],
        top_n=12,
    )
    scored = [
        (
            preference_review_decision_score(model, prediction),
            preference_review_has_dislike_evidence(prediction),
            example.label,
        )
        for example, prediction in zip(holdout, predictions, strict=True)
    ]
    values = sorted({score for score, _, _ in scored})
    if not values:
        return {
            "version": REVIEW_CALIBRATION_VERSION,
            "available": False,
            "reason": "holdout produced no scores",
            "threshold": DEFAULT_REVIEW_THRESHOLD,
            "objective": REVIEW_CALIBRATION_OBJECTIVE,
        }

    thresholds = [
        max(values) + 1e-9,
        *((lower + upper) / 2 for lower, upper in zip(values, values[1:])),
        min(values) - 1e-9,
    ]
    positives = sum(label == 1 for _, _, label in scored)
    minimum_predictions = min(MIN_VALIDATION_PER_CLASS, positives)
    rows: list[tuple[float, float, float, int, dict[str, object]]] = []
    for boundary in thresholds:
        classified = [evidence and score >= boundary for score, evidence, _ in scored]
        true_positive = sum(
            candidate and label == 1
            for candidate, (_, _, label) in zip(classified, scored, strict=True)
        )
        false_positive = sum(
            candidate and label == 0
            for candidate, (_, _, label) in zip(classified, scored, strict=True)
        )
        true_negative = sum(
            not candidate and label == 0
            for candidate, (_, _, label) in zip(classified, scored, strict=True)
        )
        false_negative = sum(
            not candidate and label == 1
            for candidate, (_, _, label) in zip(classified, scored, strict=True)
        )
        predicted = true_positive + false_positive
        if predicted < minimum_predictions:
            continue
        precision = true_positive / predicted
        recall = true_positive / max(1, true_positive + false_negative)
        accuracy = (true_positive + true_negative) / len(scored)
        f_half = (
            1.25 * precision * recall / (0.25 * precision + recall) if precision and recall else 0.0
        )
        payload: dict[str, object] = {
            "version": REVIEW_CALIBRATION_VERSION,
            "available": True,
            "source": "stratified_recent_holdout",
            "objective": REVIEW_CALIBRATION_OBJECTIVE,
            "target_precision": REVIEW_TARGET_PRECISION,
            "threshold": round(boundary, 6),
            "examples": len(scored),
            "banned": positives,
            "retained": len(scored) - positives,
            "predicted": predicted,
            "true_positive": true_positive,
            "false_positive": false_positive,
            "precision": round(precision, 3),
            "precision_lower_bound": round(
                _wilson_lower_bound(true_positive, predicted),
                3,
            ),
            "recall": round(recall, 3),
            "accuracy": round(accuracy, 3),
            "f0_5": round(f_half, 3),
        }
        rows.append((precision, recall, accuracy, false_positive, payload))

    if not rows:
        return {
            "version": REVIEW_CALIBRATION_VERSION,
            "available": False,
            "reason": "holdout had too few positive predictions",
            "threshold": DEFAULT_REVIEW_THRESHOLD,
            "objective": REVIEW_CALIBRATION_OBJECTIVE,
        }
    precise = [row for row in rows if row[0] >= REVIEW_TARGET_PRECISION]
    if not precise:
        # Do not manufacture a review queue when held-out decisions cannot
        # support the requested precision. A later retrain can reopen the gate.
        return {
            "version": REVIEW_CALIBRATION_VERSION,
            "available": False,
            "reason": "held-out precision target was not reached",
            "threshold": round(max(values) + 1e-6, 6),
            "objective": REVIEW_CALIBRATION_OBJECTIVE,
            "target_precision": REVIEW_TARGET_PRECISION,
            "examples": len(scored),
        }
    # Among boundaries that meet the precision target, retain as much recall
    # as possible. Accuracy and fewer false positives settle exact ties.
    return max(
        precise,
        key=lambda row: (row[1], row[2], row[0], -row[3]),
    )[4]


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
        example.is_explicit_ban,
        list(example.context_features),
    ]
    if include_weight:
        values.append(round(example.base_weight, 10))
    return json.dumps(values, ensure_ascii=False, separators=(",", ":"))


def _training_example_ids(examples: Iterable[PreferenceExample]) -> list[str]:
    return sorted(
        hashlib.blake2b(
            _training_example_payload(example, include_weight=False).encode(), digest_size=8
        ).hexdigest()
        for example in examples
    )


def _training_data_signature(examples: Iterable[PreferenceExample]) -> str:
    digest = hashlib.sha256()
    payloads = sorted(
        _training_example_payload(example, include_weight=True) for example in examples
    )
    for payload in payloads:
        digest.update(payload.encode())
        digest.update(b"\n")
    return digest.hexdigest()


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
    semantic_model: str | None = None,
    label_source: str = "legacy",
) -> PreferenceModel:
    """Fit the sparse model and an optional metadata-only semantic head."""
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
            example.is_explicit_ban,
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
    validation_reason = (
        "validation disabled"
        if validation_days <= 0
        else "not enough temporally observed labelled data"
    )
    validation: dict[str, object] = {
        "available": False,
        "calibrated": False,
        "reason": validation_reason,
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
        validation.update(
            {
                "available": True,
                "holdout_days": validation_days,
                "excluded_implicit_retained": implicit_retained_excluded,
                "excluded_controls": implicit_retained_excluded,
            }
        )

    calibration_training, calibration_holdout = _review_calibration_split(examples)
    review_calibration: dict[str, object] = {
        "version": REVIEW_CALIBRATION_VERSION,
        "available": False,
        "reason": "not enough explicit Keep/Ban decisions",
        "threshold": DEFAULT_REVIEW_THRESHOLD,
        "objective": REVIEW_CALIBRATION_OBJECTIVE,
    }
    if calibration_training and calibration_holdout:
        calibration_model = _fit(
            calibration_training,
            combo_min_support=combo_min_support,
            max_combo_features=max_combo_features,
            threshold=threshold,
            epochs=epochs,
        )
        _attach_semantic_head(calibration_model, calibration_training, semantic_model)
        review_calibration = _calibrate_review_boundary(
            calibration_model,
            calibration_holdout,
        )

    model = _fit(
        examples,
        combo_min_support=combo_min_support,
        max_combo_features=max_combo_features,
        threshold=threshold,
        epochs=epochs,
    )
    semantic_status, semantic_head = _attach_semantic_head(model, examples, semantic_model)
    if semantic_head is not None:
        model.training_summary.update(
            {
                "semantic_examples": semantic_head.examples,
                "semantic_positives": semantic_head.positives,
                "semantic_negatives": semantic_head.negatives,
                "semantic_dimension": semantic_head.dimension,
            }
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
            "explicit_bans": sum(example.is_explicit_ban for example in examples),
            "controls": sum(example.is_control for example in examples),
            "semantic_model": semantic_model or "",
            "semantic_status": semantic_status,
            "label_source": label_source,
            "review_threshold": review_calibration["threshold"],
            "review_calibration": review_calibration,
        }
    )
    return model


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
        "semantic_status": "disabled",
    }
    return PreferenceModel(
        bias=bias,
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
    ordered_pairs = ordered_pairs[:max_combo_features] if max_combo_features else []
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
    alpha, beta, l1, l2 = 0.12, 1.0, 0.08, 0.15
    z: dict[str, float] = {}
    n: dict[str, float] = {}
    bias_z = bias_n = 0.0
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
            model.predict(example.tags, context_features=example.context_features).probability,
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
        "calibrated": False,
        "precision_at_threshold": round(true_positive / predicted_at_threshold, 3)
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
    observed = [example for example in examples if example.temporal_label_known]
    if not observed:
        return [], []
    cutoff = max(example.timestamp for example in observed) - validation_days * 86400
    return (
        [example for example in observed if example.timestamp < cutoff],
        [example for example in observed if example.timestamp >= cutoff],
    )


def _has_both_classes(examples: Iterable[PreferenceExample], minimum: int) -> bool:
    counts = Counter(example.label for example in examples)
    return counts[0] >= minimum and counts[1] >= minimum


def _recency_weight(timestamp: int, now: int, half_life_days: int) -> float:
    if half_life_days <= 0:
        return 1.0
    age_days = max(0, now - timestamp) / 86400
    return 0.25 + 0.75 * 0.5 ** (age_days / half_life_days)


def _metadata_timestamp(meta: dict, fallback: int) -> int:
    try:
        return int(meta.get("downloaded_at", fallback))
    except (TypeError, ValueError):
        return fallback


def _validate_training_examples(examples: Iterable[PreferenceExample]) -> None:
    if not _has_both_classes(list(examples), MIN_TRAINING_PER_CLASS):
        raise ValueError(
            f"Need at least {MIN_TRAINING_PER_CLASS} banned and retained metadata examples"
        )
