import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { MonitorConfig, Purity } from "../shared/types";
import { wallhavenId, wallhavenUrl } from "../shared/tags";
import {
  findMonitor,
  getContext,
  getFocusedMonitor,
  GreeterError,
  installGreeterImage,
  queryCurrent,
  setWallpaper,
} from "./backend";
import { NO_TRANSITION, saveConfig, type TransitionConfig, type WayperConfig } from "./config";
import { getDefaultLockPath, withFileLock } from "./lock";
import { getLogger } from "./logging";
import {
  ALL_ORIENTATIONS,
  ALL_PURITIES,
  favoritesDir,
  orientationFromPath,
  poolDir,
  purityFromPath,
} from "./paths";
import {
  clearImageDerivatives,
  countImagesInDir,
  diskUsageMb,
  hydrateTagDetails,
  listImagesInDir,
  loadMetadata,
  pickRandomWallpaper,
  saveMetadataBatch,
} from "./pool";
import {
  appendPreferenceFeedback,
  loadPreferenceFeedback,
  modelReviewDirPath,
  schedulePreferenceModelRetrain,
} from "./preference/ledger";
import {
  addToBlacklist,
  goNext,
  goPrev,
  popUndo,
  pushHistory,
  pushManyHistory,
  readMode,
  removeFromBlacklist,
  writeLastRotation,
} from "./state";
import { restoreFromTrash, trashAndRecordUndo } from "./trash";
import { WallhavenClient } from "./wallhaven";
import { wallhavenWebFav, wallhavenWebUnfav } from "./wallhaven-web";

const log = getLogger("core");

export interface CoreResult {
  action: string;
  ok: boolean;
  monitor: string | null;
  image: string | null;
  status: string | null;
  error: string | null;
  extra: Record<string, unknown>;
}

type UrlOpener = (url: string) => void | Promise<void>;

function defaultUrlOpener(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command as string, args as string[], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => undefined);
  child.unref();
}

let urlOpener: UrlOpener = defaultUrlOpener;

export function setUrlOpener(opener: UrlOpener | null): void {
  urlOpener = opener ?? defaultUrlOpener;
}

export function openUrl(url: string): void {
  try {
    void Promise.resolve(urlOpener(url)).catch(() => undefined);
  } catch {
    // Opening a browser is a convenience and must not fail the action.
  }
}

function result(action: string, fields?: Partial<Omit<CoreResult, "action">>): CoreResult {
  return {
    action,
    ok: true,
    monitor: null,
    image: null,
    status: null,
    error: null,
    extra: {},
    ...fields,
  };
}

function failure(action: string, error: string): CoreResult {
  return result(action, { ok: false, error });
}

function withStateLock<T>(fn: () => Promise<T> | T): Promise<T> {
  return withFileLock(getDefaultLockPath(), fn);
}

export function isFavoritePath(config: Pick<WayperConfig, "download_dir">, image: string): boolean {
  const relative = path.relative(path.resolve(config.download_dir), path.resolve(image));
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.split(path.sep)[0] === "favorites";
  }
  return image.includes("favorites");
}

function recordFeedbackLocked(
  config: WayperConfig,
  action: string,
  filename: string,
  options?: { context?: string; model?: Record<string, unknown> | null },
): void {
  try {
    appendPreferenceFeedback(config, action, filename, {
      source: "core",
      context: options?.context ?? "core",
      model: options?.model ?? null,
    });
  } catch (error) {
    log.warn(`Could not record preference feedback for ${filename}`, error);
  }
}

export async function scheduleRetrain(config: WayperConfig): Promise<void> {
  try {
    await schedulePreferenceModelRetrain(config);
  } catch (error) {
    log.warn("Could not schedule preference model refresh", error);
  }
}

function resolveMonitor(
  config: WayperConfig,
  monitor: string | null | undefined,
  includeCurrent = true,
): { monitor: string | null; monitorConfig: MonitorConfig | null; currentImage: string | null } {
  if (!monitor) return getContext(config);
  const monitorConfig = findMonitor(config, monitor);
  if (!includeCurrent) return { monitor, monitorConfig, currentImage: null };
  return { monitor, monitorConfig, currentImage: queryCurrent()[monitor] ?? null };
}

