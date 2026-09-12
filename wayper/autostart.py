"""Manage launching the Wayper GUI when the graphical session starts."""

from __future__ import annotations

import os
import plistlib
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from .config import CONFIG_DIR, WayperConfig, save_config


class AutostartError(RuntimeError):
    """Raised when the host cannot apply the requested autostart state."""


@dataclass(frozen=True, slots=True)
class AutostartResult:
    enabled: bool
    unit: Path | str


_WINDOWS_RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
_WINDOWS_RUN_VALUE = "Wayper"


def _systemd_user_dir() -> Path:
    return Path.home() / ".config" / "systemd" / "user"


def _service_path() -> Path:
    return _systemd_user_dir() / "wayper.service"


def _launch_agent_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / "io.github.yuukidach.wayper.plist"


def _windows_startup_path() -> Path:
    appdata = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    return appdata / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup" / "Wayper.cmd"


def _windows_launcher_path() -> Path:
    return CONFIG_DIR / "WayperAutostart.vbs"


def _windows_registration() -> str:
    return f"HKCU\\{_WINDOWS_RUN_KEY}\\{_WINDOWS_RUN_VALUE}"


def _registration_path() -> Path | str:
    if sys.platform.startswith("linux"):
        return _service_path()
    if sys.platform == "darwin":
        return _launch_agent_path()
    if sys.platform == "win32":
        return _windows_registration()
    raise AutostartError(f"Autostart is not supported on {sys.platform}")


def _gui_executable() -> Path:
    """Find the unified app entry point in the current installation first."""
    executable_dir = Path(sys.executable).absolute().parent
    invoked_entry = Path(sys.argv[0]).expanduser()
    candidates = [executable_dir / "wayper"]
    if sys.platform == "win32":
        candidates.insert(0, executable_dir / "wayper.exe")
    if invoked_entry.name.lower() in {"wayper", "wayper.exe"}:
        candidates.insert(0, invoked_entry.resolve())
    elif invoked_entry.name.lower() in {"wayper-gui", "wayper-gui.exe"}:
        # Older login entries can still use the compatibility alias.
        entry_name = "wayper.exe" if sys.platform == "win32" else "wayper"
        candidates.insert(0, invoked_entry.resolve().with_name(entry_name))
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    executable = shutil.which("wayper")
    if executable:
        return Path(executable).resolve()
    raise AutostartError("Cannot find wayper; install Wayper before enabling autostart")


