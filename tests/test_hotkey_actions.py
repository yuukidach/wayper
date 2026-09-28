from __future__ import annotations

import asyncio
import json
import threading
from unittest.mock import MagicMock, patch

import httpx
import pytest
from click.testing import CliRunner

from wayper.cli import cli
from wayper.config import WayperConfig
from wayper.core import CoreResult
from wayper.server.api import _library_state_token, app, control_action, sse_events
from wayper.server.client import try_control_action


@pytest.mark.parametrize("action", ["fav", "unfav", "ban", "dislike"])
def test_control_does_not_wait_for_cloud(action, tmp_path):
    config = WayperConfig(download_dir=tmp_path)
    with (
        patch("wayper.server.api.get_config", return_value=config),
        patch(f"wayper.server.api.do_{action}", return_value=CoreResult(action)) as handler,
    ):
        control_action(action, "DP-1", False)
    assert handler.call_args.kwargs["wait_remote"] is False


def test_hotkey_protocol_resolves_focused_monitor_and_preserves_open(tmp_path):
    config = WayperConfig(download_dir=tmp_path)
    image = tmp_path / "favorites/sfw/landscape/test.jpg"

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            capabilities = await client.get("/api/control")
            assert capabilities.json() == {
                "protocol": "wayper-control-v1",
                "download_dir": str(tmp_path),
            }
            result = await client.post("/api/control/fav", json={"open_url": True})
            assert result.status_code == 200
            assert result.json()["image"] == str(image)
            assert result.json()["monitor"] == "DP-1"

    with (
        patch("wayper.server.api.get_config", return_value=config),
        patch("wayper.backend.get_context", return_value=("DP-1", None, None)),
        patch(
            "wayper.server.api.do_fav",
            return_value=CoreResult("fav", monitor="DP-1", image=image),
        ) as handler,
    ):
        asyncio.run(run())
    handler.assert_called_once_with(config, "DP-1", open_url=True, wait_remote=False)


def response(payload, status=200):
    result = MagicMock(status=status)
    result.read.return_value = json.dumps(payload).encode()
    return result


@pytest.fixture
def connections(tmp_path):
    (tmp_path / "api.port").write_text("45123")
    probe, action = MagicMock(), MagicMock()
    probe.getresponse.return_value = response(
        {
            "protocol": "wayper-control-v1",
            "download_dir": str(tmp_path),
        }
    )
    with (
        patch("wayper.server.client.CONFIG_DIR", tmp_path),
        patch("wayper.server.client.HTTPConnection", side_effect=[probe, action]),
    ):
        yield probe, action


def test_client_returns_local_result_without_waiting_for_sync(tmp_path, connections):
    probe, action = connections
    image = tmp_path / "favorites/sfw/landscape/test.jpg"
    action.getresponse.return_value = response(
        {
            "status": "ok",
            "image": str(image),
            "monitor": "DP-1",
            "remote_sync": None,
        }
    )
    result = try_control_action(WayperConfig(download_dir=tmp_path), "fav", open_url=True)
    assert result.ok and result.image == image
    assert result.monitor == "DP-1"
    assert json.loads(action.request.call_args.args[2]) == {"open_url": True}


@pytest.mark.parametrize("failure", [TimeoutError(), ConnectionResetError()])
def test_post_failure_must_not_fall_back_and_delete_another_image(
    tmp_path,
    connections,
    failure,
):
    _, action = connections
    action.getresponse.side_effect = failure
    result = try_control_action(WayperConfig(download_dir=tmp_path), "ban")
    assert result is not None and not result.ok
    assert "Check the current wallpaper" in result.error


@pytest.mark.parametrize("case", ["unavailable", "old_server", "wrong_library"])
def test_probe_failure_allows_standalone_execution(tmp_path, connections, case):
    probe, action = connections
    if case == "unavailable":
        probe.request.side_effect = ConnectionRefusedError()
    elif case == "old_server":
        probe.getresponse.return_value = response({"detail": "Not Found"}, 404)
    else:
        probe.getresponse.return_value = response(
            {
                "protocol": "wayper-control-v1",
                "download_dir": str(tmp_path / "other"),
            }
        )
    assert try_control_action(WayperConfig(download_dir=tmp_path), "ban") is None
    action.request.assert_not_called()


@pytest.mark.parametrize("action", ["fav", "unfav", "ban", "dislike"])
def test_cli_preserves_json_when_service_handles_action(tmp_path, action):
    image = tmp_path / "wallhaven-test.jpg"
    with (
        patch("wayper.cli.load_config", return_value=WayperConfig(download_dir=tmp_path)),
        patch("wayper.logging.setup_logging"),
        patch(
            "wayper.server.client.try_control_action", return_value=CoreResult(action, image=image)
        ),
        patch(f"wayper.cli.do_{action}") as local,
    ):
        result = CliRunner().invoke(cli, ["--json", action])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["action"] == action and payload["image"] == str(image)
    local.assert_not_called()


def test_custom_config_bypasses_desktop(tmp_path):
    config_path = tmp_path / "config.toml"
    config_path.touch()
    with (
        patch("wayper.cli.load_config", return_value=WayperConfig(download_dir=tmp_path)),
        patch("wayper.logging.setup_logging"),
        patch("wayper.server.client.try_control_action") as remote,
        patch("wayper.cli.do_fav", return_value=CoreResult("fav", status="already_favorite")),
    ):
        result = CliRunner().invoke(cli, ["--config", str(config_path), "--json", "fav"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["status"] == "already_favorite"
    remote.assert_not_called()


def test_library_token_detects_move_without_scanning(tmp_path):
    config = WayperConfig(download_dir=tmp_path)
    pool = tmp_path / "sfw/landscape"
    favorites = tmp_path / "favorites/sfw/landscape"
    pool.mkdir(parents=True)
    favorites.mkdir(parents=True)
    image = pool / "test.jpg"
    image.touch()
    before = _library_state_token(config)
    image.rename(favorites / image.name)
    assert _library_state_token(config) != before


def test_sse_announces_external_library_change_on_first_tick(tmp_path):
    config = WayperConfig(download_dir=tmp_path)
    loop_thread = threading.get_ident()
    query_threads = []

    def query():
        query_threads.append(threading.get_ident())
        return {}

    async def tick(_):
        config.blacklist_file.write_text("123 test.jpg\n")

    async def run():
        with (
            patch("wayper.server.api.get_config", return_value=config),
            patch("wayper.server.api.query_current", side_effect=query),
            patch("wayper.server.api.asyncio.sleep", side_effect=tick),
        ):
            stream = (await sse_events()).body_iterator
            try:
                event = await anext(stream)
                assert json.loads(event.removeprefix("data: ")) == {"type": "library"}
            finally:
                await stream.aclose()

    asyncio.run(run())
    assert query_threads and all(t != loop_thread for t in query_threads)
