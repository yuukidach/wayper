import type { MonitorConfig } from "../../shared/types";
import type { TransitionConfig, WayperConfig } from "../config";

export interface WallpaperBackend {
  detectMonitors(): MonitorConfig[];
  getFocusedMonitor(): string | null;
  setWallpaper(monitor: string, imagePath: string, transition: TransitionConfig): void;
  queryCurrent(): Record<string, string | null>;
  isLocked(): boolean;
  notify(title: string, message: string, timeoutMs?: number): void;
  ensureReady?(): void;
  invalidateCache?(): void;
}

export function findMonitor(
  config: Pick<WayperConfig, "monitors">,
  name: string | null,
): MonitorConfig | null {
  if (name === null) {
    return null;
  }
  for (const monitor of config.monitors) {
    if (monitor.name === name) {
      return monitor;
    }
  }
  if (config.monitors.length === 1) {
    return config.monitors[0];
  }
  return null;
}

export function getContext(
  backend: WallpaperBackend,
  config: Pick<WayperConfig, "monitors">,
): {
  monitor: string | null;
  monitorConfig: MonitorConfig | null;
  currentImage: string | null;
} {
  const monitor = backend.getFocusedMonitor();
  const monitorConfig = findMonitor(config, monitor);
  const current = backend.queryCurrent();
  const currentImage = monitor ? (current[monitor] ?? null) : null;
  return { monitor, monitorConfig, currentImage };
}
