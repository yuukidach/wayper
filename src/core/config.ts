import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { casefold } from "../shared/tags";
import type {
  ConfigPatchPayload,
  ConfigPayload,
  FilterStrategy,
  LanguagePreference,
  MonitorConfig,
  Orientation,
  Purity,
  ResizeMode,
} from "../shared/types";
import { detectMonitors } from "./backend/index";
import { atomicWrite } from "./image-probe";
import { compactHome, expandPath, getConfigFile, isOrientation } from "./paths";

export const FILTER_STRATEGIES: readonly FilterStrategy[] = ["rules", "model", "rules+model"];
export const LANGUAGE_CHOICES: readonly LanguagePreference[] = ["auto", "en", "zh"];
export const RESIZE_MODES: readonly ResizeMode[] = ["crop", "fit", "stretch", "no"];

export interface WallhavenConfig {
  categories: string;
  top_range: string;
  sorting: string;
  ai_art_filter: number;
  batch_size: number;
  exclude_tags: string[];
  exclude_combos: string[][];
  exclude_uploaders: string[];
  filter_strategy: FilterStrategy;
}

export interface TransitionConfig {
  type: string;
  duration: number;
  fps: number;
  resize: ResizeMode;
}

export interface GreeterConfig {
  image: string | null;
  interval: number;
  sudo_password: string | null;
  fixed_image: string | null;
}

export interface WayperConfig {
  api_key: string;
  wallhaven_username: string;
  wallhaven_password: string;
  proxy: string | null;
  download_dir: string;
  interval: number;
  quota_mb: number;
  blacklist_ttl_days: number;
  pause_on_lock: boolean;
  safe_mode: boolean;
  monitors: MonitorConfig[];
  wallhaven: WallhavenConfig;
  transition: TransitionConfig;
  greeter: GreeterConfig;
  language: LanguagePreference;
  autostart: boolean;
}

export interface ConfigChanges {
  download_dir_changed: boolean;
  exclude_tags_changed: boolean;
  exclude_uploaders_changed: boolean;
}

export interface LoadConfigOptions {
  detectDisplays?: boolean;
  detectMonitorsFn?: () => MonitorConfig[];
}

export const NO_TRANSITION: TransitionConfig = {
  type: "none",
  duration: 0,
  fps: 60,
  resize: "crop",
};

const LANGUAGE_ALIASES: Record<string, LanguagePreference> = {
  english: "en",
  "en-us": "en",
  "en-gb": "en",
  chinese: "zh",
  "zh-cn": "zh",
  "zh-tw": "zh",
  简体中文: "zh",
  繁體中文: "zh",
  自动: "auto",
};

const FILTER_STRATEGY_ALIASES: Record<string, FilterStrategy> = {
  rules_model: "rules+model",
  "rules-and-model": "rules+model",
  rulesandmodel: "rules+model",
  both: "rules+model",
  off: "rules",
};

export function normalizeLanguage(value: unknown): LanguagePreference {
  if (value === null || value === undefined || typeof value === "boolean") {
    return "auto";
  }
  const raw = String(value || "auto")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  const aliased = LANGUAGE_ALIASES[raw] ?? raw;
  if (aliased.startsWith("zh-")) return "zh";
  if (aliased.startsWith("en-")) return "en";
  if (aliased === "auto" || aliased === "en" || aliased === "zh") {
    return aliased;
  }
  return "auto";
}

export function normalizeFilterStrategy(value: unknown): FilterStrategy {
  if (value === null || value === undefined || typeof value === "boolean") {
    return "rules";
  }
  const raw = String(value || "rules")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  const aliased = FILTER_STRATEGY_ALIASES[raw] ?? raw;
  if (aliased === "rules" || aliased === "model" || aliased === "rules+model") {
    return aliased;
  }
  return "rules";
}

export function normalizeResize(value: unknown): ResizeMode {
  if (typeof value !== "string") {
    return "crop";
  }
  const mode = value.trim().toLowerCase();
  if (mode === "crop" || mode === "fit" || mode === "stretch" || mode === "no") {
    return mode;
  }
  return "crop";
}

