import fs from "node:fs";
import { ensureReady, GreeterError, installGreeterImage, isLocked } from "./backend";
import { loadConfig, type WayperConfig } from "./config";
import { setAllWallpapers } from "./core";
import { getDefaultLockPath, withFileLock } from "./lock";
import { getLogger } from "./logging";
import { getConfigFile, poolDir } from "./paths";
import { enforceQuota, ensureDirectories, listImagesInDir } from "./pool";
import { pruneBlacklist, readMode, secondsUntilNextRotation } from "./state";
import { prepareWallhavenClient, refillPool, type WallhavenClient } from "./wallhaven";
import { pushLocalFavorites } from "./wallhaven-web";

const log = getLogger("rotation");

export const FAVORITES_SYNC_INTERVAL = 12;
const ROTATION_POLL_INTERVAL_MS = process.platform === "win32" ? 100 : 1000;
const LOCK_POLL_INTERVAL_MS = process.platform === "win32" ? 500 : 5000;

export type RotationEvent = "rotated" | "library" | "reloaded" | "state";

export interface AutoRotationOptions {
  configLoader?: () => WayperConfig;
  onEvent?: (event: RotationEvent) => void;
}

function fileMtime(target: string): number {
  try {
    return fs.statSync(target).mtimeMs;
  } catch {
    return 0;
  }
}

export async function updateGreeter(config: WayperConfig): Promise<void> {
  if (!config.greeter.image || config.greeter.fixed_image) return;
  await withFileLock(getDefaultLockPath(), () => {
    const fresh = loadConfig(undefined, { detectDisplays: false });
    if (!fresh.greeter.image || fresh.greeter.fixed_image) return;
    const images = listImagesInDir(poolDir(fresh.download_dir, "sfw", "landscape"));
    if (images.length === 0) return;
    try {
      installGreeterImage(fresh.greeter, images[Math.floor(Math.random() * images.length)]);
    } catch (error) {
      if (!(error instanceof GreeterError)) throw error;
      log.warn(`Could not update greeter wallpaper: ${error.message}`);
    }
  });
}

export class AutoRotationService {
  private readonly configLoader: () => WayperConfig;
  private readonly onEvent: (event: RotationEvent) => void;
  private loop: Promise<void> | null = null;
  private stopping = false;
  private paused = false;
  private reloadRequested = false;
  private configMtime = 0;
  private wakeResolver: (() => void) | null = null;
  private pendingWake = false;
  private refillTask: Promise<void> | null = null;
  private abort = new AbortController();
  private client: WallhavenClient | null = null;
  private config: WayperConfig | null = null;

  constructor(options: AutoRotationOptions = {}) {
    this.configLoader = options.configLoader ?? (() => loadConfig());
    this.onEvent = options.onEvent ?? (() => undefined);
  }