def _systemd_quote(value: str) -> str:
    """Quote one systemd command-line argument."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _service_contents(executable: Path) -> str:
    return (
        "[Unit]\n"
        "Description=Wayper wallpaper manager\n"
        "PartOf=graphical-session.target\n"
        "After=graphical-session.target\n\n"
        "[Service]\n"
        "Type=simple\n"
        f"ExecStart={_systemd_quote(str(executable))} --hidden\n"
        "Restart=on-failure\n"
        "RestartSec=3\n\n"
        "[Install]\n"
        "WantedBy=graphical-session.target\n"
    )


def _launch_agent_contents(executable: Path) -> bytes:
    return plistlib.dumps(
        {
            "Label": "io.github.yuukidach.wayper",
            "ProgramArguments": [str(executable), "--hidden"],
            "RunAtLoad": True,
        },
        sort_keys=False,
    )


def _windows_run_command(executable: Path) -> str:
    return f'"{executable}" --hidden'


def _windows_needs_script_launcher() -> bool:
    """Detect virtual environments whose GUI entry point cannot find base pythonw.exe."""
    if sys.prefix == sys.base_prefix:
        return False
    base_executable = Path(getattr(sys, "_base_executable", sys.executable))
    return not base_executable.with_name("pythonw.exe").is_file()


def _windows_uv_launch_arguments() -> list[str] | None:
    """Build a resilient uv launch for a source checkout, if available."""
    uv = shutil.which("uv")
    if not uv:
        return None
    for parent in Path(__file__).resolve().parents:
        if (parent / "pyproject.toml").is_file() and (parent / "wayper").is_dir():
            return [
                uv,
                "run",
                "--project",
                str(parent),
                "python",
                "-m",
                "wayper.server.launcher",
                "--hidden",
            ]
    return None


def _windows_launcher_contents() -> str:
    uv_arguments = _windows_uv_launch_arguments()
    if uv_arguments:
        command = subprocess.list2cmdline(uv_arguments)
    else:
        command = f'"{Path(sys.executable).resolve()}" -m wayper.server.launcher --hidden'
    escaped = command.replace('"', '""')
    return f'CreateObject("WScript.Shell").Run "{escaped}", 0, False\n'


def _windows_script_command(launcher: Path) -> str:
    return f'wscript.exe //B //NoLogo "{launcher}"'


def _windows_read_registration() -> str | None:
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _WINDOWS_RUN_KEY) as key:
            value, _ = winreg.QueryValueEx(key, _WINDOWS_RUN_VALUE)
            return str(value)
    except FileNotFoundError:
        return None


def _windows_write_registration(command: str) -> None:
    import winreg

    with winreg.CreateKeyEx(
        winreg.HKEY_CURRENT_USER, _WINDOWS_RUN_KEY, 0, winreg.KEY_SET_VALUE
    ) as key:
        winreg.SetValueEx(key, _WINDOWS_RUN_VALUE, 0, winreg.REG_SZ, command)


def _windows_delete_registration() -> None:
    import winreg

    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER, _WINDOWS_RUN_KEY, 0, winreg.KEY_SET_VALUE
        ) as key:
            winreg.DeleteValue(key, _WINDOWS_RUN_VALUE)
    except FileNotFoundError:
        pass


def _registration_exists() -> bool:
    if sys.platform == "win32":
        return _windows_read_registration() is not None
    return Path(_registration_path()).is_file()


def _systemctl(*arguments: str) -> None:
    if not shutil.which("systemctl"):
        raise AutostartError("systemctl is required to manage Wayper autostart")
    result = subprocess.run(
        ["systemctl", "--user", *arguments],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip() or "systemctl failed"
        raise AutostartError(detail)


def set_autostart(
    config: WayperConfig,
    enabled: bool,
    *,
    config_path: Path | None = None,
) -> AutostartResult:
    """Apply and persist autostart using the platform's login mechanism."""
    unit = _registration_path()
    if sys.platform == "win32":
        legacy_startup = _windows_startup_path()
        launcher = _windows_launcher_path()
        previous = _windows_read_registration()
        previous_launcher = launcher.read_bytes() if launcher.is_file() else None
        if enabled:
            try:
                executable = _gui_executable()
                if _windows_needs_script_launcher():
                    launcher.parent.mkdir(parents=True, exist_ok=True)
                    launcher.write_text(_windows_launcher_contents(), encoding="utf-8")
                    command = _windows_script_command(launcher)
                else:
                    launcher.unlink(missing_ok=True)
                    command = _windows_run_command(executable)
                _windows_write_registration(command)
                legacy_startup.unlink(missing_ok=True)
            except Exception as error:
                if previous is None:
                    _windows_delete_registration()
                else:
                    _windows_write_registration(previous)
                if previous_launcher is None:
                    launcher.unlink(missing_ok=True)
                else:
                    launcher.parent.mkdir(parents=True, exist_ok=True)
                    launcher.write_bytes(previous_launcher)
                if isinstance(error, AutostartError):
                    raise
                raise AutostartError(str(error)) from error
        else:
            try:
                _windows_delete_registration()
                legacy_startup.unlink(missing_ok=True)
                launcher.unlink(missing_ok=True)
            except Exception as error:
                if isinstance(error, AutostartError):
                    raise
                raise AutostartError(str(error)) from error

        config.autostart = enabled
        save_config(config, config_path)
        return AutostartResult(enabled=enabled, unit=unit)

    unit = Path(unit)
    if enabled:
        previous = unit.read_bytes() if unit.is_file() else None
        unit.parent.mkdir(parents=True, exist_ok=True)
        try:
            executable = _gui_executable()
            if sys.platform.startswith("linux"):
                unit.write_text(_service_contents(executable), encoding="utf-8")
                _systemctl("daemon-reload")
                _systemctl("enable", unit.name)
            else:
                unit.write_bytes(_launch_agent_contents(executable))
        except Exception as error:
            if previous is None:
                unit.unlink(missing_ok=True)
            else:
                unit.write_bytes(previous)
            if isinstance(error, AutostartError):
                raise
            raise AutostartError(str(error)) from error
    else:
        try:
            if sys.platform.startswith("linux") and unit.exists():
                _systemctl("disable", unit.name)
            unit.unlink(missing_ok=True)
            if sys.platform.startswith("linux"):
                _systemctl("daemon-reload")
        except Exception as error:
            if isinstance(error, AutostartError):
                raise
            raise AutostartError(str(error)) from error

    config.autostart = enabled
    save_config(config, config_path)
    return AutostartResult(enabled=enabled, unit=unit)


def ensure_default_autostart(config: WayperConfig) -> None:
    """Install the default-on service on the first manual GUI launch."""
    if config.autostart and not _registration_exists():
        set_autostart(config, True)
