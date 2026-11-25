import fs from "node:fs";
import path from "node:path";
import type {
  BlocklistEntry,
  BlocklistResponse,
  ConfigPatchPayload,
  ConfigPayload,
  DiskUsageResponse,
  ImageItem,
  ImageMetadata,
  ImagePage,
  MonitorInfo,
  Purity,
  SearchResponse,
  StatusResponse,
  UpdateCheckResponse,
  WayperPushEvent,
} from "../shared/types";
import { AutostartError, setAutostart, type AutostartCommand } from "./autostart";
import { detectMonitors, getContext, queryCurrent } from "./backend";
import {
  applyConfigUpdates,
  configPayload,
  loadConfig,
  saveConfig,
  type WayperConfig,
} from "./config";
import type { ControlActionPayload, ControlActionResponse } from "./control-ipc";
import {
  doBan,
  doDislike,
  doFav,
  doNext,
  doPrev,
  doSetGreeter,
  doSetWallpaper,
  doUnban,
  doUnfav,
  isFavoritePath,
  libraryCounts,
  purgeBlacklistedFavorites,
  scheduleRetrain,
  type CoreResult,
} from "./core";
import { runHeavyTaskInProcess, type HeavyTaskRunner } from "./heavy-tasks";
import { probeImageDimensions } from "./image-probe";
import { getDefaultLockPath, withFileLock } from "./lock";
import { getLogger } from "./logging";
import {
  ALL_ORIENTATIONS,
  ALL_PURITIES,
  expandPath,
  favoritesDir,
  getConfigFile,
  isOrientation,
  isPurity,
  poolDir,
  purityFromPath,
} from "./paths";
import { diskUsageMb, ensureDirectories, listImagesInDir, loadMetadata } from "./pool";
import { AUTO_RETRAIN_MIN_FEEDBACK } from "./preference/constants";
import {
  appendPreferenceFeedback,
  currentFeedbackRevision,
  loadPreferenceModel,
  preferenceFeedbackPath,
  preferenceLearningStatus,
  preferenceModelPath,
  schedulePreferenceModelRetrain,
} from "./preference/ledger";
import {
  clearModelReviewItems,
  listModelReviewItems,
  ModelReviewError,
  modelReviewStatus,
  resolveModelReviewItem,
} from "./preference/review";
import type { AutoRotationService } from "./rotation";
import { isBlacklisted, listBlacklist, readMode, removeFromBlacklist, writeMode } from "./state";
import {
  checkTrashAccess,
  findTrashImage,
  getTrashCacheGeneration,
  listRecoverableTrash,
  restoreFromTrash,
  trashSearchDirs,
} from "./trash";
import { checkForUpdates } from "./update";
import {
  reconnectWallhaven,
  syncCloudTagBlacklist,
  syncCloudUserBlacklist,
} from "./wallhaven-web";

const log = getLogger("service");

export const MAX_IMAGE_PAGE_LIMIT = 500;
const PREFERENCE_SUGGESTION_CACHE_LIMIT = 12;
const RULE_SUGGESTION_CACHE_LIMIT = 24;
const WATCH_INTERVAL_MS = 2000;

type JsonRecord = Record<string, unknown>;
type StatToken = string;

export class ServiceError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
  }
}

export interface WayperServiceOptions {
  rotation?: AutoRotationService | null;
  emit?: (event: WayperPushEvent) => void;
  runHeavy?: HeavyTaskRunner;
  autostartCommand?: () => AutostartCommand | undefined;
}

