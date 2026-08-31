from __future__ import annotations

import sys

import pytest

from wayper import autostart
from wayper.config import WayperConfig, load_config


@pytest.fixture(autouse=True)
def linux(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")


def _mock_windows_registration(monkeypatch, startup, registry):
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(autostart, "_windows_startup_path", lambda: startup)
    monkeypatch.setattr(autostart, "_windows_read_registration", lambda: registry.get("Wayper"))
    monkeypatch.setattr(
        autostart, "_windows_write_registration", lambda value: registry.update(Wayper=value)
    )
    monkeypatch.setattr(
        autostart, "_windows_delete_registration", lambda: registry.pop("Wayper", None)
    )


def test_enable_autostart_installs_hidden_graphical_service(tmp_path, monkeypatch):
    unit = tmp_path / "systemd" / "wayper.service"
    gui = tmp_path / "bin" / "wayper-gui"
    gui.parent.mkdir()
    gui.touch()
    calls = []
    config_path = tmp_path / "config.toml"

    monkeypatch.setattr(autostart, "_service_path", lambda: unit)
    monkeypatch.setattr(autostart, "_gui_executable", lambda: gui)
    monkeypatch.setattr(autostart, "_systemctl", lambda *args: calls.append(args))

    result = autostart.set_autostart(WayperConfig(), True, config_path=config_path)

    assert result.enabled is True
    assert calls == [("daemon-reload",), ("enable", "wayper.service")]
    assert "--hidden" in unit.read_text()
    assert "WantedBy=graphical-session.target" in unit.read_text()
    assert load_config(config_path).autostart is True


def test_failed_enable_does_not_persist_or_leave_service(tmp_path, monkeypatch):
    unit = tmp_path / "wayper.service"
    config_path = tmp_path / "config.toml"
    config = WayperConfig(autostart=False)

    monkeypatch.setattr(autostart, "_service_path", lambda: unit)
    monkeypatch.setattr(autostart, "_gui_executable", lambda: tmp_path / "wayper-gui")

    def fail(*_args):
        raise autostart.AutostartError("no user bus")

    monkeypatch.setattr(autostart, "_systemctl", fail)

    with pytest.raises(autostart.AutostartError, match="no user bus"):
        autostart.set_autostart(config, True, config_path=config_path)

    assert config.autostart is False
    assert not config_path.exists()
    assert not unit.exists()


def test_autostart_defaults_enabled(tmp_path):
    assert WayperConfig().autostart is True
    assert load_config(tmp_path / "missing.toml").autostart is True


def test_explicit_disabled_autostart_is_not_installed(tmp_path, monkeypatch):
    monkeypatch.setattr(autostart, "_service_path", lambda: tmp_path / "wayper.service")
    monkeypatch.setattr(
        autostart,
        "set_autostart",
        lambda *_args, **_kwargs: pytest.fail("disabled autostart must remain disabled"),
    )

    autostart.ensure_default_autostart(WayperConfig(autostart=False))


def test_macos_autostart_uses_launch_agent(tmp_path, monkeypatch):
    agent = tmp_path / "io.github.yuukidach.wayper.plist"
    gui = tmp_path / "Wayper.app" / "Contents" / "MacOS" / "wayper-gui"
    config_path = tmp_path / "config.toml"
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(autostart, "_launch_agent_path", lambda: agent)
    monkeypatch.setattr(autostart, "_gui_executable", lambda: gui)

    result = autostart.set_autostart(WayperConfig(), True, config_path=config_path)
    payload = autostart.plistlib.loads(agent.read_bytes())

    assert result.unit == agent
    assert payload["ProgramArguments"] == [str(gui), "--hidden"]
    assert payload["RunAtLoad"] is True


def test_windows_autostart_uses_run_registry_and_removes_legacy_script(tmp_path, monkeypatch):
    startup = tmp_path / "Startup" / "Wayper.cmd"
    startup.parent.mkdir()
    startup.write_text("legacy")
    gui = tmp_path / "Program Files" / "Wayper" / "wayper-gui.exe"
    config_path = tmp_path / "config.toml"
    registry = {}
    _mock_windows_registration(monkeypatch, startup, registry)
    monkeypatch.setattr(autostart, "_gui_executable", lambda: gui)

    result = autostart.set_autostart(WayperConfig(), True, config_path=config_path)

    assert result.unit == autostart._windows_registration()
    assert registry["Wayper"] == f'"{gui}" --hidden'
    assert not startup.exists()


def test_windows_disable_removes_registry_and_legacy_script(tmp_path, monkeypatch):
    startup = tmp_path / "Startup" / "Wayper.cmd"
    startup.parent.mkdir()
    startup.write_text("legacy")
    registry = {"Wayper": '"wayper-gui.exe" --hidden'}
    _mock_windows_registration(monkeypatch, startup, registry)

    autostart.set_autostart(WayperConfig(), False, config_path=tmp_path / "config.toml")

    assert "Wayper" not in registry
    assert not startup.exists()
