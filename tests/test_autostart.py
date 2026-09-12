from __future__ import annotations

import sys

import pytest

from wayper import autostart
from wayper.config import WayperConfig, load_config


@pytest.fixture(autouse=True)
def linux(monkeypatch, tmp_path_factory):
    # Resolve pytest's base temp directory before changing the process-wide
    # platform value. On Windows, pytest otherwise looks for os.getuid().
    tmp_path_factory.getbasetemp()
    monkeypatch.setattr(sys, "platform", "linux")


def _mock_windows_registration(monkeypatch, startup, launcher, registry):
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(autostart, "_windows_startup_path", lambda: startup)
    monkeypatch.setattr(autostart, "_windows_launcher_path", lambda: launcher)
    monkeypatch.setattr(autostart, "_windows_needs_script_launcher", lambda: False)
    monkeypatch.setattr(autostart, "_windows_read_registration", lambda: registry.get("Wayper"))
    monkeypatch.setattr(
        autostart, "_windows_write_registration", lambda value: registry.update(Wayper=value)
    )
    monkeypatch.setattr(
        autostart, "_windows_delete_registration", lambda: registry.pop("Wayper", None)
    )


def test_enable_autostart_installs_hidden_graphical_service(tmp_path, monkeypatch):
    unit = tmp_path / "systemd" / "wayper.service"
    gui = tmp_path / "bin" / "wayper"
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
    assert f'ExecStart="{gui}" --hidden' in unit.read_text()
    assert "WantedBy=graphical-session.target" in unit.read_text()
    assert load_config(config_path).autostart is True


def test_failed_enable_does_not_persist_or_leave_service(tmp_path, monkeypatch):
    unit = tmp_path / "wayper.service"
    config_path = tmp_path / "config.toml"
    config = WayperConfig(autostart=False)

    monkeypatch.setattr(autostart, "_service_path", lambda: unit)
    monkeypatch.setattr(autostart, "_gui_executable", lambda: tmp_path / "wayper")

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
    gui = tmp_path / "Wayper.app" / "Contents" / "MacOS" / "wayper"
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
    launcher = tmp_path / "config" / "WayperAutostart.vbs"
    startup.parent.mkdir()
    startup.write_text("legacy")
    gui = tmp_path / "Program Files" / "Wayper" / "wayper.exe"
    config_path = tmp_path / "config.toml"
    registry = {}
    _mock_windows_registration(monkeypatch, startup, launcher, registry)
    monkeypatch.setattr(autostart, "_gui_executable", lambda: gui)

    result = autostart.set_autostart(WayperConfig(), True, config_path=config_path)

    assert result.unit == autostart._windows_registration()
    assert registry["Wayper"] == f'"{gui}" --hidden'
    assert not startup.exists()
    assert not launcher.exists()


def test_windows_uv_environment_uses_hidden_script_launcher(tmp_path, monkeypatch):
    startup = tmp_path / "Startup" / "Wayper.cmd"
    launcher = tmp_path / "config" / "WayperAutostart.vbs"
    python = tmp_path / "venv" / "Scripts" / "python.exe"
    gui = python.with_name("wayper.exe")
    registry = {}
    _mock_windows_registration(monkeypatch, startup, launcher, registry)
    monkeypatch.setattr(autostart, "_windows_needs_script_launcher", lambda: True)
    monkeypatch.setattr(autostart, "_gui_executable", lambda: gui)
    monkeypatch.setattr(autostart, "_windows_uv_launch_arguments", lambda: None)
    monkeypatch.setattr(sys, "executable", str(python))

    autostart.set_autostart(WayperConfig(), True, config_path=tmp_path / "config.toml")

    assert registry["Wayper"] == f'wscript.exe //B //NoLogo "{launcher}"'
    assert f'"""{python}"" -m wayper.server.launcher --hidden' in launcher.read_text()


