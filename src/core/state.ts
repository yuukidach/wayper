import fs from "node:fs";
import path from "node:path";
import type { Purity } from "../shared/types";
import type { WayperConfig } from "./config";
import { atomicWrite } from "./image-probe";
import { ALL_PURITIES, isPurity } from "./paths";

export const MAX_HISTORY = 50;

export type ConfigOrDir = Pick<WayperConfig, "download_dir"> | string;

export interface BlacklistRecord {
  timestamp: number;
  filename: string;
}

export interface UndoEntry {
  filename: string;
  originalDir: string;
}

interface MonitorHistoryState {
  entries: string[];
  position: number;
}

type HistoryFileData = Record<string, MonitorHistoryState>;

function resolveDownloadDir(target: ConfigOrDir): string {
  return typeof target === "string" ? target : target.download_dir;
}

function modeFilePath(target: ConfigOrDir): string {
  return path.join(resolveDownloadDir(target), ".mode");
}

function lastRotationFilePath(target: ConfigOrDir): string {
  return path.join(resolveDownloadDir(target), ".last_rotation");
}

function historyFilePath(target: ConfigOrDir): string {
  return path.join(resolveDownloadDir(target), ".history");
}

function blacklistFilePath(target: ConfigOrDir): string {
  return path.join(resolveDownloadDir(target), ".blacklist");
}

function undoFilePath(target: ConfigOrDir): string {
  return path.join(resolveDownloadDir(target), ".undo");
}

// ---------------------------------------------------------------------------
// .mode
// ---------------------------------------------------------------------------

function parseMode(raw: string): Purity[] {
  const parts = new Set(
    raw
      .split(",")
      .map((item) => item.trim())
      .filter(isPurity),
  );
  const ordered = ALL_PURITIES.filter((p) => parts.has(p));
  return ordered.length > 0 ? ordered : ["sfw"];
}

export function readMode(config: ConfigOrDir): Purity[] {
  const filePath = modeFilePath(config);
  try {
    if (!fs.existsSync(filePath)) {
      return ["sfw"];
    }
    const raw = fs.readFileSync(filePath, "utf8").trim();
    return raw ? parseMode(raw) : ["sfw"];
  } catch {
    return ["sfw"];
  }
}

export function writeMode(config: ConfigOrDir, mode: Iterable<Purity>): Purity[] {
  const requested = new Set<Purity>();
  for (const item of mode) {
    if (isPurity(item)) {
      requested.add(item);
    }
  }
  const ordered: Purity[] = ALL_PURITIES.filter((p) => requested.has(p));
  const effective: Purity[] = ordered.length > 0 ? ordered : ["sfw"];
  atomicWrite(modeFilePath(config), effective.join(","));
  return effective;
}

export function toggleBase(current: Iterable<Purity>): Purity[] {
  const set = new Set<Purity>();
  for (const item of current) {
    if (isPurity(item)) set.add(item);
  }
  if (set.has("nsfw")) {
    set.delete("nsfw");
    set.add("sfw");
  } else if (set.has("sfw")) {
    set.delete("sfw");
    set.add("nsfw");
  } else {
    set.add("nsfw");
  }
  return ALL_PURITIES.filter((p) => set.has(p));
}

export function togglePurity(current: Iterable<Purity>, purity: Purity): Purity[] {
  const set = new Set<Purity>();
  for (const item of current) {
    if (isPurity(item)) set.add(item);
  }
  if (!isPurity(purity)) {
    const keep = ALL_PURITIES.filter((p) => set.has(p));
    return keep.length > 0 ? keep : ["sfw"];
  }
  if (set.has(purity)) {
    if (set.size <= 1) {
      return ALL_PURITIES.filter((p) => set.has(p));
    }
    set.delete(purity);
  } else {
    set.add(purity);
  }
  return ALL_PURITIES.filter((p) => set.has(p));
}

// ---------------------------------------------------------------------------
// .last_rotation
// ---------------------------------------------------------------------------

export function readLastRotation(config: ConfigOrDir): number | null {
  try {
    const raw = fs.readFileSync(lastRotationFilePath(config), "utf8").trim();
    if (!raw) return null;
    const val = Number.parseFloat(raw);
    return Number.isFinite(val) ? val : null;
  } catch {
    return null;
  }
}

export function writeLastRotation(config: ConfigOrDir, when?: number): void {
  const ts = when !== undefined ? when : Date.now() / 1000;
  atomicWrite(lastRotationFilePath(config), String(ts));
}