function statToken(target: string): StatToken {
  try {
    const stat = fs.statSync(target);
    return `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  } catch {
    return "0:0:0";
  }
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function parsePurities(raw: Iterable<string> | string | null | undefined): Purity[] {
  const values = typeof raw === "string" ? raw.split(",") : [...(raw ?? [])];
  const wanted = new Set(values.map((value) => value.trim()).filter(isPurity));
  const purities = ALL_PURITIES.filter((purity) => wanted.has(purity));
  return purities.length > 0 ? purities : ["sfw"];
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WayperService {
  private readonly rotation: AutoRotationService | null;
  private readonly emit: (event: WayperPushEvent) => void;
  private readonly runHeavy: HeavyTaskRunner;
  private readonly autostartCommand: () => AutostartCommand | undefined;

  private cachedConfig: WayperConfig | null = null;
  private cachedConfigToken = "";
  private cachedMetadata: Record<string, ImageMetadata> | null = null;
  private cachedMetadataToken = "";
  private readonly imageDirCache = new Map<
    string,
    { token: StatToken; records: Array<{ mtimeMs: number; file: string }> }
  >();
  private blocklistCache: { token: string; payload: Omit<BlocklistResponse, "images"> } | null =
    null;
  private diskUsageCache: { token: string; usedMb: number } | null = null;
  private readonly suggestionCache = new Map<string, JsonRecord>();
  private readonly suggestionInflight = new Map<string, Promise<JsonRecord>>();
  private readonly ruleSuggestionCache = new Map<string, JsonRecord>();
  private readonly ruleSuggestionInflight = new Map<string, Promise<JsonRecord>>();
  private watchTimer: NodeJS.Timeout | null = null;
  private watchingRequested = false;
  private watchingActive = true;
  private pollWatchOnce: (() => void) | null = null;

  constructor(options: WayperServiceOptions = {}) {
    this.rotation = options.rotation ?? null;
    this.emit = options.emit ?? (() => undefined);
    this.runHeavy = options.runHeavy ?? runHeavyTaskInProcess;
    this.autostartCommand = options.autostartCommand ?? (() => undefined);
  }

  // ------------------------------------------------------------------
  // Cached state
  // ------------------------------------------------------------------

  getConfig(detectDisplays = true): WayperConfig {
    const token = statToken(getConfigFile());
    if (this.cachedConfig === null || token !== this.cachedConfigToken) {
      this.cachedConfig = loadConfig(undefined, { detectDisplays: false });
      this.cachedConfigToken = token;
    }
    if (detectDisplays) {
      try {
        this.cachedConfig.monitors = detectMonitors();
      } catch {
        // Keep the monitors from config.toml when the display backend is unavailable.
      }
    }
    return this.cachedConfig;
  }

  private adoptConfig(config: WayperConfig): void {
    this.cachedConfig = config;
    this.cachedConfigToken = statToken(getConfigFile());
  }

  private metadata(): Record<string, ImageMetadata> {
    const config = this.getConfig(false);
    const token = `${config.download_dir}|${statToken(path.join(config.download_dir, ".metadata.json"))}`;
    if (this.cachedMetadata === null || token !== this.cachedMetadataToken) {
      this.cachedMetadata = loadMetadata(config);
      this.cachedMetadataToken = token;
    }
    return this.cachedMetadata;
  }

  private clearLibraryCaches(): void {
    this.imageDirCache.clear();
    this.cachedMetadata = null;
    this.cachedMetadataToken = "";
    this.blocklistCache = null;
    this.diskUsageCache = null;
    this.suggestionCache.clear();
    this.ruleSuggestionCache.clear();
  }

  private invalidateMutationCaches(): void {
    this.imageDirCache.clear();
    this.blocklistCache = null;
    this.diskUsageCache = null;
    this.suggestionCache.clear();
    this.ruleSuggestionCache.clear();
  }

  private cachedDirImages(directory: string): Array<{ mtimeMs: number; file: string }> {
    const token = statToken(directory);
    if (token === "0:0:0") {
      this.imageDirCache.delete(directory);
      return [];
    }
    const cached = this.imageDirCache.get(directory);
    if (cached && cached.token === token) return cached.records;
    const records: Array<{ mtimeMs: number; file: string }> = [];
    for (const file of listImagesInDir(directory)) {
      try {
        records.push({ mtimeMs: fs.statSync(file).mtimeMs, file });
      } catch {
        // The file disappeared between listing and stat.
      }
    }
    records.sort((left, right) => right.mtimeMs - left.mtimeMs);
    this.imageDirCache.set(directory, { token, records });
    return records;
  }

  private resolveImage(config: WayperConfig, imagePath: string): string {
    const root = path.resolve(config.download_dir);
    const full = path.resolve(root, String(imagePath ?? ""));
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw new ServiceError(403, "Path traversal not allowed");
    }
    if (!isFile(full)) throw new ServiceError(404, "Image not found");
    return full;
  }

  private relativeImage(config: WayperConfig, image: string | null | undefined): string | null {
    if (!image) return null;
    const relative = path.relative(path.resolve(config.download_dir), path.resolve(image));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return toPosix(image);
    return toPosix(relative);
  }

  private relativeImageMap(config: WayperConfig, images: unknown): Record<string, string> {
    const mapped: Record<string, string> = {};
    if (images === null || typeof images !== "object") return mapped;
    for (const [monitor, image] of Object.entries(images as Record<string, unknown>)) {
      const relative = this.relativeImage(config, typeof image === "string" ? image : null);
      if (relative !== null) mapped[monitor] = relative;
    }
    return mapped;
  }

  private poolImageLocation(config: WayperConfig, image: string): [Purity, string] | null {
    const parent = path.dirname(path.resolve(image));
    for (const purity of ALL_PURITIES) {
      for (const orientation of ALL_ORIENTATIONS) {
        if (parent === path.resolve(poolDir(config.download_dir, purity, orientation))) {
          return [purity, orientation];
        }
      }
    }
    return null;
  }

  private learningPayload(config: WayperConfig, fast: boolean): JsonRecord | null {
    try {
      if (!fast) return preferenceLearningStatus(config);
      const model = loadPreferenceModel(preferenceModelPath(config));
      const previous = model?.training_summary.feedback_revision;
      const pending = Math.max(
        0,
        currentFeedbackRevision(config) - (typeof previous === "number" ? previous : 0),
      );
      return {
        status: model ? "ready" : "untrained",
        pending_feedback: pending,
        minimum_feedback: AUTO_RETRAIN_MIN_FEEDBACK,
        due: Boolean(model && pending >= AUTO_RETRAIN_MIN_FEEDBACK),
        approximate: true,
      };
    } catch (error) {
      log.debug("Could not refresh preference learning status", error);
      return null;
    }
  }

  private requireOk(result: CoreResult): CoreResult {
    if (!result.ok) throw new ServiceError(400, result.error ?? "Action failed");
    return result;
  }

  // ------------------------------------------------------------------
  // Configuration
  // ------------------------------------------------------------------

  getConfigPayload(): ConfigPayload {
    const config = this.getConfig(false);
    return configPayload(config, readMode(config));
  }

  async patchConfig(updates: ConfigPatchPayload): Promise<{ status: "ok" }> {
    if (updates === null || typeof updates !== "object") {
      throw new ServiceError(400, "Config update must be an object");
    }
    const config = this.getConfig();
    const original = structuredClone(config);
    const restore = (): void => {
      Object.assign(config, original);
    };
    const { autostart: requestedAutostart, ...rest } = updates;
    let changes: ReturnType<typeof applyConfigUpdates>;
    try {
      changes = applyConfigUpdates(config, rest, (raw) => {
        if (typeof raw !== "string") throw new ServiceError(400, "download_dir must be a string");
        const value = raw.trim();
        if (!value) throw new ServiceError(400, "download_dir cannot be empty");
        const expanded = expandPath(value);
        if (!path.isAbsolute(expanded)) {
          throw new ServiceError(400, "download_dir must be an absolute path or start with ~");
        }
        return expanded;
      });
    } catch (error) {
      restore();
      throw error;
    }
    if (rest.download_dir !== undefined) {
      try {
        ensureDirectories(config);
      } catch (error) {
        restore();
        throw new ServiceError(400, `Cannot create download directory: ${errorMessage(error)}`);
      }
    }
    if (requestedAutostart !== undefined && Boolean(requestedAutostart) !== config.autostart) {
      try {
        setAutostart(config, Boolean(requestedAutostart), this.autostartCommand());
      } catch (error) {
        restore();
        if (error instanceof AutostartError) {
          throw new ServiceError(400, `Cannot update autostart: ${error.message}`);
        }
        throw error;
      }
    } else {
      saveConfig(config);
    }
    this.adoptConfig(config);
    this.rotation?.requestReload();
    if (changes.download_dir_changed) this.clearLibraryCaches();
    if (changes.exclude_tags_changed) {
      void syncCloudTagBlacklist(config).catch(() => undefined);
    }
    if (changes.exclude_uploaders_changed) {
      void syncCloudUserBlacklist(config).catch(() => undefined);
    }
    this.emit({ type: "config" });
    return { status: "ok" };
  }

  async setMode(requested: Iterable<string>): Promise<{ status: "ok"; purities: Purity[] }> {
    const config = this.getConfig();
    const wanted = new Set([...(requested ?? [])].filter(isPurity));
    if (wanted.size === 0) throw new ServiceError(400, "At least one valid purity required");
    const purities: Purity[] = config.safe_mode
      ? ["sfw"]
      : ALL_PURITIES.filter((purity) => wanted.has(purity));
    writeMode(config, purities);

    for (const [monitor, image] of Object.entries(queryCurrent())) {
      if (image && !purities.includes(purityFromPath(config.download_dir, image))) {
        await doNext(config, monitor);
      }
    }
    this.rotation?.wake();
    return { status: "ok", purities: [...purities].sort() };
  }

  // ------------------------------------------------------------------
  // Status
  // ------------------------------------------------------------------

  rotationSnapshot(): { auto_rotation: boolean; rotation_paused: boolean } {
    const config = this.getConfig(false);
    return this.rotation?.snapshot(config) ?? { auto_rotation: false, rotation_paused: false };
  }

  getStatus(params?: {
    orient?: string;
    include_recoverable?: boolean;
    monitor?: string;
  }): StatusResponse {
    const config = this.getConfig();
    const rotation = this.rotationSnapshot();
    const purities = readMode(config);
    const selected = config.monitors.find((monitor) => monitor.name === params?.monitor) ?? null;
    const orientation = selected
      ? selected.orientation
      : isOrientation(params?.orient)
        ? params.orient
        : null;
    const [poolCount, favoritesCount] = libraryCounts(
      config,
      purities,
      orientation ? [orientation] : ALL_ORIENTATIONS,
      (directory) =>
        this.cachedDirImages(directory).filter(
          (entry) => !isBlacklisted(config, path.basename(entry.file)),
        ).length,
    );
    const blocklistCount = listBlacklist(config).length;
    const recoverableCount =
      (params?.include_recoverable ?? true) ? this.blocklistPayload(config).recoverable_count : 0;

    let review: JsonRecord = { pending_count: 0, ready: false };
    try {
      review = modelReviewStatus(config, {
        purities: selected ? purities : null,
        orientation: selected ? orientation : null,
        includeLearning: false,
      });
    } catch (error) {
      log.debug("Could not read model review status", error);
    }
    return {
      auto_rotation: rotation.auto_rotation,
      rotation_paused: rotation.rotation_paused,
      monitor: selected ? selected.name : null,
      orientation,
      pool_count: poolCount,
      favorites_count: favoritesCount,
      blocklist_count: blocklistCount,
      recoverable_count: recoverableCount,
      mode: [...purities].sort(),
      model_review_count: Number(review.pending_count ?? 0),
      model_filter_ready: Boolean(review.ready),
    };
  }

  private diskUsageToken(config: WayperConfig): string {
    const root = config.download_dir;
    const tokens = [path.resolve(root)];
    for (const purity of ALL_PURITIES) {
      for (const orient of ALL_ORIENTATIONS) {
        tokens.push(
          statToken(poolDir(root, purity, orient)),
          statToken(favoritesDir(root, purity, orient)),
        );
      }
    }
    return tokens.join("|");
  }

  getDiskUsage(): DiskUsageResponse {
    const config = this.getConfig(false);
    const token = this.diskUsageToken(config);
    if (this.diskUsageCache === null || this.diskUsageCache.token !== token) {
      this.diskUsageCache = {
        token,
        usedMb: Math.round(diskUsageMb(config) * 10) / 10,
      };
    }
    return { used_mb: this.diskUsageCache.usedMb, quota_mb: config.quota_mb };
  }

  getMonitors(): MonitorInfo[] {
    const config = this.getConfig();
    const current = queryCurrent();
    const root = path.resolve(config.download_dir);
    return config.monitors.map((monitor) => {
      const image = current[monitor.name];
      let relative: string | null = null;
      if (image) {
        const candidate = path.relative(root, path.resolve(image));
        if (candidate && !candidate.startsWith("..") && !path.isAbsolute(candidate)) {
          relative = toPosix(candidate);
        }
      }
      return {
        name: monitor.name,
        width: monitor.width,
        height: monitor.height,
        orientation: monitor.orientation,
        current_image: relative,
      };
    });
  }

  setRotation(action: string): { status: "ok"; auto_rotation: boolean; rotation_paused: boolean } {
    if (action !== "pause" && action !== "resume") throw new ServiceError(400, "Invalid action");
    if (action === "pause") this.rotation?.pause();
    else this.rotation?.resume();
    const snapshot = this.rotationSnapshot();
    this.emit({ type: "rotation", ...snapshot });
    return { status: "ok", ...snapshot };
  }

  // ------------------------------------------------------------------
  // Wallpaper actions
  // ------------------------------------------------------------------

  private async runControl(
    config: WayperConfig,
    action: string,
    monitor: string | null,
    openUrl: boolean,
  ): Promise<CoreResult> {
    let outcome: CoreResult;
    switch (action) {
      case "next": {
        outcome = await doNext(config, monitor);
        if (outcome.ok) this.rotation?.requestRefill(config);
        return outcome;
      }
      case "prev":
        return doPrev(config, monitor);
      case "unban":
        outcome = await doUnban(config, monitor);
        break;
      case "ban":
        outcome = await doBan(config, { monitor, waitRemote: false });
        break;
      case "dislike":
        outcome = await doDislike(config, { monitor, waitRemote: false });
        break;
      case "fav":
        outcome = await doFav(config, { monitor, openUrl, waitRemote: false });
        break;
      case "unfav":
        outcome = await doUnfav(config, { monitor, waitRemote: false });
        break;
      default:
        throw new ServiceError(400, `Unknown action: ${action}`);
    }
    if (outcome.ok) this.invalidateMutationCaches();
    return outcome;
  }

  async controlAction(
    action: string,
    options?: { monitor_name?: string | null; open_url?: boolean },
  ): Promise<JsonRecord> {
    const config = this.getConfig();
    const monitor = options?.monitor_name || getContext(config).monitor;
    const result = this.requireOk(
      await this.runControl(config, action, monitor, options?.open_url === true),
    );
    const response: JsonRecord = { status: result.status ?? "ok" };
    if (result.image) response.image = result.image;
    if (result.monitor) {
      response.monitor = result.monitor;
      if (action === "ban" || action === "dislike") {
        response.current_image = this.relativeImage(
          config,
          result.extra.replacement_image as string | undefined,
        );
      } else if (result.image) {
        response.current_image = this.relativeImage(config, result.image);
      }
    }
    Object.assign(response, result.extra);
    if ("replacement_image" in response) {
      response.replacement_image = this.relativeImage(config, response.replacement_image as string);
    }
    if ("replacement_images" in response) {
      response.replacement_images = this.relativeImageMap(config, response.replacement_images);
    }
    return response;
  }

  async handleControlRequest(request: ControlActionPayload): Promise<ControlActionResponse> {
    const config = this.getConfig();
    if (path.resolve(String(request.download_dir ?? "")) !== path.resolve(config.download_dir)) {
      return { matched: false, ok: false, action: request.action };
    }
    try {
      const result = await this.runControl(
        config,
        request.action,
        request.monitor || getContext(config).monitor,
        request.open_url === true,
      );
      if (result.ok) {
        if (request.action !== "next" && request.action !== "prev") {
          this.emit({ type: "library" });
        }
        this.emit({ type: "wallpaper" });
      }
      return {
        matched: true,
        ok: result.ok,
        action: result.action,
        monitor: result.monitor,
        image: result.image,
        status: result.status,
        opened: result.extra.opened === true,
        error: result.error,
      };
    } catch (error) {
      return { matched: true, ok: false, action: request.action, error: errorMessage(error) };
    }
  }

  async setWallpaper(
    monitor: string,
    imagePath: string,
  ): Promise<{ status: "ok"; monitor: string; current_image: string }> {
    const config = this.getConfig();
    const image = this.resolveImage(config, imagePath);
    if (!config.monitors.some((item) => item.name === monitor)) {
      throw new ServiceError(404, "Monitor not found");
    }
    this.requireOk(await doSetWallpaper(config, monitor, image));
    return { status: "ok", monitor, current_image: this.relativeImage(config, image) as string };
  }

  async setGreeter(
    imagePath: string,
  ): Promise<{ status: "ok"; greeter: ConfigPayload["greeter"] }> {
    const config = this.getConfig();
    const image = this.resolveImage(config, imagePath);
    this.requireOk(await doSetGreeter(config, image));
    this.adoptConfig(config);
    this.rotation?.requestReload();
    this.emit({ type: "config" });
    return { status: "ok", greeter: configPayload(config, []).greeter };
  }

  async toggleFavorite(imagePath: string): Promise<{
    status: "ok";
    new_path: string;
    is_favorite: boolean;
    remote_sync: unknown;
  }> {
    const config = this.getConfig();
    const image = this.resolveImage(config, imagePath);
    const wasFavorite = isFavoritePath(config, image);
    const result = this.requireOk(
      wasFavorite
        ? await doUnfav(config, { image, waitRemote: false })
        : await doFav(config, { image, waitRemote: false }),
    );
    this.invalidateMutationCaches();
    const moved = result.image ?? image;
    return {
      status: "ok",
      new_path: this.relativeImage(config, moved) ?? "",
      is_favorite: isFavoritePath(config, moved),
      remote_sync: result.extra.remote_sync ?? null,
    };
  }

  async banImage(
    imagePath: string,
    options?: { monitor?: string; preference_context?: string },
  ): Promise<JsonRecord> {
    const config = this.getConfig();
    const image = this.resolveImage(config, imagePath);
    const isModelReview = options?.preference_context === "model_review";
    let reviewModel: JsonRecord | null = null;
    if (isModelReview && this.poolImageLocation(config, image) !== null) {
      reviewModel = await this.reviewFeedbackDetails(config, path.basename(image));
    }
    const result = this.requireOk(
      await doBan(config, {
        image,
        waitRemote: false,
        ...(isModelReview
          ? { preferenceContext: "model_review", preferenceModel: reviewModel }
          : {}),
      }),
    );
    this.invalidateMutationCaches();
    const response: JsonRecord = {
      status: "ok",
      replacement_images: this.relativeImageMap(config, result.extra.replacement_images),
    };
    if (isModelReview) response.learning = this.learningPayload(config, true);
    return response;
  }

  async dislikeImage(imagePath: string): Promise<JsonRecord> {
    const config = this.getConfig();
    const image = this.resolveImage(config, imagePath);
    const result = this.requireOk(await doDislike(config, { image, waitRemote: false }));
    this.invalidateMutationCaches();
    return {
      status: "ok",
      replacement_images: this.relativeImageMap(config, result.extra.replacement_images),
      learning: this.learningPayload(config, true),
    };
  }

  // ------------------------------------------------------------------
  // Library
  // ------------------------------------------------------------------

  private blocklistToken(config: WayperConfig): string {
    const parts = [
      config.download_dir,
      String(getTrashCacheGeneration()),
      statToken(path.join(config.download_dir, ".blacklist")),
      statToken(path.join(config.download_dir, ".trash_paths")),
    ];
    if (process.platform === "win32") {
      parts.push(String(Math.floor(Date.now() / 30_000)));
    } else {
      for (const directory of trashSearchDirs(config)) parts.push(statToken(directory));
    }
    return parts.join("|");
  }

  private blocklistPayload(config: WayperConfig): Omit<BlocklistResponse, "images"> {
    const token = this.blocklistToken(config);
    if (this.blocklistCache && this.blocklistCache.token === token) {
      return this.blocklistCache.payload;
    }
    const records = listBlacklist(config);
    const recoverable = listRecoverableTrash(
      config,
      records.map((record) => record.filename),
    );
    const entries: BlocklistEntry[] = records.map((record) => ({
      filename: record.filename,
      timestamp: record.timestamp,
      recoverable: recoverable.has(record.filename),
    }));
    const payload = { entries, total: entries.length, recoverable_count: recoverable.size };
    this.blocklistCache = { token, payload };
    return payload;
  }

  getBlocklist(): BlocklistResponse {
    return { ...this.blocklistPayload(this.getConfig()), images: [] };
  }

  getImagesPage(params: {
    mode?: string;
    purity?: string;
    orient?: string;
    offset?: number;
    limit?: number;
  }): ImagePage {
    const config = this.getConfig(false);
    const offset = Math.max(0, Math.trunc(Number(params?.offset ?? 0)) || 0);
    const limit = Math.min(
      MAX_IMAGE_PAGE_LIMIT,
      Math.max(1, Math.trunc(Number(params?.limit ?? 120)) || 120),
    );
    const mode = params?.mode ?? "pool";

    if (mode === "trash") {
      const recoverable = this.blocklistPayload(config).entries.filter(
        (entry) => entry.recoverable,
      );
      const items: ImageItem[] = recoverable.slice(offset, offset + limit).map((entry) => ({
        path: `__trash/${entry.filename}`,
        name: entry.filename,
        is_favorite: false,
        orientation: null,
      }));
      const next = offset + items.length;
      return {
        items,
        total: recoverable.length,
        next_offset: next >= recoverable.length ? null : next,
      };
    }

    const favorites = mode === "favorites";
    const orientations = isOrientation(params?.orient) ? [params.orient] : ALL_ORIENTATIONS;
    const records: Array<{ mtimeMs: number; file: string }> = [];
    for (const purity of parsePurities(params?.purity ?? "sfw")) {
      for (const orientation of orientations) {
        const directory = favorites
          ? favoritesDir(config.download_dir, purity, orientation)
          : poolDir(config.download_dir, purity, orientation);
        for (const entry of this.cachedDirImages(directory)) {
          if (!isBlacklisted(config, path.basename(entry.file))) {
            records.push(entry);
          }
        }
      }
    }
    records.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const root = path.resolve(config.download_dir);
    const items: ImageItem[] = records.slice(offset, offset + limit).map(({ file }) => {
      const parent = path.basename(path.dirname(file));
      return {
        path: toPosix(path.relative(root, path.resolve(file))),
        name: path.basename(file),
        is_favorite: favorites,
        orientation: isOrientation(parent) ? parent : null,
      };
    });
    const next = offset + items.length;
    return { items, total: records.length, next_offset: next >= records.length ? null : next };
  }

  getImageMetadata(filenameOrPath: string): ImageMetadata | null {
    const name = path.basename(String(filenameOrPath ?? "").replace(/\\/g, "/"));
    if (!name) return null;
    return this.metadata()[name] ?? null;
  }

  checkTrashAccess(filename: string): { readable: boolean; forbidden: boolean } {
    return checkTrashAccess(this.getConfig(false), path.basename(String(filename ?? "")));
  }

  async restoreImage(imagePath: string): Promise<{ status: "ok"; new_path: string }> {
    const config = this.getConfig();
    const filename = path.basename(String(imagePath ?? "").replace(/\\/g, "/"));
    const restored = await withFileLock(getDefaultLockPath(), () => {
      const trashed = findTrashImage(config, filename);
      if (!trashed) throw new ServiceError(404, "Image not found in trash");
      const size = probeImageDimensions(trashed);
      const orientation = size && size.height > size.width ? "portrait" : "landscape";
      const recorded = this.metadata()[filename]?.purity;
      const purity: Purity = isPurity(recorded) ? recorded : "sfw";
      const dest = restoreFromTrash(
        config,
        filename,
        poolDir(config.download_dir, purity, orientation),
      );
      if (!dest) throw new ServiceError(500, "Failed to restore image");
      removeFromBlacklist(config, filename);
      this.recordFeedbackLocked(config, "unban", filename, "api_restore");
      return dest;
    });
    this.invalidateMutationCaches();
    await scheduleRetrain(config);
    return { status: "ok", new_path: this.relativeImage(config, restored) as string };
  }

  async removeBlocklistEntry(filename: string): Promise<{ status: "ok"; removed: boolean }> {
    const config = this.getConfig();
    const name = String(filename ?? "");
    if (
      !name ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\") ||
      path.basename(name) !== name
    ) {
      throw new ServiceError(400, "filename must be a single image filename");
    }
    const removed = await withFileLock(getDefaultLockPath(), () => {
      const exists = listBlacklist(config).some((entry) => entry.filename === name);
      if (exists) {
        removeFromBlacklist(config, name);
        this.recordFeedbackLocked(config, "unban", name, "api_blocklist_remove");
      }
      return exists;
    });
    if (removed) this.invalidateMutationCaches();
    if (removed) await scheduleRetrain(config);
    return { status: "ok", removed };
  }

  private recordFeedbackLocked(
    config: WayperConfig,
    action: string,
    filename: string,
    source: string,
    options?: { context?: string; model?: JsonRecord | null; strict?: boolean },
  ): void {
    try {
      appendPreferenceFeedback(config, action, filename, {
        source,
        context: options?.context ?? null,
        model: options?.model ?? null,
      });
    } catch (error) {
      log.warn(`Could not record preference feedback for ${filename}`, error);
      if (options?.strict) throw new ServiceError(500, "Could not save preference feedback");
    }
  }

  // ------------------------------------------------------------------
  // Search and rule suggestions
  // ------------------------------------------------------------------

  /** The catalog is built and kept in the worker, so typing never blocks the tray or IPC. */
  async searchImages(params?: {
    query?: string;
    tags?: string[];
    uploader?: string;
  }): Promise<SearchResponse> {
    const query = params?.query ?? "";
    const tags = (params?.tags ?? []).filter((tag) => typeof tag === "string" && tag.length > 0);
    const uploader = params?.uploader ?? "";
    if (!query && tags.length === 0 && !uploader) return { matches: [], suggestions: [] };
    const config = this.getConfig(false);
    const metadataFile = path.join(config.download_dir, ".metadata.json");
    return this.runHeavy("searchImages", {
      config: { download_dir: config.download_dir },
      stateKey: `${path.resolve(config.download_dir)}|${statToken(metadataFile)}`,
      query,
      tags,
      uploader,
    });
  }

  private ruleSuggestionStateKey(config: WayperConfig, purities: string[]): string {
    const root = config.download_dir;
    const tokens = [
      path.join(root, ".metadata.json"),
      path.join(root, ".blacklist"),
      path.join(root, ".preference_feedback.json"),
      path.join(root, ".preference_historical_bans.json"),
      path.join(root, ".model-review.json"),
      preferenceFeedbackPath(config),
    ].map(statToken);
    for (const purity of ALL_PURITIES) {
      for (const orient of ALL_ORIENTATIONS) {
        tokens.push(
          statToken(poolDir(root, purity, orient)),
          statToken(favoritesDir(root, purity, orient)),
        );
      }
    }
    return [path.resolve(root), purities.join(","), ...tokens].join("|");
  }

  /**
   * Rule suggestions scan the whole library, so they run in the worker and
   * stay cached until the library or the exclusion rules change.
   */
  private async cachedRuleSuggestions(
    key: string,
    compute: () => Promise<JsonRecord>,
  ): Promise<JsonRecord> {
    const cached = this.ruleSuggestionCache.get(key);
    if (cached) return structuredClone(cached);
    const pending = this.ruleSuggestionInflight.get(key);
    if (pending) return structuredClone(await pending);
    const task = compute().then((result) => {
      this.ruleSuggestionCache.set(key, result);
      while (this.ruleSuggestionCache.size > RULE_SUGGESTION_CACHE_LIMIT) {
        const oldest = this.ruleSuggestionCache.keys().next().value;
        if (oldest === undefined) break;
        this.ruleSuggestionCache.delete(oldest);
      }
      return result;
    });
    this.ruleSuggestionInflight.set(key, task);
    try {
      return structuredClone(await task);
    } finally {
      if (this.ruleSuggestionInflight.get(key) === task) this.ruleSuggestionInflight.delete(key);
    }
  }

  getTagSuggestions(contextTags?: string[]): Promise<JsonRecord> {
    const config = this.getConfig();
    const purities = readMode(config);
    const context = (contextTags ?? []).map((tag) => String(tag).trim()).filter(Boolean);
    const { exclude_tags: excludeTags, exclude_combos: excludeCombos } = config.wallhaven;
    const stateKey = this.ruleSuggestionStateKey(config, purities);
    const key = JSON.stringify(["tags", stateKey, context, excludeTags, excludeCombos]);
    return this.cachedRuleSuggestions(key, () =>
      this.runHeavy("tagSuggestions", {
        config: { download_dir: config.download_dir },
        purities,
        stateKey,
        contextTags: context,
        excludeTags,
        excludeCombos,
      }),
    );
  }

  getUploaderSuggestions(): Promise<JsonRecord> {
    const config = this.getConfig();
    const purities = readMode(config);
    const excludeUploaders = config.wallhaven.exclude_uploaders;
    const stateKey = this.ruleSuggestionStateKey(config, purities);
    const key = JSON.stringify(["uploaders", stateKey, excludeUploaders]);
    return this.cachedRuleSuggestions(key, () =>
      this.runHeavy("uploaderSuggestions", {
        config: { download_dir: config.download_dir },
        purities,
        stateKey,
        excludeUploaders,
      }),
    );
  }

  // ------------------------------------------------------------------
  // Preference model
  // ------------------------------------------------------------------

  private reviewFeedbackDetails(config: WayperConfig, filename: string): Promise<JsonRecord | null> {
    return this.runHeavy("reviewFeedbackDetails", {
      config: { download_dir: config.download_dir },
      filename,
    }).catch((error: unknown) => {
      log.debug(`Could not score model-review context for ${filename}`, error);
      return null;
    });
  }

  private suggestionStateKey(
    config: WayperConfig,
    purities: Purity[],
    orientation: string,
    limit: number | null,
  ): string {
    const root = config.download_dir;
    const orientations = isOrientation(orientation) ? [orientation] : ALL_ORIENTATIONS;
    const tokens = [
      preferenceModelPath(config),
      path.join(root, ".metadata.json"),
      path.join(root, ".blacklist"),
      path.join(root, ".preference_feedback.json"),
      preferenceFeedbackPath(config),
    ].map(statToken);
    for (const purity of purities) {
      for (const orient of orientations) tokens.push(statToken(poolDir(root, purity, orient)));
    }
    for (const purity of ALL_PURITIES) {
      for (const orient of ALL_ORIENTATIONS) tokens.push(statToken(favoritesDir(root, purity, orient)));
    }
    return [path.resolve(root), purities.join(","), orientation, String(limit), ...tokens].join("|");
  }

  async getPreferenceSuggestions(params?: {
    purities?: string[];
    orient?: string;
    limit?: number;
  }): Promise<JsonRecord> {
    const config = this.getConfig();
    const purities = params?.purities?.length
      ? parsePurities(params.purities)
      : parsePurities(readMode(config));
    const orientation = params?.orient ?? "";
    const rawLimit = Math.trunc(Number(params?.limit ?? 24));
    const limit = rawLimit === 0 ? null : Math.min(60, Math.max(1, rawLimit || 24));
    const key = this.suggestionStateKey(config, purities, orientation, limit);

    const cached = this.suggestionCache.get(key);
    if (cached) return structuredClone(cached);
    const pending = this.suggestionInflight.get(key);
    if (pending) return structuredClone(await pending);

    const task = (async (): Promise<JsonRecord> => {
      const result = await this.runHeavy("preferenceSuggestions", {
        config: { download_dir: config.download_dir },
        purities,
        orientation: orientation || null,
        limit,
      });
      const learning = this.learningPayload(config, result.status === "ready");
      result.learning = learning;
      if (learning?.due) {
        void schedulePreferenceModelRetrain(config, { force: true }).catch(() => undefined);
      }
      this.suggestionCache.set(key, result);
      while (this.suggestionCache.size > PREFERENCE_SUGGESTION_CACHE_LIMIT) {
        const oldest = this.suggestionCache.keys().next().value;
        if (oldest === undefined) break;
        this.suggestionCache.delete(oldest);
      }
      return result;
    })();
    this.suggestionInflight.set(key, task);
    try {
      return structuredClone(await task);
    } finally {
      if (this.suggestionInflight.get(key) === task) this.suggestionInflight.delete(key);
    }
  }

  async sendPreferenceFeedback(rawPath: string, action: string): Promise<JsonRecord> {
    if (action !== "keep") {
      throw new ServiceError(
        400,
        "Only the keep feedback action is supported for ranked candidates",
      );
    }
    const config = this.getConfig();
    const pending = listModelReviewItems(config, { includeResolved: false, limit: 500 });
    if (pending.some((item) => item.path === rawPath)) {
      return {
        status: "ok",
        review: await this.resolveReview(config, rawPath, "keep", 409),
      };
    }

    const image = this.resolveImage(config, rawPath);
    if (this.poolImageLocation(config, image) === null) {
      throw new ServiceError(400, "Keep feedback is only available for live pool images");
    }
    const candidateModel = await this.reviewFeedbackDetails(config, path.basename(image));
    if (candidateModel === null) {
      throw new ServiceError(409, "Image is no longer a model review candidate");
    }
    await withFileLock(getDefaultLockPath(), () => {
      if (!isFile(image) || this.poolImageLocation(config, image) === null) {
        throw new ServiceError(409, "Image is no longer a model review candidate");
      }
      this.recordFeedbackLocked(config, "keep", path.basename(image), "model_suggestion", {
        context: "model_review",
        model: candidateModel,
        strict: true,
      });
    });
    await scheduleRetrain(config);
    return { status: "ok", learning: this.learningPayload(config, true) };
  }

  getModelReview(params?: { purities?: string[]; orient?: string; limit?: number }): JsonRecord {
    const config = this.getConfig();
    const purities = params?.purities?.length
      ? parsePurities(params.purities)
      : parsePurities(readMode(config));
    const orientation = params?.orient || null;
    const status = modelReviewStatus(config, { purities, orientation, includeLearning: false });
    const learning = this.learningPayload(config, true);
    status.learning = learning;
    const limit = Math.min(500, Math.max(1, Math.trunc(Number(params?.limit ?? 100)) || 100));
    const items = listModelReviewItems(config, { purities, orientation, limit });
    return {
      status: status.status ?? "untrained",
      items,
      pending_count: Number(status.pending_count ?? items.length),
      filter_strategy: config.wallhaven.filter_strategy,
      model_filter: status,
      learning,
    };
  }

  private async resolveReview(
    config: WayperConfig,
    rawPath: string,
    action: string,
    missingStatus: number,
  ): Promise<JsonRecord> {
    try {
      return await resolveModelReviewItem(config, rawPath, action);
    } catch (error) {
      if (error instanceof ModelReviewError) {
        throw new ServiceError(error.code === "not_found" ? missingStatus : 400, error.message);
      }
      throw error;
    }
  }

  async resolveModelReview(rawPath: string, action: string): Promise<JsonRecord> {
    if (action !== "keep" && action !== "ban") {
      throw new ServiceError(400, "Model review action must be keep or ban");
    }
    const config = this.getConfig();
    const review = await this.resolveReview(config, rawPath, action, 409);
    this.invalidateMutationCaches();
    return { status: "ok", action, review, learning: this.learningPayload(config, true) };
  }

  async clearModelReview(params?: {
    purities?: string[];
    orientation?: string | null;
  }): Promise<JsonRecord> {
    const requested = params?.purities ?? [];
    const purities = requested.filter(isPurity);
    if (requested.length > 0 && purities.length === 0) {
      throw new ServiceError(400, "Model review clear needs a valid purity");
    }
    const orientation = params?.orientation || null;
    if (orientation !== null && !isOrientation(orientation)) {
      throw new ServiceError(400, "Model review clear has an invalid orientation");
    }
    const result = await clearModelReviewItems(this.getConfig(), {
      purities: purities.length > 0 ? [...purities].sort() : null,
      orientation,
    });
    this.invalidateMutationCaches();
    return { status: "ok", ...result };
  }

  async retrainModelNow(): Promise<JsonRecord> {
    const config = this.getConfig(false);
    let report: JsonRecord;
    try {
      report = await this.runHeavy("trainNow", { config: { download_dir: config.download_dir } });
    } catch (error) {
      throw new ServiceError(400, `Could not train preference model: ${errorMessage(error)}`);
    }
    this.suggestionCache.clear();
    this.emit({ type: "model-updated" });
    return { status: "ok", model: report };
  }

  // ------------------------------------------------------------------
  // Network helpers
  // ------------------------------------------------------------------

  checkUpdate(force = false): Promise<UpdateCheckResponse> {
    return checkForUpdates(this.getConfig(false), { force });
  }

  async reconnectWallhaven(): Promise<{ status: "ok" }> {
    const config = this.getConfig(false);
    if (!config.wallhaven_username) {
      throw new ServiceError(400, "Configure a Wallhaven username first");
    }
    if (!(await reconnectWallhaven(config))) {
      throw new ServiceError(
        503,
        "Could not log into Wallhaven. Check its availability and your saved credentials.",
      );
    }
    return { status: "ok" };
  }

  // ------------------------------------------------------------------
  // Change notifications (replaces the HTTP event stream)
  // ------------------------------------------------------------------

  private libraryToken(config: WayperConfig): string {
    const root = config.download_dir;
    const tokens = [root, statToken(path.join(root, ".blacklist"))];
    for (const purity of ALL_PURITIES) {
      for (const orientation of ALL_ORIENTATIONS) {
        tokens.push(
          statToken(poolDir(root, purity, orientation)),
          statToken(favoritesDir(root, purity, orientation)),
          statToken(path.join(root, ".model-review", purity, orientation)),
        );
      }
    }
    tokens.push(statToken(path.join(root, ".model-review.json")));
    return tokens.join("|");
  }

  private wallpaperToken(config: WayperConfig): string {
    const root = config.download_dir;
    return `${statToken(path.join(root, ".last_rotation"))}|${statToken(path.join(root, ".history"))}`;
  }

  private scheduleWatchTimer(): void {
    if (!this.watchingRequested || !this.watchingActive || !this.pollWatchOnce) return;
    if (this.watchTimer !== null) return;
    this.watchTimer = setInterval(this.pollWatchOnce, WATCH_INTERVAL_MS);
    this.watchTimer.unref?.();
  }

  setWatchingActive(active: boolean): void {
    if (this.watchingActive === active) return;
    this.watchingActive = active;
    if (!this.watchingRequested) return;
    if (!active) {
      if (this.watchTimer !== null) {
        clearInterval(this.watchTimer);
        this.watchTimer = null;
      }
      return;
    }
    this.pollWatchOnce?.();
    this.scheduleWatchTimer();
  }

  startWatching(): void {
    if (this.watchingRequested) return;
    this.watchingRequested = true;
    let config = this.getConfig(false);
    void purgeBlacklistedFavorites(config)
      .then((purged) => {
        if (purged > 0) {
          this.invalidateMutationCaches();
          this.emit({ type: "library" });
        }
      })
      .catch((error: unknown) => {
        log.debug("Initial blacklisted favorite cleanup failed", error);
      });
    let configToken = this.cachedConfigToken;
    let modeToken = statToken(path.join(config.download_dir, ".mode"));
    let mode = readMode(config).join(",");
    let library = this.libraryToken(config);
    let wallpaper = this.wallpaperToken(config);
    let model = statToken(preferenceModelPath(config));

    this.pollWatchOnce = () => {
      try {
        config = this.getConfig(false);
        if (this.cachedConfigToken !== configToken) {
          configToken = this.cachedConfigToken;
          this.emit({ type: "config" });
        }
        const nextModeToken = statToken(path.join(config.download_dir, ".mode"));
        if (nextModeToken !== modeToken) {
          modeToken = nextModeToken;
          const purities = readMode(config);
          if (purities.join(",") !== mode) {
            mode = purities.join(",");
            this.emit({ type: "mode", purities: [...purities].sort() });
          }
        }
        const nextLibrary = this.libraryToken(config);
        const libraryChanged = nextLibrary !== library;
        if (libraryChanged) {
          library = nextLibrary;
          this.invalidateMutationCaches();
          this.emit({ type: "library" });
        }
        const nextWallpaper = this.wallpaperToken(config);
        if (libraryChanged || nextWallpaper !== wallpaper) {
          wallpaper = nextWallpaper;
          this.emit({ type: "wallpaper" });
        }
        const nextModel = statToken(preferenceModelPath(config));
        if (nextModel !== model) {
          model = nextModel;
          this.suggestionCache.clear();
          this.emit({ type: "model-updated" });
        }
      } catch (error) {
        log.debug("State watcher tick failed", error);
      }
    };
    this.scheduleWatchTimer();
  }

  stopWatching(): void {
    this.watchingRequested = false;
    this.pollWatchOnce = null;
    if (this.watchTimer !== null) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
  }
}
