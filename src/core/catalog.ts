import fs from "node:fs";
import path from "node:path";
import { casefold, normalizeTag, tagItems } from "../shared/tags";
import type { ImageMetadata, Purity, RuleMatchStats, SearchResponse } from "../shared/types";
import type { WayperConfig } from "./config";
import { ALL_ORIENTATIONS, ALL_PURITIES, poolDir } from "./paths";
import { favoriteFilenames, listImagesInDir, loadMetadata } from "./pool";
import { isBlacklisted, listBlacklist, type ConfigOrDir } from "./state";

export const FAVORITE_WEIGHT = 3;
export const KEPT_WEIGHT = 5;

export function pyRound(value: number, digits = 0): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  const scaled = value * factor;
  const floorVal = Math.floor(scaled);
  const diff = scaled - floorVal;
  const eps = 1e-12;
  let rounded: number;
  if (diff > 0.5 + eps) {
    rounded = floorVal + 1;
  } else if (diff < 0.5 - eps) {
    rounded = floorVal;
  } else {
    rounded = floorVal % 2 === 0 ? floorVal : floorVal + 1;
  }
  return digits === 0 ? rounded : Number((rounded / factor).toFixed(digits));
}

export function weightedPrecision(banned: number, kept: number, favorites: number): number {
  const total = banned + kept + FAVORITE_WEIGHT * favorites;
  return total > 0 ? banned / total : 0.0;
}

export function netBenefit(banned: number, kept: number, favorites: number): number {
  return banned - KEPT_WEIGHT * kept - FAVORITE_WEIGHT * favorites;
}

export function codePointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface CatalogImage {
  readonly filename: string;
  readonly metadata: ImageMetadata;
  readonly tags: ReadonlySet<string>;
  readonly uploader: string;
  readonly purity: string;
  readonly banned: boolean;
  readonly favorite: boolean;
  readonly tagOrder: readonly string[];
  readonly orderedTags: readonly string[];
}

export interface MatchStatsDict extends RuleMatchStats {
  banned_files?: Set<string>;
}

export class MatchStats {
  readonly banned: number;
  readonly kept: number;
  readonly favorites: number;
  readonly bannedFiles: ReadonlySet<string>;

  constructor(
    banned = 0,
    kept = 0,
    favorites = 0,
    bannedFiles: ReadonlySet<string> = new Set(),
  ) {
    this.banned = banned;
    this.kept = kept;
    this.favorites = favorites;
    this.bannedFiles = bannedFiles;
  }

  get precision(): number {
    return weightedPrecision(this.banned, this.kept, this.favorites);
  }

  get netBenefit(): number {
    return netBenefit(this.banned, this.kept, this.favorites);
  }

  toDict(): RuleMatchStats;
  toDict(options: { includeFiles: true }): RuleMatchStats & { banned_files: Set<string> };
  toDict(options?: { includeFiles?: boolean }): MatchStatsDict {
    const base: MatchStatsDict = {
      banned: this.banned,
      kept: this.kept,
      favorites: this.favorites,
      precision: pyRound(this.precision, 3),
      net_benefit: pyRound(this.netBenefit, 1),
    };
    if (options?.includeFiles) {
      base.banned_files = new Set(this.bannedFiles);
    }
    return base;
  }
}

export interface CatalogSearchResult extends SearchResponse {
  tag_suggestions: string[];
  uploader_suggestions: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedTagSet(values: Iterable<unknown>): Set<string> {
  const out = new Set<string>();
  for (const val of values) {
    const key = normalizeTag(val);
    if (key) out.add(key);
  }
  return out;
}

function extractUploaderString(rawUploader: unknown): string {
  if (typeof rawUploader === "string") {
    return rawUploader.trim();
  }
  if (isRecord(rawUploader) && typeof rawUploader.username === "string") {
    return rawUploader.username.trim();
  }
  return rawUploader !== null && rawUploader !== undefined ? String(rawUploader).trim() : "";
}

interface QueryIndexEntry {
  record: CatalogImage;
  rawTags: string[];
  foldedTags: string[];
  category: string;
  filename: string;
  uploaderDisplay: string;
}

export class ImageCatalog implements Iterable<CatalogImage> {
  private readonly records = new Map<string, CatalogImage>();
  private readonly tagDisplay = new Map<string, string>();
  private readonly uploaderDisplay = new Map<string, string>();
  private queryIndexCache: QueryIndexEntry[] | null = null;

