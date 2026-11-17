import fs from "node:fs";
import path from "node:path";
import { PREVIEW_DIMENSIONS, previewCacheDirectory } from "../shared/media";
import { normalizeTag } from "../shared/tags";
import type { ImageItem, ImageMetadata, Orientation, Purity, TagDetail } from "../shared/types";
import type { WayperConfig } from "./config";
import { atomicWrite } from "./image-probe";
import { withFileLockSync } from "./lock";
import {
  ALL_ORIENTATIONS,
  ALL_PURITIES,
  favoritesDir,
  isImageFile,
  isOrientation,
  isPurity,
  poolDir,
} from "./paths";
import { isBlacklisted, listBlacklist, type ConfigOrDir } from "./state";
import { listRecoverableTrash } from "./trash";

export const METADATA_SCHEMA_VERSION = 2;

function resolveDownloadDir(target: ConfigOrDir): string {
  return typeof target === "string" ? target : target.download_dir;
}

function metadataFilePath(target: ConfigOrDir): string {
  return path.join(resolveDownloadDir(target), ".metadata.json");
}

function metadataLockPath(target: ConfigOrDir): string {
  return path.join(resolveDownloadDir(target), ".metadata.json.lock");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractTagNames(tags: unknown): string[] {
  if (!Array.isArray(tags) || tags.length === 0) {
    return [];
  }
  const names: string[] = [];
  for (const tag of tags) {
    const rawName = isRecord(tag) ? tag.name : tag;
    if (rawName === null || rawName === undefined) continue;
    const clean = String(rawName).trim();
    if (clean) {
      names.push(clean);
    }
  }
  return names;
}

export function extractTagDetails(tags: unknown): TagDetail[] {
  if (!Array.isArray(tags)) {
    return [];
  }
  const details: TagDetail[] = [];
  for (const raw of tags) {
    if (!isRecord(raw)) continue;
    const name = String(raw.name ?? "").trim();
    if (!name) continue;
    const detail: TagDetail = { name };
    for (const key of ["alias", "category", "purity", "created_at"] as const) {
      const val = raw[key];
      if (val !== null && val !== undefined && val !== "") {
        detail[key] = String(val);
      }
    }
    if (typeof raw.id === "number" && Number.isInteger(raw.id)) {
      detail.id = raw.id;
    }
    if (typeof raw.category_id === "number" && Number.isInteger(raw.category_id)) {
      detail.category_id = raw.category_id;
    }
    details.push(detail);
  }
  return details;
}

export function normalizeImageMetadata(
  item: Record<string, unknown>,
  previous?: ImageMetadata | null,
  options?: { complete?: boolean; fetchedAt?: number },
): ImageMetadata {
  const prev: Record<string, unknown> = isRecord(previous) ? previous : {};
  const fetchedAt =
    options?.fetchedAt !== undefined ? Math.trunc(options.fetchedAt) : Math.floor(Date.now() / 1000);

  const record: ImageMetadata = {
    ...prev,
    ...item,
  };

  const rawTags = item.tags;
  const tagNames = extractTagNames(rawTags);
  const tagDetails = extractTagDetails(rawTags);

  if (tagNames.length > 0 || "tags" in item) {
    record.tags = tagNames;
  } else {
    record.tags = extractTagNames(prev.tags);
  }

  if (tagDetails.length > 0) {
    record.tag_details = tagDetails;
  } else if (Array.isArray(prev.tag_details)) {
    record.tag_details = extractTagDetails(prev.tag_details);
  }

  if ("tags" in item) {
    record.tag_details_complete = tagDetails.length === tagNames.length;
  } else if ("tag_details_complete" in prev) {
    record.tag_details_complete = Boolean(prev.tag_details_complete);
  }

  const uploader = item.uploader;
  if (isRecord(uploader)) {
    record.uploader = String(uploader.username ?? "").trim();
    record.uploader_details = { ...uploader };
  } else if (uploader !== undefined && uploader !== null) {
    record.uploader = String(uploader).trim();
  } else {
    record.uploader = String(prev.uploader ?? "").trim();
  }

  const prevDownloadedAt = prev.downloaded_at;
  record.downloaded_at =
    typeof prevDownloadedAt === "number" && Number.isInteger(prevDownloadedAt)
      ? prevDownloadedAt
      : fetchedAt;

  const effectiveComplete = options?.complete ?? tagDetails.length > 0;
  const wasComplete = prev.metadata_complete === true;
  record.metadata_complete = wasComplete || effectiveComplete;

  if (effectiveComplete) {
    record.metadata_fetched_at = fetchedAt;
    delete record.metadata_unavailable;
    delete record.metadata_error;
    delete record.metadata_checked_at;
  } else if (typeof prev.metadata_fetched_at === "number") {
    record.metadata_fetched_at = prev.metadata_fetched_at;
  }

  record.metadata_schema_version = METADATA_SCHEMA_VERSION;
  return record;
}

function parseFirstJsonObject(text: string): Record<string, ImageMetadata> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) return {};
    return filterMetadataRecords(parsed);
  } catch {
    // Recover first balanced JSON object when trailing junk exists
    const start = text.indexOf("{");
    if (start === -1) return {};
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, i + 1)) as unknown;
            return isRecord(parsed) ? filterMetadataRecords(parsed) : {};
          } catch {
            return {};
          }
        }
      }
    }
    return {};
  }
}

