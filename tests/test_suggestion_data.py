from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from click.testing import CliRunner

from wayper.ai_suggestions import _generate_ai_suggestions_impl
from wayper.cli import cli
from wayper.config import WayperConfig
from wayper.pool import favorites_dir, pool_dir
from wayper.suggestion_data import load_suggestion_catalog


class SuggestionDataTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.config = WayperConfig(download_dir=Path(self.directory.name))

    def write_metadata(self, names: list[str], *, purity: str = "nsfw") -> dict:
        metadata = {
            name: {"tags": ["specific", "detail"], "purity": purity, "uploader": "Artist"}
            for name in names
        }
        self.config.metadata_file.write_text(json.dumps(metadata))
        return metadata

    def write_history(self, names: list[str]) -> None:
        (self.config.download_dir / ".preference_historical_bans.json").write_text(
            json.dumps({"schema_version": 1, "bans": [[1, name] for name in names]})
        )

    def write_feedback(self, actions: list[tuple[str, str]]) -> None:
        self.config.preference_events_file.write_text(
            "\n".join(
                json.dumps(
                    {
                        "schema_version": 2,
                        "revision": revision,
                        "timestamp": 100 + revision,
                        "filename": filename,
                        "action": action,
                    }
                )
                for revision, (filename, action) in enumerate(actions, 1)
            )
            + "\n"
        )

    def touch_image(self, filename: str, *, favorite: bool = False) -> None:
        directory = (favorites_dir if favorite else pool_dir)(self.config, "nsfw", "landscape")
        directory.mkdir(parents=True, exist_ok=True)
        (directory / filename).touch()

    def make_suggestion_library(self) -> dict:
        names = [f"banned{index}.jpg" for index in range(12)]
        metadata = self.write_metadata([*names, "evicted.jpg", "sfw-only.jpg"])
        metadata["sfw-only.jpg"]["purity"] = "sfw"
        for index in range(40):
            filename = f"pool{index}.jpg"
            metadata[filename] = {"tags": ["landscape"], "purity": "nsfw"}
            self.touch_image(filename)
        self.config.metadata_file.write_text(json.dumps(metadata))
        self.config.state_file.write_text("nsfw")
        self.write_history([*names, "sfw-only.jpg"])
        return metadata

    def test_history_is_negative_and_unlabelled_missing_files_are_not_kept(self) -> None:
        self.write_metadata(["old.jpg", "blocked.jpg", "pool.jpg", "evicted.jpg"])
        self.write_history(["old.jpg"])
        self.config.blacklist_file.write_text("10 blocked.jpg\n")
        self.touch_image("pool.jpg")
        before = {
            path: path.read_bytes()
            for path in self.config.download_dir.rglob("*")
            if path.is_file()
        }

        catalog = load_suggestion_catalog(self.config)

        self.assertEqual(catalog.banned_filenames, {"old.jpg", "blocked.jpg"})
        self.assertEqual(
            catalog.summary,
            {
                "total_banned": 2,
                "total_kept": 1,
                "total_favorites": 0,
            },
        )
        self.assertIsNone(catalog.get("evicted.jpg"))
        self.assertEqual(
            before,
            {
                path: path.read_bytes()
                for path in self.config.download_dir.rglob("*")
                if path.is_file()
            },
        )

    def test_latest_corrections_override_history_without_reviving_expired_bans(self) -> None:
        names = ["unblocked.jpg", "keep.jpg", "unfavorite.jpg", "dislike.jpg", "ban.jpg"]
        self.write_metadata(names)
        self.write_history(names)
        self.config.blacklist_file.write_text("10 unblocked.jpg\n10 keep.jpg\n")
        self.write_feedback(
            [
                ("unblocked.jpg", "ban"),
                ("unblocked.jpg", "unban"),
                ("keep.jpg", "ban"),
                ("keep.jpg", "keep"),
                ("unfavorite.jpg", "favorite"),
                ("unfavorite.jpg", "unfavorite"),
                ("dislike.jpg", "keep"),
                ("dislike.jpg", "dislike"),
                ("ban.jpg", "ban"),
            ]
        )

        catalog = load_suggestion_catalog(self.config)

        self.assertEqual(catalog.banned_filenames, {"dislike.jpg", "ban.jpg"})
        self.assertEqual(set(catalog.metadata), {"keep.jpg", "dislike.jpg", "ban.jpg"})
        self.touch_image("unblocked.jpg")
        self.assertFalse(load_suggestion_catalog(self.config).get("unblocked.jpg").banned)

    def test_current_and_explicit_favorites_veto_historical_bans(self) -> None:
        self.write_metadata(["current.jpg", "explicit.jpg"])
        self.write_history(["current.jpg", "explicit.jpg"])
        self.config.blacklist_file.write_text("10 current.jpg\n10 explicit.jpg\n")
        self.touch_image("current.jpg", favorite=True)
        self.write_feedback([("explicit.jpg", "favorite")])

        catalog = load_suggestion_catalog(self.config)

        self.assertEqual(catalog.banned_filenames, set())
        self.assertEqual(catalog.favorite_filenames, {"current.jpg", "explicit.jpg"})
        self.assertEqual(catalog.tag_stats("specific").favorites, 2)
        self.write_feedback([("explicit.jpg", "favorite"), ("explicit.jpg", "unfavorite")])
        catalog = load_suggestion_catalog(self.config)
        self.assertIsNone(catalog.get("explicit.jpg"))
        self.assertEqual(catalog.favorite_filenames, {"current.jpg"})

    def test_neutral_model_actions_are_not_labels_but_later_decisions_are(self) -> None:
        names = ["pending.jpg", "filtered.jpg", "corrected.jpg"]
        self.write_metadata(names)
        self.write_history(names)
        self.config.blacklist_file.write_text("10 filtered.jpg\n")
        self.config.model_review_file.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "items": {
                        name: {
                            "name": name,
                            "path": f".model-review/nsfw/landscape/{name}",
                            "status": "pending" if name == "pending.jpg" else "filter",
                            "created_at": 1,
                            "resolved_at": 102,
                        }
                        for name in names
                    },
                }
            )
        )
        self.write_feedback(
            [
                ("pending.jpg", "ban"),
                ("filtered.jpg", "dislike"),
                ("corrected.jpg", "dislike"),
            ]
        )

        catalog = load_suggestion_catalog(self.config)

        self.assertEqual(set(catalog.metadata), {"corrected.jpg"})
        self.assertEqual(catalog.banned_filenames, {"corrected.jpg"})
        self.touch_image("filtered.jpg", favorite=True)
        self.assertTrue(load_suggestion_catalog(self.config).get("filtered.jpg").favorite)

    def test_api_and_cli_share_durable_evidence(self) -> None:
        from wayper.server.api import tag_stats, tag_suggestions, uploader_suggestions

        metadata = self.make_suggestion_library()
        with (
            patch("wayper.server.api.get_config", return_value=self.config),
            patch("wayper.server.api._get_metadata", return_value=metadata),
            patch("wayper.cli.load_config", return_value=self.config),
        ):
            tags = tag_suggestions()
            api_stats = tag_stats(tags="specific", purity="nsfw")
            api_uploaders = uploader_suggestions()
            cli_result = CliRunner().invoke(cli, ["--json", "suggest"])

        self.assertEqual(api_stats["tags"][0]["banned"], 12)
        self.assertEqual(api_stats["tags"][0]["kept"], 0)
        self.assertEqual(tags["suggestions"][0]["banned"], 12)
        self.assertTrue(tags["combo_suggestions"])
        self.assertEqual(api_uploaders["suggestions"][0]["ban_count"], 12)
        self.assertEqual(cli_result.exit_code, 0, cli_result.output)
        self.assertEqual(json.loads(cli_result.output)["suggestions"], tags["suggestions"])

    def test_ai_uses_history_even_when_current_blacklist_is_empty(self) -> None:
        self.make_suggestion_library()
        result = {
            "analysis": "Narrow historical pattern",
            "add_suggestions": [
                {
                    "type": "tag",
                    "tags": ["specific"],
                    "reason": "Historical bans",
                    "confidence": "high",
                }
            ],
            "remove_suggestions": [],
        }
        with patch(
            "wayper.ai_suggestions._invoke_codex", new=AsyncMock(return_value=result)
        ) as invoke:
            actual = asyncio.run(_generate_ai_suggestions_impl(self.config))

        invoke.assert_awaited_once()
        prompt = invoke.await_args.args[0]
        statistics = json.loads(prompt.split("## Local Statistics\n")[1].splitlines()[0])
        tag = next(item for item in statistics["tags"] if item["tag"] == "specific")
        self.assertEqual((tag["banned"], tag["kept"]), (12, 0))
        self.assertEqual(len(actual["add_suggestions"]), 1)
        stats = actual["add_suggestions"][0]["stats"]
        self.assertEqual((stats["banned"], stats["kept"]), (12, 0))


if __name__ == "__main__":
    unittest.main()
