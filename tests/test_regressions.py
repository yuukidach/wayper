from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import HTTPException

from wayper.config import MonitorConfig, WallhavenConfig, WayperConfig, load_config
from wayper.model_review import queue_model_review_item
from wayper.pool import load_metadata, save_metadata
from wayper.server.api import (
    ActionRequest,
    ModelReviewActionRequest,
    PreferenceFeedbackRequest,
    UnblockRequest,
    app,
    ban_image_route,
    dislike_image_route,
    get_config_route,
    get_status,
    model_review_action_route,
    model_review_route,
    preference_suggestion_feedback,
    preference_suggestions,
    remove_blocklist_entry,
    update_config_route,
)
from wayper.state import write_mode
from wayper.wallhaven import WallhavenClient


class _FakeResponse:
    def __init__(self, status_code: int, payload: dict | None = None) -> None:
        self.status_code = status_code
        self._payload = payload or {}
        self.request = httpx.Request("GET", "https://wallhaven.test/search")
        self.response = httpx.Response(status_code, request=self.request)

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                "fake failure",
                request=self.request,
                response=self.response,
            )

    def json(self) -> dict:
        return self._payload


class _FakeAsyncClient:
    def __init__(self, pages: dict[int, _FakeResponse]) -> None:
        self.pages = pages

    async def get(self, _url: str, params: dict) -> _FakeResponse:
        return self.pages[int(params.get("page", 1))]

    async def aclose(self) -> None:
        pass


