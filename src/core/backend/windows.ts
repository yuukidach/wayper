import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import type { MonitorConfig, Orientation } from "../../shared/types";
import type { TransitionConfig } from "../config";
import type { WallpaperBackend } from "./base";

const CSHARP_SOURCE = `
using System;
using System.Runtime.InteropServices;

namespace WayperNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO {
        public uint cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [ComImport]
    [Guid("B92B56A9-8B55-4E14-9A89-0199BBB6F93B")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IDesktopWallpaper {
        void SetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID, [MarshalAs(UnmanagedType.LPWStr)] string wallpaper);
        [return: MarshalAs(UnmanagedType.LPWStr)]
        string GetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID);
        [return: MarshalAs(UnmanagedType.LPWStr)]
        string GetMonitorDevicePathAt(uint monitorIndex);
        uint GetMonitorDevicePathCount();
        RECT GetMonitorRECT([MarshalAs(UnmanagedType.LPWStr)] string monitorID);
    }

    [ComImport]
    [Guid("C2CF3110-460E-4FC1-B9D0-8A1C0C9CC4BD")]
    public class DesktopWallpaperCom {}

    public static class Win32 {
        public const uint SPI_SETDESKWALLPAPER = 0x0014;
        public const uint SPIF_UPDATEINIFILE = 0x01;
        public const uint SPIF_SENDWININICHANGE = 0x02;
        public const uint MONITOR_DEFAULTTONEAREST = 0x00000002;
        public const uint DESKTOP_SWITCHDESKTOP = 0x0100;

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool SystemParametersInfoW(uint uiAction, uint uiParam, string pvParam, uint fWinIni);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);

        [DllImport("user32.dll")]
        public static extern bool GetCursorPos(out POINT lpPoint);

        [DllImport("user32.dll")]
        public static extern IntPtr MonitorFromPoint(POINT pt, uint dwFlags);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern bool GetMonitorInfoW(IntPtr hMonitor, ref MONITORINFO lpmi);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SwitchDesktop(IntPtr hDesktop);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool CloseDesktop(IntPtr hDesktop);

        public static bool IsSessionLocked() {
            IntPtr hDesk = OpenInputDesktop(0, false, DESKTOP_SWITCHDESKTOP);
            if (hDesk == IntPtr.Zero) return false;
            try {
                return !SwitchDesktop(hDesk);
            } finally {
                CloseDesktop(hDesk);
            }
        }

        public static bool GetActiveMonitorRect(out RECT rect) {
            rect = new RECT();
            IntPtr hMon = IntPtr.Zero;
            IntPtr hwnd = GetForegroundWindow();
            if (hwnd != IntPtr.Zero) {
                hMon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            }
            if (hMon == IntPtr.Zero) {
                POINT pt;
                if (GetCursorPos(out pt)) {
                    hMon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
                }
            }
            if (hMon == IntPtr.Zero) return false;
            MONITORINFO mi = new MONITORINFO();
            mi.cbSize = (uint)Marshal.SizeOf(typeof(MONITORINFO));
            if (!GetMonitorInfoW(hMon, ref mi)) return false;
            rect = mi.rcMonitor;
            return true;
        }
    }
}
`;

const CSHARP_HASH = crypto.createHash("sha256").update(CSHARP_SOURCE, "utf8").digest("hex").slice(0, 12);
const CACHED_DLL_NAME = `WayperNative-${CSHARP_HASH}.dll`;

/**
 * Compiles the Win32/COM interop assembly once into %LOCALAPPDATA%\wayper\native
 * and loads the cached DLL on subsequent calls so PowerShell never invokes
 * csc.exe or churns temporary assemblies in %TEMP% on routine operations.
 */
const CSHARP_WALLPAPER_TYPES = `
if (-not ('WayperNative.Win32' -as [type])) {
    $wayperNativeCode = @'
${CSHARP_SOURCE}
'@
    $loaded = $false
    $baseDir = [Environment]::GetFolderPath('LocalApplicationData')
    if ([string]::IsNullOrWhiteSpace($baseDir)) { $baseDir = [System.IO.Path]::GetTempPath() }
    $dllDir = Join-Path $baseDir 'wayper\\native'
    $dllPath = Join-Path $dllDir '${CACHED_DLL_NAME}'
    if (Test-Path -LiteralPath $dllPath) {
        try {
            Add-Type -LiteralPath $dllPath -ErrorAction Stop
            $loaded = $true
        } catch {
            $loaded = [bool]('WayperNative.Win32' -as [type])
        }
    }
    if (-not $loaded) {
        try {
            [void][System.IO.Directory]::CreateDirectory($dllDir)
            $tmpDll = Join-Path $dllDir ('${CACHED_DLL_NAME}.' + $PID + '.' + [Guid]::NewGuid().ToString('N') + '.dll')
            Add-Type -TypeDefinition $wayperNativeCode -OutputAssembly $tmpDll -ErrorAction Stop
            try {
                Move-Item -LiteralPath $tmpDll -Destination $dllPath -Force -ErrorAction Stop
            } catch {
                if (-not (Test-Path -LiteralPath $dllPath)) { throw }
            } finally {
                if (Test-Path -LiteralPath $tmpDll) {
                    Remove-Item -LiteralPath $tmpDll -Force -ErrorAction SilentlyContinue
                }
            }
            Add-Type -LiteralPath $dllPath -ErrorAction Stop
            $loaded = $true
        } catch {
            $loaded = [bool]('WayperNative.Win32' -as [type])
        }
    }
    if (-not $loaded) {
        Add-Type -TypeDefinition $wayperNativeCode -ErrorAction Stop
    }
}
`;