export function createDefaultConfig(overrides?: Partial<WayperConfig>): WayperConfig {
  const base: WayperConfig = {
    api_key: "",
    wallhaven_username: "",
    wallhaven_password: "",
    proxy: null,
    download_dir: path.join(os.homedir(), "Pictures", "wallpaper"),
    interval: 300,
    quota_mb: 4000,
    blacklist_ttl_days: 30,
    pause_on_lock: true,
    safe_mode: false,
    monitors: [],
    wallhaven: {
      categories: "111",
      top_range: "1M",
      sorting: "toplist",
      ai_art_filter: 0,
      batch_size: 5,
      exclude_tags: [],
      exclude_combos: [],
      exclude_uploaders: [],
      filter_strategy: "rules",
    },
    transition: {
      type: "grow",
      duration: 0.5,
      fps: 60,
      resize: "crop",
    },
    greeter: {
      image: null,
      interval: 12,
      sudo_password: null,
      fixed_image: null,
    },
    language: "auto",
    autostart: true,
  };
  if (!overrides) return base;
  return {
    ...base,
    ...overrides,
    wallhaven: {
      ...base.wallhaven,
      ...(overrides.wallhaven ?? {}),
      filter_strategy: normalizeFilterStrategy(
        overrides.wallhaven?.filter_strategy ?? base.wallhaven.filter_strategy,
      ),
    },
    transition: {
      ...base.transition,
      ...(overrides.transition ?? {}),
      resize: normalizeResize(overrides.transition?.resize ?? base.transition.resize),
    },
    greeter: {
      ...base.greeter,
      ...(overrides.greeter ?? {}),
    },
    language: normalizeLanguage(overrides.language ?? base.language),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asStringMatrix(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  const result: string[][] = [];
  for (const row of value) {
    if (Array.isArray(row)) {
      result.push(row.filter((item): item is string => typeof item === "string"));
    }
  }
  return result;
}

function parseConfigMonitors(rawMonitors: unknown): MonitorConfig[] {
  if (!Array.isArray(rawMonitors)) return [];
  const monitors: MonitorConfig[] = [];
  for (const item of rawMonitors) {
    if (!isRecord(item)) continue;
    const name = typeof item.name === "string" ? item.name : "";
    const width = asInt(item.width, 0);
    const height = asInt(item.height, 0);
    if (!name || width <= 0 || height <= 0) continue;
    const orientation: Orientation = isOrientation(item.orientation)
      ? item.orientation
      : height > width
        ? "portrait"
        : "landscape";
    monitors.push({ name, width, height, orientation });
  }
  return monitors;
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function saveConfig(config: WayperConfig, configPath?: string): void {
  const targetPath = configPath ?? getConfigFile();
  const dl = compactHome(config.download_dir);
  const lines: string[] = [];

  lines.push(`api_key = "${escapeTomlString(config.api_key)}"`);
  if (config.wallhaven_username) {
    lines.push(`wallhaven_username = "${escapeTomlString(config.wallhaven_username)}"`);
  }
  if (config.wallhaven_password) {
    lines.push(`wallhaven_password = "${escapeTomlString(config.wallhaven_password)}"`);
  }
  if (config.proxy) {
    lines.push(`proxy = "${escapeTomlString(config.proxy)}"`);
  }
  lines.push(`download_dir = "${escapeTomlString(dl)}"`);
  lines.push(`interval = ${config.interval}`);
  lines.push(`quota_mb = ${config.quota_mb}`);
  lines.push(`blacklist_ttl_days = ${config.blacklist_ttl_days}`);
  lines.push(`pause_on_lock = ${String(Boolean(config.pause_on_lock))}`);
  lines.push(`safe_mode = ${String(Boolean(config.safe_mode))}`);
  lines.push(`autostart = ${String(Boolean(config.autostart))}`);
  lines.push(`language = "${escapeTomlString(normalizeLanguage(config.language))}"`);

  const wh = config.wallhaven;
  lines.push("");
  lines.push("[wallhaven]");
  lines.push(`categories = "${escapeTomlString(wh.categories)}"`);
  lines.push(`top_range = "${escapeTomlString(wh.top_range)}"`);
  lines.push(`sorting = "${escapeTomlString(wh.sorting)}"`);
  lines.push(`ai_art_filter = ${wh.ai_art_filter}`);
  lines.push(`filter_strategy = "${escapeTomlString(normalizeFilterStrategy(wh.filter_strategy))}"`);
  lines.push(`batch_size = ${wh.batch_size}`);
  if (wh.exclude_tags.length > 0) {
    const tagsStr = wh.exclude_tags.map((t) => `"${escapeTomlString(t)}"`).join(", ");
    lines.push(`exclude_tags = [${tagsStr}]`);
  }
  if (wh.exclude_combos.length > 0) {
    const comboStrs = wh.exclude_combos.map(
      (combo) => `[${combo.map((t) => `"${escapeTomlString(t)}"`).join(", ")}]`,
    );
    lines.push(`exclude_combos = [${comboStrs.join(", ")}]`);
  }
  if (wh.exclude_uploaders.length > 0) {
    const uploadersStr = wh.exclude_uploaders.map((u) => `"${escapeTomlString(u)}"`).join(", ");
    lines.push(`exclude_uploaders = [${uploadersStr}]`);
  }

  const tr = config.transition;
  lines.push("");
  lines.push("[transition]");
  lines.push(`type = "${escapeTomlString(tr.type)}"`);
  lines.push(`duration = ${tr.duration}`);
  lines.push(`fps = ${tr.fps}`);
  lines.push(`resize = "${escapeTomlString(normalizeResize(tr.resize))}"`);

  const gr = config.greeter;
  if (gr.image) {
    lines.push("");
    lines.push("[greeter]");
    lines.push(`image = "${escapeTomlString(gr.image)}"`);
    lines.push(`interval = ${gr.interval}`);
    if (gr.fixed_image) {
      lines.push(`fixed_image = "${escapeTomlString(gr.fixed_image)}"`);
    }
    if (gr.sudo_password) {
      lines.push(`sudo_password = "${escapeTomlString(gr.sudo_password)}"`);
    }
  }

  lines.push("");
  atomicWrite(targetPath, lines.join("\n"));
}

export function loadConfig(configPath?: string, options?: LoadConfigOptions): WayperConfig {
  const targetPath = configPath ?? getConfigFile();
  let raw: Record<string, unknown> = {};

  if (fs.existsSync(targetPath)) {
    const content = fs.readFileSync(targetPath, "utf8");
    if (content.trim()) {
      const parsed = parseToml(content);
      if (isRecord(parsed)) {
        raw = parsed;
      }
    }
  }

  let monitors = parseConfigMonitors(raw.monitors);
  const shouldDetect = options?.detectDisplays ?? true;
  if (shouldDetect) {
    try {
      const detectFn = options?.detectMonitorsFn ?? detectMonitors;
      const detected = detectFn();
      // Configured [[monitors]] are the documented fallback when detection finds nothing.
      if (detected.length > 0 || monitors.length === 0) monitors = detected;
    } catch {
      // Fall back to config or empty monitors when display backend is unavailable
    }
  }

  const wallhavenRaw = isRecord(raw.wallhaven) ? raw.wallhaven : {};
  const wallhaven: WallhavenConfig = {
    categories: asString(wallhavenRaw.categories, "111"),
    top_range: asString(wallhavenRaw.top_range, "1M"),
    sorting: asString(wallhavenRaw.sorting, "toplist"),
    ai_art_filter: asInt(wallhavenRaw.ai_art_filter, 0),
    filter_strategy: normalizeFilterStrategy(
      wallhavenRaw.filter_strategy ?? wallhavenRaw.filter_mode ?? "rules",
    ),
    batch_size: Math.max(1, asInt(wallhavenRaw.batch_size, 5)),
    exclude_tags: asStringArray(wallhavenRaw.exclude_tags),
    exclude_combos: asStringMatrix(wallhavenRaw.exclude_combos),
    exclude_uploaders: asStringArray(wallhavenRaw.exclude_uploaders),
  };

  const transitionRaw = isRecord(raw.transition) ? raw.transition : {};
  const transition: TransitionConfig = {
    type: asString(transitionRaw.type, "grow"),
    duration: asNumber(transitionRaw.duration, 0.5),
    fps: asInt(transitionRaw.fps, 60),
    resize: normalizeResize(transitionRaw.resize ?? "crop"),
  };

  const greeterRaw = isRecord(raw.greeter) ? raw.greeter : {};
  const greeter: GreeterConfig = {
    image:
      typeof greeterRaw.image === "string" && greeterRaw.image.trim()
        ? expandPath(greeterRaw.image)
        : null,
    interval: asInt(greeterRaw.interval, 12),
    sudo_password: typeof greeterRaw.sudo_password === "string" ? greeterRaw.sudo_password : null,
    fixed_image:
      typeof greeterRaw.fixed_image === "string" && greeterRaw.fixed_image
        ? greeterRaw.fixed_image
        : null,
  };

  const downloadDir =
    typeof raw.download_dir === "string" && raw.download_dir.trim()
      ? path.resolve(expandPath(raw.download_dir))
      : path.join(os.homedir(), "Pictures", "wallpaper");

  const proxyVal = typeof raw.proxy === "string" && raw.proxy.trim() ? raw.proxy.trim() : null;

  return {
    api_key: asString(raw.api_key, ""),
    wallhaven_username: asString(raw.wallhaven_username, ""),
    wallhaven_password: asString(raw.wallhaven_password, ""),
    proxy: proxyVal,
    download_dir: downloadDir,
    interval: asInt(raw.interval, 300),
    quota_mb: asInt(raw.quota_mb, 4000),
    blacklist_ttl_days: asInt(raw.blacklist_ttl_days, 30),
    pause_on_lock: asBool(raw.pause_on_lock, true),
    safe_mode: asBool(raw.safe_mode, false),
    autostart: asBool(raw.autostart, true),
    monitors,
    wallhaven,
    transition,
    greeter,
    language: normalizeLanguage(raw.language ?? raw.locale ?? "auto"),
  };
}

export function configPayload(
  config: WayperConfig,
  mode: Iterable<Purity>,
  platform: NodeJS.Platform = process.platform,
): ConfigPayload {
  const sortedMode = [...new Set(mode)].sort() as Purity[];
  const strategy = normalizeFilterStrategy(config.wallhaven.filter_strategy);
  return {
    download_dir: config.download_dir,
    interval_min: Math.floor(config.interval / 60),
    mode: sortedMode,
    quota_mb: config.quota_mb,
    proxy: config.proxy ?? "",
    pause_on_lock: config.pause_on_lock,
    safe_mode: config.safe_mode,
    autostart: config.autostart,
    language: normalizeLanguage(config.language),
    transition: {
      resize: normalizeResize(config.transition.resize),
      resize_available: platform === "linux",
    },
    greeter: {
      available: platform === "linux" && config.greeter.image !== null,
      fixed_image: config.greeter.fixed_image,
    },
    has_api_key: Boolean(config.api_key),
    has_wh_password: Boolean(config.wallhaven_password),
    wallhaven_username: config.wallhaven_username,
    blacklist_ttl_days: config.blacklist_ttl_days,
    wallhaven: {
      categories: config.wallhaven.categories,
      top_range: config.wallhaven.top_range,
      sorting: config.wallhaven.sorting,
      ai_art_filter: config.wallhaven.ai_art_filter,
      filter_strategy: strategy,
      filter_mode: strategy,
      batch_size: config.wallhaven.batch_size,
      exclude_tags: [...config.wallhaven.exclude_tags],
      exclude_combos: config.wallhaven.exclude_combos.map((c) => [...c]),
      exclude_uploaders: [...config.wallhaven.exclude_uploaders],
    },
  };
}

function deduplicateBy<T>(items: readonly T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const marker = keyFn(item);
    if (!seen.has(marker)) {
      seen.add(marker);
      out.push(item);
    }
  }
  return out;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function applyConfigUpdates(
  config: WayperConfig,
  updates: ConfigPatchPayload,
  resolveDownloadDir: (raw: string) => string = (raw) => path.resolve(expandPath(raw)),
): ConfigChanges {
  const oldDownloadDir = config.download_dir;
  const oldExcludeTags = [...config.wallhaven.exclude_tags];
  const oldExcludeUploaders = [...config.wallhaven.exclude_uploaders];

  if (updates.interval_min !== undefined) {
    config.interval = Math.trunc(Number(updates.interval_min)) * 60;
  } else if (updates.interval !== undefined) {
    config.interval = Math.trunc(Number(updates.interval));
  }

  if (updates.quota_mb !== undefined) {
    config.quota_mb = Math.trunc(Number(updates.quota_mb));
  }
  if ("proxy" in updates) {
    const trimmed = String(updates.proxy ?? "").trim();
    config.proxy = trimmed || null;
  }
  if (updates.pause_on_lock !== undefined) {
    config.pause_on_lock = Boolean(updates.pause_on_lock);
  }
  if (updates.safe_mode !== undefined) {
    config.safe_mode = Boolean(updates.safe_mode);
  }
  if (updates.api_key !== undefined) {
    config.api_key = String(updates.api_key).trim();
  }
  if (updates.wallhaven_username !== undefined) {
    config.wallhaven_username = String(updates.wallhaven_username).trim();
  }
  if (updates.wallhaven_password !== undefined) {
    config.wallhaven_password = String(updates.wallhaven_password);
  }
  if (updates.blacklist_ttl_days !== undefined) {
    config.blacklist_ttl_days = Math.max(0, Math.trunc(Number(updates.blacklist_ttl_days)));
  }

  const languageRaw = updates.language !== undefined ? updates.language : updates.locale;
  if (languageRaw !== undefined) {
    config.language = normalizeLanguage(languageRaw);
  }

  if (updates.download_dir !== undefined) {
    config.download_dir = resolveDownloadDir(updates.download_dir);
  }

  if (isRecord(updates.transition) && "resize" in updates.transition) {
    config.transition.resize = normalizeResize(updates.transition.resize);
  }

  if (isRecord(updates.wallhaven)) {
    const wh = updates.wallhaven;
    if (wh.categories !== undefined) {
      config.wallhaven.categories = String(wh.categories);
    }
    if (wh.top_range !== undefined) {
      config.wallhaven.top_range = String(wh.top_range);
    }
    if (wh.sorting !== undefined) {
      config.wallhaven.sorting = String(wh.sorting);
    }
    if (wh.ai_art_filter !== undefined) {
      config.wallhaven.ai_art_filter = Math.trunc(Number(wh.ai_art_filter));
    }
    const strategyVal = wh.filter_strategy !== undefined ? wh.filter_strategy : wh.filter_mode;
    if (strategyVal !== undefined) {
      config.wallhaven.filter_strategy = normalizeFilterStrategy(strategyVal);
    }
    if (wh.batch_size !== undefined) {
      config.wallhaven.batch_size = Math.max(1, Math.trunc(Number(wh.batch_size)));
    }
    if (wh.exclude_tags !== undefined && Array.isArray(wh.exclude_tags)) {
      config.wallhaven.exclude_tags = deduplicateBy(wh.exclude_tags, (val) =>
        casefold(String(val)),
      );
    }
    if (wh.exclude_combos !== undefined && Array.isArray(wh.exclude_combos)) {
      config.wallhaven.exclude_combos = deduplicateBy(wh.exclude_combos, (combo) =>
        [...new Set(combo.map((tag) => casefold(String(tag))))].sort().join("\u001f"),
      );
    }
    if (wh.exclude_uploaders !== undefined && Array.isArray(wh.exclude_uploaders)) {
      config.wallhaven.exclude_uploaders = deduplicateBy(wh.exclude_uploaders, (val) =>
        casefold(String(val)),
      );
    }
  }

  return {
    download_dir_changed: config.download_dir !== oldDownloadDir,
    exclude_tags_changed: !arraysEqual(config.wallhaven.exclude_tags, oldExcludeTags),
    exclude_uploaders_changed: !arraysEqual(
      config.wallhaven.exclude_uploaders,
      oldExcludeUploaders,
    ),
  };
}
