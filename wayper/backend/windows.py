"""Windows backend: IDesktopWallpaper + Win32 session checks."""

from __future__ import annotations

import ctypes
import logging
import subprocess
import uuid
from ctypes import wintypes
from pathlib import Path

from ..config import MonitorConfig, TransitionConfig
from ..process import windows_no_window_kwargs
from .base import WallpaperBackend

log = logging.getLogger("wayper")

COINIT_APARTMENTTHREADED = 0x2
CLSCTX_ALL = 0x17
S_OK = 0
S_FALSE = 1
RPC_E_CHANGED_MODE = 0x80010106

CLSID_DESKTOP_WALLPAPER = "C2CF3110-460E-4FC1-B9D0-8A1C0C9CC4BD"
IID_IDESKTOP_WALLPAPER = "B92B56A9-8B55-4E14-9A89-0199BBB6F93B"

SPI_SETDESKWALLPAPER = 0x0014
SPIF_UPDATEINIFILE = 0x01
SPIF_SENDWININICHANGE = 0x02

DESKTOP_SWITCHDESKTOP = 0x0100
MONITOR_DEFAULTTONEAREST = 0x00000002


class GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", ctypes.c_ulong),
        ("Data2", ctypes.c_ushort),
        ("Data3", ctypes.c_ushort),
        ("Data4", ctypes.c_ubyte * 8),
    ]

    @classmethod
    def from_string(cls, value: str) -> GUID:
        return cls.from_buffer_copy(uuid.UUID(value).bytes_le)


class RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    ]


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


class MONITORINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("rcMonitor", RECT),
        ("rcWork", RECT),
        ("dwFlags", wintypes.DWORD),
    ]


def _failed(hr: int) -> bool:
    return bool(hr & 0x80000000)


def _monitor_name(index: int) -> str:
    return f"DISPLAY{index + 1}"


def _user32():
    user32 = ctypes.windll.user32
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.MonitorFromWindow.restype = wintypes.HMONITOR
    user32.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
    user32.MonitorFromPoint.restype = wintypes.HMONITOR
    user32.MonitorFromPoint.argtypes = [POINT, wintypes.DWORD]
    user32.GetCursorPos.argtypes = [ctypes.POINTER(POINT)]
    user32.GetCursorPos.restype = wintypes.BOOL
    user32.GetMonitorInfoW.argtypes = [wintypes.HMONITOR, ctypes.POINTER(MONITORINFO)]
    user32.GetMonitorInfoW.restype = wintypes.BOOL
    user32.OpenInputDesktop.restype = wintypes.HDESK
    user32.OpenInputDesktop.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    user32.SwitchDesktop.argtypes = [wintypes.HDESK]
    user32.SwitchDesktop.restype = wintypes.BOOL
    user32.CloseDesktop.argtypes = [wintypes.HDESK]
    user32.CloseDesktop.restype = wintypes.BOOL
    return user32


