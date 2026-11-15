import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WallpaperBackend } from "../../src/core/backend/base";
import { setBackend } from "../../src/core/backend";
import { loadConfig, type WayperConfig } from "../../src/core/config";
import { setUrlOpener } from "../../src/core/core";
import { setRetrainSpawner } from "../../src/core/preference/ledger";
import { setTrashHandler } from "../../src/core/trash";
import type { MonitorConfig, Orientation, Purity } from "../../src/shared/types";

// Smallest valid PNG (1x1), enough for extension- and header-based checks.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

export class FakeBackend implements WallpaperBackend {
  monitors: MonitorConfig[];
  focused: string | null;
  current: Record<string, string | null> = {};
  calls: Array<{ monitor: string; image: string }> = [];
  notifications: string[] = [];

  constructor(monitors: MonitorConfig[]) {
    this.monitors = monitors;
    this.focused = monitors[0]?.name ?? null;
  }

  detectMonitors(): MonitorConfig[] {
    return this.monitors;
  }

  getFocusedMonitor(): string | null {
    return this.focused;
  }

  setWallpaper(monitor: string, imagePath: string): void {
    this.current[monitor] = imagePath;
    this.calls.push({ monitor, image: imagePath });
  }

  queryCurrent(): Record<string, string | null> {
    return { ...this.current };
  }

  isLocked(): boolean {
    return false;
  }

  notify(_title: string, message: string): void {
    this.notifications.push(message);
  }
}

export interface Sandbox {
  root: string;
  configDir: string;
  downloadDir: string;
  backend: FakeBackend;
  openedUrls: string[];
  config(): WayperConfig;
  addImage(purity: Purity, orientation: Orientation, name: string, favorite?: boolean): string;
  cleanup(): void;
}

const DEFAULT_MONITORS: MonitorConfig[] = [
  { name: "TEST-1", width: 2560, height: 1440, orientation: "landscape" },
  { name: "TEST-2", width: 1440, height: 2560, orientation: "portrait" },
];

/**
 * An isolated Wayper installation: its own config directory, library, trash
 * and fake display backend.  Nothing touches the real user environment.
 */
export function createSandbox(options?: { monitors?: MonitorConfig[]; extraToml?: string }): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wayper-test-")));
  const configDir = path.join(root, "config");
  const downloadDir = path.join(root, "library");
  const trashDir = path.join(root, "custom-trash");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(downloadDir, { recursive: true });

  const previousEnv = {
    WAYPER_CONFIG_DIR: process.env.WAYPER_CONFIG_DIR,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  };
  process.env.WAYPER_CONFIG_DIR = configDir;
  process.env.XDG_DATA_HOME = path.join(root, "xdg-data");

  fs.writeFileSync(
    path.join(configDir, "config.toml"),
    `download_dir = ${JSON.stringify(downloadDir)}\n` +
      "interval = 0\nautostart = false\nblacklist_ttl_days = 0\n" +
      (options?.extraToml ?? ""),
    "utf8",
  );

  const backend = new FakeBackend(options?.monitors ?? DEFAULT_MONITORS);
  setBackend(backend);
  setRetrainSpawner(() => null);
  const openedUrls: string[] = [];
  setUrlOpener((url) => {
    openedUrls.push(url);
  });
  if (process.platform !== "linux") {
    // Other platforms would reach the real system trash; keep files in the sandbox.
    setTrashHandler(async (target) => {
      fs.mkdirSync(trashDir, { recursive: true });
      fs.renameSync(target, path.join(trashDir, path.basename(target)));
    });
  }

  return {
    root,
    configDir,
    downloadDir,
    backend,
    openedUrls,
    config: () => loadConfig(),
    addImage(purity, orientation, name, favorite = false) {
      const directory = favorite
        ? path.join(downloadDir, "favorites", purity, orientation)
        : path.join(downloadDir, purity, orientation);
      fs.mkdirSync(directory, { recursive: true });
      const target = path.join(directory, name);
      fs.writeFileSync(target, PNG_BYTES);
      return target;
    },
    cleanup() {
      setBackend(null);
      setRetrainSpawner(null);
      setUrlOpener(null);
      setTrashHandler(null);
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
