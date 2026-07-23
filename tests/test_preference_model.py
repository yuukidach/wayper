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
    PreferenceExample,
    PreferenceTrainingSnapshot,
    _auto_retrain_lease_path,
    _bootstrap_historical_preference_bans,
    _build_feature_space,
    _claim_or_touch_auto_retrain_worker,
    _release_auto_retrain_worker,
    _save_automatic_preference_model,
    _save_manual_preference_model,
    _temporal_split,
    _training_data_signature,
    auto_skip_ready,
    build_training_examples,
    collect_preference_training_snapshot,
    load_preference_historical_bans,
    load_preference_model,
    preference_deletion_suggestions,
    preference_learning_status,
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

            record_preference_feedback(config, "keep", "bad-candidate.jpg")
            kept = preference_deletion_suggestions(
                config, purities=("sfw",), orientation="landscape"
            )
            self.assertEqual(kept["items"], [])

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
