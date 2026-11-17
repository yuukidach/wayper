import fs from "node:fs";
import path from "node:path";
import type { Orientation, Purity } from "../shared/types";
import { normalizeTag } from "../shared/tags";
import { normalizeFilterStrategy, type WayperConfig } from "./config";
import { HttpStatusError, httpGetBytes, httpGetJson, USER_AGENT } from "./http";
import { validateImageFile } from "./image-probe";
import { LockBusyError, withFileLock } from "./lock";
import { getLogger } from "./logging";
import { favoritesDir, isOrientation, isPurity, poolDir } from "./paths";
import { extractTagNames, favoriteFilenames, saveMetadataRecord, shouldDownload } from "./pool";
import {
  autoFilterPrediction,
  autoFilterStatus,
  loadPreferenceModel,
  modelReviewDirPath,
  preferenceModelPath,
} from "./preference/ledger";
import {
  predictionToDict,
  preferenceDecisionScore,
  type PreferenceModel,
} from "./preference/model";
import { queueModelReviewItem } from "./preference/review";
import { isBlacklisted, readMode } from "./state";
import { fetchCloudTags, mergeCloudBlacklistsIntoConfig } from "./wallhaven-web";

const log = getLogger("wallhaven");

export const SEARCH_URL = "https://wallhaven.cc/api/v1/search";
const API_BASE = "https://wallhaven.cc/api/v1";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_EXCLUDE_QUERY_LENGTH = 1500;

type JsonRecord = Record<string, unknown>;

export interface ModelFilterContext {
  model: PreferenceModel | null;
  ready: boolean;
  status: Record<string, unknown>;
}