  get running(): boolean {
    return this.loop !== null;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  snapshot(config: Pick<WayperConfig, "interval">): {
    auto_rotation: boolean;
    rotation_paused: boolean;
  } {
    return {
      auto_rotation: this.running && !this.paused && config.interval > 0,
      rotation_paused: this.paused,
    };
  }

  start(): void {
    if (this.loop !== null) return;
    this.stopping = false;
    this.abort = new AbortController();
    this.loop = this.run().finally(() => {
      this.loop = null;
    });
  }

  async stop(): Promise<void> {
    const loop = this.loop;
    if (loop === null) return;
    this.stopping = true;
    this.abort.abort();
    this.wake();
    await loop.catch(() => undefined);
  }

  pause(): void {
    this.paused = true;
    this.wake();
    this.onEvent("state");
  }

  resume(): void {
    this.paused = false;
    this.wake();
    this.onEvent("state");
  }

  requestReload(): void {
    this.reloadRequested = true;
    this.wake();
  }

  requestRefill(config?: WayperConfig): void {
    const active = config ?? this.config;
    if (active === null || this.stopping) return;
    this.startRefill(active, this.client);
  }

  wake(): void {
    const resolver = this.wakeResolver;
    if (resolver) {
      this.wakeResolver = null;
      resolver();
    } else {
      this.pendingWake = true;
    }
  }

  private sleepOrWake(timeoutMs: number): Promise<void> {
    if (this.pendingWake) {
      this.pendingWake = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        if (this.wakeResolver === done) this.wakeResolver = null;
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, timeoutMs));
      this.wakeResolver = done;
    });
  }

  private startRefill(config: WayperConfig, client: WallhavenClient | null): void {
    if (this.stopping || this.refillTask !== null) return;
    this.refillTask = refillPool(config, readMode(config), client)
      .then((summary) => {
        if (summary && (summary.downloaded > 0 || summary.skipped.model > 0)) {
          this.onEvent("library");
        }
      })
      .catch((error: unknown) => {
        log.warn("Could not refill the wallpaper pool", error);
      })
      .finally(() => {
        this.refillTask = null;
      });
  }

  private async prepareClient(config: WayperConfig): Promise<WallhavenClient> {
    return prepareWallhavenClient(config, { signal: this.abort.signal });
  }

  private async reloadIfNeeded(): Promise<boolean> {
    const mtime = fileMtime(getConfigFile());
    if (!this.reloadRequested && mtime === this.configMtime) return false;
    this.reloadRequested = false;
    this.configMtime = mtime;
    const config = this.configLoader();
    ensureDirectories(config);
    this.config = config;
    this.client = await this.prepareClient(config);
    log.info("Automatic rotation configuration reloaded");
    this.onEvent("reloaded");
    return true;
  }

  private async waitForTurn(): Promise<boolean> {
    let loggedDisabled = false;
    let reloaded = false;
    while (!this.stopping) {
      if (await this.reloadIfNeeded()) {
        loggedDisabled = false;
        reloaded = true;
      }
      const config = this.config as WayperConfig;
      if (this.paused) {
        await this.sleepOrWake(LOCK_POLL_INTERVAL_MS);
        continue;
      }
      if (config.interval <= 0) {
        if (!loggedDisabled) {
          log.info("Automatic rotation disabled (interval=0)");
          loggedDisabled = true;
        }
        await this.sleepOrWake(LOCK_POLL_INTERVAL_MS);
        continue;
      }
      const remaining = secondsUntilNextRotation(config) * 1000;
      if (remaining <= 0) return reloaded;
      await this.sleepOrWake(Math.min(ROTATION_POLL_INTERVAL_MS, remaining));
    }
    return false;
  }

  private async run(): Promise<void> {
    let favoritesSyncCount = FAVORITES_SYNC_INTERVAL;
    let greeterCount = 0;
    let syncTask: Promise<void> | null = null;
    let greeterTask: Promise<void> | null = null;
    try {
      this.config = this.configLoader();
      ensureDirectories(this.config);
      ensureReady();
      this.configMtime = fileMtime(getConfigFile());
      this.client = await this.prepareClient(this.config);
      log.info("Automatic rotation service started");

      while (!this.stopping) {
        const reloaded = await this.waitForTurn();
        if (this.stopping) break;
        if (reloaded) favoritesSyncCount = FAVORITES_SYNC_INTERVAL;
        let config = this.config as WayperConfig;

        if (config.pause_on_lock && isLocked()) {
          log.info("Session locked; automatic rotation is waiting");
          while (!this.stopping && config.pause_on_lock && isLocked()) {
            await this.reloadIfNeeded();
            config = this.config as WayperConfig;
            await this.sleepOrWake(LOCK_POLL_INTERVAL_MS);
          }
          continue;
        }

        await setAllWallpapers(config, readMode(config));
        this.onEvent("rotated");
        this.startRefill(config, this.client);
        enforceQuota(config);
        pruneBlacklist(config);

        favoritesSyncCount += 1;
        if (favoritesSyncCount >= FAVORITES_SYNC_INTERVAL) {
          if (syncTask === null) {
            const client = this.client as WallhavenClient;
            syncTask = (async () => {
              try {
                const [synced, remoteFiles] = await client.syncRemoteFavorites();
                await pushLocalFavorites(config, remoteFiles);
                if (synced > 0) this.onEvent("library");
              } catch (error) {
                log.warn("Background favorites sync failed", error);
              }
            })().finally(() => {
              syncTask = null;
            });
          } else {
            log.info("Skipping favorites sync because the previous sync is running");
          }
          favoritesSyncCount = 0;
        }

        greeterCount += 1;
        if (
          config.greeter.image &&
          !config.greeter.fixed_image &&
          greeterCount >= config.greeter.interval
        ) {
          if (greeterTask === null) {
            greeterTask = updateGreeter(config)
              .catch((error: unknown) => {
                log.warn("Background greeter update failed", error);
              })
              .finally(() => {
                greeterTask = null;
              });
          } else {
            log.info("Skipping greeter update because the previous update is running");
          }
          greeterCount = 0;
        }
      }
    } catch (error) {
      log.error("Automatic rotation service stopped unexpectedly", error);
    } finally {
      const pending = [this.refillTask, syncTask, greeterTask].filter(
        (task): task is Promise<void> => task !== null,
      );
      await Promise.allSettled(pending);
      this.client = null;
      log.info("Automatic rotation service stopped");
    }
  }
}
