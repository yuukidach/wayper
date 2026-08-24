from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from click.testing import CliRunner

from wayper.cli import cli
from wayper.config import WayperConfig
from wayper.preference.model import preference_decision_score
from wayper.preference_model import (
    MODEL_SCHEMA_VERSION,
    PreferenceExample,
    PreferenceModel,
    PreferencePrediction,
    PreferenceTrainingSnapshot,
    _auto_retrain_lease_path,
    _batched_preference_predictions,
    _bootstrap_historical_preference_bans,
    _build_feature_space,
    _claim_or_touch_auto_retrain_worker,
    _diversify_preference_review_rank,
    _pid_is_running,
    _release_auto_retrain_worker,
    _save_automatic_preference_model,
    _save_manual_preference_model,
    _training_data_signature,
    auto_filter_prediction,
    auto_filter_status,
    build_neighbor_prototypes,
    build_training_examples,
    collect_preference_training_snapshot,
    load_preference_feedback,
    load_preference_historical_bans,
    load_preference_model,
    preference_decision_threshold,
    preference_deletion_suggestions,
    preference_learning_status,
    record_preference_feedback,
    run_scheduled_preference_model_retrain,
    save_preference_model,
    schedule_preference_model_retrain,
    select_preference_examples,
    train_local_preference_model,
    train_preference_model,
)


def _examples(
    prefix: str,
    count: int,
    tags: tuple[str, ...],
    label: int,
    *,
    start: int = 1_700_000_000,
) -> list[PreferenceExample]:
    return [
        PreferenceExample(
            filename=f"{prefix}{index}.jpg",
            tags=tags,
            label=label,
            base_weight=1.0,
            timestamp=start + index,
            is_explicit_ban=label == 1,
            is_explicit_keep=label == 0,
        )
        for index in range(count)
    ]


def _write_cold_start_library(config: WayperConfig) -> dict[str, dict[str, object]]:
    pool = config.download_dir / "sfw" / "landscape"
    pool.mkdir(parents=True)
    metadata: dict[str, dict[str, object]] = {}
    for index in range(10):
        filename = f"dislike{index}.jpg"
        metadata[filename] = {"tags": ["bad", "detail"], "downloaded_at": 1_700_000_000}
        record_preference_feedback(
            config,
            "dislike",
            filename,
            source="core",
            context="manual_dislike",
            timestamp=1_700_000_000 + index,
        )
    for index in range(10):
        filename = f"keep{index}.jpg"
        metadata[filename] = {"tags": ["good", "detail"], "downloaded_at": 1_700_001_000}
        (pool / filename).touch()
    config.metadata_file.write_text(json.dumps(metadata))
    return metadata


def _mark_semantic_model_ready(model: PreferenceModel) -> PreferenceModel:
    """Give status/scheduler tests a dependency-free current semantic head."""
    if not model.neighbor_head_ready:
        examples = [
            *_examples("status-ban", 10, ("bad", "detail"), 1),
            *_examples("status-keep", 10, ("good", "detail"), 0, start=1_700_001_000),
        ]
        model.neighbor_prototypes = build_neighbor_prototypes(examples)
    model.semantic_model = "fake-model"
    model.semantic_weights = (0.0,)
    model.training_summary["decision_threshold"] = 0.5
    model.training_summary["decision_calibration"] = {
        "available": True,
        "version": 6,
        "threshold": 0.5,
    }
    return model