class _DesktopWallpaper:
    """Small ctypes wrapper around the Windows IDesktopWallpaper COM interface."""

    def __init__(self) -> None:
        self._coinitialized = False
        self._ptr = ctypes.c_void_p()
        self._vtbl: ctypes.POINTER(ctypes.c_void_p) | None = None

        ole32 = ctypes.windll.ole32
        hr = ole32.CoInitializeEx(None, COINIT_APARTMENTTHREADED)
        if hr in (S_OK, S_FALSE):
            self._coinitialized = True
        elif hr != RPC_E_CHANGED_MODE and _failed(hr):
            raise OSError(f"CoInitializeEx failed: 0x{hr & 0xFFFFFFFF:08x}")

        clsid = GUID.from_string(CLSID_DESKTOP_WALLPAPER)
        iid = GUID.from_string(IID_IDESKTOP_WALLPAPER)
        hr = ole32.CoCreateInstance(
            ctypes.byref(clsid),
            None,
            CLSCTX_ALL,
            ctypes.byref(iid),
            ctypes.byref(self._ptr),
        )
        if _failed(hr) or not self._ptr:
            self.close()
            raise OSError(f"CoCreateInstance(IDesktopWallpaper) failed: 0x{hr & 0xFFFFFFFF:08x}")

        vtbl_type = ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))
        self._vtbl = ctypes.cast(self._ptr, vtbl_type).contents

    def close(self) -> None:
        if self._ptr:
            if self._vtbl is not None:
                release = ctypes.WINFUNCTYPE(wintypes.ULONG, ctypes.c_void_p)(self._vtbl[2])
                release(self._ptr)
            self._ptr = ctypes.c_void_p()
        if self._coinitialized:
            ctypes.windll.ole32.CoUninitialize()
            self._coinitialized = False

    def __enter__(self) -> _DesktopWallpaper:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _method(self, index: int, restype, *argtypes):
        if self._vtbl is None:
            raise RuntimeError("IDesktopWallpaper is not initialized")
        prototype = ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)
        return prototype(self._vtbl[index])

    def monitor_count(self) -> int:
        count = wintypes.UINT()
        fn = self._method(6, ctypes.c_long, ctypes.POINTER(wintypes.UINT))
        hr = fn(self._ptr, ctypes.byref(count))
        if _failed(hr):
            raise OSError(f"GetMonitorDevicePathCount failed: 0x{hr & 0xFFFFFFFF:08x}")
        return int(count.value)

    def monitor_id_at(self, index: int) -> str:
        raw = wintypes.LPWSTR()
        fn = self._method(5, ctypes.c_long, wintypes.UINT, ctypes.POINTER(wintypes.LPWSTR))
        hr = fn(self._ptr, index, ctypes.byref(raw))
        if _failed(hr):
            raise OSError(f"GetMonitorDevicePathAt failed: 0x{hr & 0xFFFFFFFF:08x}")
        try:
            return raw.value or ""
        finally:
            if raw:
                ctypes.windll.ole32.CoTaskMemFree(ctypes.cast(raw, ctypes.c_void_p))

    def monitor_rect(self, monitor_id: str) -> RECT:
        rect = RECT()
        fn = self._method(7, ctypes.c_long, wintypes.LPCWSTR, ctypes.POINTER(RECT))
        hr = fn(self._ptr, monitor_id, ctypes.byref(rect))
        if _failed(hr):
            raise OSError(f"GetMonitorRECT failed: 0x{hr & 0xFFFFFFFF:08x}")
        return rect

    def set_wallpaper(self, monitor_id: str, image: Path) -> None:
        fn = self._method(3, ctypes.c_long, wintypes.LPCWSTR, wintypes.LPCWSTR)
        hr = fn(self._ptr, monitor_id, str(image))
        if _failed(hr):
            raise OSError(f"SetWallpaper failed: 0x{hr & 0xFFFFFFFF:08x}")

    def get_wallpaper(self, monitor_id: str) -> Path | None:
        raw = wintypes.LPWSTR()
        fn = self._method(4, ctypes.c_long, wintypes.LPCWSTR, ctypes.POINTER(wintypes.LPWSTR))
        hr = fn(self._ptr, monitor_id, ctypes.byref(raw))
        if _failed(hr):
            return None
        try:
            return Path(raw.value) if raw.value else None
        finally:
            if raw:
                ctypes.windll.ole32.CoTaskMemFree(ctypes.cast(raw, ctypes.c_void_p))


