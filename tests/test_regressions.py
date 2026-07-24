from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import HTTPException

from wayper.config import MonitorConfig, WallhavenConfig, WayperConfig, load_config
from wayper.pool import load_metadata, save_metadata
from wayper.server.api import (
    ActionRequest,
    PreferenceFeedbackRequest,
    UnblockRequest,
    app,
    ban_image_route,
    get_config_route,
    preference_suggestion_feedback,
    preference_suggestions,
    remove_blocklist_entry,
    update_config_route,
)
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
                    return_value={"schema_version": 2, "feature_score": 1.25, "rank": 1},
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
        self.assertEqual(kwargs["preference_model"]["feature_score"], 1.25)

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