const UNMANAGED_WALLPAPER = "Current wallpaper is not in the Wayper library";

// The compositor can show an image another tool set. Acting on "the current
// wallpaper" must never move or trash a file outside the library.
function isInLibrary(config: WayperConfig, image: string): boolean {
  const relative = path.relative(path.resolve(config.download_dir), path.resolve(image));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function instantTransition(config: WayperConfig): TransitionConfig {
  return { ...NO_TRANSITION, resize: config.transition.resize };
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function updateMonitorsForMovedImage(config: WayperConfig, oldPath: string, newPath: string): void {
  let current: Record<string, string | null>;
  try {
    current = queryCurrent();
  } catch {
    return;
  }
  for (const [monitor, image] of Object.entries(current)) {
    if (image && samePath(image, oldPath)) {
      setWallpaper(monitor, newPath, instantTransition(config));
    }
  }
}

function replaceOnAllMonitors(
  config: WayperConfig,
  bannedImage: string,
  purities: Iterable<Purity>,
  exclude: string,
): Record<string, string> {
  const replacements: Record<string, string> = {};
  let current: Record<string, string | null>;
  try {
    current = queryCurrent();
  } catch {
    return replacements;
  }
  const active = [...purities];
  for (const monitor of config.monitors) {
    const shown = current[monitor.name];
    if (!shown || !samePath(shown, bannedImage)) continue;
    const next = pickRandomWallpaper(config, active, monitor.orientation, exclude);
    if (!next) continue;
    setWallpaper(monitor.name, next, config.transition);
    pushHistory(config, monitor.name, next);
    replacements[monitor.name] = next;
  }
  return replacements;
}

async function syncRemoteFavorite(
  config: WayperConfig,
  filename: string,
  wantFavorite: boolean,
  wait: boolean,
): Promise<boolean | null> {
  if (!config.wallhaven_username) return wait ? false : null;
  const task = (wantFavorite ? wallhavenWebFav : wallhavenWebUnfav)(config, filename).catch(
    (error: unknown) => {
      log.warn(`Wallhaven favorite sync failed for ${filename}`, error);
      return false;
    },
  );
  return wait ? task : null;
}

export async function doSetWallpaper(
  config: WayperConfig,
  monitor: string,
  image: string,
): Promise<CoreResult> {
  if (!findMonitor(config, monitor)) return failure("set", "Monitor not found");
  await withStateLock(() => {
    setWallpaper(monitor, image, config.transition);
    writeLastRotation(config);
  });
  return result("set", { monitor, image });
}

export async function doSetGreeter(config: WayperConfig, image: string): Promise<CoreResult> {
  return withStateLock(() => {
    const updated: WayperConfig = structuredClone(config);
    try {
      installGreeterImage(updated.greeter, image);
    } catch (error) {
      if (error instanceof GreeterError) return failure("greeter", error.message);
      throw error;
    }
    updated.greeter.fixed_image = path.basename(image);
    try {
      saveConfig(updated);
    } catch {
      return failure("greeter", "Login background copied, but fixed mode could not be saved");
    }
    config.greeter = updated.greeter;
    return result("greeter", { image });
  });
}

function pickNext(config: WayperConfig, monitor: string, orientation: string): string | null {
  const forward = goNext(config, monitor);
  if (forward) return forward;
  const image = pickRandomWallpaper(config, readMode(config), orientation);
  if (image) pushHistory(config, monitor, image);
  return image;
}

export async function doNext(config: WayperConfig, monitor?: string | null): Promise<CoreResult> {
  const started = performance.now();
  const outcome = await withStateLock(() => {
    const resolved = resolveMonitor(config, monitor, false);
    if (!resolved.monitor || !resolved.monitorConfig) {
      log.warn("next: no monitor config found");
      return failure("next", "No monitor config found");
    }
    const image = pickNext(config, resolved.monitor, resolved.monitorConfig.orientation);
    if (!image) {
      log.warn(`next: no images available for ${resolved.monitor}`);
      return failure("next", "No images available");
    }
    setWallpaper(resolved.monitor, image, config.transition);
    writeLastRotation(config);
    return result("next", { monitor: resolved.monitor, image });
  });
  if (outcome.ok && outcome.image) {
    log.info(
      `next: ${outcome.monitor} → ${path.basename(outcome.image)} ` +
        `(total=${Math.round(performance.now() - started)}ms)`,
    );
  }
  return outcome;
}

export async function doPrev(config: WayperConfig, monitor?: string | null): Promise<CoreResult> {
  const outcome = await withStateLock(() => {
    const resolved = resolveMonitor(config, monitor, false);
    if (!resolved.monitor || !resolved.monitorConfig) {
      log.warn("prev: no monitor config found");
      return failure("prev", "No monitor config found");
    }
    const image = goPrev(config, resolved.monitor);
    if (!image) return result("prev", { status: "at_oldest" });
    setWallpaper(resolved.monitor, image, config.transition);
    writeLastRotation(config);
    return result("prev", { monitor: resolved.monitor, image });
  });
  if (outcome.image) log.info(`prev: ${outcome.monitor} → ${path.basename(outcome.image)}`);
  return outcome;
}

export interface ImageActionOptions {
  monitor?: string | null;
  image?: string | null;
  waitRemote?: boolean;
}

async function moveBetweenLibraries(
  config: WayperConfig,
  action: "fav" | "unfav",
  options: ImageActionOptions,
): Promise<CoreResult> {
  const toFavorites = action === "fav";
  const moved = await withStateLock(() => {
    let monitor = options.monitor ?? null;
    let image: string;
    if (options.image) {
      image = options.image;
    } else {
      const resolved = resolveMonitor(config, monitor);
      monitor = resolved.monitor;
      if (!resolved.currentImage || !resolved.monitorConfig) {
        return failure(action, "No current wallpaper");
      }
      if (!isInLibrary(config, resolved.currentImage)) return failure(action, UNMANAGED_WALLPAPER);
      image = resolved.currentImage;
    }
    if (isFavoritePath(config, image) === toFavorites) {
      return result(action, { status: toFavorites ? "already_favorite" : "not_favorite" });
    }
    const purity = purityFromPath(config.download_dir, image);
    const orientation = orientationFromPath(config.download_dir, image);
    const destDir = toFavorites
      ? favoritesDir(config.download_dir, purity, orientation)
      : poolDir(config.download_dir, purity, orientation);
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, path.basename(image));
    fs.renameSync(image, dest);

    if (options.image) {
      updateMonitorsForMovedImage(config, image, dest);
    } else if (monitor) {
      setWallpaper(monitor, dest, instantTransition(config));
    }
    recordFeedbackLocked(config, toFavorites ? "favorite" : "unfavorite", path.basename(dest));
    return result(action, { monitor, image: dest, extra: { source_image: image } });
  });
  if (!moved.ok || moved.status || !moved.image) return moved;

  await scheduleRetrain(config);
  const remoteSync = await syncRemoteFavorite(
    config,
    path.basename(moved.image),
    toFavorites,
    options.waitRemote ?? true,
  );
  moved.extra = { remote_sync: remoteSync };
  return moved;
}

export async function doFav(
  config: WayperConfig,
  options: ImageActionOptions & { openUrl?: boolean } = {},
): Promise<CoreResult> {
  const outcome = await moveBetweenLibraries(config, "fav", options);
  if (outcome.ok && !outcome.status && outcome.image) {
    if (options.openUrl) openUrl(wallhavenUrl(outcome.image));
    outcome.extra = { opened: Boolean(options.openUrl), ...outcome.extra };
  }
  return outcome;
}

export function doUnfav(config: WayperConfig, options: ImageActionOptions = {}): Promise<CoreResult> {
  return moveBetweenLibraries(config, "unfav", options);
}

export interface BlockOptions extends ImageActionOptions {
  preferenceContext?: string;
  preferenceModel?: Record<string, unknown> | null;
}

async function doBlock(
  config: WayperConfig,
  action: "ban" | "dislike",
  feedbackAction: "ban" | "dislike",
  options: BlockOptions,
): Promise<CoreResult> {
  const blocked = await withStateLock(async () => {
    let monitor = options.monitor ?? null;
    let monitorConfig: MonitorConfig | null = null;
    let image: string;
    if (options.image) {
      image = options.image;
    } else {
      const resolved = resolveMonitor(config, monitor);
      monitor = resolved.monitor;
      monitorConfig = resolved.monitorConfig;
      if (!resolved.currentImage || !monitorConfig) return failure(action, "No current wallpaper");
      if (!isInLibrary(config, resolved.currentImage)) return failure(action, UNMANAGED_WALLPAPER);
      image = resolved.currentImage;
    }
    let isFile = false;
    try {
      isFile = fs.statSync(image).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) return failure(action, "Image is no longer available");

    const shownImage = image;
    if (isFavoritePath(config, image)) {
      const destDir = poolDir(
        config.download_dir,
        purityFromPath(config.download_dir, image),
        orientationFromPath(config.download_dir, image),
      );
      fs.mkdirSync(destDir, { recursive: true });
      const dest = path.join(destDir, path.basename(image));
      fs.renameSync(image, dest);
      image = dest;
    }

    const extra: Record<string, unknown> = {};
    const purities = readMode(config);
    if (options.image) {
      const replacements = replaceOnAllMonitors(config, shownImage, purities, image);
      if (Object.keys(replacements).length > 0) {
        writeLastRotation(config);
        extra.replacement_images = replacements;
      }
    } else if (monitor && monitorConfig) {
      const next = pickRandomWallpaper(config, purities, monitorConfig.orientation, image);
      if (next) {
        setWallpaper(monitor, next, config.transition);
        pushHistory(config, monitor, next);
        writeLastRotation(config);
        extra.replacement_image = next;
      }
    }

    const filename = path.basename(image);
    addToBlacklist(config, filename);
    await trashAndRecordUndo(config, image);
    clearImageDerivatives(config, image);
    recordFeedbackLocked(config, feedbackAction, filename, {
      context: options.preferenceContext ?? "core",
      model: options.preferenceModel ?? null,
    });
    return result(action, { monitor, image, extra });
  });
  if (!blocked.ok || !blocked.image) return blocked;

  await scheduleRetrain(config);
  const remoteSync = await syncRemoteFavorite(
    config,
    path.basename(blocked.image),
    false,
    options.waitRemote ?? true,
  );
  log.info(`${action}: ${blocked.monitor} → trashed ${path.basename(blocked.image)}`);
  blocked.extra = { remote_sync: remoteSync, ...blocked.extra };
  return blocked;
}

export function doBan(config: WayperConfig, options: BlockOptions = {}): Promise<CoreResult> {
  const context = options.preferenceContext ?? "core";
  return doBlock(config, "ban", context === "model_review" ? "dislike" : "ban", {
    ...options,
    preferenceContext: context,
  });
}

export function doDislike(
  config: WayperConfig,
  options: ImageActionOptions = {},
): Promise<CoreResult> {
  return doBlock(config, "dislike", "dislike", {
    ...options,
    preferenceContext: "manual_dislike",
  });
}

export async function doUnban(config: WayperConfig, monitor?: string | null): Promise<CoreResult> {
  const outcome = await withStateLock(() => {
    const entry = popUndo(config);
    if (!entry) return result("unban", { status: "nothing_to_undo" });
    const restored = restoreFromTrash(config, entry.filename, entry.originalDir);
    removeFromBlacklist(config, entry.filename);

    let unbanned: CoreResult;
    if (restored) {
      const target = monitor || getFocusedMonitor();
      if (target) {
        setWallpaper(target, restored, config.transition);
        writeLastRotation(config);
      }
      unbanned = result("unban", { monitor: target ?? null, image: restored });
    } else {
      unbanned = result("unban", {
        status: "file_missing",
        extra: { note: "blacklist entry removed but file not found in trash" },
      });
    }
    recordFeedbackLocked(config, "unban", entry.filename);
    return unbanned;
  });
  if (outcome.status !== "nothing_to_undo") await scheduleRetrain(config);
  return outcome;
}

export function setAllWallpapers(config: WayperConfig, purities: Iterable<Purity>): Promise<void> {
  const active = [...purities];
  return withStateLock(() => {
    const historyItems: Array<readonly [string, string]> = [];
    for (const monitor of config.monitors) {
      const image = pickRandomWallpaper(config, active, monitor.orientation);
      if (!image) continue;
      setWallpaper(monitor.name, image, config.transition);
      historyItems.push([monitor.name, image]);
    }
    pushManyHistory(config, historyItems);
    writeLastRotation(config);
  });
}

export function libraryCounts(
  config: Pick<WayperConfig, "download_dir">,
  purities: Iterable<string>,
  orientations: Iterable<string>,
  count: (directory: string) => number = countImagesInDir,
): [number, number] {
  const orientationList = [...orientations];
  let poolCount = 0;
  let favoriteCount = 0;
  for (const purity of purities) {
    for (const orientation of orientationList) {
      poolCount += count(poolDir(config.download_dir, purity, orientation));
      favoriteCount += count(favoritesDir(config.download_dir, purity, orientation));
    }
  }
  return [poolCount, favoriteCount];
}

export function statusSnapshot(config: WayperConfig): Record<string, unknown> {
  const purities = readMode(config);
  const current = queryCurrent();
  return {
    mode: [...purities].sort(),
    disk_mb: Math.round(diskUsageMb(config) * 10) / 10,
    quota_mb: config.quota_mb,
    monitors: config.monitors.map((monitor) => {
      const [poolCount, favoriteCount] = libraryCounts(config, purities, [monitor.orientation]);
      return {
        name: monitor.name,
        orientation: monitor.orientation,
        image: current[monitor.name] ?? null,
        pool_count: poolCount,
        favorites_count: favoriteCount,
      };
    }),
  };
}

function metadataBackfillFilenames(config: WayperConfig, includeHistory: boolean): Set<string> {
  const filenames = new Set<string>();
  for (const purity of ALL_PURITIES) {
    for (const orientation of ALL_ORIENTATIONS) {
      for (const directory of [
        poolDir(config.download_dir, purity, orientation),
        favoritesDir(config.download_dir, purity, orientation),
        path.join(modelReviewDirPath(config), purity, orientation),
      ]) {
        for (const image of listImagesInDir(directory)) filenames.add(path.basename(image));
      }
    }
  }
  try {
    for (const event of loadPreferenceFeedback(config).events) {
      if (typeof event.filename === "string") filenames.add(event.filename);
    }
  } catch (error) {
    log.warn("Could not include preference feedback in metadata backfill", error);
  }
  if (includeHistory) {
    for (const filename of Object.keys(loadMetadata(config))) filenames.add(filename);
  }
  return filenames;
}

type MetadataRecord = Record<string, unknown>;

function asMetadataRecord(value: unknown): MetadataRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as MetadataRecord)
    : null;
}