class WindowsBackend(WallpaperBackend):
    """Windows backend using the native Desktop Wallpaper COM API."""

    def _monitor_ids(self) -> list[str]:
        with _DesktopWallpaper() as desktop:
            return [desktop.monitor_id_at(i) for i in range(desktop.monitor_count())]

    def _monitor_id_for_name(self, monitor: str) -> str | None:
        ids = self._monitor_ids()
        for index, monitor_id in enumerate(ids):
            if monitor in (monitor_id, _monitor_name(index)):
                return monitor_id
        if len(ids) == 1:
            return ids[0]
        return None

    def detect_monitors(self) -> list[MonitorConfig]:
        try:
            with _DesktopWallpaper() as desktop:
                monitors = []
                for index in range(desktop.monitor_count()):
                    monitor_id = desktop.monitor_id_at(index)
                    rect = desktop.monitor_rect(monitor_id)
                    width = int(rect.right - rect.left)
                    height = int(rect.bottom - rect.top)
                    orientation = "portrait" if height > width else "landscape"
                    monitors.append(
                        MonitorConfig(
                            name=_monitor_name(index),
                            width=width,
                            height=height,
                            orientation=orientation,
                        )
                    )
                return monitors
        except Exception as e:
            log.warning("Failed to detect monitors via IDesktopWallpaper: %s", e)
            return []

    def set_wallpaper(self, monitor: str, image: Path, transition: TransitionConfig) -> None:
        del transition  # Windows does not expose transition controls for direct wallpaper changes.

        try:
            monitor_id = self._monitor_id_for_name(monitor)
            if monitor_id is None:
                log.warning("Windows monitor not found: %s", monitor)
                return
            with _DesktopWallpaper() as desktop:
                desktop.set_wallpaper(monitor_id, image)
        except Exception as e:
            log.warning("IDesktopWallpaper failed; falling back to system wallpaper: %s", e)
            ctypes.windll.user32.SystemParametersInfoW(
                SPI_SETDESKWALLPAPER,
                0,
                str(image),
                SPIF_UPDATEINIFILE | SPIF_SENDWININICHANGE,
            )

    def get_focused_monitor(self) -> str | None:
        try:
            user32 = _user32()
            hwnd = user32.GetForegroundWindow()
            monitor_handle = None
            if hwnd:
                monitor_handle = user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
            if not monitor_handle:
                point = POINT()
                if user32.GetCursorPos(ctypes.byref(point)):
                    monitor_handle = user32.MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST)

            with _DesktopWallpaper() as desktop:
                for index in range(desktop.monitor_count()):
                    monitor_id = desktop.monitor_id_at(index)
                    rect = desktop.monitor_rect(monitor_id)
                    if monitor_handle and _monitor_handle_matches_rect(monitor_handle, rect):
                        return _monitor_name(index)
                return _monitor_name(0) if desktop.monitor_count() else None
        except Exception:
            return None

    def query_current(self) -> dict[str, Path | None]:
        try:
            with _DesktopWallpaper() as desktop:
                current: dict[str, Path | None] = {}
                for index in range(desktop.monitor_count()):
                    monitor_id = desktop.monitor_id_at(index)
                    current[_monitor_name(index)] = desktop.get_wallpaper(monitor_id)
                return current
        except Exception:
            return {}

    def is_locked(self) -> bool:
        user32 = _user32()
        desktop = user32.OpenInputDesktop(0, False, DESKTOP_SWITCHDESKTOP)
        if not desktop:
            return False
        try:
            return not bool(user32.SwitchDesktop(desktop))
        finally:
            user32.CloseDesktop(desktop)

    def notify(self, title: str, message: str, timeout_ms: int = 2000) -> None:
        del timeout_ms
        script = (
            "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, "
            "ContentType = WindowsRuntime] | Out-Null; "
            "Add-Type -AssemblyName System.Runtime.WindowsRuntime; "
            "$template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02; "
            "$manager = [Windows.UI.Notifications.ToastNotificationManager]; "
            "$xml = $manager::GetTemplateContent($template); "
            "$texts = $xml.GetElementsByTagName('text'); "
            f"$texts.Item(0).AppendChild($xml.CreateTextNode('{_ps_escape(title)}')) | Out-Null; "
            f"$texts.Item(1).AppendChild($xml.CreateTextNode('{_ps_escape(message)}')) | Out-Null; "
            "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml); "
            "$manager::CreateToastNotifier('wayper').Show($toast)"
        )
        try:
            subprocess.Popen(
                ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                **windows_no_window_kwargs(),
            )
        except FileNotFoundError:
            pass


def _ps_escape(value: str) -> str:
    return value.replace("'", "''")


def _monitor_handle_matches_rect(handle, rect: RECT) -> bool:
    info = MONITORINFO()
    info.cbSize = ctypes.sizeof(MONITORINFO)
    if not _user32().GetMonitorInfoW(handle, ctypes.byref(info)):
        return False
    monitor = info.rcMonitor
    return (
        monitor.left == rect.left
        and monitor.top == rect.top
        and monitor.right == rect.right
        and monitor.bottom == rect.bottom
    )