  constructor(
    metadata: Record<string, ImageMetadata>,
    blacklisted: Iterable<string> = [],
    favorites: Iterable<string> = [],
    options?: { purities?: Iterable<string> | string | null },
  ) {
    const bannedNames = new Set<string>(
      typeof blacklisted === "string" ? [blacklisted] : blacklisted,
    );
    const favoriteNames = new Set<string>(
      typeof favorites === "string" ? [favorites] : favorites,
    );

    let purityFilter: Set<string> | null = null;
    if (options?.purities !== undefined && options.purities !== null) {
      const iter =
        typeof options.purities === "string" ? [options.purities] : options.purities;
      const values = new Set<string>();
      for (const item of iter) {
        const cleaned = casefold(String(item ?? "").trim());
        if (cleaned) values.add(cleaned);
      }
      purityFilter = values.size > 0 ? values : null;
    }

    for (const [filename, rawMetadata] of Object.entries(metadata)) {
      if (!isRecord(rawMetadata)) {
        continue;
      }
      const purity = casefold(String(rawMetadata.purity ?? "sfw"));
      if (purityFilter !== null && !purityFilter.has(purity)) {
        continue;
      }

      const items = tagItems(Array.isArray(rawMetadata.tags) ? rawMetadata.tags : []);
      for (const [key, display] of items) {
        if (!this.tagDisplay.has(key)) {
          this.tagDisplay.set(key, display);
        }
      }

      const uploaderRaw = extractUploaderString(rawMetadata.uploader);
      const uploader = casefold(uploaderRaw);
      if (uploader && !this.uploaderDisplay.has(uploader)) {
        this.uploaderDisplay.set(uploader, uploaderRaw);
      }

      const tagOrder = items.map(([key]) => key);
      const tagSet = new Set(tagOrder);
      const isBanned = bannedNames.has(filename);
      const isFavorite = favoriteNames.has(filename) && !isBanned;
      const orderedTags = tagOrder.length > 0 ? tagOrder : [...tagSet].sort(codePointCompare);

      this.records.set(filename, {
        filename,
        metadata: rawMetadata as ImageMetadata,
        tags: tagSet,
        uploader,
        purity,
        banned: isBanned,
        favorite: isFavorite,
        tagOrder,
        orderedTags,
      });
    }
  }

  get size(): number {
    return this.records.size;
  }

  get length(): number {
    return this.records.size;
  }

  [Symbol.iterator](): Iterator<CatalogImage> {
    return this.records.values();
  }

  get(filename: string): CatalogImage | undefined {
    return this.records.get(filename);
  }

  get metadata(): Record<string, ImageMetadata> {
    const out: Record<string, ImageMetadata> = {};
    for (const record of this.records.values()) {
      out[record.filename] = record.metadata;
    }
    return out;
  }

  get summary(): { total_banned: number; total_kept: number; total_favorites: number } {
    let banned = 0;
    let favorites = 0;
    for (const record of this.records.values()) {
      if (record.banned) banned += 1;
      if (record.favorite) favorites += 1;
    }
    return {
      total_banned: banned,
      total_kept: this.records.size - banned,
      total_favorites: favorites,
    };
  }

  displayTag(value: unknown): string {
    const key = normalizeTag(value);
    return this.tagDisplay.get(key) ?? String(value ?? "").trim();
  }

  displayUploader(value: unknown): string {
    const trimmed = String(value ?? "").trim();
    const key = casefold(trimmed);
    return this.uploaderDisplay.get(key) ?? trimmed;
  }