class PreferenceModelTest(unittest.TestCase):
    def test_pid_probe_does_not_terminate_current_process(self) -> None:
        self.assertTrue(_pid_is_running(os.getpid()))

    def test_examples_use_live_retained_files_and_weight_recent_bans(self) -> None:
        metadata = {
            "old-ban.jpg": {"tags": ["old"]},
            "new-ban.jpg": {"tags": ["new"]},
            "retained.jpg": {"tags": ["kept"]},
            "favorite.jpg": {"tags": ["loved"]},
            "evicted.jpg": {"tags": ["stale"]},
        }
        examples = build_training_examples(
            metadata,
            [(1_000, "old-ban.jpg"), (1_900, "new-ban.jpg")],
            {"favorite.jpg"},
            {"retained.jpg", "favorite.jpg"},
            now=2_000,
            recency_half_life_days=1,
        )
        by_name = {example.filename: example for example in examples}

        self.assertEqual(
            set(by_name), {"old-ban.jpg", "new-ban.jpg", "retained.jpg", "favorite.jpg"}
        )
        self.assertGreater(by_name["new-ban.jpg"].base_weight, by_name["old-ban.jpg"].base_weight)
        self.assertTrue(by_name["favorite.jpg"].is_favorite)
        self.assertGreater(by_name["favorite.jpg"].base_weight, by_name["retained.jpg"].base_weight)

    def test_controlled_pairs_exclude_layout_but_keep_subject_preferences(self) -> None:
        examples = [
            *_examples("ban", 12, ("bad", "specific"), 1),
            *_examples("keep", 12, ("good", "specific"), 0, start=1_700_001_000),
            *_examples("layout", 8, ("portrait display", "bad"), 1, start=1_700_002_000),
            *_examples("demo", 8, ("Asian", "plants"), 1, start=1_700_003_000),
        ]
        space = _build_feature_space(examples, combo_min_support=5, max_combo_features=100)

        self.assertIn("bad", space.tags)
        self.assertNotIn("portrait display", space.tags)
        self.assertIn("asian", space.tags)
        self.assertIn("asian\x1fplants", space.combos)
        self.assertNotIn("bad\x1fportrait display", space.combos)
        self.assertIn("bad\x1fspecific", space.combos)

    def test_model_scores_learned_dislike_combo_above_kept_combo(self) -> None:
        examples = [
            *_examples("ban", 30, ("bad", "specific"), 1),
            *_examples("keep", 30, ("good", "specific"), 0, start=1_700_001_000),
            *_examples("fav", 10, ("good", "specific"), 0, start=1_700_002_000),
        ]
        model = train_preference_model(
            examples,
            combo_min_support=5,
            max_combo_features=100,
            epochs=12,
        )
        disliked = model.predict(["bad", "specific"])
        kept = model.predict(["good", "specific"])

        self.assertGreater(disliked.probability, kept.probability)
        self.assertTrue(any(item["feature"] == "bad" for item in disliked.contributions))
        self.assertIn("bad\x1fspecific", model.combo_weights)

    def test_filter_fails_open_without_semantic_neighbor_runtime(self) -> None:
        examples = [
            *[
                PreferenceExample(
                    filename=f"explicit-ban-{index}.jpg",
                    tags=("bad subject", "shared context"),
                    label=1,
                    base_weight=1.0,
                    timestamp=1_700_000_000 + index,
                    is_explicit_ban=True,
                )
                for index in range(20)
            ],
            *[
                PreferenceExample(
                    filename=f"explicit-keep-{index}.jpg",
                    tags=("good subject", "shared context"),
                    label=0,
                    base_weight=1.0,
                    timestamp=1_700_001_000 + index,
                    is_explicit_keep=True,
                )
                for index in range(20)
            ],
        ]
        model = train_preference_model(examples, semantic_model=None)
        model.tag_weights["unseen risk"] = 2.0

        candidate, prediction = auto_filter_prediction(
            model,
            {"tags": ["unseen risk"]},
        )

        self.assertTrue(model.neighbor_head_ready)
        self.assertFalse(model.semantic_enabled)
        self.assertFalse(prediction.neighbor_available)
        self.assertFalse(candidate)

        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "model.json"
            save_preference_model(model, path)
            loaded = load_preference_model(path)
        self.assertIsNotNone(loaded)
        assert loaded is not None
        self.assertTrue(loaded.neighbor_head_ready)
        self.assertFalse(loaded.predict(["unseen risk"]).neighbor_available)

    def test_content_neighbor_head_requires_both_explicit_classes(self) -> None:
        examples = [
            *[
                PreferenceExample(
                    filename=f"ban-{index}.jpg",
                    tags=("bad", "shared"),
                    label=1,
                    base_weight=1.0,
                    timestamp=1_700_000_000 + index,
                    is_explicit_ban=True,
                )
                for index in range(12)
            ],
            *[
                PreferenceExample(
                    filename=f"background-{index}.jpg",
                    tags=("good",),
                    label=0,
                    base_weight=1.0,
                    timestamp=1_700_001_000 + index,
                )
                for index in range(12)
            ],
        ]
        model = train_preference_model(examples)

        self.assertFalse(model.neighbor_head_ready)
        self.assertEqual(model.neighbor_prototypes, ())

    def test_stale_neighbor_calibration_cannot_enable_auto_filtering(self) -> None:
        examples = [
            *[
                PreferenceExample(
                    f"ban-{index}.jpg",
                    ("bad", "shared"),
                    1,
                    1.0,
                    1_700_000_000 + index,
                    is_explicit_ban=True,
                )
                for index in range(20)
            ],
            *[
                PreferenceExample(
                    f"keep-{index}.jpg",
                    ("good", "shared"),
                    0,
                    1.0,
                    1_700_001_000 + index,
                    is_explicit_keep=True,
                )
                for index in range(20)
            ],
        ]
        model = train_preference_model(examples)
        model.semantic_model = "fake-model"
        model.semantic_weights = (0.0,)
        model.training_summary["decision_calibration"] = {
            "available": True,
            "version": 5,
            "threshold": 0.5,
        }

        with tempfile.TemporaryDirectory() as td:
            status = auto_filter_status(WayperConfig(download_dir=Path(td)), model)

        self.assertFalse(status["ready"])
        self.assertEqual(status["status"], "calibration_pending")

    def test_fitting_is_bounded_but_knn_retains_all_explicit_labels(self) -> None:
        examples = [
            *_examples("ban", 1_500, ("bad", "detail"), 1, start=1_000),
            *_examples("keep", 1_500, ("good", "detail"), 0, start=10_000),
        ]
        working = select_preference_examples(examples)
        model = train_preference_model(examples, epochs=1)

        self.assertEqual(len(working), 2_048)
        self.assertEqual(sum(example.label == 0 for example in working), 1_024)
        self.assertEqual(sum(example.label == 1 for example in working), 1_024)
        self.assertEqual(model.training_summary["working_examples"], 2_048)
        self.assertEqual(len(model.neighbor_prototypes), 3_000)
        self.assertNotIn("recommendation_strategy", model.training_summary)

    def test_library_predictions_are_bounded_to_small_batches(self) -> None:
        class FakeModel:
            def __init__(self) -> None:
                self.batch_sizes: list[int] = []

            def predict_many(self, records, *, top_n: int):
                materialized = tuple(records)
                self.batch_sizes.append(len(materialized))
                self.assert_top_n = top_n
                return tuple(range(len(materialized)))

        records = [
            (Path(f"item-{index}.jpg"), f"item-{index}.jpg", {"tags": ["tag"]})
            for index in range(130)
        ]
        model = FakeModel()

        predictions = list(_batched_preference_predictions(model, records, top_n=20))

        self.assertEqual(model.batch_sizes, [64, 64, 2])
        self.assertEqual(model.assert_top_n, 20)
        self.assertEqual(len(predictions), len(records))

    def test_save_load_round_trip_preserves_predictions(self) -> None:
        examples = [
            *_examples("ban", 15, ("bad", "detail"), 1),
            *_examples("keep", 15, ("good", "detail"), 0, start=1_700_001_000),
        ]
        model = train_preference_model(examples, max_combo_features=100, epochs=8)
        before = model.predict(["bad", "detail"])
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "model.json"
            save_preference_model(model, path)
            loaded = load_preference_model(path)

        self.assertIsNotNone(loaded)
        assert loaded is not None
        after = loaded.predict(["bad", "detail"])
        self.assertAlmostEqual(before.probability, after.probability)

    def test_v2_context_features_round_trip_without_pair_features(self) -> None:
        examples = [
            *[
                PreferenceExample(
                    f"ban{index}.jpg",
                    ("bad",),
                    1,
                    1.0,
                    1_700_000_000 + index,
                    context_features=("category:people", "color:#ff0000"),
                )
                for index in range(12)
            ],
            *[
                PreferenceExample(
                    f"keep{index}.jpg",
                    ("good",),
                    0,
                    1.0,
                    1_700_001_000 + index,
                    context_features=("category:general", "color:#0000ff"),
                )
                for index in range(12)
            ],
        ]
        model = train_preference_model(examples)

        self.assertEqual(model.schema_version, MODEL_SCHEMA_VERSION)
        self.assertEqual(model.max_combo_features, 0)
        self.assertEqual(model.combo_weights, {})
        self.assertIn("category:people", model.feature_space.context)
        prediction = model.predict(
            ["bad"],
            metadata={"category": "people", "colors": ["#ff0000"]},
        )
        self.assertTrue(any(item["type"] == "category" for item in prediction.contributions))

        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "model.json"
            save_preference_model(model, path)
            loaded = load_preference_model(path)
        self.assertIsNotNone(loaded)
        assert loaded is not None
        self.assertEqual(loaded.feature_normalization, "field_l2")
        self.assertEqual(loaded.context_weights, model.context_weights)

    def test_explicit_ban_and_keep_flags_are_preserved_for_semantic_head(self) -> None:
        metadata = {
            "ban.jpg": {"tags": ["person"]},
            "keep.jpg": {"tags": ["person", "asian"]},
        }
        examples = build_training_examples(
            metadata,
            [],
            set(),
            None,
            feedback_events=[
                {
                    "schema_version": 2,
                    "revision": 1,
                    "timestamp": 100,
                    "filename": "ban.jpg",
                    "action": "ban",
                },
                {
                    "schema_version": 2,
                    "revision": 2,
                    "timestamp": 101,
                    "filename": "keep.jpg",
                    "action": "keep",
                },
            ],
            now=200,
        )
        by_name = {example.filename: example for example in examples}
        self.assertTrue(by_name["ban.jpg"].is_explicit_ban)
        self.assertTrue(by_name["keep.jpg"].is_explicit_keep)

    def test_semantic_head_prediction_and_round_trip(self) -> None:
        model = PreferenceModel(
            bias=0.0,
            prior_log_odds=0.0,
            tag_weights={},
            combo_weights={},
            context_weights={},
            trained_at="test",
            training_summary={"semantic_status": "trained"},
            combo_min_support=20,
            max_combo_features=0,
            semantic_model="fake-model",
            semantic_bias=0.1,
            semantic_weights=(1.0, -0.5),
            semantic_blend=0.5,
        )
        prediction = model.predict(["unseen"], _semantic_embedding=(1.0, 0.0))
        self.assertTrue(prediction.semantic_available)
        self.assertGreater(prediction.semantic_score or 0.0, 0.0)
        self.assertTrue(any(item["type"] == "semantic" for item in prediction.contributions))

        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "model.json"
            save_preference_model(model, path)
            loaded = load_preference_model(path)
        self.assertIsNotNone(loaded)
        assert loaded is not None
        self.assertEqual(loaded.semantic_model, "fake-model")
        self.assertEqual(loaded.semantic_weights, (1.0, -0.5))

    def test_two_stage_semantic_neighbors_match_related_unseen_tags(self) -> None:
        examples = [
            *[
                PreferenceExample(
                    filename=f"forest-dislike-{index}.jpg",
                    tags=("forest", "fog"),
                    label=1,
                    base_weight=1.0,
                    timestamp=1_700_000_000 + index,
                    is_explicit_ban=True,
                )
                for index in range(12)
            ],
            *[
                PreferenceExample(
                    filename=f"ocean-keep-{index}.jpg",
                    tags=("ocean", "sunlight"),
                    label=0,
                    base_weight=1.0,
                    timestamp=1_700_001_000 + index,
                    is_explicit_keep=True,
                )
                for index in range(12)
            ],
        ]
        model = train_preference_model(examples, semantic_model=None)
        model.semantic_model = "fake-model"
        model.semantic_weights = (0.0, 0.0, 0.0)

        def fake_embed(texts, *, model_name, batch_size=64):
            del model_name, batch_size

            def vector(text: str) -> tuple[float, float, float]:
                lowered = text.casefold()
                if "forest" in lowered or "woodland" in lowered:
                    return (1.0, 0.0, 0.0)
                if "fog" in lowered or "mist" in lowered:
                    return (0.8, 0.6, 0.0)
                if "ocean" in lowered or "seaside" in lowered:
                    return (-1.0, 0.0, 0.0)
                if "sunlight" in lowered or "sunshine" in lowered:
                    return (-0.8, 0.6, 0.0)
                return (0.0, 0.0, 1.0)

            return [vector(text) for text in texts]

        from wayper.preference import semantic as semantic_module

        real_embed_tag_sets = semantic_module.embed_tag_sets
        tag_set_batch_sizes: list[int] = []

        def counting_embed_tag_sets(records, *, model_name, idf=None):
            materialized = tuple(records)
            tag_set_batch_sizes.append(len(materialized))
            return real_embed_tag_sets(materialized, model_name=model_name, idf=idf)

        with (
            patch("wayper.preference.semantic.embed_texts", side_effect=fake_embed),
            patch(
                "wayper.preference.semantic.embed_tag_sets",
                side_effect=counting_embed_tag_sets,
            ),
        ):
            disliked = model.predict(
                ["woodland", "mist"],
                _semantic_embedding=(0.0, 0.0, 0.0),
            )
            kept = model.predict(
                ["seaside", "sunshine"],
                _semantic_embedding=(0.0, 0.0, 0.0),
            )
            cached_call_count = len(tag_set_batch_sizes)
            model.predict(
                ["woodland", "mist"],
                _semantic_embedding=(0.0, 0.0, 0.0),
            )

        self.assertGreater(max(tag_set_batch_sizes[:cached_call_count]), 2)
        self.assertEqual(tag_set_batch_sizes[cached_call_count:], [2])

        self.assertEqual(disliked.neighbor_exact_max_similarity, 0.0)
        self.assertGreater(disliked.neighbor_semantic_max_similarity, 0.9)
        self.assertGreater(disliked.neighbor_probability or 0.0, 0.9)
        self.assertIsNotNone(kept.neighbor_probability)
        assert kept.neighbor_probability is not None
        self.assertLess(kept.neighbor_probability, 0.1)
        self.assertTrue(disliked.neighbor_nearest_dislike)
        assert disliked.neighbor_nearest_dislike is not None
        matched = {
            (item["query"], item["prototype"])
            for item in disliked.neighbor_nearest_dislike["tag_matches"]
        }
        self.assertIn(("woodland", "forest"), matched)
        self.assertIn(("mist", "fog"), matched)

    def test_two_stage_decision_keeps_neighbor_vote_primary(self) -> None:
        model = PreferenceModel(
            bias=0.0,
            prior_log_odds=0.0,
            tag_weights={},
            combo_weights={},
            trained_at="test",
            training_summary={},
            combo_min_support=20,
            max_combo_features=0,
        )
        prediction = PreferencePrediction(
            probability=0.2,
            score=0.0,
            feature_score=0.0,
            contributions=(),
            neighbor_probability=0.9,
            neighbor_available=True,
        )

        self.assertAlmostEqual(preference_decision_score(model, prediction), 0.76)

    def test_semantic_tag_text_uses_alias_and_category_per_tag(self) -> None:
        from wayper.preference.semantic import semantic_tag_items

        items = semantic_tag_items(
            ["forest"],
            {
                "tag_details": [
                    {
                        "name": "forest",
                        "alias": "woodland, woods",
                        "category": "Nature",
                    }
                ]
            },
        )

        self.assertEqual(items[0][0], "forest")
        self.assertIn("woodland, woods", items[0][1])
        self.assertIn("Nature", items[0][1])

    def test_semantic_tag_items_accept_calibration_text_override(self) -> None:
        from wayper.preference.semantic import semantic_tag_items

        items = semantic_tag_items(
            ["forest"],
            {"_semantic_tag_items": (("forest", "forest; aliases: woodland"),)},
        )

        self.assertEqual(items, (("forest", "forest; aliases: woodland"),))

    def test_predict_many_batches_semantic_metadata_without_images(self) -> None:
        model = PreferenceModel(
            bias=0.0,
            prior_log_odds=0.0,
            tag_weights={},
            combo_weights={},
            context_weights={},
            trained_at="test",
            training_summary={},
            combo_min_support=20,
            max_combo_features=0,
            semantic_model="fake-model",
            semantic_weights=(1.0, 0.0),
            semantic_blend=1.0,
        )
        with patch.object(
            model,
            "_predict_semantic_neighbors_many",
            return_value=[({}, (1.0, 0.0)), ({}, (-1.0, 0.0))],
        ) as embed:
            predictions = model.predict_many(
                [
                    (("first",), {"category": "people"}, None),
                    (("second",), {"category": "general"}, None),
                ]
            )
        embed.assert_called_once()
        self.assertEqual(len(predictions), 2)
        self.assertGreater(predictions[0].semantic_score or 0.0, 0.0)
        self.assertLess(predictions[1].semantic_score or 0.0, 0.0)

    def test_model_has_no_metadata_identity_prior(self) -> None:
        model = PreferenceModel(
            bias=0.0,
            prior_log_odds=0.0,
            tag_weights={},
            combo_weights={},
            context_weights={},
            trained_at="test",
            training_summary={},
            combo_min_support=20,
            max_combo_features=0,
        )

        people = model.predict(["women", "blonde"], metadata={"category": "people"})
        anime = model.predict(["women", "blonde"], metadata={"category": "anime"})

        self.assertAlmostEqual(people.score, anime.score)
        self.assertFalse(any(item["type"] == "concept" for item in people.contributions))
        self.assertFalse(any(item["type"] == "concept" for item in anime.contributions))

    def test_review_only_uses_model_review_ban_and_keep_only(self) -> None:
        metadata = {
            "gallery-ban.jpg": {"tags": ["ordinary-ban"]},
            "manual-dislike.jpg": {"tags": ["missed-by-model"]},
            "review-ban.jpg": {"tags": ["review-ban"]},
            "review-keep.jpg": {"tags": ["review-keep"]},
            "favorite.jpg": {"tags": ["favorite"]},
        }
        events = [
            {
                "schema_version": 2,
                "revision": 1,
                "timestamp": 100,
                "filename": "gallery-ban.jpg",
                "action": "ban",
                "source": "core",
                "context": "core",
            },
            {
                "schema_version": 2,
                "revision": 2,
                "timestamp": 101,
                "filename": "manual-dislike.jpg",
                "action": "dislike",
                "source": "core",
                "context": "manual_dislike",
            },
            {
                "schema_version": 2,
                "revision": 3,
                "timestamp": 101,
                "filename": "review-ban.jpg",
                "action": "ban",
                "source": "core",
                "context": "model_review",
            },
            {
                "schema_version": 2,
                "revision": 4,
                "timestamp": 102,
                "filename": "review-keep.jpg",
                "action": "keep",
                "source": "model_suggestion",
                "context": "model_review",
            },
            {
                "schema_version": 2,
                "revision": 5,
                "timestamp": 103,
                "filename": "favorite.jpg",
                "action": "favorite",
                "source": "core",
                "context": "core",
            },
        ]

        examples = build_training_examples(
            metadata,
            [(99, "gallery-ban.jpg")],
            {"favorite.jpg"},
            retained_files={"favorite.jpg"},
            feedback_events=events,
            now=200,
            review_only=True,
        )

        self.assertEqual(
            {example.filename for example in examples},
            {"manual-dislike.jpg", "review-ban.jpg", "review-keep.jpg"},
        )
        by_name = {example.filename: example for example in examples}
        self.assertEqual(by_name["manual-dislike.jpg"].label, 1)
        self.assertTrue(by_name["manual-dislike.jpg"].is_explicit_ban)
        self.assertEqual(by_name["review-ban.jpg"].label, 1)
        self.assertTrue(by_name["review-ban.jpg"].is_explicit_ban)
        self.assertEqual(by_name["review-keep.jpg"].label, 0)
        self.assertTrue(by_name["review-keep.jpg"].is_explicit_keep)
        self.assertFalse(any(example.is_control for example in examples))

    def test_review_unban_clears_a_previous_review_ban(self) -> None:
        metadata = {"review-ban.jpg": {"tags": ["review-ban"]}}
        events = [
            {
                "schema_version": 2,
                "revision": 1,
                "timestamp": 100,
                "filename": "review-ban.jpg",
                "action": "ban",
                "source": "model_suggestion",
                "context": "model_review",
            },
            {
                "schema_version": 2,
                "revision": 2,
                "timestamp": 101,
                "filename": "review-ban.jpg",
                "action": "unban",
                "source": "core",
                "context": "core",
            },
        ]

        examples = build_training_examples(
            metadata,
            (),
            set(),
            feedback_events=events,
            review_only=True,
        )

        self.assertEqual(examples, [])

    def test_manual_dislike_switches_to_curated_labels_and_unban_clears_it(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            config.metadata_file.write_text(
                json.dumps({"missed.jpg": {"tags": ["missed-by-model"]}})
            )

            record_preference_feedback(
                config,
                "dislike",
                "missed.jpg",
                context="manual_dislike",
                timestamp=100,
            )
            disliked = collect_preference_training_snapshot(config)
            record_preference_feedback(config, "unban", "missed.jpg", timestamp=101)
            undone = collect_preference_training_snapshot(config)

        self.assertEqual(disliked.label_source, "model_review")
        self.assertEqual([example.filename for example in disliked.examples], ["missed.jpg"])
        self.assertEqual(disliked.examples[0].label, 1)
        self.assertTrue(disliked.examples[0].is_explicit_ban)
        self.assertEqual(undone.label_source, "model_review")
        self.assertEqual(undone.examples, ())

    def test_legacy_feedback_and_unfavorite_do_not_create_keep_label(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            config.preference_feedback_file.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "revision": 1,
                        "events": [
                            {
                                "revision": 1,
                                "timestamp": 100,
                                "action": "favorite",
                                "filename": "kept.jpg",
                            }
                        ],
                    }
                )
            )
            record_preference_feedback(
                config,
                "unfavorite",
                "kept.jpg",
                timestamp=200,
            )
            feedback = load_preference_feedback(config)

        self.assertEqual(feedback["revision"], 2)
        self.assertEqual(
            [event["action"] for event in feedback["events"]], ["favorite", "unfavorite"]
        )
        examples = build_training_examples(
            {"kept.jpg": {"tags": ["calm"]}},
            [],
            set(),
            {"kept.jpg"},
            feedback_events=feedback["events"],
        )
        self.assertEqual(len(examples), 1)
        self.assertTrue(examples[0].is_control)
        self.assertFalse(examples[0].temporal_label_known)

    def test_decision_calibration_split_is_bounded_and_balanced(self) -> None:
        from wayper.preference.training import _decision_calibration_split

        examples = [
            *_examples("ban", 2_000, ("bad", "detail"), 1, start=1_000_000),
            *_examples("keep", 2_000, ("good", "detail"), 0, start=2_000_000),
        ]
        training, holdout = _decision_calibration_split(examples)

        self.assertEqual(len(training), 2_048)
        self.assertEqual(len(holdout), 640)
        self.assertEqual(sum(example.label == 0 for example in holdout), 320)
        self.assertEqual(sum(example.label == 1 for example in holdout), 320)

    def test_review_boundary_is_learned_from_recent_explicit_holdout(self) -> None:
        examples = [
            *[
                PreferenceExample(
                    filename=f"ban-{index}.jpg",
                    tags=("bad", "detail"),
                    label=1,
                    base_weight=1.0,
                    timestamp=1_700_000_000 + index,
                    is_explicit_ban=True,
                )
                for index in range(30)
            ],
            *[
                PreferenceExample(
                    filename=f"keep-{index}.jpg",
                    tags=("good", "detail"),
                    label=0,
                    base_weight=1.0,
                    timestamp=1_700_001_000 + index,
                    is_explicit_keep=True,
                )
                for index in range(30)
            ],
        ]

        def fake_embed(texts, *, model_name, batch_size=64):
            del model_name, batch_size
            return [
                (1.0, 0.0)
                if "bad" in text.casefold()
                else (-1.0, 0.0)
                if "good" in text.casefold()
                else (0.0, 1.0)
                for text in texts
            ]

        with patch("wayper.preference.semantic.embed_texts", side_effect=fake_embed):
            model = train_preference_model(examples, epochs=8, semantic_model="fake-model")
            calibration = model.training_summary["decision_calibration"]
            held, _ = auto_filter_prediction(model, {"tags": ["bad", "detail"]})
            kept, _ = auto_filter_prediction(model, {"tags": ["good", "detail"]})

        self.assertTrue(calibration["available"])
        self.assertEqual(calibration["source"], "stratified_recent_holdout")
        self.assertEqual(calibration["method"], "two_stage_tag_semantic_knn")
        self.assertGreaterEqual(calibration["precision"], 0.8)
        self.assertGreaterEqual(calibration["threshold"], 0.5)
        self.assertEqual(
            preference_decision_threshold(model),
            calibration["threshold"],
        )
        self.assertTrue(held)
        self.assertFalse(kept)

    def test_explicit_keep_uses_feedback_time_and_strong_weight(self) -> None:
        examples = build_training_examples(
            {"kept.jpg": {"tags": ["calm"], "downloaded_at": 1}},
            [],
            set(),
            {"kept.jpg"},
            feedback_events=[
                {
                    "revision": 1,
                    "timestamp": 2_000,
                    "action": "keep",
                    "filename": "kept.jpg",
                }
            ],
            now=3_000,
        )

        self.assertEqual(len(examples), 1)
        self.assertTrue(examples[0].is_explicit_keep)
        self.assertEqual(examples[0].timestamp, 2_000)
        self.assertEqual(examples[0].base_weight, 4.0)

    def test_ledger_ban_survives_blacklist_pruning_until_later_positive_feedback(self) -> None:
        metadata = {"expired-ban.jpg": {"tags": ["bad"], "downloaded_at": 1}}
        ledger_ban = {
            "revision": 1,
            "timestamp": 2_000,
            "action": "ban",
            "filename": "expired-ban.jpg",
        }

        after_ttl = build_training_examples(
            metadata,
            [],
            set(),
            set(),
            feedback_events=[ledger_ban],
            now=3_000,
        )
        self.assertEqual(
            [(item.filename, item.label) for item in after_ttl], [("expired-ban.jpg", 1)]
        )

        reversed_label = build_training_examples(
            metadata,
            [],
            set(),
            {"expired-ban.jpg"},
            historical_bans=[(1_000, "expired-ban.jpg")],
            feedback_events=[
                ledger_ban,
                {
                    "revision": 2,
                    "timestamp": 2_100,
                    "action": "unban",
                    "filename": "expired-ban.jpg",
                },
            ],
            now=3_000,
        )
        self.assertEqual(
            [(item.filename, item.label) for item in reversed_label], [("expired-ban.jpg", 0)]
        )
        self.assertTrue(reversed_label[0].temporal_label_known)

    def test_historical_blacklist_bootstrap_survives_ttl_without_feedback_events(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            config.metadata_file.write_text(
                json.dumps({"pre-ledger-ban.jpg": {"tags": ["bad"], "downloaded_at": 1}})
            )
            config.blacklist_file.write_text("1000 pre-ledger-ban.jpg\n")

            self.assertEqual(_bootstrap_historical_preference_bans(config), 1)
            self.assertEqual(load_preference_historical_bans(config), {"pre-ledger-ban.jpg": 1_000})
            self.assertFalse(config.preference_feedback_file.exists())

            # Simulate normal TTL pruning after the model feature was enabled.
            config.blacklist_file.write_text("")
            snapshot = collect_preference_training_snapshot(config)

        self.assertEqual(
            [(item.filename, item.label) for item in snapshot.examples], [("pre-ledger-ban.jpg", 1)]
        )

    def test_decision_calibration_requires_explicit_keep_and_dislike(self) -> None:
        implicit_old_keeps = [
            PreferenceExample(
                filename=f"old-keep{index}.jpg",
                tags=("good", "old"),
                label=0,
                base_weight=1.0,
                timestamp=1_000_000 + index,
                temporal_label_known=False,
            )
            for index in range(10)
        ]
        implicit_recent_keeps = [
            PreferenceExample(
                filename=f"recent-keep{index}.jpg",
                tags=("good", "recent"),
                label=0,
                base_weight=1.0,
                timestamp=2_000_000 + index,
                temporal_label_known=False,
            )
            for index in range(5)
        ]
        examples = [
            *_examples("old-ban", 10, ("bad", "old"), 1, start=1_000_000),
            *implicit_old_keeps,
            *_examples("recent-ban", 5, ("bad", "recent"), 1, start=2_000_000),
            *implicit_recent_keeps,
        ]

        model = train_preference_model(examples, max_combo_features=100)

        calibration = model.training_summary["decision_calibration"]
        self.assertFalse(calibration["available"])
        self.assertEqual(calibration["reason"], "not enough explicit Keep/Dislike decisions")

    def test_review_candidates_are_live_nonfavorite_and_need_positive_evidence(self) -> None:
        training = [
            *_examples("ban", 30, ("bad", "detail"), 1),
            *_examples("keep", 30, ("good", "detail"), 0, start=1_700_001_000),
        ]
        model = train_preference_model(training, max_combo_features=100, epochs=12)
        model.semantic_model = "fake-model"
        model.semantic_weights = (0.0,)
        model.training_summary["decision_threshold"] = 0.5
        model.training_summary["decision_calibration"] = {
            "available": True,
            "version": 6,
            "threshold": 0.5,
        }

        def fake_predict_many(_model, records, *, top_n=8):
            del top_n
            predictions = []
            for tags, _, _ in records:
                is_bad = "bad" in tags
                predictions.append(
                    PreferencePrediction(
                        probability=0.9 if is_bad else 0.5,
                        score=1.0 if is_bad else 0.0,
                        feature_score=1.0 if is_bad else 0.0,
                        contributions=(
                            {
                                "type": "tag",
                                "feature": "bad",
                                "weight": 1.0,
                                "direction": "dislike",
                            },
                        )
                        if is_bad
                        else (),
                        neighbor_probability=0.9 if is_bad else None,
                        neighbor_available=is_bad,
                        neighbor_count=1 if is_bad else 0,
                        neighbor_dislike_count=1 if is_bad else 0,
                        neighbor_max_similarity=1.0 if is_bad else 0.0,
                        neighbor_nearest_dislike={"filename": "ban0.jpg"} if is_bad else None,
                    )
                )
            return tuple(predictions)

        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            pool_dir = config.download_dir / "sfw" / "landscape"
            favorite_dir = config.download_dir / "favorites" / "sfw" / "landscape"
            pool_dir.mkdir(parents=True)
            favorite_dir.mkdir(parents=True)
            for filename in ("bad-candidate.jpg", "unknown.jpg"):
                (pool_dir / filename).touch()
            (favorite_dir / "favorite-bad.jpg").touch()
            config.metadata_file.write_text(
                '{"bad-candidate.jpg":{"tags":["bad","detail"]},'
                '"unknown.jpg":{"tags":["unknown"]},'
                '"favorite-bad.jpg":{"tags":["bad","detail"]}}'
            )
            save_preference_model(model, config.preference_model_file)

            with patch.object(PreferenceModel, "predict_many", new=fake_predict_many):
                suggestions = preference_deletion_suggestions(
                    config, purities=("sfw",), orientation="landscape"
                )
            self.assertEqual([item["name"] for item in suggestions["items"]], ["bad-candidate.jpg"])
            self.assertTrue(suggestions["items"][0]["contributions"])
            self.assertEqual(suggestions["items"][0]["rank"], 1)
            self.assertIn("percentile", suggestions["items"][0])
            self.assertIn("dislike_evidence", suggestions["items"][0])
            self.assertIn("keep_evidence", suggestions["items"][0])

            record_preference_feedback(config, "keep", "bad-candidate.jpg")
            with patch.object(PreferenceModel, "predict_many", new=fake_predict_many):
                kept = preference_deletion_suggestions(
                    config, purities=("sfw",), orientation="landscape"
                )
            self.assertEqual(kept["items"], [])

    def test_review_rank_diversifies_repeated_primary_reasons(self) -> None:
        def item(name: str, reason: str, score: float) -> dict[str, object]:
            prediction = PreferencePrediction(
                probability=0.5,
                score=score,
                feature_score=score,
                contributions=(),
                neighbor_nearest_dislike={"filename": reason},
            )
            return {"name": name, "prediction": prediction, "decision_score": score}

        ranked = [
            item(f"same-{index:02d}.jpg", "same", float(30 - index)) for index in range(1, 25)
        ]
        ranked.append(item("alternate.jpg", "alternate", 1.0))

        diversified = _diversify_preference_review_rank(ranked)

        self.assertEqual(
            [entry["name"] for entry in diversified[:24]],
            [*[f"same-{index:02d}.jpg" for index in range(1, 24)], "alternate.jpg"],
        )
        self.assertEqual(diversified[24]["name"], "same-24.jpg")

    def test_feedback_revision_marks_a_trained_model_due_for_refresh(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            pool_dir = config.download_dir / "sfw" / "landscape"
            pool_dir.mkdir(parents=True)
            metadata: dict[str, dict[str, object]] = {}
            blacklisted: list[str] = []
            for index in range(10):
                filename = f"ban{index}.jpg"
                metadata[filename] = {"tags": ["bad", "detail"], "downloaded_at": 1_700_000_000}
                blacklisted.append(f"1700000{index:03d} {filename}")
            for index in range(10):
                filename = f"keep{index}.jpg"
                metadata[filename] = {"tags": ["good", "detail"], "downloaded_at": 1_700_001_000}
                (pool_dir / filename).touch()
            config.metadata_file.write_text(json.dumps(metadata))
            config.blacklist_file.write_text("\n".join(blacklisted) + "\n")

            model, snapshot = train_local_preference_model(config, max_combo_features=100)
            _mark_semantic_model_ready(model)
            save_preference_model(model, config.preference_model_file)
            self.assertFalse(preference_learning_status(config, model, snapshot)["stale"])

            for index in range(10):
                record_preference_feedback(config, "keep", f"keep{index}.jpg")
            status = preference_learning_status(config)

        self.assertTrue(status["stale"])
        self.assertEqual(status["pending_feedback"], 10)
        self.assertTrue(status["due"])

    def test_model_without_decision_calibration_is_scheduled_for_upgrade(self) -> None:
        examples = [
            *_examples("ban", 10, ("bad", "detail"), 1),
            *_examples("keep", 10, ("good", "detail"), 0, start=1_700_001_000),
        ]
        model = train_preference_model(examples)
        model.training_summary.pop("decision_threshold")
        model.training_summary.pop("decision_calibration")
        snapshot = PreferenceTrainingSnapshot(
            examples=tuple(examples),
            feedback_revision=0,
            data_signature=_training_data_signature(examples),
            favorite_files=0,
        )

        with tempfile.TemporaryDirectory() as td:
            status = preference_learning_status(
                WayperConfig(download_dir=Path(td)),
                model,
                snapshot,
            )

        self.assertTrue(status["decision_boundary_upgrade_due"])
        self.assertTrue(status["upgrade_due"])
        self.assertTrue(status["due"])

    def test_snapshot_switches_to_model_review_labels_after_first_review_event(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            pool = config.download_dir / "sfw" / "landscape"
            pool.mkdir(parents=True)
            (pool / "ordinary-keep.jpg").touch()
            config.metadata_file.write_text(
                json.dumps(
                    {
                        "ordinary-ban.jpg": {"tags": ["ordinary-ban"]},
                        "ordinary-keep.jpg": {"tags": ["ordinary-keep"]},
                        "review-ban.jpg": {"tags": ["review-ban"]},
                    }
                )
            )
            config.blacklist_file.write_text("100 ordinary-ban.jpg\n")

            legacy = collect_preference_training_snapshot(config)
            self.assertEqual(legacy.label_source, "legacy")
            self.assertEqual(
                {example.filename for example in legacy.examples},
                {"ordinary-ban.jpg", "ordinary-keep.jpg"},
            )

            record_preference_feedback(
                config,
                "ban",
                "review-ban.jpg",
                source="model_suggestion",
                context="model_review",
                timestamp=200,
            )
            reviewed = collect_preference_training_snapshot(config)

        self.assertEqual(reviewed.label_source, "model_review")
        self.assertEqual([example.filename for example in reviewed.examples], ["review-ban.jpg"])
        self.assertTrue(reviewed.examples[0].is_explicit_ban)
        self.assertFalse(any(example.is_control for example in reviewed.examples))

    def test_recency_weight_change_marks_model_for_refresh_without_new_feedback(self) -> None:
        examples = [
            *_examples("ban", 10, ("bad", "detail"), 1),
            *_examples("keep", 10, ("good", "detail"), 0, start=1_700_001_000),
        ]
        model = _mark_semantic_model_ready(train_preference_model(examples, max_combo_features=100))
        reweighted = [
            PreferenceExample(
                filename=example.filename,
                tags=example.tags,
                label=example.label,
                base_weight=example.base_weight * 0.9 if example.label else example.base_weight,
                timestamp=example.timestamp,
                is_favorite=example.is_favorite,
                is_explicit_keep=example.is_explicit_keep,
                is_explicit_ban=example.is_explicit_ban,
                temporal_label_known=example.temporal_label_known,
            )
            for example in examples
        ]
        snapshot = PreferenceTrainingSnapshot(
            examples=tuple(reweighted),
            feedback_revision=0,
            data_signature=_training_data_signature(reweighted),
            favorite_files=0,
        )

        with tempfile.TemporaryDirectory() as td:
            status = preference_learning_status(
                WayperConfig(download_dir=Path(td)),
                model,
                snapshot,
            )

        self.assertTrue(status["stale"])
        self.assertEqual(status["changed_examples"], 0)
        self.assertTrue(status["weight_refresh_due"])
        self.assertTrue(status["due"])

    def test_untrained_feedback_bootstraps_but_waits_for_explicit_keeps(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            metadata = _write_cold_start_library(config)

            explicit_snapshot = collect_preference_training_snapshot(config)
            learning = preference_learning_status(config)
            token = _claim_or_touch_auto_retrain_worker(config)
            self.assertIsNotNone(token)
            assert token is not None
            run_scheduled_preference_model_retrain(config, token, delay_seconds=0)
            model = load_preference_model(config.preference_model_file)

            candidate = config.download_dir / "sfw" / "landscape" / "candidate.jpg"
            candidate.touch()
            metadata[candidate.name] = {
                "tags": ["bad", "detail"],
                "downloaded_at": 1_700_002_000,
            }
            config.metadata_file.write_text(json.dumps(metadata))
            suggestions = preference_deletion_suggestions(
                config,
                purities=("sfw",),
                orientation="landscape",
            )

        self.assertEqual(explicit_snapshot.label_source, "model_review")
        self.assertEqual(
            {example.label for example in explicit_snapshot.examples},
            {1},
        )
        self.assertEqual(learning["label_source"], "legacy")
        self.assertTrue(learning["training_ready"])
        self.assertTrue(learning["due"])
        self.assertIsNotNone(model)
        assert model is not None
        self.assertEqual(model.training_summary["label_source"], "legacy")
        self.assertEqual(model.training_summary["banned"], 10)
        self.assertEqual(model.training_summary["retained"], 10)
        self.assertEqual(suggestions["status"], "learning")
        self.assertEqual(suggestions["items"], [])
        self.assertFalse(model.neighbor_head_ready)

    def test_scheduler_starts_frozen_worker_for_first_trainable_model(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            _write_cold_start_library(config)
            with (
                patch.object(sys, "frozen", True, create=True),
                patch("wayper.preference_model.subprocess.Popen") as popen,
            ):
                popen.return_value.pid = os.getpid()
                schedule_preference_model_retrain(config)

            self.assertEqual(popen.call_count, 1)
            command = popen.call_args.args[0]
            self.assertEqual(command[0], sys.executable)
            self.assertEqual(command[1:3], ["model", "refresh"])
            self.assertNotIn("wayper.cli", command)
            lease = json.loads(_auto_retrain_lease_path(config).read_text())
            _release_auto_retrain_worker(config, lease["token"])

    def test_scheduler_detaches_one_worker_for_short_lived_callers(self) -> None:
        examples = [
            *_examples("ban", 10, ("bad", "detail"), 1),
            *_examples("keep", 10, ("good", "detail"), 0, start=1_700_001_000),
        ]
        model = _mark_semantic_model_ready(train_preference_model(examples, max_combo_features=100))
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            save_preference_model(model, config.preference_model_file)
            with patch("wayper.preference_model.subprocess.Popen") as popen:
                popen.return_value.pid = os.getpid()
                schedule_preference_model_retrain(config)
                self.assertEqual(popen.call_count, 0)
                for index in range(10):
                    record_preference_feedback(config, "keep", f"keep{index}.jpg")
                schedule_preference_model_retrain(config)
                schedule_preference_model_retrain(config)

            self.assertEqual(popen.call_count, 1)
            command = popen.call_args.args[0]
            self.assertEqual(command[0], sys.executable)
            self.assertIn("wayper.cli", command)
            self.assertIn("model", command)
            self.assertIn("refresh", command)
            if os.name != "nt":
                self.assertTrue(popen.call_args.kwargs["start_new_session"])

            lease = json.loads(_auto_retrain_lease_path(config).read_text())
            _release_auto_retrain_worker(config, lease["token"])
            self.assertFalse(_auto_retrain_lease_path(config).exists())

    def test_detached_worker_consumes_persisted_lease_after_caller_returns(self) -> None:
        examples = [
            *_examples("ban", 10, ("bad", "detail"), 1),
            *_examples("keep", 10, ("good", "detail"), 0, start=1_700_001_000),
        ]
        model = train_preference_model(examples, max_combo_features=100)
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            save_preference_model(model, config.preference_model_file)
            token = _claim_or_touch_auto_retrain_worker(config)
            self.assertIsNotNone(token)
            assert token is not None

            with (
                patch("wayper.preference_model._run_auto_retrain", return_value="settled") as run,
                patch("wayper.preference_model.schedule_preference_model_retrain"),
            ):
                run_scheduled_preference_model_retrain(config, token, delay_seconds=0)

            run.assert_called_once_with(config)
            self.assertFalse(_auto_retrain_lease_path(config).exists())

    def test_automatic_commit_does_not_overwrite_matching_manual_fit(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            pool_dir = config.download_dir / "sfw" / "landscape"
            pool_dir.mkdir(parents=True)
            metadata: dict[str, dict[str, object]] = {}
            blacklist: list[str] = []
            for index in range(10):
                filename = f"ban{index}.jpg"
                metadata[filename] = {"tags": ["bad", "detail"], "downloaded_at": 1_700_000_000}
                blacklist.append(f"1700000{index:03d} {filename}")
            for index in range(10):
                filename = f"keep{index}.jpg"
                metadata[filename] = {"tags": ["good", "detail"], "downloaded_at": 1_700_001_000}
                (pool_dir / filename).touch()
            config.metadata_file.write_text(json.dumps(metadata))
            config.blacklist_file.write_text("\n".join(blacklist) + "\n")

            manual, snapshot = train_local_preference_model(
                config,
                max_combo_features=100,
            )
            save_preference_model(manual, config.preference_model_file)
            automatic = train_preference_model(
                list(snapshot.examples),
                max_combo_features=20,
                feedback_revision=snapshot.feedback_revision,
                retrain_mode="automatic",
            )

            self.assertTrue(_save_automatic_preference_model(config, automatic, snapshot))
            saved = load_preference_model(config.preference_model_file)

        self.assertIsNotNone(saved)
        assert saved is not None
        self.assertEqual(saved.training_summary["retrain_mode"], "manual")
        self.assertEqual(saved.max_combo_features, 100)

    def test_manual_commit_refuses_a_snapshot_changed_during_fit(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            pool_dir = config.download_dir / "sfw" / "landscape"
            pool_dir.mkdir(parents=True)
            metadata: dict[str, dict[str, object]] = {}
            blacklist: list[str] = []
            for index in range(10):
                filename = f"ban{index}.jpg"
                metadata[filename] = {"tags": ["bad", "detail"], "downloaded_at": 1_700_000_000}
                blacklist.append(f"1700000{index:03d} {filename}")
            for index in range(10):
                filename = f"keep{index}.jpg"
                metadata[filename] = {"tags": ["good", "detail"], "downloaded_at": 1_700_001_000}
                (pool_dir / filename).touch()
            config.metadata_file.write_text(json.dumps(metadata))
            config.blacklist_file.write_text("\n".join(blacklist) + "\n")

            model, snapshot = train_local_preference_model(
                config,
                max_combo_features=100,
            )
            record_preference_feedback(config, "keep", "keep0.jpg")

            committed = _save_manual_preference_model(config, model, snapshot)

        self.assertFalse(committed)

    def test_concurrent_model_saves_serialize_the_model_write(self) -> None:
        from wayper.util import atomic_write as real_atomic_write

        examples = [
            *_examples("ban", 10, ("bad", "detail"), 1),
            *_examples("keep", 10, ("good", "detail"), 0, start=1_700_001_000),
        ]
        first = train_preference_model(examples, max_combo_features=100)
        second = train_preference_model(examples, max_combo_features=20)
        active_writes = 0
        maximum_active_writes = 0
        counter_lock = threading.Lock()
        start = threading.Barrier(3)
        errors: list[Exception] = []

        def measured_write(path: Path, content: str) -> None:
            nonlocal active_writes, maximum_active_writes
            with counter_lock:
                active_writes += 1
                maximum_active_writes = max(maximum_active_writes, active_writes)
            try:
                time.sleep(0.01)
                real_atomic_write(path, content)
            finally:
                with counter_lock:
                    active_writes -= 1

        def save_from_thread(model) -> None:
            try:
                start.wait()
                save_preference_model(model, path)
            except Exception as exc:  # pragma: no cover - asserted after joining threads
                errors.append(exc)

        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "model.json"
            with patch("wayper.preference_model.atomic_write", side_effect=measured_write):
                first_thread = threading.Thread(target=save_from_thread, args=(first,))
                second_thread = threading.Thread(target=save_from_thread, args=(second,))
                first_thread.start()
                second_thread.start()
                start.wait()
                first_thread.join()
                second_thread.join()

            saved = load_preference_model(path)

        self.assertEqual(errors, [])
        self.assertEqual(maximum_active_writes, 1)
        self.assertIsNotNone(saved)

    def test_feedback_append_reads_only_the_tail_revision(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            record_preference_feedback(config, "keep", "first.jpg", timestamp=100)
            with patch(
                "wayper.preference_model.load_preference_feedback",
                side_effect=AssertionError("full ledger read"),
            ):
                revision = record_preference_feedback(
                    config,
                    "dislike",
                    "second.jpg",
                    timestamp=101,
                )
            feedback = load_preference_feedback(config)

        self.assertEqual(revision, 2)
        self.assertEqual(feedback["revision"], 2)
        self.assertEqual([event["action"] for event in feedback["events"]], ["keep", "dislike"])

    def test_score_without_input_preserves_json_output(self) -> None:
        examples = [
            *_examples("ban", 10, ("bad", "detail"), 1),
            *_examples("keep", 10, ("good", "detail"), 0, start=1_700_001_000),
        ]
        model = train_preference_model(examples, max_combo_features=100)
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            save_preference_model(model, config.preference_model_file)
            with (
                patch("wayper.cli.load_config", return_value=config),
                patch("wayper.logging.setup_logging"),
            ):
                result = CliRunner().invoke(cli, ["--json", "model", "score"])

        self.assertEqual(result.exit_code, 2)
        self.assertEqual(result.output, '{"error": "Provide FILENAME or --tags tag1,tag2"}\n')


if __name__ == "__main__":
    unittest.main()