export interface DownloadSummary {
  results: number;
  sampled: number;
  downloaded: number;
  skipped: Record<
    "dup" | "fav" | "blacklist" | "uploader" | "combo" | "local_tag" | "model" | "metadata" | "fail",
    number
  >;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordList(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function sampleItems<T>(items: readonly T[], count: number): T[] {
  const pool = [...items];
  const take = Math.min(Math.max(0, count), pool.length);
  for (let index = 0; index < take; index += 1) {
    const swap = index + Math.floor(Math.random() * (pool.length - index));
    [pool[index], pool[swap]] = [pool[swap], pool[index]];
  }
  return pool.slice(0, take);
}

function excludeFragment(tag: string): string {
  return tag.includes(" ") ? `-"${tag}"` : `-${tag}`;
}

function filenameFromUrl(url: string): string {
  return url.slice(url.lastIndexOf("/") + 1);
}

function errorName(error: unknown): string {
  if (error instanceof HttpStatusError) return `HTTP ${error.status}`;
  return error instanceof Error ? error.name : String(error);
}

export class WallhavenClient {
  readonly config: WayperConfig;
  private localExcludeTags: string[] = [];
  private cloudTags = new Set<string>();
  private readonly signal: AbortSignal | undefined;

  constructor(config: WayperConfig, options?: { signal?: AbortSignal }) {
    this.config = config;
    this.signal = options?.signal;
  }

  private get headers(): Record<string, string> {
    const headers: Record<string, string> = { "User-Agent": USER_AGENT };
    if (this.config.api_key) headers["X-API-Key"] = this.config.api_key;
    return headers;
  }

  private getJson(url: string, params?: Record<string, string | number>): Promise<JsonRecord> {
    const target = new URL(url);
    for (const [key, value] of Object.entries(params ?? {})) {
      target.searchParams.set(key, String(value));
    }
    return httpGetJson(target.toString(), {
      headers: this.headers,
      timeoutMs: REQUEST_TIMEOUT_MS,
      proxy: this.config.proxy,
      signal: this.signal,
    });
  }

  setCloudTags(tags: Iterable<string>): void {
    this.cloudTags = new Set([...tags].map((tag) => tag.toLowerCase()));
  }

  async refreshCloudTags(): Promise<void> {
    this.setCloudTags(await fetchCloudTags(this.config));
    if (this.cloudTags.size > 0) {
      log.info(`Loaded ${this.cloudTags.size} cloud tags from Wallhaven account`);
    }
  }

  get filterStrategy(): string {
    return normalizeFilterStrategy(this.config.wallhaven.filter_strategy);
  }

  get rulesEnabled(): boolean {
    return this.filterStrategy === "rules" || this.filterStrategy === "rules+model";
  }

  get modelEnabled(): boolean {
    return this.filterStrategy === "model" || this.filterStrategy === "rules+model";
  }

  splitExcludeTags(): [string[], string[]] {
    if (!this.rulesEnabled) {
      this.localExcludeTags = [];
      return [[], []];
    }
    const tags = this.config.wallhaven.exclude_tags.filter(
      (tag) => !this.cloudTags.has(tag.toLowerCase()),
    );
    if (tags.length === 0) return [[], []];
    const apiTags: string[] = [];
    let currentLength = 0;
    for (let index = 0; index < tags.length; index += 1) {
      const added = excludeFragment(tags[index]).length + (apiTags.length > 0 ? 1 : 0);
      if (currentLength + added > MAX_EXCLUDE_QUERY_LENGTH) {
        const local = tags.slice(index);
        log.warn(
          `exclude_tags query too long (${currentLength} chars); ` +
            `${local.length}/${tags.length} tags will be filtered locally`,
        );
        return [apiTags, local];
      }
      apiTags.push(tags[index]);
      currentLength += added;
    }
    return [apiTags, []];
  }

  excludeQuery(): string {
    const [apiTags, localTags] = this.splitExcludeTags();
    this.localExcludeTags = localTags;
    return apiTags.map(excludeFragment).join(" ");
  }

  modelFilterContext(): ModelFilterContext {
    if (!this.modelEnabled) return { model: null, ready: false, status: {} };
    try {
      const model = loadPreferenceModel(preferenceModelPath(this.config));
      const status = autoFilterStatus(this.config, model);
      return { model, ready: Boolean(status.ready), status };
    } catch (error) {
      log.warn("Could not load the model filter; failing open", error);
      return { model: null, ready: false, status: {} };
    }
  }

  private matchesLocalExclude(tagNames: string[]): boolean {
    if (this.localExcludeTags.length === 0) return false;
    const normalized = new Set(tagNames.map(normalizeTag).filter(Boolean));
    return this.localExcludeTags.some((tag) => normalized.has(normalizeTag(tag)));
  }

  private matchesExcludeCombo(tagNames: string[]): boolean {
    const tagSet = new Set(tagNames.map(normalizeTag).filter(Boolean));
    return this.config.wallhaven.exclude_combos.some((combo) =>
      combo.every((tag) => tagSet.has(normalizeTag(tag))),
    );
  }

  async search(orientations: Iterable<string>, purities: Iterable<string>): Promise<JsonRecord[]> {
    const orientationList = [...new Set(orientations)].sort();
    const puritySet = new Set(purities);
    const orientationQuery = orientationList.join(",");
    const purityLabel = [...puritySet].sort().join(",");
    const params: Record<string, string | number> = {
      categories: this.config.wallhaven.categories,
      purity: (["sfw", "sketchy", "nsfw"] as const)
        .map((value) => (puritySet.has(value) ? "1" : "0"))
        .join(""),
      topRange: this.config.wallhaven.top_range,
      sorting: this.config.wallhaven.sorting,
      order: "desc",
      ai_art_filter: this.config.wallhaven.ai_art_filter,
      ratios: orientationQuery,
      page: 1,
    };
    const excludeQuery = this.excludeQuery();
    if (excludeQuery) params.q = excludeQuery;
    try {
      const data = await this.getJson(SEARCH_URL, params);
      const pageOne = recordList(data.data);
      const meta = isRecord(data.meta) ? data.meta : {};
      const lastPage = typeof meta.last_page === "number" ? Math.trunc(meta.last_page) : 1;
      if (lastPage <= 1) return pageOne;

      const tried = new Set<number>();
      const attempts = Math.min(5, lastPage);
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const page = 1 + Math.floor(Math.random() * lastPage);
        if (tried.has(page)) continue;
        tried.add(page);
        if (page === 1) return pageOne;
        const items = await this.searchPage(params, page);
        if (items !== null) return items;
      }
      log.info(
        "Wallhaven search falling back to page 1 after page fetch failures " +
          `(orientation=${orientationQuery}, purity=${purityLabel})`,
      );
      return pageOne;
    } catch (error) {
      log.warn(
        `Wallhaven search failed (orientation=${orientationQuery}, purity=${purityLabel})`,
        errorName(error),
      );
      return [];
    }
  }

  private async searchPage(
    params: Record<string, string | number>,
    page: number,
  ): Promise<JsonRecord[] | null> {
    try {
      const data = await this.getJson(SEARCH_URL, { ...params, page });
      return recordList(data.data);
    } catch (error) {
      log.debug(`Wallhaven search page ${page} failed`, errorName(error));
      return null;
    }
  }

  async wallpaperInfo(wallpaperId: string, options?: { retries?: number }): Promise<JsonRecord> {
    if (!wallpaperId) return {};
    const retries = Math.max(0, options?.retries ?? 2);
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      let failure: string;
      try {
        const body = await this.getJson(`${API_BASE}/w/${encodeURIComponent(wallpaperId)}`);
        return isRecord(body.data) ? body.data : {};
      } catch (error) {
        if (error instanceof HttpStatusError) {
          if (error.status !== 429 && error.status >= 400 && error.status < 500) {
            log.info(`Wallpaper metadata unavailable for ${wallpaperId} (HTTP ${error.status})`);
            return {};
          }
        }
        failure = errorName(error);
      }
      if (attempt >= retries || this.signal?.aborted) {
        log.warn(
          `Failed to fetch wallpaper info for ${wallpaperId} after ${attempt + 1} attempts (${failure})`,
        );
        return {};
      }
      await sleep(500 * 2 ** attempt, this.signal);
    }
    return {};
  }