export function secondsUntilNextRotation(
  config: Pick<WayperConfig, "download_dir" | "interval">,
  now?: number,
): number {
  if (config.interval <= 0) {
    return 0;
  }
  const lastRotation = readLastRotation(config);
  if (lastRotation === null) {
    return 0;
  }
  const currentSec = now !== undefined ? now : Date.now() / 1000;
  const elapsed = Math.max(0, currentSec - lastRotation);
  return Math.max(0, config.interval - elapsed);
}

// ---------------------------------------------------------------------------
// .history
// ---------------------------------------------------------------------------

function loadHistoryData(config: ConfigOrDir): HistoryFileData {
  try {
    const raw = fs.readFileSync(historyFilePath(config), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const result: HistoryFileData = {};
    for (const [monitor, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const rec = value as Record<string, unknown>;
      const entries = Array.isArray(rec.entries)
        ? rec.entries.filter((item): item is string => typeof item === "string")
        : [];
      const position =
        typeof rec.position === "number" && Number.isInteger(rec.position) ? rec.position : -1;
      result[monitor] = { entries, position };
    }
    return result;
  } catch {
    return {};
  }
}

function saveHistoryData(config: ConfigOrDir, data: HistoryFileData): void {
  atomicWrite(historyFilePath(config), JSON.stringify(data));
}

function ensureMonitorHistory(data: HistoryFileData, monitor: string): MonitorHistoryState {
  if (!data[monitor]) {
    data[monitor] = { entries: [], position: -1 };
  }
  return data[monitor];
}

function pushHistoryEntry(data: HistoryFileData, monitor: string, imagePath: string): void {
  const md = ensureMonitorHistory(data, monitor);
  const { entries } = md;
  const pos = md.position;

  if (pos >= 0 && pos < entries.length - 1) {
    entries.splice(pos + 1);
  }

  if (entries.length > 0 && entries[entries.length - 1] === imagePath) {
    md.position = entries.length - 1;
    return;
  }

  entries.push(imagePath);
  if (entries.length > MAX_HISTORY) {
    entries.splice(0, entries.length - MAX_HISTORY);
  }
  md.position = entries.length - 1;
}

export function pushHistory(config: ConfigOrDir, monitor: string, imagePath: string): void {
  const data = loadHistoryData(config);
  pushHistoryEntry(data, monitor, imagePath);
  saveHistoryData(config, data);
}

export function pushManyHistory(
  config: ConfigOrDir,
  items: ReadonlyArray<readonly [string, string] | { monitor: string; imagePath: string }>,
): void {
  if (items.length === 0) {
    return;
  }
  const data = loadHistoryData(config);
  for (const item of items) {
    if (Array.isArray(item)) {
      const [monitor, imagePath] = item as readonly [string, string];
      pushHistoryEntry(data, monitor, imagePath);
    } else {
      const obj = item as { monitor: string; imagePath: string };
      pushHistoryEntry(data, obj.monitor, obj.imagePath);
    }
  }
  saveHistoryData(config, data);
}

function navigateHistory(config: ConfigOrDir, monitor: string, direction: -1 | 1): string | null {
  const data = loadHistoryData(config);
  const md = ensureMonitorHistory(data, monitor);
  const { entries } = md;
  let candidate = md.position + direction;

  while (candidate >= 0 && candidate < entries.length) {
    const candidatePath = entries[candidate];
    if (fs.existsSync(candidatePath)) {
      md.position = candidate;
      saveHistoryData(config, data);
      return candidatePath;
    }
    candidate += direction;
  }
  return null;
}

export function goPrev(config: ConfigOrDir, monitor: string): string | null {
  return navigateHistory(config, monitor, -1);
}

export function goNext(config: ConfigOrDir, monitor: string): string | null {
  return navigateHistory(config, monitor, 1);
}

// ---------------------------------------------------------------------------
// .blacklist
// ---------------------------------------------------------------------------

let blacklistCacheSet: Set<string> | null = null;
let blacklistCacheMtime = -1;
let blacklistCacheSize = -1;
let blacklistCachePath: string | null = null;

function invalidateBlacklistCache(): void {
  blacklistCacheSet = null;
  blacklistCachePath = null;
  blacklistCacheMtime = -1;
  blacklistCacheSize = -1;
}

function splitFirstWhitespace(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\S+)\s+(.+)$/);
  if (!match) return null;
  return [match[1], match[2]];
}

function parseBlacklistRecords(lines: readonly string[]): BlacklistRecord[] {
  const records: BlacklistRecord[] = [];
  for (const line of lines) {
    const parts = splitFirstWhitespace(line);
    if (!parts) continue;
    const [tsStr, filename] = parts;
    if (/^\d+$/.test(tsStr)) {
      records.push({
        timestamp: Number.parseInt(tsStr, 10),
        filename,
      });
    }
  }
  return records;
}