const DETECT_MONITORS_PS = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
${CSHARP_WALLPAPER_TYPES}
$dw = [WayperNative.IDesktopWallpaper](New-Object WayperNative.DesktopWallpaperCom)
try {
    $count = $dw.GetMonitorDevicePathCount()
    $list = @()
    for ($i = 0; $i -lt $count; $i++) {
        $id = $dw.GetMonitorDevicePathAt($i)
        $r = $dw.GetMonitorRECT($id)
        $w = [int]($r.Right - $r.Left)
        $h = [int]($r.Bottom - $r.Top)
        if ($w -gt 0 -and $h -gt 0) {
            $list += [PSCustomObject]@{
                name = "DISPLAY$($i + 1)"
                width = $w
                height = $h
                orientation = if ($h -gt $w) { "portrait" } else { "landscape" }
            }
        }
    }
    ConvertTo-Json -Compress -InputObject @($list)
} finally {
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($dw)
}
`;

const FOCUSED_MONITOR_PS = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
${CSHARP_WALLPAPER_TYPES}
$dw = [WayperNative.IDesktopWallpaper](New-Object WayperNative.DesktopWallpaperCom)
try {
    $count = $dw.GetMonitorDevicePathCount()
    if ($count -eq 0) { exit 0 }
    $activeRect = New-Object WayperNative.RECT
    $hasRect = [WayperNative.Win32]::GetActiveMonitorRect([ref]$activeRect)
    if ($hasRect) {
        for ($i = 0; $i -lt $count; $i++) {
            $id = $dw.GetMonitorDevicePathAt($i)
            $r = $dw.GetMonitorRECT($id)
            if ($r.Left -eq $activeRect.Left -and $r.Top -eq $activeRect.Top -and $r.Right -eq $activeRect.Right -and $r.Bottom -eq $activeRect.Bottom) {
                Write-Output "DISPLAY$($i + 1)"
                exit 0
            }
        }
    }
    Write-Output "DISPLAY1"
} finally {
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($dw)
}
`;

const SET_WALLPAPER_PS = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
${CSHARP_WALLPAPER_TYPES}
$targetMon = $env:WAYPER_MON
$imgPath = $env:WAYPER_IMG
try {
    $dw = [WayperNative.IDesktopWallpaper](New-Object WayperNative.DesktopWallpaperCom)
    try {
        $count = $dw.GetMonitorDevicePathCount()
        $matchedId = $null
        for ($i = 0; $i -lt $count; $i++) {
            $id = $dw.GetMonitorDevicePathAt($i)
            $dispName = "DISPLAY$($i + 1)"
            if ($targetMon -eq $id -or $targetMon -eq $dispName) {
                $matchedId = $id
                break
            }
        }
        if ($null -eq $matchedId -and $count -eq 1) {
            $matchedId = $dw.GetMonitorDevicePathAt(0)
        }
        if ($null -ne $matchedId) {
            $dw.SetWallpaper($matchedId, $imgPath)
        }
    } finally {
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($dw)
    }
} catch {
    [void][WayperNative.Win32]::SystemParametersInfoW(
        [WayperNative.Win32]::SPI_SETDESKWALLPAPER,
        0,
        $imgPath,
        [WayperNative.Win32]::SPIF_UPDATEINIFILE -bor [WayperNative.Win32]::SPIF_SENDWININICHANGE
    )
}
`;

const QUERY_CURRENT_PS = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
${CSHARP_WALLPAPER_TYPES}
$dw = [WayperNative.IDesktopWallpaper](New-Object WayperNative.DesktopWallpaperCom)
try {
    $count = $dw.GetMonitorDevicePathCount()
    $map = @{}
    for ($i = 0; $i -lt $count; $i++) {
        $id = $dw.GetMonitorDevicePathAt($i)
        $wp = $null
        try { $wp = $dw.GetWallpaper($id) } catch { $wp = $null }
        $map["DISPLAY$($i + 1)"] = if ([string]::IsNullOrWhiteSpace($wp)) { $null } else { $wp }
    }
    ConvertTo-Json -Compress -InputObject $map
} finally {
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($dw)
}
`;

