from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import httpx
import pytest

from wayper.backend.linux import LinuxBackend
from wayper.config import (
    NO_TRANSITION,
    MonitorConfig,
    TransitionConfig,
    WayperConfig,
    load_config,
    save_config,
)
from wayper.core import do_fav, do_unfav
from wayper.server import api
from wayper.server.config_service import config_payload
from wayper.server.schemas import ConfigResponse


@pytest.fixture
def resize_config(tmp_path, monkeypatch):
    monitors = [MonitorConfig("DP-1", 1920, 1080, "landscape")]
    monkeypatch.setattr("wayper.config.CONFIG_FILE", tmp_path / "config.toml")
    monkeypatch.setattr("wayper.lock.LOCK_PATH", tmp_path / "state.lock")
    monkeypatch.setattr("wayper.backend.detect_monitors", lambda: monitors)
    monkeypatch.setattr("wayper.server.config_service.sys", SimpleNamespace(platform="linux"))
    monkeypatch.setattr(api, "_cached_config", None)
    monkeypatch.setattr(api, "_cached_mtime", 0)
    monkeypatch.setattr(api.rotation_service, "request_reload", Mock())
    config = WayperConfig(
        download_dir=tmp_path / "library",
        monitors=monitors,
        transition=TransitionConfig(type="wipe", duration=1.25, fps=30, resize="fit"),
    )
    save_config(config)
    return config


@pytest.mark.parametrize("mode", ["crop", "fit", "stretch", "no", "  FIT  ", "invalid"])
def test_api_persists_resize_and_passes_it_to_linux(resize_config, mode):
    expected = "fit" if mode == "  FIT  " else "crop" if mode == "invalid" else mode

    async def update():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=api.app), base_url="http://wayper.test"
        ) as client:
            initial = await client.get("/api/config")
            assert initial.json()["transition"] == {"resize": "fit", "resize_available": True}
            response = await client.patch("/api/config", json={"transition": {"resize": mode}})
            assert response.status_code == 200
            response = await client.get("/api/config")
            assert response.status_code == 200
            assert response.json()["transition"] == {
                "resize": expected,
                "resize_available": True,
            }
            # Unrelated settings and empty transition updates must retain the choice.
            await client.patch("/api/config", json={"language": "zh", "transition": {}})

    asyncio.run(update())
    saved = load_config()
    assert saved.transition == TransitionConfig(type="wipe", duration=1.25, fps=30, resize=expected)
    assert saved.language == "zh"

    image = resize_config.download_dir / "original.jpg"
    with patch(
        "wayper.backend.linux.subprocess.run",
        return_value=subprocess.CompletedProcess([], 0),
    ) as run:
        LinuxBackend().set_wallpaper("DP-1", image, saved.transition)
    command = run.call_args.args[0]
    assert command[command.index("--resize") + 1] == expected
    assert command[command.index("--filter") + 1] == "Lanczos3"


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        ("", "crop"),
        ('[transition]\nresize = " Stretch "', "stretch"),
        ('[transition]\nresize = "unknown"', "crop"),
        ("[transition]\nresize = false", "crop"),
        ("[transition]\nresize = 123", "crop"),
    ],
)
def test_legacy_and_hand_edited_resize_configs(resize_config, tmp_path, content, expected):
    path = tmp_path / "hand-edited.toml"
    path.write_text(content, encoding="utf-8")
    config = load_config(path)
    assert config.transition.resize == expected
    save_config(config, path)
    assert load_config(path).transition.resize == expected


@pytest.mark.parametrize("platform", ["linux", "win32", "darwin"])
def test_resize_availability_survives_response_serialization(monkeypatch, platform):
    monkeypatch.setattr("wayper.server.config_service.sys", SimpleNamespace(platform=platform))
    config = WayperConfig(transition=TransitionConfig(resize="no"))
    payload = ConfigResponse(**config_payload(config, {"sfw"})).model_dump()
    assert payload["transition"] == {"resize": "no", "resize_available": platform == "linux"}


@pytest.mark.parametrize("mode", ["crop", "fit", "stretch", "no"])
@pytest.mark.parametrize("by_image", [False, True])
def test_favorite_moves_keep_resize(resize_config, monkeypatch, mode, by_image):
    config = resize_config
    config.transition.resize = mode
    image = config.download_dir / "sfw" / "landscape" / "original.jpg"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"original image")
    current = {"DP-1": image}

    def show(monitor: str, path: Path, transition: TransitionConfig) -> None:
        current[monitor] = path

    display = Mock(side_effect=show)
    monkeypatch.setattr("wayper.core.query_current", lambda: current)
    monkeypatch.setattr("wayper.core.set_wallpaper", display)
    monkeypatch.setattr("wayper.core._record_preference_feedback", Mock())
    monkeypatch.setattr("wayper.core._schedule_preference_model_retrain", Mock())
    monkeypatch.setattr("wayper.wallhaven_web.wallhaven_web_fav", Mock())
    monkeypatch.setattr("wayper.wallhaven_web.wallhaven_web_unfav", Mock())

    favorite = do_fav(config, image=image) if by_image else do_fav(config, "DP-1")
    assert favorite.ok
    unfavorite = do_unfav(config, image=favorite.image) if by_image else do_unfav(config, "DP-1")
    assert unfavorite.ok
    assert image.read_bytes() == b"original image"
    assert display.call_count == 2
    for call in display.call_args_list:
        assert call.args[2] == TransitionConfig(type="none", duration=0, fps=60, resize=mode)
    assert config.transition == TransitionConfig(type="wipe", duration=1.25, fps=30, resize=mode)
    assert NO_TRANSITION.resize == "crop"