function filterMetadataRecords(raw: Record<string, unknown>): Record<string, ImageMetadata> {
  const out: Record<string, ImageMetadata> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (isRecord(val)) {
      out[key] = val as ImageMetadata;
    }
  }
  return out;
}

export function loadMetadata(config: ConfigOrDir): Record<string, ImageMetadata> {
  const mf = metadataFilePath(config);
  if (!fs.existsSync(mf)) {
    return {};
  }
  try {
    const text = fs.readFileSync(mf, "utf8");
    return parseFirstJsonObject(text);
  } catch {
    return {};
  }
}

export function saveMetadataBatch(
  config: ConfigOrDir,
  items: Record<string, Record<string, unknown>>,
  options?: { complete?: boolean; fetchedAt?: number },
): number {
  const entries = Object.entries(items);
  if (entries.length === 0) {
    return 0;
  }
  const timestamp =
    options?.fetchedAt !== undefined ? Math.trunc(options.fetchedAt) : Math.floor(Date.now() / 1000);
  const mf = metadataFilePath(config);
  const lockFile = metadataLockPath(config);

  withFileLockSync(lockFile, () => {
    const data = loadMetadata(config);
    for (const [rawFilename, item] of entries) {
      const filename = path.basename(rawFilename);
      if (!filename || !isRecord(item)) continue;
      data[filename] = normalizeImageMetadata(item, data[filename], {
        complete: options?.complete,
        fetchedAt: timestamp,
      });
    }
    atomicWrite(mf, `${JSON.stringify(data)}\n`);
  });
  return entries.length;
}

export function saveMetadataRecord(
  config: ConfigOrDir,
  filename: string,
  item: Record<string, unknown>,
  options?: { complete?: boolean; fetchedAt?: number },
): void {
  saveMetadataBatch(config, { [filename]: item }, options);
}

function tagDetailsEqual(a: unknown, b: readonly TagDetail[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function hydrateTagDetails(config: ConfigOrDir): {
  known_tags: number;
  tag_complete_records: number;
  changed_records: number;
} {
  const mf = metadataFilePath(config);
  const lockFile = metadataLockPath(config);

  return withFileLockSync(lockFile, () => {
    const data = loadMetadata(config);
    const catalog = new Map<string, TagDetail>();

    for (const record of Object.values(data)) {
      const details = extractTagDetails(record.tag_details);
      for (const detail of details) {
        const key = normalizeTag(detail.name);
        if (key) {
          const prev = catalog.get(key);
          catalog.set(key, prev ? { ...prev, ...detail } : detail);
        }
      }
    }

    let changedRecords = 0;
    let completeRecords = 0;

    for (const record of Object.values(data)) {
      const tags = extractTagNames(record.tags);
      if (tags.length === 0) continue;

      const current = new Map<string, TagDetail>();
      for (const detail of extractTagDetails(record.tag_details)) {
        const key = normalizeTag(detail.name);
        if (key) current.set(key, detail);
      }

      const available: TagDetail[] = [];
      for (const tag of tags) {
        const key = normalizeTag(tag);
        const known = catalog.get(key);
        const existing = current.get(key);
        if (known && existing) {
          available.push({ ...known, ...existing });
        } else if (existing || known) {
          available.push((existing ?? known) as TagDetail);
        }
      }

      const isComplete = available.length === tags.length;
      let recordChanged = false;

      if (available.length > 0 && !tagDetailsEqual(record.tag_details, available)) {
        record.tag_details = available;
        record.metadata_schema_version = METADATA_SCHEMA_VERSION;
        recordChanged = true;
      }
      if (record.tag_details_complete !== isComplete) {
        record.tag_details_complete = isComplete;
        recordChanged = true;
      }

      if (recordChanged) changedRecords += 1;
      if (isComplete) completeRecords += 1;
    }

    if (changedRecords > 0) {
      atomicWrite(mf, `${JSON.stringify(data)}\n`);
    }

    return {
      known_tags: catalog.size,
      tag_complete_records: completeRecords,
      changed_records: changedRecords,
    };
  });
}

export function listImagesInDir(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.isFile() && isImageFile(entry.name)) {
        files.push(path.join(dirPath, entry.name));
      }
    }
    return files;
  } catch {
    return [];
  }
}

