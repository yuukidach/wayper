import type { MonitorConfig } from "../../shared/types";
import type { TransitionConfig, WayperConfig } from "../config";
import { findMonitor, getContext as getBackendContext, type WallpaperBackend } from "./base";
import { GreeterError, installGreeterImage, type InstallGreeterOptions } from "./greeter";
import { LinuxBackend } from "./linux";
import { MacOSBackend } from "./macos";
import { WindowsBackend } from "./windows";

export {
  findMonitor,
  GreeterError,
  installGreeterImage,
  LinuxBackend,
  MacOSBackend,
  WindowsBackend,
  type InstallGreeterOptions,
  type WallpaperBackend,
};

const MONITOR_CACHE_TTL_MS = 10_000;

let activeBackend: WallpaperBackend | null = null;
let monitorsCache: MonitorConfig[] = [];
let monitorsDirty = true;
let monitorsCacheAt = 0;

export function createBackend(platform: NodeJS.Platform = process.platform): WallpaperBackend {
  if (platform === "darwin") {
    return new MacOSBackend();
  }
  if (platform === "win32") {
    return new WindowsBackend();
  }
  return new LinuxBackend();
}

export function getBackend(): WallpaperBackend {
  if (!activeBackend) {
    activeBackend = createBackend();
  }
  return activeBackend;
}

export function setBackend(backend: WallpaperBackend | null): void {
  activeBackend = backend;
  invalidateMonitorCache();
}

export function invalidateMonitorCache(): void {
  monitorsDirty = true;
}

export function detectMonitors(nowMs: number = performance.now()): MonitorConfig[] {
  if (!monitorsDirty && monitorsCache.length > 0 && nowMs - monitorsCacheAt < MONITOR_CACHE_TTL_MS) {
    return monitorsCache;
  }
  monitorsDirty = false;
  monitorsCache = getBackend().detectMonitors();
  monitorsCacheAt = nowMs;
  return monitorsCache;
}

export function getFocusedMonitor(): string | null {
  return getBackend().getFocusedMonitor();
}

export function setWallpaper(
  monitor: string,
  imagePath: string,
  transition: TransitionConfig,
): void {
  getBackend().setWallpaper(monitor, imagePath, transition);
}

export function queryCurrent(): Record<string, string | null> {
  return getBackend().queryCurrent();
}

export function isLocked(): boolean {
  return getBackend().isLocked();
}

export function notify(title: string, message: string, timeoutMs = 2000): void {
  getBackend().notify(title, message, timeoutMs);
}

export function ensureReady(): void {
  getBackend().ensureReady?.();
}

export function getContext(config: Pick<WayperConfig, "monitors">): {
  monitor: string | null;
  monitorConfig: MonitorConfig | null;
  currentImage: string | null;
} {
  return getBackendContext(getBackend(), config);
}
