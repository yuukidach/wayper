from __future__ import annotations

import copy
import subprocess
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from PIL import Image

from wayper.backend.greeter import GreeterError, install_greeter_image
from wayper.config import GreeterConfig, WayperConfig, load_config, save_config
from wayper.core import do_set_greeter
from wayper.rotation import update_greeter
from wayper.server import api
from wayper.server.config_service import config_payload
from wayper.server.schemas import ActionRequest, ConfigResponse


@pytest.fixture
def greeter_setup(tmp_path, monkeypatch):
    monkeypatch.setattr("wayper.backend.greeter.sys.platform", "linux")
    monkeypatch.setattr("wayper.config.CONFIG_FILE", tmp_path / "config.toml")
    monkeypatch.setattr("wayper.backend.detect_monitors", lambda: [])
    monkeypatch.setattr("wayper.lock.LOCK_PATH", tmp_path / "state.lock")
    config = WayperConfig(
        download_dir=tmp_path / "library",
        greeter=GreeterConfig(image=tmp_path / "greeter.jpg"),
    )
    image = config.download_dir / "sfw" / "landscape" / "chosen.jpg"
    image.parent.mkdir(parents=True)
    Image.new("RGB", (16, 9), "blue").save(image)
    save_config(config)
    return config, image


def test_selection_copies_and_persists_without_changing_desktop(greeter_setup, monkeypatch):
    config, image = greeter_setup
    desktop = Mock()
    monkeypatch.setattr("wayper.core.set_wallpaper", desktop)

    result = do_set_greeter(config, image)

    assert result.ok
    assert config.greeter.fixed_image == image.name
    saved = load_config()
    assert saved.greeter.fixed_image == image.name
    assert saved.greeter.image == config.greeter.image
    assert saved.interval == config.interval
    assert config.greeter.image.read_bytes() == image.read_bytes()
    assert config.greeter.image.stat().st_mode & 0o777 == 0o644
    image.unlink()
    assert config.greeter.image.is_file()
    desktop.assert_not_called()


def test_another_selection_replaces_fixed_background(greeter_setup):
    config, image = greeter_setup
    assert do_set_greeter(config, image).ok
    replacement = image.with_name("replacement.png")
    Image.new("RGB", (16, 9), "red").save(replacement)
    assert do_set_greeter(config, replacement).ok
    assert load_config().greeter.fixed_image == replacement.name
    assert config.greeter.image.read_bytes() == replacement.read_bytes()


def test_legacy_config_keeps_random_updates(greeter_setup):
    config, image = greeter_setup
    assert load_config().greeter.fixed_image is None
    update_greeter(config)
    assert config.greeter.image.read_bytes() == image.read_bytes()
    assert load_config().greeter.fixed_image is None


def test_stale_rotation_cannot_overwrite_a_fixed_selection(greeter_setup, monkeypatch):
    config, image = greeter_setup
    stale = copy.deepcopy(config)
    assert do_set_greeter(config, image).ok
    install = Mock()
    monkeypatch.setattr("wayper.rotation.install_greeter_image", install)
    update_greeter(stale)
    update_greeter(config)
    install.assert_not_called()


def test_removing_fixed_marker_resumes_random_updates(greeter_setup):
    config, image = greeter_setup
    assert do_set_greeter(config, image).ok
    config.greeter.fixed_image = None
    save_config(config)
    Image.new("RGB", (16, 9), "green").save(image)
    update_greeter(config)
    assert config.greeter.image.read_bytes() == image.read_bytes()


@pytest.mark.parametrize("platform", ["darwin", "win32"])
def test_unsupported_platform_does_not_write(greeter_setup, monkeypatch, platform):
    config, image = greeter_setup
    monkeypatch.setattr("wayper.backend.greeter.sys.platform", platform)
    with pytest.raises(GreeterError, match="only supported on Linux"):
        install_greeter_image(config.greeter, image)
    assert not config.greeter.image.exists()
    assert config_payload(config, {"sfw"})["greeter"]["available"] is False


def test_disabled_greeter_is_not_implicitly_enabled(greeter_setup):
    config, image = greeter_setup
    config.greeter.image = None
    save_config(config)
    result = do_set_greeter(config, image)
    assert not result.ok
    assert "Configure [greeter].image" in result.error
    assert load_config().greeter.image is None
    assert config_payload(config, {"sfw"})["greeter"]["available"] is False