function parseBlacklistFilenames(lines: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const line of lines) {
    const parts = splitFirstWhitespace(line);
    if (parts) {
      names.add(parts[1]);
    }
  }
  return names;
}

function getBlacklistSet(config: ConfigOrDir): Set<string> {
  const bf = blacklistFilePath(config);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(bf);
  } catch {
    invalidateBlacklistCache();
    return new Set();
  }
  if (
    blacklistCacheSet === null ||
    blacklistCachePath !== bf ||
    blacklistCacheMtime !== stat.mtimeMs ||
    blacklistCacheSize !== stat.size
  ) {
    const lines = fs.readFileSync(bf, "utf8").split(/\r?\n/);
    blacklistCacheSet = parseBlacklistFilenames(lines);
    blacklistCacheMtime = stat.mtimeMs;
    blacklistCacheSize = stat.size;
    blacklistCachePath = bf;
  }
  return blacklistCacheSet;
}

export function listBlacklist(config: ConfigOrDir): BlacklistRecord[] {
  const bf = blacklistFilePath(config);
  if (!fs.existsSync(bf)) {
    return [];
  }
  const lines = fs.readFileSync(bf, "utf8").split(/\r?\n/);
  const entries = parseBlacklistRecords(lines);
  entries.sort((a, b) => b.timestamp - a.timestamp);
  return entries;
}

export function isBlacklisted(config: ConfigOrDir, filename: string): boolean {
  return getBlacklistSet(config).has(filename);
}

export function addToBlacklist(config: ConfigOrDir, filename: string, timestamp?: number): void {
  const bf = blacklistFilePath(config);
  fs.mkdirSync(path.dirname(bf), { recursive: true });
  const ts = timestamp !== undefined ? Math.trunc(timestamp) : Math.floor(Date.now() / 1000);
  fs.appendFileSync(bf, `${ts} ${filename}\n`, "utf8");
  invalidateBlacklistCache();
}

export function removeFromBlacklist(config: ConfigOrDir, filename: string): boolean {
  const bf = blacklistFilePath(config);
  if (!fs.existsSync(bf)) {
    return false;
  }
  const rawLines = fs.readFileSync(bf, "utf8").split(/\r?\n/);
  const kept: string[] = [];
  let removed = false;
  for (const line of rawLines) {
    if (!line) continue;
    const parts = splitFirstWhitespace(line);
    if (parts && parts[1] === filename) {
      removed = true;
    } else {
      kept.push(line);
    }
  }
  atomicWrite(bf, kept.length > 0 ? `${kept.join("\n")}\n` : "");
  invalidateBlacklistCache();
  return removed;
}

export function pruneBlacklist(
  config: Pick<WayperConfig, "download_dir" | "blacklist_ttl_days">,
  nowSec?: number,
): void {
  if (config.blacklist_ttl_days <= 0) {
    return;
  }
  const bf = blacklistFilePath(config);
  if (!fs.existsSync(bf)) {
    return;
  }
  const now = nowSec !== undefined ? Math.trunc(nowSec) : Math.floor(Date.now() / 1000);
  const cutoff = now - config.blacklist_ttl_days * 86_400;
  const rawLines = fs.readFileSync(bf, "utf8").split(/\r?\n/);
  const kept: string[] = [];
  for (const line of rawLines) {
    if (!line) continue;
    const parts = splitFirstWhitespace(line);
    if (parts && /^\d+$/.test(parts[0]) && Number.parseInt(parts[0], 10) >= cutoff) {
      kept.push(line);
    }
  }
  atomicWrite(bf, kept.length > 0 ? `${kept.join("\n")}\n` : "");
  invalidateBlacklistCache();
}

// ---------------------------------------------------------------------------
// .undo
// ---------------------------------------------------------------------------

export function appendUndo(config: ConfigOrDir, filename: string, originalDir: string): void {
  const uf = undoFilePath(config);
  fs.mkdirSync(path.dirname(uf), { recursive: true });
  fs.appendFileSync(uf, `${filename} ${originalDir}\n`, "utf8");
}

export function popUndo(config: ConfigOrDir): UndoEntry | null {
  const uf = undoFilePath(config);
  if (!fs.existsSync(uf)) {
    return null;
  }
  const lines = fs
    .readFileSync(uf, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }
  const last = lines[lines.length - 1];
  const parts = splitFirstWhitespace(last);
  if (!parts) {
    return null;
  }
  const remaining = lines.slice(0, -1);
  atomicWrite(uf, remaining.length > 0 ? `${remaining.join("\n")}\n` : "");
  return {
    filename: parts[0],
    originalDir: parts[1],
  };
}