export function countImagesInDir(dirPath: string): number {
  return listImagesInDir(dirPath).length;
}

export function ensureDirectories(config: ConfigOrDir): void {
  const dl = resolveDownloadDir(config);
  for (const purity of ALL_PURITIES) {
    for (const orient of ALL_ORIENTATIONS) {
      fs.mkdirSync(poolDir(dl, purity, orient), { recursive: true });
      fs.mkdirSync(favoritesDir(dl, purity, orient), { recursive: true });
    }
  }
}

export function favoriteFilenames(
  config: ConfigOrDir,
  purities?: Iterable<Purity>,
): Set<string> {
  const dl = resolveDownloadDir(config);
  const active = purities ? [...purities].filter(isPurity) : ALL_PURITIES;
  const names = new Set<string>();
  for (const purity of active) {
    for (const orient of ALL_ORIENTATIONS) {
      for (const imgPath of listImagesInDir(favoritesDir(dl, purity, orient))) {
        const filename = path.basename(imgPath);
        if (!isBlacklisted(config, filename)) {
          names.add(filename);
        }
      }
    }
  }
  return names;
}

export function diskUsageMb(config: ConfigOrDir): number {
  const dl = resolveDownloadDir(config);
  let totalBytes = 0;
  for (const purity of ALL_PURITIES) {
    for (const orient of ALL_ORIENTATIONS) {
      for (const dir of [poolDir(dl, purity, orient), favoritesDir(dl, purity, orient)]) {
        try {
          if (!fs.existsSync(dir)) continue;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            try {
              totalBytes += fs.statSync(path.join(dir, entry.name)).size;
            } catch {
              // Ignore concurrently removed files
            }
          }
        } catch {
          // Ignore inaccessible directory
        }
      }
    }
  }
  return totalBytes / 1024 / 1024;
}

function collectImagesRecursive(rootDir: string): Array<{ filePath: string; mtimeMs: number; size: number }> {
  const found: Array<{ filePath: string; mtimeMs: number; size: number }> = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !fs.existsSync(current)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && isImageFile(entry.name)) {
        try {
          const stat = fs.statSync(fullPath);
          found.push({ filePath: fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
        } catch {
          // Ignore race
        }
      }
    }
  }
  return found;
}

export function enforceQuota(config: Pick<WayperConfig, "download_dir" | "quota_mb">): number {
  const quotaBytesPerPurity = Math.floor(
    (config.quota_mb * 1024 * 1024) / ALL_PURITIES.length,
  );
  let deletedCount = 0;

  for (const purity of ALL_PURITIES) {
    const purityRoot = path.join(config.download_dir, purity);
    if (!fs.existsSync(purityRoot)) continue;

    const images = collectImagesRecursive(purityRoot);
    images.sort((a, b) => a.mtimeMs - b.mtimeMs);

    let total = images.reduce((sum, img) => sum + img.size, 0);
    for (const img of images) {
      if (total <= quotaBytesPerPurity) {
        break;
      }
      try {
        fs.unlinkSync(img.filePath);
        total -= img.size;
        deletedCount += 1;
      } catch {
        // Ignore race
      }
    }
  }

  return deletedCount;
}

function resolvePuritiesInput(purities: Iterable<Purity> | string): Purity[] {
  if (typeof purities === "string") {
    const parsed = purities
      .split(",")
      .map((s) => s.trim())
      .filter(isPurity);
    return parsed.length > 0 ? parsed : ["sfw"];
  }
  const set = new Set<Purity>();
  for (const p of purities) {
    if (isPurity(p)) set.add(p);
  }
  const ordered = ALL_PURITIES.filter((p) => set.has(p));
  return ordered.length > 0 ? ordered : ["sfw"];
}