const IS_LOCKED_PS = `
$ErrorActionPreference = 'Stop'
${CSHARP_WALLPAPER_TYPES}
if ([WayperNative.Win32]::IsSessionLocked()) { Write-Output "true" } else { Write-Output "false" }
`;

const NOTIFY_PS = `
$ErrorActionPreference = 'SilentlyContinue'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02
$manager = [Windows.UI.Notifications.ToastNotificationManager]
$xml = $manager::GetTemplateContent($template)
$texts = $xml.GetElementsByTagName('text')
$texts.Item(0).AppendChild($xml.CreateTextNode($env:WAYPER_TITLE)) | Out-Null
$texts.Item(1).AppendChild($xml.CreateTextNode($env:WAYPER_MESSAGE)) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$manager::CreateToastNotifier('wayper').Show($toast)
`;

export type PowerShellRunner = (
  script: string,
  extraEnv?: Record<string, string>,
  timeoutMs?: number,
) => string | null;

function defaultPowerShellRunner(
  script: string,
  extraEnv: Record<string, string> = {},
  timeoutMs = 12_000,
): string | null {
  const res = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, ...extraEnv },
    },
  );
  if (res.error || res.status !== 0) {
    return null;
  }
  return (res.stdout ?? "").trim();
}

const DEFAULT_CURRENT_CACHE_TTL_MS = 30_000;

export interface WindowsBackendOptions {
  currentCacheTtlMs?: number;
}

export class WindowsBackend implements WallpaperBackend {
  private readonly runPs: PowerShellRunner;
  private readonly currentCacheTtlMs: number;
  private currentCache: { at: number; current: Record<string, string | null> } | null = null;

  constructor(
    runPs: PowerShellRunner = defaultPowerShellRunner,
    options?: WindowsBackendOptions,
  ) {
    this.runPs = runPs;
    this.currentCacheTtlMs = options?.currentCacheTtlMs ?? DEFAULT_CURRENT_CACHE_TTL_MS;
  }

  invalidateCache(): void {
    this.currentCache = null;
  }

  detectMonitors(): MonitorConfig[] {
    const raw = this.runPs(DETECT_MONITORS_PS);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      const monitors: MonitorConfig[] = [];
      for (const item of parsed) {
        if (typeof item !== "object" || item === null) continue;
        const rec = item as Record<string, unknown>;
        const name = String(rec.name ?? "");
        const width = Math.trunc(Number(rec.width));
        const height = Math.trunc(Number(rec.height));
        if (!name || !(width > 0 && height > 0)) continue;
        const orientation: Orientation = height > width ? "portrait" : "landscape";
        monitors.push({ name, width, height, orientation });
      }
      return monitors;
    } catch {
      return [];
    }
  }

  getFocusedMonitor(): string | null {
    const out = this.runPs(FOCUSED_MONITOR_PS);
    return out || null;
  }

  setWallpaper(monitor: string, imagePath: string, _transition: TransitionConfig): void {
    const resolved = path.resolve(imagePath);
    const out = this.runPs(SET_WALLPAPER_PS, { WAYPER_MON: monitor, WAYPER_IMG: resolved }, 12_000);
    if (out !== null && this.currentCache !== null && /^DISPLAY\d+$/.test(monitor)) {
      this.currentCache.current[monitor] = resolved;
      this.currentCache.at = performance.now();
    } else if (out !== null) {
      this.currentCache = null;
    }
  }

  queryCurrent(): Record<string, string | null> {
    const now = performance.now();
    if (
      this.currentCacheTtlMs > 0 &&
      this.currentCache !== null &&
      now - this.currentCache.at < this.currentCacheTtlMs
    ) {
      return { ...this.currentCache.current };
    }
    const raw = this.runPs(QUERY_CURRENT_PS);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {};
      }
      const current: Record<string, string | null> = {};
      for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
        current[key] = typeof val === "string" && val ? val : null;
      }
      if (this.currentCacheTtlMs > 0) {
        this.currentCache = { at: performance.now(), current };
      }
      return { ...current };
    } catch {
      return {};
    }
  }

  isLocked(): boolean {
    return this.runPs(IS_LOCKED_PS, {}, 6_000) === "true";
  }

  notify(title: string, message: string, _timeoutMs = 2000): void {
    try {
      const child = spawn(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", NOTIFY_PS],
        {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          env: {
            ...process.env,
            WAYPER_TITLE: title,
            WAYPER_MESSAGE: message,
          },
        },
      );
      child.on("error", () => {
        // Ignore missing powershell
      });
      child.unref();
    } catch {
      // Ignore
    }
  }
}