  matching(predicate: (record: CatalogImage) => boolean): CatalogImage[] {
    const out: CatalogImage[] = [];
    for (const record of this.records.values()) {
      if (predicate(record)) out.push(record);
    }
    return out;
  }

  matchingTags(tags: Iterable<unknown>): CatalogImage[] {
    const required = normalizedTagSet(tags);
    return this.matching((record) => {
      for (const req of required) {
        if (!record.tags.has(req)) return false;
      }
      return true;
    });
  }

  matchingUploader(uploader: unknown): CatalogImage[] {
    const key = casefold(String(uploader ?? "").trim());
    return this.matching((record) => record.uploader === key);
  }

  static stats(records: Iterable<CatalogImage>): MatchStats {
    const bannedFiles = new Set<string>();
    let banned = 0;
    let kept = 0;
    let favorites = 0;
    for (const record of records) {
      if (record.banned) {
        banned += 1;
        bannedFiles.add(record.filename);
      } else {
        kept += 1;
        if (record.favorite) favorites += 1;
      }
    }
    return new MatchStats(banned, kept, favorites, bannedFiles);
  }

  tagStats(tag: unknown): MatchStats {
    const key = normalizeTag(tag);
    return ImageCatalog.stats(this.matching((record) => record.tags.has(key)));
  }

  comboStats(tags: Iterable<unknown>): MatchStats {
    return ImageCatalog.stats(this.matchingTags(tags));
  }

  uploaderStats(uploader: unknown): MatchStats {
    return ImageCatalog.stats(this.matchingUploader(uploader));
  }

  tagCounts(): {
    banned: Map<string, number>;
    kept: Map<string, number>;
    favorites: Map<string, number>;
  } {
    const banned = new Map<string, number>();
    const kept = new Map<string, number>();
    const favorites = new Map<string, number>();
    for (const record of this.records.values()) {
      const target = record.banned ? banned : kept;
      for (const tag of record.orderedTags) {
        target.set(tag, (target.get(tag) ?? 0) + 1);
        if (record.favorite) {
          favorites.set(tag, (favorites.get(tag) ?? 0) + 1);
        }
      }
    }
    return { banned, kept, favorites };
  }

  get bannedFilenames(): Set<string> {
    const out = new Set<string>();
    for (const record of this.records.values()) {
      if (record.banned) out.add(record.filename);
    }
    return out;
  }

  get favoriteFilenames(): Set<string> {
    const out = new Set<string>();
    for (const record of this.records.values()) {
      if (record.favorite) out.add(record.filename);
    }
    return out;
  }

  /** Case-folded text per image, built on the first free-text search and reused. */
  private queryIndex(): QueryIndexEntry[] {
    if (this.queryIndexCache === null) {
      const index: QueryIndexEntry[] = [];
      for (const record of this.records.values()) {
        const rawTags = Array.isArray(record.metadata.tags)
          ? record.metadata.tags.map((t) => String(t))
          : [];
        index.push({
          record,
          rawTags,
          foldedTags: rawTags.map((t) => casefold(t)),
          category: casefold(String(record.metadata.category ?? "")),
          filename: casefold(record.filename),
          uploaderDisplay: extractUploaderString(record.metadata.uploader),
        });
      }
      this.queryIndexCache = index;
    }
    return this.queryIndexCache;
  }