function hasItems(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function backfillSortKey(record: MetadataRecord | null, filename: string): [number, number, number, number, string] {
  const tags = record?.tags;
  const details = record?.tag_details;
  const missingDetails = Math.max(
    0,
    (Array.isArray(tags) ? tags.length : 0) - (Array.isArray(details) ? details.length : 0),
  );
  return [
    record === null ? 0 : 1,
    record === null || !hasItems(tags) ? 0 : 1,
    record === null || !hasItems(details) ? 0 : 1,
    -missingDetails,
    filename,
  ];
}

export function metadataBackfillStatus(
  config: WayperConfig,
  options?: { includeHistory?: boolean },
): Record<string, number> {
  const metadata = loadMetadata(config) as Record<string, unknown>;
  const filenames = metadataBackfillFilenames(config, options?.includeHistory ?? false);
  let missingRecords = 0;
  let missingTags = 0;
  let incomplete = 0;
  let unavailable = 0;
  let tagDetailsComplete = 0;
  let partialTagDetails = 0;
  let missingTagDetails = 0;
  for (const filename of filenames) {
    const record = asMetadataRecord(metadata[filename]);
    if (record === null) {
      missingRecords += 1;
      continue;
    }
    const tagged = hasItems(record.tags);
    if (!tagged) missingTags += 1;
    if (record.metadata_complete !== true) incomplete += 1;
    if (record.metadata_unavailable === true) unavailable += 1;
    if (tagged && record.tag_details_complete === true) tagDetailsComplete += 1;
    if (tagged && hasItems(record.tag_details) && record.tag_details_complete !== true) {
      partialTagDetails += 1;
    }
    if (tagged && !hasItems(record.tag_details)) missingTagDetails += 1;
  }
  return {
    records: filenames.size,
    missing_records: missingRecords,
    missing_tags: missingTags,
    missing_tag_inputs: missingRecords + missingTags,
    incomplete_records: missingRecords + incomplete,
    complete_records: filenames.size - missingRecords - incomplete,
    unavailable_records: unavailable,
    tag_details_complete_records: tagDetailsComplete,
    partial_tag_detail_records: partialTagDetails,
    missing_tag_detail_records: missingTagDetails,
  };
}

export interface BackfillOptions {
  includeHistory?: boolean;
  missingTagsOnly?: boolean;
  limit?: number | null;
  delaySeconds?: number;
  batchSize?: number;
  progress?: (state: Record<string, number>) => void;
  client?: Pick<WallhavenClient, "wallpaperInfo">;
}

export async function doBackfillMetadata(
  config: WayperConfig,
  options: BackfillOptions = {},
): Promise<CoreResult> {
  const metadata = loadMetadata(config) as Record<string, unknown>;
  const filenames = metadataBackfillFilenames(config, options.includeHistory ?? false);
  const needsFetch = (filename: string): boolean => {
    const record = asMetadataRecord(metadata[filename]);
    if (record === null) return true;
    if (options.missingTagsOnly) return !hasItems(record.tags);
    return record.metadata_complete !== true;
  };
  const eligible = [...filenames].filter(needsFetch).sort((left, right) => {
    const first = backfillSortKey(asMetadataRecord(metadata[left]), left);
    const second = backfillSortKey(asMetadataRecord(metadata[right]), right);
    for (let index = 0; index < 4; index += 1) {
      const delta = (first[index] as number) - (second[index] as number);
      if (delta !== 0) return delta;
    }
    return first[4] < second[4] ? -1 : first[4] > second[4] ? 1 : 0;
  });
  const targets =
    options.limit === null || options.limit === undefined
      ? eligible
      : eligible.slice(0, Math.max(0, options.limit));
  const total = targets.length;
  if (total === 0) {
    const remaining = eligible.length;
    return result("metadata_backfill", {
      status: remaining ? "partial" : "complete",
      extra: {
        targeted: 0,
        updated: 0,
        failed: 0,
        remaining,
        tag_hydration: hydrateTagDetails(config),
      },
    });
  }

  const client = options.client ?? new WallhavenClient(config);
  const delayMs = (options.delaySeconds ?? 1.4) * 1000;
  const batchSize = Math.max(1, options.batchSize ?? 20);
  let pending: Record<string, Record<string, unknown>> = {};
  let unavailable: Record<string, Record<string, unknown>> = {};
  let attempted = 0;
  let updated = 0;
  let failed = 0;

  const commit = (): void => {
    const batch = pending;
    pending = {};
    if (Object.keys(batch).length > 0) {
      saveMetadataBatch(config, batch, { complete: true });
      updated += Object.keys(batch).length;
    }
    const missing = unavailable;
    unavailable = {};
    if (Object.keys(missing).length > 0) {
      saveMetadataBatch(config, missing, { complete: false });
    }
  };

  try {
    for (let index = 0; index < total; index += 1) {
      const filename = targets[index];
      const detail = await client.wallpaperInfo(wallhavenId(filename), { retries: 1 });
      attempted += 1;
      if (Object.keys(detail).length > 0) {
        pending[filename] = detail;
      } else {
        failed += 1;
        unavailable[filename] = {
          id: wallhavenId(filename),
          metadata_unavailable: true,
          metadata_error: "unavailable_or_request_failed",
          metadata_checked_at: Math.floor(Date.now() / 1000),
        };
      }
      if (Object.keys(pending).length + Object.keys(unavailable).length >= batchSize) commit();
      if (options.progress && (attempted === total || attempted % 10 === 0)) {
        options.progress({
          targeted: total,
          attempted,
          updated: updated + Object.keys(pending).length,
          failed,
        });
      }
      if (index + 1 < total && delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  } finally {
    commit();
  }

  const remaining = Math.max(0, eligible.length - updated);
  return result("metadata_backfill", {
    status: remaining ? "partial" : "complete",
    extra: {
      targeted: total,
      attempted,
      updated,
      failed,
      remaining,
      tag_hydration: hydrateTagDetails(config),
    },
  });
}