export function listLibraryImages(
  config: ConfigOrDir,
  mode: "pool" | "favorites" | "trash",
  purities: Iterable<Purity> | string,
  orient?: string | null,
): ImageItem[] {
  const dl = path.resolve(resolveDownloadDir(config));

  if (mode === "trash") {
    const blacklist = listBlacklist(config);
    const recoverable = listRecoverableTrash(
      config,
      blacklist.map((entry) => entry.filename),
    );
    const trashItems: ImageItem[] = [];
    for (const entry of blacklist) {
      if (recoverable.has(entry.filename)) {
        trashItems.push({
          path: `__trash/${entry.filename}`,
          name: entry.filename,
          is_favorite: false,
          orientation: null,
        });
      }
    }
    return trashItems;
  }

  const activePurities = resolvePuritiesInput(purities);
  const orientations: Orientation[] =
    orient && isOrientation(orient) ? [orient] : ALL_ORIENTATIONS;
  const isFav = mode === "favorites";

  const records: Array<{ mtimeMs: number; fullPath: string }> = [];
  for (const purity of activePurities) {
    for (const orientation of orientations) {
      const dir = isFav ? favoritesDir(dl, purity, orientation) : poolDir(dl, purity, orientation);
      for (const fullPath of listImagesInDir(dir)) {
        if (isBlacklisted(config, path.basename(fullPath))) continue;
        try {
          const stat = fs.statSync(fullPath);
          records.push({ mtimeMs: stat.mtimeMs, fullPath });
        } catch {
          // Ignore concurrently removed files
        }
      }
    }
  }

  records.sort((a, b) => b.mtimeMs - a.mtimeMs);

  return records.map(({ fullPath }) => {
    const relPosix = path.relative(dl, fullPath).split(path.sep).join("/");
    const parentName = path.basename(path.dirname(fullPath));
    return {
      path: relPosix,
      name: path.basename(fullPath),
      is_favorite: isFav,
      orientation: isOrientation(parentName) ? parentName : null,
    };
  });
}

export function pickRandomWallpaper(
  config: ConfigOrDir,
  purities: Iterable<Purity>,
  orientation: Orientation | string,
  exclude?: string | null,
): string | null {
  const dl = resolveDownloadDir(config);
  const requested = new Set<Purity>();
  for (const p of purities) {
    if (isPurity(p)) requested.add(p);
  }
  const active = ALL_PURITIES.filter((p) => requested.has(p));
  if (active.length === 0) {
    return null;
  }

  // Fisher-Yates shuffle so each purity has equal weight
  for (let i = active.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [active[i], active[j]] = [active[j], active[i]];
  }

  const resolvedExclude = exclude ? path.resolve(exclude) : null;

  for (const purity of active) {
    let candidates = [
      ...listImagesInDir(poolDir(dl, purity, orientation)),
      ...listImagesInDir(favoritesDir(dl, purity, orientation)),
    ];
    if (resolvedExclude) {
      candidates = candidates.filter((img) => path.resolve(img) !== resolvedExclude);
    }
    candidates = candidates.filter((img) => !isBlacklisted(config, path.basename(img)));
    if (candidates.length > 0) {
      const idx = Math.floor(Math.random() * candidates.length);
      return candidates[idx];
    }
  }

  return null;
}

export function clearImageDerivatives(config: ConfigOrDir, relPath: string): void {
  const dl = path.resolve(resolveDownloadDir(config));
  const normalizedInput = path.isAbsolute(relPath)
    ? path.relative(dl, path.resolve(relPath))
    : path.normalize(relPath);

  if (!normalizedInput || normalizedInput.startsWith("..") || path.isAbsolute(normalizedInput)) {
    return;
  }

  const parentDir = path.dirname(normalizedInput);
  const ext = path.extname(normalizedInput);
  const stem = path.basename(normalizedInput, ext);
  if (!stem) return;

  for (const cacheName of [".thumbnails", ...PREVIEW_DIMENSIONS.map(previewCacheDirectory)]) {
    const derivative = path.join(dl, cacheName, parentDir, `${stem}.jpg`);
    try {
      fs.rmSync(derivative, { force: true });
    } catch {
      // Ignore
    }
  }
}

export function shouldDownload(config: ConfigOrDir, purities: Iterable<Purity>): boolean {
  const dl = resolveDownloadDir(config);
  for (const purity of purities) {
    if (!isPurity(purity)) continue;
    for (const orient of ALL_ORIENTATIONS) {
      if (countImagesInDir(poolDir(dl, purity, orient)) < 30) {
        return true;
      }
    }
  }
  return Math.random() < 0.2;
}