  search(params?: {
    query?: string;
    tags?: Iterable<unknown>;
    uploader?: string;
  }): CatalogSearchResult {
    const requiredTags = params?.tags ? normalizedTagSet(params.tags) : new Set<string>();
    if (requiredTags.size > 0) {
      const matches = this.matching((record) => {
        for (const req of requiredTags) {
          if (!record.tags.has(req)) return false;
        }
        return true;
      }).map((r) => r.filename);
      return {
        matches,
        suggestions: [],
        tag_suggestions: [],
        uploader_suggestions: [],
      };
    }

    const uploaderKey = casefold((params?.uploader ?? "").trim());
    if (uploaderKey) {
      const matches = this.matching((record) => record.uploader === uploaderKey).map(
        (r) => r.filename,
      );
      return {
        matches,
        suggestions: [],
        tag_suggestions: [],
        uploader_suggestions: [],
      };
    }

    const queryKey = casefold(params?.query ?? "");
    if (!queryKey) {
      return {
        matches: [],
        suggestions: [],
        tag_suggestions: [],
        uploader_suggestions: [],
      };
    }

    const matches: string[] = [];
    const tagCounts = new Map<string, number>();
    const uploaderCounts = new Map<string, number>();

    for (const entry of this.queryIndex()) {
      const { record, rawTags, foldedTags, category, filename, uploaderDisplay } = entry;

      const matched =
        foldedTags.some((t) => t.includes(queryKey)) ||
        category.includes(queryKey) ||
        record.uploader.includes(queryKey) ||
        filename.includes(queryKey);

      if (!matched) continue;
      matches.push(record.filename);

      for (let index = 0; index < rawTags.length; index += 1) {
        if (foldedTags[index].startsWith(queryKey)) {
          const tag = rawTags[index];
          tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        }
      }
      if (uploaderDisplay && record.uploader.includes(queryKey)) {
        uploaderCounts.set(uploaderDisplay, (uploaderCounts.get(uploaderDisplay) ?? 0) + 1);
      }
    }

    const topTags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([tag]) => tag);
    const topUploaders = [...uploaderCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([name]) => name);

    return {
      matches,
      suggestions: topTags,
      tag_suggestions: topTags,
      uploader_suggestions: topUploaders,
    };
  }
}

// ---------------------------------------------------------------------------
// Suggestion Catalog Loader (parity with the original Python suggestion_data module)
// ---------------------------------------------------------------------------

interface FeedbackEventSummary {
  revision: number;
  filename: string;
  action: string;
  timestamp: number;
}

function resolveDownloadDir(target: ConfigOrDir): string {
  return typeof target === "string" ? target : target.download_dir;
}

function readHistoricalBans(dlDir: string): Set<string> {
  const filePath = path.join(dlDir, ".preference_historical_bans.json");
  const bans = new Set<string>();
  if (!fs.existsSync(filePath)) return bans;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(raw) || raw.schema_version !== 1 || !Array.isArray(raw.bans)) {
      return bans;
    }
    for (const entry of raw.bans) {
      if (Array.isArray(entry) && entry.length === 2 && typeof entry[1] === "string") {
        const name = path.basename(entry[1]);
        if (name) bans.add(name);
      }
    }
  } catch {
    // Ignore malformed file
  }
  return bans;
}

function readNeutralModelReviewTimestamps(dlDir: string): Map<string, number> {
  const filePath = path.join(dlDir, ".model-review.json");
  const neutral = new Map<string, number>();
  if (!fs.existsSync(filePath)) return neutral;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(raw) || raw.schema_version !== 1 || !isRecord(raw.items)) {
      return neutral;
    }
    for (const item of Object.values(raw.items)) {
      if (!isRecord(item)) continue;
      const status = item.status ?? "pending";
      if (status !== "pending" && status !== "filter") continue;
      const name = path.basename(String(item.name ?? item.filename ?? ""));
      if (!name) continue;
      const createdAt = typeof item.created_at === "number" ? item.created_at : 0;
      const resolvedAt = typeof item.resolved_at === "number" ? item.resolved_at : 0;
      neutral.set(name, Math.max(createdAt, resolvedAt, 0));
    }
  } catch {
    // Ignore malformed file
  }
  return neutral;
}

function parseFeedbackEvent(raw: unknown): FeedbackEventSummary | null {
  if (!isRecord(raw)) return null;
  const revision = raw.revision;
  const filename = path.basename(String(raw.filename ?? ""));
  const action = String(raw.action ?? "");
  const timestamp = raw.timestamp;
  if (
    typeof revision !== "number" ||
    !Number.isInteger(revision) ||
    !filename ||
    !action ||
    typeof timestamp !== "number" ||
    !Number.isFinite(timestamp)
  ) {
    return null;
  }
  return {
    revision,
    filename,
    action,
    timestamp: Math.trunc(timestamp),
  };
}