  async downloadImage(url: string, dest: string): Promise<boolean> {
    const tmp = path.join(path.dirname(dest), `.dl_${path.basename(dest)}`);
    try {
      const bytes = await httpGetBytes(url, {
        headers: this.headers,
        timeoutMs: 120_000,
        proxy: this.config.proxy,
        signal: this.signal,
      });
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.writeFile(tmp, bytes);
      if (!validateImageFile(tmp)) {
        fs.rmSync(tmp, { force: true });
        return false;
      }
      fs.renameSync(tmp, dest);
      return true;
    } catch (error) {
      log.warn(`Download failed: ${url}`, errorName(error));
      fs.rmSync(tmp, { force: true });
      return false;
    }
  }

  async downloadFor(
    orientations: Iterable<string>,
    modes: Iterable<string>,
    options?: { modelFilterContext?: ModelFilterContext },
  ): Promise<DownloadSummary> {
    const config = this.config;
    const orientationSet = new Set(orientations);
    const modeSet = new Set(modes);
    const modeLabel = [...modeSet].sort().join(",");
    const orientationLabel = [...orientationSet].sort().join(",");
    const context = options?.modelFilterContext ?? this.modelFilterContext();
    if (this.modelEnabled && !context.ready) {
      log.info(
        `Model filter selected for ${modeLabel}/${orientationLabel} but no compatible model is ` +
          "ready; downloads remain eligible until the model is trained",
      );
    }

    const items = await this.search(orientationSet, modeSet);
    const summary: DownloadSummary = {
      results: items.length,
      sampled: 0,
      downloaded: 0,
      skipped: {
        dup: 0,
        fav: 0,
        blacklist: 0,
        uploader: 0,
        combo: 0,
        local_tag: 0,
        model: 0,
        metadata: 0,
        fail: 0,
      },
    };
    const skipped = summary.skipped;

    if (items.length > 0) {
      const sample = sampleItems(items, config.wallhaven.batch_size);
      summary.sampled = sample.length;
      const candidates: Array<{
        filename: string;
        url: string;
        item: JsonRecord;
        purity: Purity;
        orientation: Orientation;
        dest: string;
      }> = [];
      for (const item of sample) {
        const url = typeof item.path === "string" ? item.path : "";
        if (!url) continue;
        const filename = filenameFromUrl(url);
        const purity = item.purity;
        const orientation: Orientation =
          Number(item.dimension_y ?? 0) > Number(item.dimension_x ?? 0) ? "portrait" : "landscape";
        if (!isPurity(purity) || !modeSet.has(purity) || !orientationSet.has(orientation)) continue;
        const dest = path.join(poolDir(config.download_dir, purity, orientation), filename);
        const favDest = path.join(favoritesDir(config.download_dir, purity, orientation), filename);
        if (fs.existsSync(dest)) {
          skipped.dup += 1;
          continue;
        }
        if (fs.existsSync(favDest)) {
          skipped.fav += 1;
          continue;
        }
        if (isBlacklisted(config, filename)) {
          skipped.blacklist += 1;
          continue;
        }
        candidates.push({ filename, url, item, purity, orientation, dest });
      }

      if (candidates.length > 0) {
        const details = await Promise.all(
          candidates.map((candidate) => this.wallpaperInfo(String(candidate.item.id ?? ""))),
        );
        const excludedUploaders = new Set(
          config.wallhaven.exclude_uploaders.map((uploader) => uploader.toLowerCase()),
        );
        for (let index = 0; index < candidates.length; index += 1) {
          if (this.signal?.aborted) break;
          const { filename, url, purity, orientation, dest } = candidates[index];
          const detail = details[index];
          if (Object.keys(detail).length === 0) {
            skipped.metadata += 1;
            continue;
          }
          const item: JsonRecord = { ...candidates[index].item, ...detail };
          const tagNames = extractTagNames(item.tags ?? []);
          if (this.rulesEnabled) {
            const rawUploader = item.uploader;
            const uploader = isRecord(rawUploader)
              ? String(rawUploader.username ?? "")
              : String(rawUploader ?? "");
            if (uploader && excludedUploaders.has(uploader.toLowerCase())) {
              skipped.uploader += 1;
              continue;
            }
            if (this.matchesExcludeCombo(tagNames)) {
              skipped.combo += 1;
              continue;
            }
            if (this.matchesLocalExclude(tagNames)) {
              skipped.local_tag += 1;
              continue;
            }
          }

          if (context.ready && context.model !== null) {
            const model = context.model;
            let hit = false;
            let prediction: Awaited<ReturnType<typeof autoFilterPrediction>>[1] | null = null;
            try {
              [hit, prediction] = await autoFilterPrediction(model, item);
            } catch (error) {
              log.warn(
                `Model filter scoring failed for ${filename}; keeping download eligible`,
                error,
              );
            }
            if (hit && prediction !== null) {
              const reviewDest = path.join(
                modelReviewDirPath(config),
                purity,
                orientation,
                filename,
              );
              if (fs.existsSync(reviewDest)) {
                skipped.dup += 1;
                continue;
              }
              if (!(await this.downloadImage(url, reviewDest))) {
                skipped.fail += 1;
                continue;
              }
              saveMetadataRecord(config, filename, item, { complete: true });
              try {
                await queueModelReviewItem(config, reviewDest, {
                  purity,
                  orientation,
                  prediction: {
                    ...predictionToDict(prediction),
                    decision_score: preferenceDecisionScore(model, prediction),
                    threshold: context.status.threshold ?? null,
                    threshold_kind: context.status.threshold_kind ?? null,
                    schema_version: model.schema_version,
                    trained_at: model.trained_at,
                  },
                  strategy: this.filterStrategy,
                });
              } catch (error) {
                fs.rmSync(reviewDest, { force: true });
                skipped.fail += 1;
                log.warn(`Could not register model review item ${filename}`, error);
                continue;
              }
              skipped.model += 1;
              continue;
            }
          }

          if (!(await this.downloadImage(url, dest))) {
            skipped.fail += 1;
            continue;
          }
          saveMetadataRecord(config, filename, item, { complete: true });
          summary.downloaded += 1;
        }
      }
    }

    log.info(
      `Download[${modeLabel}/${orientationLabel}] results=${summary.results} ` +
        `sampled=${summary.sampled} skipped(dup=${skipped.dup},fav=${skipped.fav},` +
        `blacklist=${skipped.blacklist},uploader=${skipped.uploader},combo=${skipped.combo},` +
        `local_tag=${skipped.local_tag},model=${skipped.model},metadata=${skipped.metadata},` +
        `fail=${skipped.fail}) downloaded=${summary.downloaded}`,
    );
    return summary;
  }