class RegressionTest(unittest.TestCase):
    def test_status_counts_follow_selected_monitor_orientation(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(
                download_dir=Path(td),
                monitors=[
                    MonitorConfig("landscape-monitor", 1920, 1080, "landscape"),
                    MonitorConfig("portrait-monitor", 1080, 1920, "portrait"),
                ],
            )
            write_mode(config, {"sfw"})
            for orientation, suffix in (("landscape", "wide"), ("portrait", "tall")):
                pool = config.download_dir / "sfw" / orientation
                favorite = config.download_dir / "favorites" / "sfw" / orientation
                pool.mkdir(parents=True)
                favorite.mkdir(parents=True)
                (pool / f"{suffix}.jpg").touch()
                (favorite / f"{suffix}.jpg").touch()
                review = config.model_review_dir / "sfw" / orientation / f"{suffix}.jpg"
                review.parent.mkdir(parents=True)
                review.touch()
                queue_model_review_item(
                    config,
                    review,
                    purity="sfw",
                    orientation=orientation,
                    prediction={"probability": 0.99},
                    strategy="model",
                )

            with (
                patch("wayper.server.api.get_config", return_value=config),
                patch("wayper.server.api.is_daemon_running", return_value=(False, None)),
            ):
                landscape = get_status(monitor="landscape-monitor", include_recoverable=False)
                portrait = get_status(monitor="portrait-monitor", include_recoverable=False)
                unscoped = get_status(include_recoverable=False)

        self.assertEqual(landscape.monitor, "landscape-monitor")
        self.assertEqual(landscape.orientation, "landscape")
        self.assertEqual((landscape.pool_count, landscape.favorites_count), (1, 1))
        self.assertEqual(landscape.model_review_count, 1)
        self.assertEqual(portrait.monitor, "portrait-monitor")
        self.assertEqual(portrait.orientation, "portrait")
        self.assertEqual((portrait.pool_count, portrait.favorites_count), (1, 1))
        self.assertEqual(portrait.model_review_count, 1)
        self.assertIsNone(unscoped.monitor)
        self.assertEqual((unscoped.pool_count, unscoped.favorites_count), (2, 2))
        self.assertEqual(unscoped.model_review_count, 2)

    def test_config_route_exposes_and_updates_wallhaven_batch_size(self) -> None:
        config = WayperConfig(wallhaven=WallhavenConfig(batch_size=7))

        with (
            patch("wayper.server.api.get_config", return_value=config),
            patch("wayper.server.api.save_config") as save_config,
            patch("wayper.server.api.request_config_reload"),
            patch("wayper.server.api._cached_config", None),
            patch("wayper.server.api._cached_mtime", 0),
        ):
            response = get_config_route()
            update_config_route({"wallhaven": {"batch_size": 9}})

        self.assertEqual(response["wallhaven"]["batch_size"], 7)
        self.assertEqual(config.wallhaven.batch_size, 9)
        save_config.assert_called_once_with(config)

    def test_config_route_exposes_and_normalizes_filter_strategy(self) -> None:
        config = WayperConfig(wallhaven=WallhavenConfig(filter_strategy="rules"))

        with (
            patch("wayper.server.api.get_config", return_value=config),
            patch("wayper.server.api.save_config"),
            patch("wayper.server.api.request_config_reload"),
            patch("wayper.server.api._cached_config", None),
            patch("wayper.server.api._cached_mtime", 0),
        ):
            update_config_route({"wallhaven": {"filter_mode": "both"}})
            response = get_config_route()

        self.assertEqual(config.wallhaven.filter_strategy, "rules+model")
        self.assertEqual(response["wallhaven"]["filter_strategy"], "rules+model")

    def test_config_load_clamps_wallhaven_batch_size_to_one(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "config.toml"
            path.write_text("[wallhaven]\nbatch_size = -2\n")

            config = load_config(path)

        self.assertEqual(config.wallhaven.batch_size, 1)

    def test_wallhaven_max_favorites_treats_failed_deep_pages_as_upper_bound(self) -> None:
        config = WayperConfig(
            api_key="test",
            wallhaven=WallhavenConfig(min_favorites=10),
        )
        client = WallhavenClient(config)
        asyncio.run(client.close())
        client.client = _FakeAsyncClient(
            {
                3: _FakeResponse(200, {"data": [{"favorites": 12}]}),
                4: _FakeResponse(200, {"data": [{"favorites": 9}]}),
                5: _FakeResponse(500),
            }
        )

        try:
            max_page = asyncio.run(client._max_favorites_page({}, 8, [{"favorites": 20}]))
        finally:
            asyncio.run(client.close())

        self.assertEqual(max_page, 3)

    def test_model_filter_quarantines_hits_without_validation_gate(self) -> None:
        from wayper.model_review import list_model_review_items
        from wayper.preference_model import PreferenceModel, save_preference_model

        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(
                download_dir=Path(td),
                wallhaven=WallhavenConfig(filter_strategy="model", batch_size=1),
            )
            model = PreferenceModel(
                bias=-2.0,
                prior_log_odds=0.0,
                tag_weights={"likely block": 3.0},
                combo_weights={},
                context_weights={},
                threshold=0.98,
                trained_at="test",
                training_summary={},
                validation={"available": False, "calibrated": False},
                combo_min_support=20,
                max_combo_features=0,
            )
            save_preference_model(model, config.preference_model_file)
            item = {
                "id": "candidate",
                "path": "https://wallhaven.test/candidate.jpg",
                "favorites": 10,
            }
            detail = {
                **item,
                "tags": [{"name": "likely block"}],
                "purity": "sfw",
                "category": "general",
            }
            client = WallhavenClient(config)
            client.search = AsyncMock(return_value=[item])
            client.wallpaper_info = AsyncMock(return_value=detail)

            async def download(_url: str, destination: Path) -> bool:
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(b"candidate")
                return True

            client.download_image = AsyncMock(side_effect=download)
            try:
                asyncio.run(client.download_for("landscape", "sfw"))
            finally:
                asyncio.run(client.close())

            held = list_model_review_items(config)

        self.assertEqual(len(held), 1)
        self.assertEqual(held[0]["name"], "candidate.jpg")
        self.assertTrue(held[0]["auto_filtered"])

    def test_metadata_load_tolerates_trailing_data_and_save_repairs_file(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            config.metadata_file.write_text('{"old.jpg": {"tags": ["a"]}}\n trailing junk')

            self.assertEqual(load_metadata(config)["old.jpg"]["tags"], ["a"])

            save_metadata(
                config,
                "new.jpg",
                {
                    "id": "new",
                    "tags": [{"name": "b"}],
                    "uploader": {"username": "user"},
                },
            )

            repaired = json.loads(config.metadata_file.read_text())
            self.assertIn("old.jpg", repaired)
            self.assertEqual(repaired["new.jpg"]["tags"], ["b"])

    def test_trash_routes_support_head_for_permission_probe(self) -> None:
        methods_by_path: dict[str, set[str]] = {}
        for route in app.routes:
            path = getattr(route, "path", "")
            methods = getattr(route, "methods", set()) or set()
            methods_by_path.setdefault(path, set()).update(methods)

        self.assertIn("HEAD", methods_by_path["/trash/{filename}"])
        self.assertIn("HEAD", methods_by_path["/trash-thumbnails/{filename}"])

    def test_do_next_records_last_wallpaper_change(self) -> None:
        from wayper.core import do_next
        from wayper.state import read_last_wallpaper_change

        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(
                download_dir=Path(td),
                monitors=[MonitorConfig("main", 1920, 1080, "landscape")],
            )
            image = config.download_dir / "sfw" / "landscape" / "next.jpg"
            image.parent.mkdir(parents=True)
            image.touch()

            with (
                patch("wayper.core.pick_next", return_value=image),
                patch("wayper.core.set_wallpaper") as set_wallpaper,
                patch("wayper.state.time.time", return_value=1234.5),
            ):
                result = do_next(config, "main")

            self.assertTrue(result.ok)
            set_wallpaper.assert_called_once_with("main", image, config.transition)
            self.assertEqual(read_last_wallpaper_change(config), 1234.5)

    def test_seconds_until_next_rotation_uses_last_wallpaper_change(self) -> None:
        from wayper.daemon import seconds_until_next_rotation
        from wayper.state import record_wallpaper_change

        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td), interval=300)
            record_wallpaper_change(config, when=1000.0)

            self.assertEqual(seconds_until_next_rotation(config, now=1175.0), 125.0)
            self.assertEqual(seconds_until_next_rotation(config, now=1400.0), 0.0)
            self.assertEqual(seconds_until_next_rotation(config, now=900.0), 300.0)

    def test_preference_suggestion_routes_are_review_only_and_record_keep_feedback(self) -> None:
        from wayper.preference_model import load_preference_feedback

        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            image = config.download_dir / "sfw" / "landscape" / "candidate.jpg"
            image.parent.mkdir(parents=True)
            image.touch()

            with patch("wayper.server.api.get_config", return_value=config):
                untrained = preference_suggestions(purity="sfw", orient="landscape")
                with patch(
                    "wayper.preference_model.preference_deletion_suggestions",
                    return_value={"items": [{"path": "sfw/landscape/candidate.jpg"}]},
                ):
                    response = preference_suggestion_feedback(
                        PreferenceFeedbackRequest(path="sfw/landscape/candidate.jpg", action="keep")
                    )

            feedback = load_preference_feedback(config)

        self.assertEqual(untrained["status"], "untrained")
        self.assertEqual(untrained["items"], [])
        self.assertEqual(response["status"], "ok")
        self.assertEqual(feedback["revision"], 1)
        self.assertEqual(feedback["events"][0]["action"], "keep")
        self.assertEqual(feedback["events"][0]["context"], "model_review")

    def test_automatic_model_review_keep_moves_quarantine_to_pool_and_records_label(self) -> None:
        from wayper.model_review import queue_model_review_item
        from wayper.preference_model import load_preference_feedback

        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(
                download_dir=Path(td),
                wallhaven=WallhavenConfig(filter_strategy="model"),
            )
            image = config.model_review_dir / "sfw" / "landscape" / "candidate.jpg"
            image.parent.mkdir(parents=True)
            image.touch()
            queue_model_review_item(
                config,
                image,
                purity="sfw",
                orientation="landscape",
                prediction={"probability": 0.99, "threshold": 0.98},
                strategy="model",
            )

            with patch("wayper.server.api.get_config", return_value=config):
                pending = model_review_route(purity="sfw", orient="landscape")
                response = model_review_action_route(
                    ModelReviewActionRequest(
                        path=".model-review/sfw/landscape/candidate.jpg",
                        action="keep",
                    )
                )

            feedback = load_preference_feedback(config)

        self.assertEqual(len(pending["items"]), 1)
        self.assertTrue(pending["items"][0]["auto_filtered"])
        self.assertEqual(response["review"]["new_path"], "sfw/landscape/candidate.jpg")
        self.assertEqual(feedback["events"][0]["action"], "keep")
        self.assertEqual(feedback["events"][0]["source"], "model_filter")

    def test_model_review_queue_keeps_same_named_files_and_scopes_counts(self) -> None:
        from wayper.model_review import (
            list_model_review_items,
            pending_model_review_count,
            queue_model_review_item,
        )

        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            for purity, orientation in (("sfw", "landscape"), ("nsfw", "portrait")):
                image = config.model_review_dir / purity / orientation / "same.jpg"
                image.parent.mkdir(parents=True)
                image.touch()
                queue_model_review_item(
                    config,
                    image,
                    purity=purity,
                    orientation=orientation,
                    prediction={"probability": 0.99},
                    strategy="model",
                )

            self.assertEqual(pending_model_review_count(config), 2)
            self.assertEqual(
                pending_model_review_count(config, purities=("sfw",)),
                1,
            )
            self.assertEqual(
                pending_model_review_count(config, orientation="portrait"),
                1,
            )
            self.assertEqual(
                {item["path"] for item in list_model_review_items(config)},
                {
                    ".model-review/sfw/landscape/same.jpg",
                    ".model-review/nsfw/portrait/same.jpg",
                },
            )

    def test_preference_keep_feedback_rejects_non_candidates_and_unblock_paths(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            image = config.download_dir / "sfw" / "landscape" / "candidate.jpg"
            image.parent.mkdir(parents=True)
            image.touch()
            config.blacklist_file.write_text("100 candidate.jpg\n")

            with patch("wayper.server.api.get_config", return_value=config):
                with self.assertRaises(HTTPException) as candidate_error:
                    preference_suggestion_feedback(
                        PreferenceFeedbackRequest(path="sfw/landscape/candidate.jpg", action="keep")
                    )
                with self.assertRaises(HTTPException) as traversal_error:
                    remove_blocklist_entry(UnblockRequest(filename="../candidate.jpg"))
                unchanged = remove_blocklist_entry(UnblockRequest(filename="missing.jpg"))

            from wayper.preference_model import load_preference_feedback

            feedback = load_preference_feedback(config)

        self.assertEqual(candidate_error.exception.status_code, 409)
        self.assertEqual(traversal_error.exception.status_code, 400)
        self.assertFalse(unchanged["removed"])
        self.assertEqual(feedback["events"], [])

    def test_model_review_ban_passes_server_observed_context_to_core(self) -> None:
        from wayper.core import CoreResult

        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            image = config.download_dir / "sfw" / "landscape" / "candidate.jpg"
            image.parent.mkdir(parents=True)
            image.touch()
            result = CoreResult(action="ban", image=image, extra={"replacement_images": {}})

            with (
                patch("wayper.server.api.get_config", return_value=config),
                patch(
                    "wayper.server.api._model_review_feedback",
                    return_value={
                        "schema_version": 2,
                        "feature_score": -0.25,
                        "review_score": 1.25,
                        "strongest_review_dislike_score": 1.0,
                        "rank": 1,
                    },
                ),
                patch("wayper.server.api.do_ban", return_value=result) as do_ban,
            ):
                response = ban_image_route(
                    ActionRequest(
                        image_path="sfw/landscape/candidate.jpg",
                        preference_context="model_review",
                    )
                )

        self.assertEqual(response["status"], "ok")
        kwargs = do_ban.call_args.kwargs
        self.assertEqual(kwargs["preference_context"], "model_review")
        self.assertEqual(kwargs["preference_model"]["feature_score"], -0.25)
        self.assertEqual(kwargs["preference_model"]["review_score"], 1.25)

    def test_manual_dislike_records_distinct_feedback_and_blocks_exact_image(self) -> None:
        from wayper.core import do_ban, do_dislike
        from wayper.preference_model import load_preference_feedback

        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            image = config.download_dir / "sfw" / "landscape" / "missed.jpg"
            image.parent.mkdir(parents=True)
            image.touch()
            ordinary_ban = image.with_name("tired.jpg")
            review_dislike = image.with_name("review.jpg")
            ordinary_ban.touch()
            review_dislike.touch()

            with (
                patch("wayper.core._replace_on_all_monitors", return_value={}),
                patch("wayper.core.push_undo") as push_undo,
                patch("wayper.core._schedule_preference_model_retrain"),
                patch("wayper.wallhaven_web.wallhaven_web_unfav", return_value="queued"),
            ):
                result = do_dislike(config, image=image, wait_remote=False)
                do_ban(config, image=ordinary_ban, wait_remote=False)
                do_ban(
                    config,
                    image=review_dislike,
                    wait_remote=False,
                    preference_context="model_review",
                )

            feedback = load_preference_feedback(config)
            blacklist = config.blacklist_file.read_text()

        self.assertTrue(result.ok)
        self.assertEqual(result.action, "dislike")
        self.assertIn("missed.jpg", blacklist)
        self.assertEqual(push_undo.call_count, 3)
        push_undo.assert_any_call(config, "missed.jpg", image.parent)
        self.assertEqual(
            [event["action"] for event in feedback["events"]],
            ["dislike", "ban", "dislike"],
        )
        self.assertEqual(feedback["events"][0]["context"], "manual_dislike")
        self.assertEqual(feedback["events"][2]["context"], "model_review")

    def test_dislike_image_route_uses_explicit_dislike_core_action(self) -> None:
        from wayper.core import CoreResult

        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            image = config.download_dir / "sfw" / "landscape" / "candidate.jpg"
            image.parent.mkdir(parents=True)
            image.touch()
            result = CoreResult(action="dislike", image=image, extra={"replacement_images": {}})

            with (
                patch("wayper.server.api.get_config", return_value=config),
                patch("wayper.server.api.do_dislike", return_value=result) as do_dislike,
                patch(
                    "wayper.server.api._preference_learning_payload",
                    return_value={"due": False},
                ),
            ):
                response = dislike_image_route(
                    ActionRequest(image_path="sfw/landscape/candidate.jpg")
                )

        self.assertEqual(response["status"], "ok")
        self.assertEqual(response["learning"], {"due": False})
        kwargs = do_dislike.call_args.kwargs
        self.assertEqual(kwargs["image"], image.resolve())
        self.assertFalse(kwargs["wait_remote"])
        self.assertTrue(callable(kwargs["clear_thumbnail"]))

    def test_dislike_cli_preserves_json_output(self) -> None:
        from click.testing import CliRunner

        from wayper.cli import cli
        from wayper.core import CoreResult

        config = WayperConfig()
        image = Path("/tmp/missed.jpg")
        with (
            patch("wayper.cli.load_config", return_value=config),
            patch(
                "wayper.cli.do_dislike",
                return_value=CoreResult(action="dislike", image=image),
            ),
        ):
            result = CliRunner().invoke(cli, ["--json", "dislike"])

        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual(json.loads(result.output), {"action": "dislike", "image": str(image)})

    def test_preference_keep_feedback_reports_a_ledger_write_failure(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            image = config.download_dir / "sfw" / "landscape" / "candidate.jpg"
            image.parent.mkdir(parents=True)
            image.touch()

            with (
                patch("wayper.server.api.get_config", return_value=config),
                patch(
                    "wayper.preference_model.preference_deletion_suggestions",
                    return_value={"items": [{"path": "sfw/landscape/candidate.jpg"}]},
                ),
                patch(
                    "wayper.preference_model.record_preference_feedback",
                    side_effect=OSError("disk full"),
                ),
            ):
                with self.assertLogs("wayper.api", level="WARNING"):
                    with self.assertRaises(HTTPException) as error:
                        preference_suggestion_feedback(
                            PreferenceFeedbackRequest(
                                path="sfw/landscape/candidate.jpg", action="keep"
                            )
                        )

        self.assertEqual(error.exception.status_code, 500)

    def test_mcp_delete_records_ban_feedback_only_when_blacklisted(self) -> None:
        from wayper.core import CoreResult
        from wayper.mcp_server import delete_wallpaper

        with tempfile.TemporaryDirectory() as td:
            config = WayperConfig(download_dir=Path(td))
            ordinary = config.download_dir / "sfw" / "landscape" / "ordinary.jpg"
            blacklisted = config.download_dir / "sfw" / "landscape" / "blacklisted.jpg"
            ordinary.parent.mkdir(parents=True)
            ordinary.touch()
            blacklisted.touch()

            with (
                patch("wayper.mcp_server._config", return_value=config),
                patch(
                    "wayper.mcp_server.do_ban",
                    return_value=CoreResult(action="ban", image=blacklisted),
                ) as do_ban,
            ):
                ordinary_result = delete_wallpaper(str(ordinary))
                blacklisted_result = delete_wallpaper(str(blacklisted), add_to_blacklist_flag=True)
                directory_result = delete_wallpaper(
                    str(ordinary.parent), add_to_blacklist_flag=True
                )
                ordinary_deleted = not ordinary.exists()
                blacklisted_still_present = blacklisted.exists()

        self.assertFalse(ordinary_result["blacklisted"])
        self.assertTrue(blacklisted_result["blacklisted"])
        self.assertTrue(ordinary_deleted)
        self.assertTrue(blacklisted_still_present)
        self.assertIn("error", directory_result)
        do_ban.assert_called_once_with(config, image=blacklisted, wait_remote=False)


if __name__ == "__main__":
    unittest.main()