function readLatestPreferenceFeedback(dlDir: string): Map<string, FeedbackEventSummary> {
  const byRevision = new Map<number, FeedbackEventSummary>();

  const legacyFile = path.join(dlDir, ".preference_feedback.json");
  if (fs.existsSync(legacyFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(legacyFile, "utf8")) as unknown;
      if (isRecord(raw) && raw.schema_version === 1 && Array.isArray(raw.events)) {
        for (const ev of raw.events) {
          const parsed = parseFeedbackEvent(ev);
          if (parsed) byRevision.set(parsed.revision, parsed);
        }
      }
    } catch {
      // Ignore
    }
  }

  const jsonlFile = path.join(dlDir, ".preference_events.jsonl");
  if (fs.existsSync(jsonlFile)) {
    try {
      const lines = fs.readFileSync(jsonlFile, "utf8").split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const raw = JSON.parse(line) as unknown;
          if (isRecord(raw) && raw.schema_version === 2) {
            const parsed = parseFeedbackEvent(raw);
            if (parsed) byRevision.set(parsed.revision, parsed);
          }
        } catch {
          continue;
        }
      }
    } catch {
      // Ignore
    }
  }

  const ordered = [...byRevision.values()].sort((a, b) => a.revision - b.revision);
  const latestByFile = new Map<string, FeedbackEventSummary>();
  for (const ev of ordered) {
    latestByFile.set(ev.filename, ev);
  }
  return latestByFile;
}

export function loadSuggestionCatalog(
  config: Pick<WayperConfig, "download_dir"> | string,
  options?: {
    purities?: Iterable<Purity | string> | null;
    metadataSnapshot?: Record<string, ImageMetadata>;
  },
): ImageCatalog {
  const dl = resolveDownloadDir(config);
  const metadata = options?.metadataSnapshot ?? loadMetadata(config);
  const favorites = favoriteFilenames(config);

  const retained = new Set<string>();
  for (const purity of ALL_PURITIES) {
    for (const orient of ALL_ORIENTATIONS) {
      for (const imgPath of listImagesInDir(poolDir(dl, purity, orient))) {
        const filename = path.basename(imgPath);
        if (!isBlacklisted(config, filename)) {
          retained.add(filename);
        }
      }
    }
  }

  const banned = readHistoricalBans(dl);
  for (const entry of listBlacklist(config)) {
    banned.add(entry.filename);
  }

  const neutral = readNeutralModelReviewTimestamps(dl);
  for (const neutralName of neutral.keys()) {
    banned.delete(neutralName);
    retained.delete(neutralName);
  }

  const latestFeedback = readLatestPreferenceFeedback(dl);
  for (const [filename, ev] of latestFeedback) {
    const neutralTs = neutral.get(filename);
    if (neutralTs !== undefined && ev.timestamp <= neutralTs) {
      continue;
    }
    if (ev.action === "ban" || ev.action === "dislike") {
      banned.add(filename);
    } else {
      banned.delete(filename);
      if (ev.action === "keep" || ev.action === "favorite") {
        retained.add(filename);
      }
      if (ev.action === "favorite") {
        favorites.add(filename);
      }
    }
  }

  for (const fav of favorites) {
    banned.delete(fav);
    retained.add(fav);
  }

  const known = new Set<string>([...banned, ...retained]);
  const scopedMeta: Record<string, ImageMetadata> = {};
  for (const [filename, meta] of Object.entries(metadata)) {
    if (known.has(filename)) {
      scopedMeta[filename] = meta;
    }
  }

  return new ImageCatalog(scopedMeta, banned, favorites, {
    purities: options?.purities ?? null,
  });
}