  async syncRemoteFavorites(): Promise<[number, Set<string>]> {
    const config = this.config;
    const remoteFiles = new Set<string>();
    if (!config.api_key || !config.wallhaven_username) return [0, remoteFiles];

    let collections: JsonRecord[];
    try {
      collections = recordList((await this.getJson(`${API_BASE}/collections`)).data);
    } catch (error) {
      log.warn("Failed to list Wallhaven collections", errorName(error));
      return [0, remoteFiles];
    }
    if (collections.length === 0) return [0, remoteFiles];

    const username = encodeURIComponent(config.wallhaven_username);
    const existingFavorites = favoriteFilenames(config);
    let synced = 0;
    for (const collection of collections) {
      const collectionId = collection.id;
      if (!collectionId) continue;
      let page = 1;
      for (;;) {
        if (this.signal?.aborted) return [synced, remoteFiles];
        let body: JsonRecord;
        try {
          body = await this.getJson(`${API_BASE}/collections/${username}/${collectionId}`, {
            page,
          });
        } catch (error) {
          log.warn(`Failed to fetch collection ${collectionId} page ${page}`, errorName(error));
          break;
        }
        const items = recordList(body.data);
        if (items.length === 0) break;

        let pageNew = 0;
        for (const listed of items) {
          let url = typeof listed.path === "string" ? listed.path : "";
          if (!url) continue;
          const filename = filenameFromUrl(url);
          remoteFiles.add(filename);
          if (isBlacklisted(config, filename) || existingFavorites.has(filename)) continue;
          const purity: Purity = isPurity(listed.purity) ? listed.purity : "sfw";
          let width = 1920;
          let height = 1080;
          const match = /^(\d+)x(\d+)$/.exec(String(listed.resolution ?? ""));
          if (match) {
            width = Number.parseInt(match[1], 10);
            height = Number.parseInt(match[2], 10);
          }
          const orientation: Orientation = height > width ? "portrait" : "landscape";
          const favDir = favoritesDir(config.download_dir, purity, orientation);
          const favDest = path.join(favDir, filename);
          const poolPath = path.join(poolDir(config.download_dir, purity, orientation), filename);
          if (fs.existsSync(favDest)) {
            existingFavorites.add(filename);
            continue;
          }

          if (fs.existsSync(poolPath)) {
            fs.mkdirSync(favDir, { recursive: true });
            fs.renameSync(poolPath, favDest);
            existingFavorites.add(filename);
            pageNew += 1;
            log.info(`sync: moved ${filename} from pool to favorites`);
            continue;
          }

          const detail = await this.wallpaperInfo(String(listed.id ?? ""));
          if (Object.keys(detail).length === 0) {
            log.warn(`Skipping favorite ${filename} without complete metadata`);
            continue;
          }
          if (isBlacklisted(config, filename)) continue;
          const item: JsonRecord = { ...listed, ...detail };
          url = typeof item.path === "string" && item.path ? item.path : url;
          fs.mkdirSync(favDir, { recursive: true });
          if (!(await this.downloadImage(url, favDest))) continue;
          if (isBlacklisted(config, filename)) {
            fs.rmSync(favDest, { force: true });
            continue;
          }
          saveMetadataRecord(config, filename, item, { complete: true });
          existingFavorites.add(filename);
          pageNew += 1;
        }
        synced += pageNew;

        const meta = isRecord(body.meta) ? body.meta : {};
        const lastPage = typeof meta.last_page === "number" ? meta.last_page : 1;
        if (page >= lastPage) break;
        page += 1;
      }
    }
    if (synced > 0) log.info(`Synced ${synced} wallpapers from Wallhaven collections`);
    return [synced, remoteFiles];
  }
}

