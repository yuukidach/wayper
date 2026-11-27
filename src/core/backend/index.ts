import type { MonitorConfig } from "../../shared/types";
import type { TransitionConfig, WayperConfig } from "../config";
import {
  findMonitor,
  getContext as getBackendContext,
  getContextAsync as getBackendContextAsync,
  type WallpaperBackend,
} from "./base";
import { GreeterError, installGreeterImage, type InstallGreeterOptions } from "./greeter";
import {
  LinuxBackend,
  type AsyncCommandRunner,
  type CommandRunner,
  type CommandRunnerResult,
} from "./linux";
import { MacOSBackend } from "./macos";
import { WindowsBackend } from "./windows";

export {
  findMonitor,
  GreeterError,
  installGreeterImage,
  LinuxBackend,
  MacOSBackend,
  WindowsBackend,
  type AsyncCommandRunner,
  type CommandRunner,
  type CommandRunnerResult,
  type InstallGreeterOptions,
  type WallpaperBackend,
};

const DEFAULT_MONITOR_CACHE_TTL_MS = 10_000;

let activeBackend: WallpaperBackend | null = null;
let monitorsCache: MonitorConfig[] = [];
let monitorsDirty = true;
let monitorsCacheAt = 0;
let monitorsInflight: Promise<MonitorConfig[]> | null = null;
let monitorCacheTtlMs = DEFAULT_MONITOR_CACHE_TTL_MS;
let lockStateProvider: (() => boolean) | null = null;

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

export function setMonitorCacheTtl(ttlMs: number | null): void {
  monitorCacheTtlMs =
    typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs >= 0
      ? ttlMs
      : DEFAULT_MONITOR_CACHE_TTL_MS;
}

export function setLockStateProvider(provider: (() => boolean) | null): void {
  lockStateProvider = provider;
}

export function invalidateMonitorCache(): void {
  monitorsDirty = true;
  monitorsInflight = null;
  activeBackend?.invalidateCache?.();
}

export function detectMonitors(nowMs: number = performance.now()): MonitorConfig[] {
  if (!monitorsDirty && monitorsCache.length > 0 && nowMs - monitorsCacheAt < monitorCacheTtlMs) {
    return monitorsCache;
  }
  monitorsDirty = false;
  monitorsCache = getBackend().detectMonitors();
  monitorsCacheAt = nowMs;
  return monitorsCache;
}

export async function detectMonitorsAsync(
  nowMs: number = performance.now(),
): Promise<MonitorConfig[]> {
  if (!monitorsDirty && monitorsCache.length > 0 && nowMs - monitorsCacheAt < monitorCacheTtlMs) {
    return monitorsCache;
  }
  if (monitorsInflight !== null) {
    return monitorsInflight;
  }
  const backend = getBackend();
  if (!backend.detectMonitorsAsync) {
    return detectMonitors(nowMs);
  }
  const task = backend.detectMonitorsAsync().then((detected) => {
    if (monitorsInflight === task) {
      monitorsDirty = false;
      monitorsCache = detected;
      monitorsCacheAt = performance.now();
    }
    return detected;
  });
  monitorsInflight = task;
  try {
    return await task;
  } finally {
    if (monitorsInflight === task) {
      monitorsInflight = null;
    }
  }
}

export function getFocusedMonitor(): string | null {
  return getBackend().getFocusedMonitor();
}

export async function getFocusedMonitorAsync(): Promise<string | null> {
  const backend = getBackend();
  return backend.getFocusedMonitorAsync
    ? backend.getFocusedMonitorAsync()
    : backend.getFocusedMonitor();
}

export function setWallpaper(
  monitor: string,
  imagePath: string,
  transition: TransitionConfig,
): void {
  getBackend().setWallpaper(monitor, imagePath, transition);
}

export async function setWallpaperAsync(
  monitor: string,
  imagePath: string,
  transition: TransitionConfig,
): Promise<void> {
  const backend = getBackend();
  if (backend.setWallpaperAsync) {
    await backend.setWallpaperAsync(monitor, imagePath, transition);
    return;
  }
  backend.setWallpaper(monitor, imagePath, transition);
}

export function queryCurrent(): Record<string, string | null> {
  return getBackend().queryCurrent();
}

export async function queryCurrentAsync(): Promise<Record<string, string | null>> {
  const backend = getBackend();
  return backend.queryCurrentAsync ? backend.queryCurrentAsync() : backend.queryCurrent();
}

export function isLocked(): boolean {
  if (lockStateProvider) {
    return lockStateProvider();
  }
  return getBackend().isLocked();
}

export async function isLockedAsync(): Promise<boolean> {
  if (lockStateProvider) {
    return lockStateProvider();
  }
  const backend = getBackend();
  return backend.isLockedAsync ? backend.isLockedAsync() : backend.isLocked();
}

export function notify(title: string, message: string, timeoutMs = 2000): void {
  getBackend().notify(title, message, timeoutMs);
}

export function ensureReady(): void {
  getBackend().ensureReady?.();
}

export async function ensureReadyAsync(): Promise<void> {
  const backend = getBackend();
  if (backend.ensureReadyAsync) {
    await backend.ensureReadyAsync();
    return;
  }
  backend.ensureReady?.();
}

export function getContext(config: Pick<WayperConfig, "monitors">): {
  monitor: string | null;
  monitorConfig: MonitorConfig | null;
  currentImage: string | null;
} {
  return getBackendContext(getBackend(), config);
}

export function getContextAsync(config: Pick<WayperConfig, "monitors">): Promise<{
  monitor: string | null;
  monitorConfig: MonitorConfig | null;
  currentImage: string | null;
}> {
  return getBackendContextAsync(getBackend(), config);
}