def test_non_image_and_directory_target_are_rejected(greeter_setup):
    config, image = greeter_setup
    config.greeter.image.mkdir()
    with pytest.raises(GreeterError, match="not a directory"):
        install_greeter_image(config.greeter, image)
    image.write_text("not an image")
    with pytest.raises(GreeterError, match="not a readable image"):
        install_greeter_image(config.greeter, image)


@pytest.mark.parametrize("password", [None, "test-secret"])
def test_privileged_copy_is_bounded_and_noninteractive(greeter_setup, monkeypatch, password):
    config, image = greeter_setup
    config.greeter.sudo_password = password
    monkeypatch.setattr("wayper.backend.greeter.shutil.copyfile", Mock(side_effect=PermissionError))
    run = Mock()
    monkeypatch.setattr("wayper.backend.greeter.subprocess.run", run)
    install_greeter_image(config.greeter, image)
    args, kwargs = run.call_args
    assert args[0][:2] == ["sudo", "-S" if password else "-n"]
    assert args[0][-6:] == ["-m", "644", "-T", "--", str(image), str(config.greeter.image)]
    assert kwargs["input"] == (password.encode() if password else b"")
    assert kwargs["check"] is True
    assert kwargs["timeout"] == 15
    assert not password or password not in args[0]


@pytest.mark.parametrize(
    "error",
    [subprocess.CalledProcessError(1, "sudo"), subprocess.TimeoutExpired("sudo", 15)],
)
def test_failed_copy_does_not_persist_fixed_marker(greeter_setup, monkeypatch, error):
    config, image = greeter_setup
    monkeypatch.setattr("wayper.backend.greeter.shutil.copyfile", Mock(side_effect=PermissionError))
    monkeypatch.setattr("wayper.backend.greeter.subprocess.run", Mock(side_effect=error))
    result = do_set_greeter(config, image)
    assert not result.ok
    assert config.greeter.fixed_image is None
    assert load_config().greeter.fixed_image is None


def test_save_failure_reports_partial_success(greeter_setup, monkeypatch):
    config, image = greeter_setup
    monkeypatch.setattr("wayper.core.save_config", Mock(side_effect=OSError))
    result = do_set_greeter(config, image)
    assert not result.ok
    assert "could not be saved" in result.error
    assert config.greeter.fixed_image is None
    assert load_config().greeter.fixed_image is None


def test_api_sets_greeter_and_hides_credentials(greeter_setup, monkeypatch):
    config, image = greeter_setup
    config.greeter.sudo_password = "never-expose"
    monkeypatch.setattr(api, "get_config", lambda: config)
    reload = Mock()
    monkeypatch.setattr(api.rotation_service, "request_reload", reload)
    response = api.set_greeter_route(
        ActionRequest(image_path=image.relative_to(config.download_dir).as_posix())
    )
    assert response == {
        "status": "ok",
        "greeter": {"available": True, "fixed_image": image.name},
    }
    reload.assert_called_once()
    payload = ConfigResponse(**config_payload(config, {"sfw"})).model_dump()
    assert payload["greeter"] == response["greeter"]
    assert "never-expose" not in str(payload)


@pytest.mark.parametrize(
    ("path", "status"), [("../outside.jpg", 403), ("sfw/landscape/missing.jpg", 404)]
)
def test_api_rejects_invalid_paths(greeter_setup, monkeypatch, path, status):
    config, _ = greeter_setup
    monkeypatch.setattr(api, "get_config", lambda: config)
    install = Mock()
    monkeypatch.setattr(api, "do_set_greeter", install)
    with pytest.raises(HTTPException) as error:
        api.set_greeter_route(ActionRequest(image_path=path))
    assert error.value.status_code == status
    install.assert_not_called()


def test_api_surfaces_copy_failure(greeter_setup, monkeypatch):
    config, image = greeter_setup
    monkeypatch.setattr(api, "get_config", lambda: config)
    monkeypatch.setattr(
        "wayper.core.install_greeter_image", Mock(side_effect=GreeterError("Permission denied"))
    )
    with pytest.raises(HTTPException) as error:
        api.set_greeter_route(ActionRequest(image_path=str(image)))
    assert error.value.status_code == 400
    assert error.value.detail == "Permission denied"