export async function prepareWallhavenClient(
  config: WayperConfig,
  options?: { signal?: AbortSignal },
): Promise<WallhavenClient> {
  const client = new WallhavenClient(config, options);
  try {
    const merged = await mergeCloudBlacklistsIntoConfig(config);
    client.setCloudTags(merged.cloudTags);
    if (merged.cloudTags.length > 0) {
      log.info(`Loaded ${merged.cloudTags.length} cloud tags from Wallhaven account`);
    }
    if (merged.addedTags > 0) {
      log.info(`Merged ${merged.addedTags} cloud tags into local exclude_tags`);
    }
    if (merged.addedUsers > 0) {
      log.info(`Merged ${merged.addedUsers} cloud users into local exclude_uploaders`);
    }
  } catch (error) {
    log.warn("Could not refresh Wallhaven account state", error);
  }
  return client;
}

function downloadLockPath(config: Pick<WayperConfig, "download_dir">): string {
  return path.join(config.download_dir, ".download.lock");
}

export async function refillPool(
  config: WayperConfig,
  purities?: Iterable<Purity>,
  client?: WallhavenClient | null,
): Promise<DownloadSummary | null> {
  const active = purities ? [...purities] : readMode(config);
  try {
    return await withFileLock(
      downloadLockPath(config),
      async () => {
        try {
          const orientations = new Set(
            config.monitors.map((monitor) => monitor.orientation).filter(isOrientation),
          );
          if (orientations.size === 0 || !shouldDownload(config, active)) return null;
          const activeClient = client ?? new WallhavenClient(config);
          return await activeClient.downloadFor(orientations, active, {
            modelFilterContext: activeClient.modelFilterContext(),
          });
        } catch (error) {
          log.warn("Background download failed", error);
          return null;
        }
      },
      { blocking: false },
    );
  } catch (error) {
    if (error instanceof LockBusyError) return null;
    throw error;
  }
}
