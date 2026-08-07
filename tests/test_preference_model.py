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
from wayper.preference_model import (
    MODEL_SCHEMA_VERSION,
    PreferenceExample,
    PreferenceModel,
    PreferencePrediction,
    PreferenceTrainingSnapshot,
    _auto_retrain_lease_path,
    _bootstrap_historical_preference_bans,
    _build_feature_space,
    _claim_or_touch_auto_retrain_worker,
    _diversify_preference_review_rank,
    _pid_is_running,
    _release_auto_retrain_worker,
    _save_automatic_preference_model,
    _save_manual_preference_model,
    _temporal_split,
    _training_data_signature,
    auto_filter_prediction,
    auto_filter_status,
    auto_skip_ready,
    build_training_examples,
    collect_preference_training_snapshot,
    load_preference_feedback,
    load_preference_historical_bans,
    load_preference_model,
    preference_deletion_suggestions,
    preference_learning_status,
    preference_recommendation_candidate,
    record_preference_feedback,
    run_scheduled_preference_model_retrain,
    save_preference_model,
    schedule_preference_model_retrain,
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
        )
        for index in range(count)
    ]


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
            validation_days=0,
        )
        disliked = model.predict(["bad", "specific"])
        kept = model.predict(["good", "specific"])

        self.assertGreater(disliked.probability, kept.probability)
        self.assertTrue(any(item["feature"] == "bad" for item in disliked.contributions))
        self.assertIn("bad\x1fspecific", model.combo_weights)

    def test_content_neighbor_head_separates_recommendation_from_auto_boundary(self) -> None:
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
        model = train_preference_model(examples, validation_days=0)
        model.training_summary["auto_filter_threshold"] = 0.99

        candidate, prediction = auto_filter_prediction(
            model,
            {"tags": ["bad subject", "shared context"]},
        )

        self.assertTrue(model.neighbor_head_ready)
        self.assertGreater(prediction.neighbor_probability or 0.0, 0.5)
        self.assertTrue(preference_recommendation_candidate(model, prediction))
        self.assertFalse(candidate)

        # A new model may still explain an unseen tag with its sparse head, but
        # automatic filtering must fail open until a content neighbour exists.
        model.tag_weights["unseen risk"] = 2.0
        uncovered_hit, uncovered_prediction = auto_filter_prediction(
            model,
            {"tags": ["unseen risk"]},
        )
        self.assertFalse(uncovered_prediction.neighbor_available)
        self.assertFalse(uncovered_hit)

        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "model.json"
            save_preference_model(model, path)
            loaded = load_preference_model(path)
        self.assertIsNotNone(loaded)
        assert loaded is not None
        self.assertTrue(loaded.neighbor_head_ready)
        restored = loaded.predict(["bad subject", "shared context"])
        self.assertAlmostEqual(
            restored.neighbor_probability or 0.0,
            prediction.neighbor_probability or 0.0,
        )

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
        model = train_preference_model(examples, validation_days=0)

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
        model = train_preference_model(examples, validation_days=0)
        calibration = model.training_summary["auto_filter_calibration"]
        calibration["version"] = int(calibration["version"]) - 1

        with tempfile.TemporaryDirectory() as td:
            status = auto_filter_status(WayperConfig(download_dir=Path(td)), model)

        self.assertFalse(status["ready"])
        self.assertEqual(status["status"], "calibration_pending")

    def test_temporal_holdout_does_not_seed_training_pair_vocabulary(self) -> None:
        examples = [
            *_examples("old-ban", 10, ("old", "bad"), 1, start=1_000),
            *_examples("old-keep", 10, ("old", "good"), 0, start=1_000),
            *_examples("new-ban", 10, ("future", "bad"), 1, start=100_000),
            *_examples("new-keep", 10, ("future", "good"), 0, start=100_000),
        ]
        training, holdout = _temporal_split(examples, validation_days=1)
        space = _build_feature_space(training, combo_min_support=5, max_combo_features=100)

        self.assertTrue(holdout)
        self.assertNotIn("future", space.tags)
        self.assertNotIn("future\x1fbad", space.combos)

    def test_save_load_round_trip_preserves_predictions(self) -> None:
        examples = [
            *_examples("ban", 15, ("bad", "detail"), 1),
            *_examples("keep", 15, ("good", "detail"), 0, start=1_700_001_000),
        ]
        model = train_preference_model(
            examples, max_combo_features=100, epochs=8, validation_days=0
        )
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
        model = train_preference_model(examples, validation_days=0)

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
            threshold=0.98,
            trained_at="test",
            training_summary={"semantic_status": "trained"},
            validation={},
            combo_min_support=20,
            max_combo_features=0,
            semantic_model="fake-model",
            semantic_bias=0.1,
            semantic_weights=(1.0, -0.5),
            semantic_blend=0.5,
            semantic_rank_weight=0.65,
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

    def test_predict_many_batches_semantic_metadata_without_images(self) -> None:
        model = PreferenceModel(
            bias=0.0,
            prior_log_odds=0.0,
            tag_weights={},
            combo_weights={},
            context_weights={},
            threshold=0.98,
            trained_at="test",
            training_summary={},
            validation={},
            combo_min_support=20,
            max_combo_features=0,
            semantic_model="fake-model",
            semantic_weights=(1.0, 0.0),
            semantic_blend=1.0,
            semantic_rank_weight=0.65,
        )
        with patch(
            "wayper.preference.semantic.embed_metadata",
            return_value=[(1.0, 0.0), (-1.0, 0.0)],
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
            threshold=0.98,
            trained_at="test",
            training_summary={},
            validation={},
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

    def test_validation_reports_when_both_recent_classes_exist(self) -> None:
        examples = [
            *_examples("old-ban", 15, ("bad", "old"), 1, start=1_000_000),
            *_examples("old-keep", 15, ("good", "old"), 0, start=1_000_000),
            *_examples("recent-ban", 6, ("bad", "recent"), 1, start=2_000_000),
            *_examples("recent-keep", 6, ("good", "recent"), 0, start=2_000_000),
        ]
        model = train_preference_model(
            examples,
            max_combo_features=100,
            epochs=4,
            validation_days=1,
        )

        self.assertTrue(model.validation["available"])
        self.assertIn("precision_at_threshold", model.validation)

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

        model = train_preference_model(examples, epochs=8, validation_days=0)
        calibration = model.training_summary["review_calibration"]
        held, _ = auto_filter_prediction(model, {"tags": ["bad", "detail"]})
        kept, _ = auto_filter_prediction(model, {"tags": ["good", "detail"]})

        self.assertTrue(calibration["available"])
        self.assertEqual(calibration["source"], "stratified_recent_holdout")
        self.assertEqual(calibration["method"], "content_knn")
        self.assertGreaterEqual(calibration["precision"], 0.8)
        self.assertGreaterEqual(calibration["threshold"], 0.5)
        self.assertEqual(model.training_summary["review_threshold"], calibration["threshold"])
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

    def test_temporal_validation_excludes_implicit_current_retention(self) -> None:
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

        model = train_preference_model(
            examples,
            max_combo_features=100,
            validation_days=1,
        )

        self.assertFalse(model.validation["available"])
        self.assertEqual(model.validation["excluded_implicit_retained"], 15)
        self.assertEqual(model.validation["reason"], "not enough temporally observed labelled data")

    def test_review_candidates_are_live_nonfavorite_and_need_positive_evidence(self) -> None:
        training = [
            *_examples("ban", 30, ("bad", "detail"), 1),
            *_examples("keep", 30, ("good", "detail"), 0, start=1_700_001_000),
        ]
        model = train_preference_model(
            training, max_combo_features=100, epochs=12, validation_days=0
        )
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
            kept = preference_deletion_suggestions(
                config, purities=("sfw",), orientation="landscape"
            )
            self.assertEqual(kept["items"], [])

    def test_review_rank_preserves_a_strong_dislike_signal_in_mixed_preferences(self) -> None:
        model = PreferenceModel(
            bias=0.0,
            prior_log_odds=0.0,
            tag_weights={"asian": -1.4, "favorite one": -0.4, "favorite two": -0.4},
            combo_weights={},
            context_weights={"category:people": 0.5},
            threshold=0.98,
            trained_at="test",
            training_summary={},
            validation={},
            combo_min_support=20,
            max_combo_features=0,
        )
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            pool = config.download_dir / "sfw" / "portrait"
            pool.mkdir(parents=True)
            for filename in ("mixed-dislike.jpg", "protected-keep.jpg"):
                (pool / filename).touch()
            config.metadata_file.write_text(
                json.dumps(
                    {
                        "mixed-dislike.jpg": {
                            "tags": ["favorite one", "favorite two"],
                            "category": "people",
                        },
                        "protected-keep.jpg": {
                            "tags": ["favorite one", "favorite two", "asian"],
                            "category": "people",
                        },
                    }
                )
            )
            save_preference_model(model, config.preference_model_file)

            suggestions = preference_deletion_suggestions(
                config,
                purities=("sfw",),
                orientation="portrait",
            )

        self.assertEqual(suggestions["review_strategy"], "boosted_dislike_rank")
        self.assertEqual(
            [item["name"] for item in suggestions["items"]],
            ["mixed-dislike.jpg"],
        )
        item = suggestions["items"][0]
        self.assertLess(item["feature_score"], 0)
        self.assertGreater(item["review_score"], 0)
        self.assertEqual(item["strongest_review_dislike"]["feature"], "category: people")
        self.assertLess(
            item["strongest_review_keep_score"],
            item["strongest_review_dislike_score"],
        )

    def test_semantic_rank_does_not_promote_scores_below_the_review_boundary(self) -> None:
        model = PreferenceModel(
            bias=0.0,
            prior_log_odds=0.0,
            tag_weights={},
            combo_weights={},
            context_weights={},
            threshold=0.98,
            trained_at="test",
            training_summary={},
            validation={},
            combo_min_support=20,
            max_combo_features=0,
            semantic_model="test-semantic-model",
            semantic_weights=(1.0,),
            semantic_blend=0.65,
            semantic_rank_weight=1.0,
        )
        predictions = (
            PreferencePrediction(
                probability=0.49,
                score=-0.1,
                feature_score=-0.1,
                contributions=(),
                semantic_score=-0.01,
                semantic_probability=0.4975,
                semantic_available=True,
            ),
            PreferencePrediction(
                probability=0.48,
                score=-0.2,
                feature_score=-0.2,
                contributions=(),
                semantic_score=-0.02,
                semantic_probability=0.495,
                semantic_available=True,
            ),
            PreferencePrediction(
                probability=0.47,
                score=-0.3,
                feature_score=-0.3,
                contributions=(),
                semantic_score=-0.03,
                semantic_probability=0.4925,
                semantic_available=True,
            ),
        )
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            pool = config.download_dir / "sfw" / "landscape"
            pool.mkdir(parents=True)
            (pool / "higher.jpg").touch()
            (pool / "lower.jpg").touch()
            (pool / "lowest.jpg").touch()
            config.metadata_file.write_text(
                json.dumps(
                    {
                        "higher.jpg": {"tags": ["first"]},
                        "lower.jpg": {"tags": ["second"]},
                        "lowest.jpg": {"tags": ["third"]},
                    }
                )
            )
            save_preference_model(model, config.preference_model_file)

            with patch.object(PreferenceModel, "predict_many", return_value=predictions):
                suggestions = preference_deletion_suggestions(
                    config,
                    purities=("sfw",),
                    orientation="landscape",
                    limit=2,
                )

        self.assertEqual(suggestions["review_strategy"], "hybrid_semantic_rank")
        self.assertEqual(suggestions["items"], [])
        self.assertEqual(suggestions["diagnostics"]["candidate_count"], 0)
        self.assertEqual(suggestions["diagnostics"]["returned_count"], 0)
        self.assertEqual(suggestions["diagnostics"]["ranked_pool_count"], 0)
        self.assertEqual(suggestions["diagnostics"]["semantic_scored_images"], 3)
        self.assertEqual(suggestions["diagnostics"]["semantic_evidence_images"], 0)

    def test_review_boost_ignores_broad_color_and_purity_signals(self) -> None:
        model = PreferenceModel(
            bias=0.0,
            prior_log_odds=0.0,
            tag_weights={"subject": 0.25},
            combo_weights={},
            context_weights={
                "category:people": 0.5,
                "color:#ffffff": 1.2,
                "purity:sfw": 1.0,
            },
            threshold=0.98,
            trained_at="test",
            training_summary={},
            validation={},
            combo_min_support=20,
            max_combo_features=0,
        )

        prediction = model.predict(
            ["subject"],
            metadata={"category": "people", "colors": ["#ffffff"], "purity": "sfw"},
        )

        self.assertEqual(prediction.strongest_review_dislike_score, 0.5)
        self.assertEqual(prediction.strongest_review_dislike["feature"], "category: people")

    def test_review_rank_diversifies_repeated_primary_reasons(self) -> None:
        def item(name: str, reason: str, score: float) -> dict[str, object]:
            prediction = PreferencePrediction(
                probability=0.5,
                score=score,
                feature_score=score,
                contributions=(),
                strongest_review_dislike_score=score,
                strongest_review_dislike={"type": "tag", "feature": reason},
            )
            return {"name": name, "prediction": prediction, "review_score": score}

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

            model, snapshot = train_local_preference_model(
                config, max_combo_features=100, validation_days=0
            )
            save_preference_model(model, config.preference_model_file)
            self.assertFalse(preference_learning_status(config, model, snapshot)["stale"])

            for index in range(10):
                record_preference_feedback(config, "keep", f"keep{index}.jpg")
            status = preference_learning_status(config)

        self.assertTrue(status["stale"])
        self.assertEqual(status["pending_feedback"], 10)
        self.assertTrue(status["due"])

    def test_model_without_review_calibration_is_scheduled_for_upgrade(self) -> None:
        examples = [
            *_examples("ban", 10, ("bad", "detail"), 1),
            *_examples("keep", 10, ("good", "detail"), 0, start=1_700_001_000),
        ]
        model = train_preference_model(examples, validation_days=0)
        model.training_summary.pop("review_threshold")
        model.training_summary.pop("review_calibration")
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

        self.assertTrue(status["review_boundary_upgrade_due"])
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
        model = train_preference_model(examples, max_combo_features=100, validation_days=0)
        reweighted = [
            PreferenceExample(
                filename=example.filename,
                tags=example.tags,
                label=example.label,
                base_weight=example.base_weight * 0.9 if example.label else example.base_weight,
                timestamp=example.timestamp,
                is_favorite=example.is_favorite,
                is_explicit_keep=example.is_explicit_keep,
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

    def test_scheduler_detaches_one_worker_for_short_lived_callers(self) -> None:
        examples = [
            *_examples("ban", 10, ("bad", "detail"), 1),
            *_examples("keep", 10, ("good", "detail"), 0, start=1_700_001_000),
        ]
        model = train_preference_model(examples, max_combo_features=100, validation_days=0)
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
        model = train_preference_model(examples, max_combo_features=100, validation_days=0)
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
                validation_days=0,
            )
            save_preference_model(manual, config.preference_model_file)
            automatic = train_preference_model(
                list(snapshot.examples),
                max_combo_features=20,
                validation_days=0,
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
                validation_days=0,
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
        first = train_preference_model(examples, max_combo_features=100, validation_days=0)
        second = train_preference_model(examples, max_combo_features=20, validation_days=0)
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

    def test_auto_skip_needs_more_than_one_correct_high_score(self) -> None:
        model = train_preference_model(
            [
                *_examples("ban", 10, ("bad", "detail"), 1),
                *_examples("keep", 10, ("good", "detail"), 0, start=1_700_001_000),
            ],
            max_combo_features=100,
            validation_days=0,
        )
        model.validation = {
            "available": True,
            "precision_at_threshold": 1.0,
            "predicted_at_threshold": 1,
            "precision_lower_bound": 0.2,
        }
        self.assertFalse(auto_skip_ready(model))

    def test_human_review_filter_does_not_require_unattended_skip_validation(self) -> None:
        model = PreferenceModel(
            bias=-2.0,
            prior_log_odds=0.0,
            tag_weights={"likely block": 1.0, "likely keep": -1.0},
            combo_weights={},
            context_weights={"uploader:blocked user": 3.0},
            threshold=0.98,
            trained_at="test",
            training_summary={},
            validation={"available": False, "calibrated": False},
            combo_min_support=20,
            max_combo_features=0,
        )
        with tempfile.TemporaryDirectory() as td:
            status = auto_filter_status(WayperConfig(download_dir=Path(td)), model)

        held, held_prediction = auto_filter_prediction(
            model,
            {"tags": [{"name": "likely block"}]},
        )
        kept, _ = auto_filter_prediction(model, {"tags": ["likely keep"]})
        uploader_held, _ = auto_filter_prediction(
            model,
            {"tags": ["unknown"], "uploader": {"username": "blocked user"}},
        )

        self.assertTrue(status["ready"])
        self.assertEqual(status["status"], "ready")
        self.assertEqual(status["threshold_kind"], "calibrated_review_score")
        self.assertEqual(status["threshold"], 0.2)
        self.assertFalse(status["unattended_skip_ready"])
        self.assertTrue(held)
        self.assertLess(held_prediction.probability, model.threshold)
        self.assertTrue(uploader_held)
        self.assertFalse(kept)

    def test_human_review_filter_rejects_weak_dislike_evidence_below_boundary(self) -> None:
        model = PreferenceModel(
            bias=0.0,
            prior_log_odds=0.0,
            tag_weights={
                "risk": 0.1,
                "clear risk": 0.5,
                "counter": -0.25,
                "strong counter": -0.5,
            },
            combo_weights={},
            context_weights={},
            threshold=0.98,
            trained_at="test",
            training_summary={},
            validation={},
            combo_min_support=20,
            max_combo_features=0,
        )

        weak, weak_prediction = auto_filter_prediction(
            model,
            {"tags": ["risk", "counter"]},
        )
        clear, _ = auto_filter_prediction(model, {"tags": ["clear risk"]})
        protected, _ = auto_filter_prediction(
            model,
            {"tags": ["risk", "strong counter"]},
        )

        self.assertFalse(weak)
        self.assertLess(weak_prediction.feature_score, 0)
        self.assertTrue(clear)
        self.assertFalse(protected)

    def test_human_review_filter_accepts_semantic_evidence_only_above_shared_boundary(self) -> None:
        model = PreferenceModel(
            bias=0.0,
            prior_log_odds=0.0,
            tag_weights={},
            combo_weights={},
            context_weights={},
            threshold=0.98,
            trained_at="test",
            training_summary={},
            validation={},
            combo_min_support=20,
            max_combo_features=0,
            semantic_model="test-semantic-model",
            semantic_weights=(1.0,),
            semantic_blend=0.65,
        )
        semantic_hit = PreferencePrediction(
            probability=0.5,
            score=0.0,
            feature_score=0.0,
            contributions=(),
            semantic_score=0.8,
            semantic_probability=0.69,
            semantic_available=True,
        )
        semantic_keep = PreferencePrediction(
            probability=0.5,
            score=0.0,
            feature_score=0.0,
            contributions=(),
            semantic_score=-0.8,
            semantic_probability=0.31,
            semantic_available=True,
        )

        with patch.object(
            PreferenceModel,
            "predict",
            side_effect=(semantic_hit, semantic_keep),
        ):
            held, _ = auto_filter_prediction(model, {"tags": ["unseen dislike"]})
            kept, _ = auto_filter_prediction(model, {"tags": ["unseen keep"]})

        self.assertTrue(held)
        self.assertFalse(kept)

    def test_score_without_input_preserves_json_output(self) -> None:
        examples = [
            *_examples("ban", 10, ("bad", "detail"), 1),
            *_examples("keep", 10, ("good", "detail"), 0, start=1_700_001_000),
        ]
        model = train_preference_model(examples, max_combo_features=100, validation_days=0)
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