def test_windows_source_autostart_uses_uv_instead_of_venv_python(tmp_path, monkeypatch):
    startup = tmp_path / "Startup" / "Wayper.cmd"
    launcher = tmp_path / "config" / "WayperAutostart.vbs"
    gui = tmp_path / "venv" / "Scripts" / "wayper.exe"
    registry = {}
    uv_arguments = [
        str(tmp_path / "uv.exe"),
        "run",
        "--project",
        str(tmp_path / "project with spaces"),
        "python",
        "-m",
        "wayper.server.launcher",
        "--hidden",
    ]
    _mock_windows_registration(monkeypatch, startup, launcher, registry)
    monkeypatch.setattr(autostart, "_windows_needs_script_launcher", lambda: True)
    monkeypatch.setattr(autostart, "_gui_executable", lambda: gui)
    monkeypatch.setattr(autostart, "_windows_uv_launch_arguments", lambda: uv_arguments)

    autostart.set_autostart(WayperConfig(), True, config_path=tmp_path / "config.toml")

    contents = launcher.read_text()
    assert str(tmp_path / "uv.exe") in contents
    assert 'run --project ""' in contents
    assert ".venv\\Scripts\\python.exe" not in contents


def test_windows_disable_removes_registry_and_legacy_script(tmp_path, monkeypatch):
    startup = tmp_path / "Startup" / "Wayper.cmd"
    launcher = tmp_path / "config" / "WayperAutostart.vbs"
    startup.parent.mkdir()
    startup.write_text("legacy")
    launcher.parent.mkdir()
    launcher.write_text("legacy")
    registry = {"Wayper": '"wayper-gui.exe" --hidden'}
    _mock_windows_registration(monkeypatch, startup, launcher, registry)

    autostart.set_autostart(WayperConfig(), False, config_path=tmp_path / "config.toml")

    assert "Wayper" not in registry
    assert not startup.exists()
    assert not launcher.exists()


@pytest.mark.parametrize("platform", ["linux", "darwin", "win32"])
@pytest.mark.parametrize("legacy", [False, True])
def test_autostart_prefers_current_installation(tmp_path, monkeypatch, platform, legacy):
    monkeypatch.setattr(sys, "platform", platform)
    suffix = ".exe" if platform == "win32" else ""
    app = tmp_path / "current" / f"wayper{suffix}"
    app.parent.mkdir()
    app.touch()
    invoked = app.with_name(f"wayper-gui{suffix}") if legacy else app
    invoked.touch(exist_ok=True)
    monkeypatch.setattr(sys, "argv", [str(invoked)])
    monkeypatch.setattr(sys, "executable", str(tmp_path / "python"))
    monkeypatch.setattr(autostart.shutil, "which", lambda _: str(tmp_path / "other" / app.name))

    assert autostart._gui_executable() == app


def test_autostart_finds_entry_next_to_virtualenv_python(tmp_path, monkeypatch):
    python = tmp_path / "venv" / "bin" / "python"
    python.parent.mkdir(parents=True)
    try:
        python.symlink_to(sys.executable)
    except OSError:
        pytest.skip("Creating symlinks is not permitted on this platform")
    app = python.with_name("wayper")
    app.touch()
    monkeypatch.setattr(sys, "argv", ["launcher.py"])
    monkeypatch.setattr(sys, "executable", str(python))
    monkeypatch.setattr(autostart.shutil, "which", lambda _: None)

    assert autostart._gui_executable() == app


def test_autostart_falls_back_to_unified_entry_on_path(tmp_path, monkeypatch):
    app = tmp_path / "bin" / "wayper"
    monkeypatch.setattr(sys, "argv", ["launcher.py"])
    monkeypatch.setattr(sys, "executable", str(tmp_path / "python"))
    monkeypatch.setattr(
        autostart.shutil, "which", lambda name: str(app) if name == "wayper" else None
    )

    assert autostart._gui_executable() == app
