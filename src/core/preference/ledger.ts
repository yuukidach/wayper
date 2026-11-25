import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { WayperConfig } from "../config";
import { atomicWrite } from "../image-probe";
import { getDefaultLockPath, isPidAlive, withFileLock } from "../lock";
import { ALL_ORIENTATIONS, ALL_PURITIES, favoritesDir, poolDir } from "../paths";
import { listImagesInDir, loadMetadata } from "../pool";
import { isBlacklisted, listBlacklist, type ConfigOrDir } from "../state";
import {
  AUTO_RETRAIN_DELAY_SECONDS,
  AUTO_RETRAIN_MIN_CHANGED_EXAMPLES,
  AUTO_RETRAIN_MIN_FEEDBACK,
  AUTO_RETRAIN_WORKER_STALE_SECONDS,
  compareStrings,
  DECISION_CALIBRATION_VERSION,
  DEFAULT_COMBO_MIN_SUPPORT,
  DEFAULT_EPOCHS,
  DEFAULT_FAVORITE_WEIGHT,
  DEFAULT_FEATURE_NORMALIZATION,
  DEFAULT_MAX_COMBO_FEATURES,
  DEFAULT_NEIGHBOR_MIN_SIMILARITY,
  DEFAULT_RECENCY_HALF_LIFE_DAYS,
  DEFAULT_SEMANTIC_MODEL,
  DEFAULT_TRAINING_MAX_EXAMPLES,
  FEEDBACK_ACTIONS,
  FEEDBACK_SCHEMA_VERSION,
  HISTORICAL_BAN_SCHEMA_VERSION,
  isLegacySemanticModel,
  LEGACY_FEEDBACK_SCHEMA_VERSION,
  MIN_TRAINING_PER_CLASS,
  MODEL_SCHEMA_VERSION,
} from "./constants";
import {
  makeExample,
  modelContextFeatures,
  modelTags,
  predictionToDict,
  preferenceCandidate,
  preferenceDecisionScore,
  preferenceDecisionThreshold,
  PreferenceModel,
  preferenceNeighborVoteWeight,
  selectPreferenceExamples,
  type PreferenceExample,
  type PreferencePrediction,
  type PreferenceTrainingSnapshot,
} from "./model";
import { prefetchEmbeddings, semanticTagItems } from "./semantic";
import {
  hasBothClasses,
  metadataTimestamp,
  recencyWeight,
  trainingDataSignature,
  trainingExampleIds,
  trainPreferenceModel,
} from "./training";

export interface FeedbackEvent {
  schema_version?: number;
  revision: number;
  timestamp: number;
  filename: string;
  action: string;
  source?: string;
  context?: string;
  [key: string]: unknown;
}

type Metadata = Record<string, Record<string, unknown>>;

function downloadDirOf(config: ConfigOrDir): string {
  return typeof config === "string" ? config : config.download_dir;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function preferenceModelPath(config: ConfigOrDir): string {
  return path.join(downloadDirOf(config), ".preference_model.json");
}

export function preferenceFeedbackPath(config: ConfigOrDir): string {
  return path.join(downloadDirOf(config), ".preference_events.jsonl");
}

export function legacyPreferenceFeedbackPath(config: ConfigOrDir): string {
  return path.join(downloadDirOf(config), ".preference_feedback.json");
}

export function preferenceHistoricalBansPath(config: ConfigOrDir): string {
  return path.join(downloadDirOf(config), ".preference_historical_bans.json");
}

export function modelReviewFilePath(config: ConfigOrDir): string {
  return path.join(downloadDirOf(config), ".model-review.json");
}

export function modelReviewDirPath(config: ConfigOrDir): string {
  return path.join(downloadDirOf(config), ".model-review");
}

function metadataLockPath(config: ConfigOrDir): string {
  return path.join(downloadDirOf(config), ".metadata.json.lock");
}

function preferenceModelLockPath(modelPath: string): string {
  return `${modelPath}.lock`;
}

type NeutralFilterProvider = (config: ConfigOrDir) => Set<string>;
let neutralFilterProvider: NeutralFilterProvider = () => new Set();

export function setNeutralFilterProvider(provider: NeutralFilterProvider): void {
  neutralFilterProvider = provider;
}

export function loadPreferenceHistoricalBans(config: ConfigOrDir): Map<string, number> {
  const bans = new Map<string, number>();
  const raw = readJson(preferenceHistoricalBansPath(config));
  if (!isRecord(raw) || raw.schema_version !== HISTORICAL_BAN_SCHEMA_VERSION) return bans;
  if (!Array.isArray(raw.bans)) return bans;
  for (const record of raw.bans) {
    if (
      !Array.isArray(record) ||
      record.length !== 2 ||
      !isInteger(record[0]) ||
      typeof record[1] !== "string"
    ) {
      continue;
    }
    const filename = path.basename(record[1]);
    if (filename) {
      bans.set(filename, Math.max(record[0], bans.get(filename) ?? 0));
    }
  }
  return bans;
}

export function isFeedbackEvent(value: unknown): value is FeedbackEvent {
  if (!isRecord(value)) return false;
  const schemaVersion = value.schema_version ?? LEGACY_FEEDBACK_SCHEMA_VERSION;
  return (
    (schemaVersion === LEGACY_FEEDBACK_SCHEMA_VERSION ||
      schemaVersion === FEEDBACK_SCHEMA_VERSION) &&
    isInteger(value.revision) &&
    isInteger(value.timestamp) &&
    typeof value.filename === "string" &&
    Boolean(value.filename.trim()) &&
    typeof value.action === "string" &&
    FEEDBACK_ACTIONS.has(value.action)
  );
}

export function latestFeedbackByFilename(
  events: Iterable<unknown>,
): Map<string, FeedbackEvent> {
  const latest = new Map<string, FeedbackEvent>();
  for (const event of events) {
    if (!isFeedbackEvent(event)) continue;
    const existing = latest.get(event.filename);
    if (existing === undefined || event.revision >= existing.revision) {
      latest.set(event.filename, event);
    }
  }
  return latest;
}

function isExplicitKeep(event: FeedbackEvent | undefined): boolean {
  return event !== undefined && event.action === "keep";
}

export function hasExplicitPositiveFeedback(event: FeedbackEvent | undefined): boolean {
  return (
    event !== undefined &&
    (event.action === "favorite" || event.action === "unban" || event.action === "keep")
  );
}

function positiveLabelTimestamp(
  meta: Record<string, unknown>,
  event: FeedbackEvent | undefined,
  fallback: number,
): number {
  if (event !== undefined && hasExplicitPositiveFeedback(event)) {
    return Math.trunc(event.timestamp);
  }
  return metadataTimestamp(meta, fallback);
}

export interface FeedbackLedger {
  schema_version: number;
  revision: number;
  events: FeedbackEvent[];
}

export function loadPreferenceFeedback(config: ConfigOrDir): FeedbackLedger {
  const eventsByRevision = new Map<number, FeedbackEvent>();
  let declaredRevision = 0;

  const raw = readJson(legacyPreferenceFeedbackPath(config));
  if (isRecord(raw) && raw.schema_version === LEGACY_FEEDBACK_SCHEMA_VERSION) {
    if (isInteger(raw.revision) && raw.revision >= 0) declaredRevision = raw.revision;
    if (Array.isArray(raw.events)) {
      for (const event of raw.events) {
        if (!isFeedbackEvent(event)) continue;
        eventsByRevision.set(event.revision, {
          ...event,
          schema_version: event.schema_version ?? LEGACY_FEEDBACK_SCHEMA_VERSION,
          filename: path.basename(event.filename),
        });
      }
    }
  }

  let text: string | null = null;
  try {
    text = fs.readFileSync(preferenceFeedbackPath(config), "utf8");
  } catch {
    text = null;
  }
  if (text !== null) {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (isFeedbackEvent(event) && event.schema_version === FEEDBACK_SCHEMA_VERSION) {
        eventsByRevision.set(event.revision, { ...event, filename: path.basename(event.filename) });
        declaredRevision = Math.max(declaredRevision, event.revision);
      }
    }
  }

  const revisions = [...eventsByRevision.keys()].sort((left, right) => left - right);
  return {
    schema_version: FEEDBACK_SCHEMA_VERSION,
    revision: Math.max(declaredRevision, revisions.length ? revisions[revisions.length - 1] : 0),
    events: revisions.map((revision) => eventsByRevision.get(revision) as FeedbackEvent),
  };
}

function lastJsonlFeedbackRevision(filePath: string): number {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return 0;
  }
  try {
    let position = fs.fstatSync(fd).size;
    let suffix: Buffer = Buffer.alloc(0);
    while (position > 0) {
      const size = Math.min(64 * 1024, position);
      position -= size;
      const chunk = Buffer.alloc(size);
      fs.readSync(fd, chunk, 0, size, position);
      const combined = Buffer.concat([chunk, suffix]);
      const lines: Buffer[] = [];
      let start = 0;
      for (let index = 0; index < combined.length; index += 1) {
        if (combined[index] === 0x0a) {
          lines.push(combined.subarray(start, index));
          start = index + 1;
        }
      }
      lines.push(combined.subarray(start));
      if (position > 0) {
        suffix = Buffer.from(lines.shift() as Buffer);
      } else {
        suffix = Buffer.alloc(0);
      }
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const rawLine = lines[index].toString("utf8");
        if (!rawLine.trim()) continue;
        let event: unknown;
        try {
          event = JSON.parse(rawLine);
        } catch {
          continue;
        }
        if (isFeedbackEvent(event) && event.schema_version === FEEDBACK_SCHEMA_VERSION) {
          return event.revision;
        }
      }
    }
  } catch {
    return 0;
  } finally {
    fs.closeSync(fd);
  }
  return 0;
}

export function currentFeedbackRevision(config: ConfigOrDir): number {
  let legacyRevision = 0;
  const raw = readJson(legacyPreferenceFeedbackPath(config));
  if (isRecord(raw) && raw.schema_version === LEGACY_FEEDBACK_SCHEMA_VERSION) {
    if (isInteger(raw.revision) && raw.revision >= 0) legacyRevision = raw.revision;
  }
  return Math.max(legacyRevision, lastJsonlFeedbackRevision(preferenceFeedbackPath(config)));
}

function preferenceImageId(filename: string): string {
  const base = path.basename(filename);
  const stem = base.slice(0, base.length - path.extname(base).length);
  if (stem.startsWith("wallhaven-") && stem.length > "wallhaven-".length) {
    return `wallhaven:${stem.slice("wallhaven-".length)}`;
  }
  return `file:${base}`;
}

const MODEL_FEEDBACK_KEYS: ReadonlySet<string> = new Set([
  "schema_version",
  "feature_normalization",
  "trained_at",
  "threshold",
  "score",
  "feature_score",
  "decision_score",
  "semantic_score",
  "semantic_probability",
  "semantic_available",
  "neighbor_probability",
  "neighbor_available",
  "neighbor_count",
  "neighbor_dislike_count",
  "neighbor_keep_count",
  "neighbor_similarity_sum",
  "neighbor_max_similarity",
  "neighbor_exact_max_similarity",
  "neighbor_semantic_max_similarity",
  "neighbor_preference_gap",
  "probability",
  "calibrated",
  "percentile",
  "rank",
]);

function isJsonPrimitive(value: unknown): value is string | number | boolean {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" || typeof value === "boolean";
}

function cleanModelFeedback(model: unknown): Record<string, unknown> | null {
  if (!isRecord(model)) return null;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(model)) {
    if (MODEL_FEEDBACK_KEYS.has(key) && isJsonPrimitive(value)) clean[key] = value;
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

export interface RecordFeedbackOptions {
  source?: string;
  context?: string | null;
  model?: Record<string, unknown> | null;
  timestamp?: number | null;
}

export function appendPreferenceFeedback(
  config: ConfigOrDir,
  action: string,
  filename: string,
  options?: RecordFeedbackOptions,
): number {
  if (!FEEDBACK_ACTIONS.has(action)) {
    throw new Error(`Unsupported preference feedback action: ${action}`);
  }
  const cleanFilename = path.basename(filename);
  if (!cleanFilename) throw new Error("Preference feedback needs a filename");
  const source = options?.source ?? "user";
  const revision = currentFeedbackRevision(config) + 1;
  const event: Record<string, unknown> = {
    schema_version: FEEDBACK_SCHEMA_VERSION,
    revision,
    timestamp:
      options?.timestamp === null || options?.timestamp === undefined
        ? nowSeconds()
        : Math.trunc(options.timestamp),
    image_id: preferenceImageId(cleanFilename),
    filename: cleanFilename,
    action,
    source,
    context: options?.context || source,
    explicit: action !== "unfavorite",
  };
  const cleanModel = cleanModelFeedback(options?.model);
  if (cleanModel !== null) event.model = cleanModel;

  const filePath = preferenceFeedbackPath(config);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let needsSeparator = false;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      if (size > 0) {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        needsSeparator = last[0] !== 0x0a;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    needsSeparator = false;
  }
  const fd = fs.openSync(filePath, "a");
  try {
    fs.writeSync(fd, `${needsSeparator ? "\n" : ""}${JSON.stringify(event)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return revision;
}

export async function recordPreferenceFeedback(
  config: ConfigOrDir,
  action: string,
  filename: string,
  options?: RecordFeedbackOptions & { alreadyLocked?: boolean },
): Promise<number> {
  if (options?.alreadyLocked) {
    return appendPreferenceFeedback(config, action, filename, options);
  }
  return withFileLock(getDefaultLockPath(), () =>
    appendPreferenceFeedback(config, action, filename, options),
  );
}

async function bootstrapHistoricalPreferenceBans(config: ConfigOrDir): Promise<number> {
  return withFileLock(getDefaultLockPath(), () => {
    const historical = loadPreferenceHistoricalBans(config);
    const latestFeedback = latestFeedbackByFilename(loadPreferenceFeedback(config).events);
    const neutralFilters = neutralFilterProvider(config);
    let changed = false;
    for (const { timestamp, filename: rawFilename } of listBlacklist(config)) {
      const filename = path.basename(rawFilename);
      if (!filename || latestFeedback.has(filename) || neutralFilters.has(filename)) continue;
      if (timestamp > (historical.get(filename) ?? 0)) {
        historical.set(filename, timestamp);
        changed = true;
      }
    }
    if (changed) {
      const bans = [...historical.entries()]
        .sort((left, right) => compareStrings(left[0], right[0]))
        .map(([filename, timestamp]) => [timestamp, filename]);
      atomicWrite(
        preferenceHistoricalBansPath(config),
        `${JSON.stringify({ schema_version: HISTORICAL_BAN_SCHEMA_VERSION, bans }, null, 2)}\n`,
      );
    }
    return historical.size;
  });
}

type FileVersion = string | null;

function fileVersion(filePath: string): FileVersion {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    return `${stat.mtimeNs}:${stat.size}:${stat.ino}`;
  } catch {
    return null;
  }
}

const MODEL_CACHE_LIMIT = 8;
const modelCache = new Map<string, { version: string; model: PreferenceModel | null }>();

export function savePreferenceModelUnlocked(model: PreferenceModel, modelPath: string): void {
  atomicWrite(modelPath, `${JSON.stringify(model.toDict())}\n`);
}

export async function savePreferenceModel(model: PreferenceModel, modelPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(modelPath), { recursive: true });
  await withFileLock(preferenceModelLockPath(modelPath), () =>
    savePreferenceModelUnlocked(model, modelPath),
  );
}

export function loadPreferenceModel(modelPath: string): PreferenceModel | null {
  const cacheKey = path.resolve(modelPath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const version = fileVersion(modelPath);
    if (version === null) {
      modelCache.delete(cacheKey);
      return null;
    }
    const cached = modelCache.get(cacheKey);
    if (cached !== undefined && cached.version === version) return cached.model;
    let model: PreferenceModel | null;
    try {
      model = PreferenceModel.fromDict(JSON.parse(fs.readFileSync(modelPath, "utf8")));
    } catch {
      model = null;
    }
    if (fileVersion(modelPath) !== version) continue;
    modelCache.delete(cacheKey);
    modelCache.set(cacheKey, { version, model });
    while (modelCache.size > MODEL_CACHE_LIMIT) {
      modelCache.delete(modelCache.keys().next().value as string);
    }
    return model;
  }
  return null;
}

export function isCuratedPreferenceFeedback(event: unknown): boolean {
  if (!isRecord(event)) return false;
  if (event.action === "dislike" || event.action === "favorite") return true;
  if (event.action !== "ban" && event.action !== "keep") return false;
  return (
    event.context === "model_review" ||
    event.source === "model_review" ||
    event.source === "model_suggestion"
  );
}

function curatedPreferenceLabels(events: Iterable<unknown>): Map<string, [string, number]> {
  const ordered = [...events]
    .filter(isFeedbackEvent)
    .sort((left, right) => left.revision - right.revision);
  const labels = new Map<string, [string, number]>();
  for (const event of ordered) {
    const filename = event.filename;
    const current = labels.get(filename)?.[0];
    if (isCuratedPreferenceFeedback(event)) {
      labels.set(filename, [event.action, event.timestamp]);
    } else if (event.action === "unban" && (current === "ban" || current === "dislike")) {
      labels.delete(filename);
    } else if (event.action === "unfavorite" && (current === "favorite" || current === "keep")) {
      labels.delete(filename);
    }
  }
  return labels;
}

function metadataTags(meta: Record<string, unknown>): string[] {
  const raw = meta.tags ?? [];
  return modelTags(Array.isArray(raw) || typeof raw === "string" ? raw : []);
}

function buildCuratedPreferenceExamples(
  metadata: Metadata,
  feedbackEvents: readonly unknown[],
  options: {
    favorites: ReadonlySet<string>;
    now: number;
    favoriteWeight: number;
    recencyHalfLifeDays: number;
  },
): PreferenceExample[] {
  const labels = curatedPreferenceLabels(feedbackEvents);
  const latestFeedback = latestFeedbackByFilename(feedbackEvents);
  for (const filename of options.favorites) {
    const meta = metadata[filename];
    if (!isRecord(meta)) continue;
    labels.set(filename, [
      "favorite",
      positiveLabelTimestamp(meta, latestFeedback.get(filename), options.now),
    ]);
  }
  const examples: PreferenceExample[] = [];
  const ordered = [...labels.entries()].sort((left, right) => compareStrings(left[0], right[0]));
  for (const [filename, [action, timestamp]] of ordered) {
    const meta = metadata[filename];
    if (!isRecord(meta)) continue;
    const tags = metadataTags(meta);
    if (tags.length === 0) continue;
    const contextFeatures = modelContextFeatures(meta);
    const semanticTags = semanticTagItems(tags, meta);
    if (action === "ban" || action === "dislike") {
      examples.push(
        makeExample({
          filename,
          tags,
          label: 1,
          base_weight: recencyWeight(timestamp, options.now, options.recencyHalfLifeDays),
          timestamp,
          context_features: contextFeatures,
          temporal_label_known: true,
          is_explicit_ban: true,
          semantic_tags: semanticTags,
        }),
      );
    } else {
      examples.push(
        makeExample({
          filename,
          tags,
          label: 0,
          base_weight: options.favoriteWeight,
          timestamp,
          context_features: contextFeatures,
          temporal_label_known: true,
          is_favorite: options.favorites.has(filename),
          is_explicit_keep: true,
          semantic_tags: semanticTags,
        }),
      );
    }
  }
  return examples;
}

export interface BuildTrainingExamplesOptions {
  historicalBans?: Iterable<readonly [number, string]>;
  feedbackEvents?: readonly unknown[];
  now?: number;
  favoriteWeight?: number;
  recencyHalfLifeDays?: number;
  reviewOnly?: boolean;
}

export function buildTrainingExamples(
  metadata: Metadata,
  blacklistEntries: Iterable<readonly [number, string]>,
  favorites: ReadonlySet<string>,
  retainedFiles: ReadonlySet<string> | null,
  options?: BuildTrainingExamplesOptions,
): PreferenceExample[] {
  const now = options?.now ?? nowSeconds();
  const favoriteWeight = options?.favoriteWeight ?? DEFAULT_FAVORITE_WEIGHT;
  const recencyHalfLifeDays = options?.recencyHalfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS;
  const feedbackEvents = options?.feedbackEvents ?? [];
  if (options?.reviewOnly) {
    return buildCuratedPreferenceExamples(metadata, feedbackEvents, {
      favorites,
      now,
      favoriteWeight,
      recencyHalfLifeDays,
    });
  }
  const hasMeta = (filename: string): boolean =>
    Object.prototype.hasOwnProperty.call(metadata, filename);
  const latestBans = new Map<string, number>();
  for (const entries of [blacklistEntries, options?.historicalBans ?? []]) {
    for (const [timestamp, filename] of entries) {
      if (hasMeta(filename)) {
        latestBans.set(filename, Math.max(timestamp, latestBans.get(filename) ?? 0));
      }
    }
  }

  const latestFeedback = latestFeedbackByFilename(feedbackEvents);
  for (const [filename, feedback] of latestFeedback) {
    if (!hasMeta(filename)) continue;
    if (feedback.action === "ban" || feedback.action === "dislike") {
      latestBans.set(filename, Math.trunc(feedback.timestamp));
    } else {
      latestBans.delete(filename);
    }
  }

  const filenames = Object.keys(metadata).sort(compareStrings);
  const retained = new Set<string>();
  if (retainedFiles === null) {
    for (const filename of filenames) {
      if (!latestBans.has(filename)) retained.add(filename);
    }
  } else {
    for (const filename of retainedFiles) {
      if (hasMeta(filename)) retained.add(filename);
    }
  }

  const examples: PreferenceExample[] = [];
  for (const filename of filenames) {
    const meta = metadata[filename];
    if (!isRecord(meta)) continue;
    const tags = metadataTags(meta);
    if (tags.length === 0) continue;
    const contextFeatures = modelContextFeatures(meta);
    const semanticTags = semanticTagItems(tags, meta);
    const feedback = latestFeedback.get(filename);
    const isExplicitBan =
      feedback !== undefined && (feedback.action === "ban" || feedback.action === "dislike");
    const banTimestamp = latestBans.get(filename);
    if (banTimestamp !== undefined) {
      examples.push(
        makeExample({
          filename,
          tags,
          label: 1,
          base_weight: recencyWeight(banTimestamp, now, recencyHalfLifeDays),
          timestamp: banTimestamp,
          context_features: contextFeatures,
          temporal_label_known: true,
          is_explicit_ban: isExplicitBan,
          semantic_tags: semanticTags,
        }),
      );
    } else if (retained.has(filename)) {
      const isFavorite = favorites.has(filename);
      const explicitPositive = isFavorite || hasExplicitPositiveFeedback(feedback);
      examples.push(
        makeExample({
          filename,
          tags,
          label: 0,
          base_weight: explicitPositive ? favoriteWeight : 1.0,
          timestamp: positiveLabelTimestamp(meta, feedback, now),
          context_features: contextFeatures,
          is_favorite: isFavorite,
          is_explicit_keep: isFavorite || isExplicitKeep(feedback),
          is_control: !explicitPositive,
          temporal_label_known: hasExplicitPositiveFeedback(feedback),
          semantic_tags: semanticTags,
        }),
      );
    }
  }
  return examples;
}

export function libraryFilenames(config: ConfigOrDir): {
  favorites: Set<string>;
  retained: Set<string>;
} {
  const downloadDir = downloadDirOf(config);
  const favorites = new Set<string>();
  const retained = new Set<string>();
  for (const purity of ALL_PURITIES) {
    for (const orientation of ALL_ORIENTATIONS) {
      for (const image of listImagesInDir(poolDir(downloadDir, purity, orientation))) {
        const filename = path.basename(image);
        if (!isBlacklisted(config, filename)) {
          retained.add(filename);
        }
      }
      for (const image of listImagesInDir(favoritesDir(downloadDir, purity, orientation))) {
        const name = path.basename(image);
        if (!isBlacklisted(config, name)) {
          retained.add(name);
          favorites.add(name);
        }
      }
    }
  }
  return { favorites, retained };
}

export function collectPreferenceTrainingSnapshot(config: ConfigOrDir): PreferenceTrainingSnapshot {
  const metadata = loadMetadata(config) as Metadata;
  const { favorites, retained } = libraryFilenames(config);
  const feedback = loadPreferenceFeedback(config);
  const historicalBans = loadPreferenceHistoricalBans(config);
  const neutralFilters = neutralFilterProvider(config);
  const blacklistEntries = listBlacklist(config)
    .filter((entry) => !neutralFilters.has(path.basename(entry.filename)))
    .map((entry): [number, string] => [entry.timestamp, entry.filename]);
  const snapshotNow = Math.floor(Date.now() / 1000 / 86400) * 86400;
  const legacyExamples = buildTrainingExamples(metadata, blacklistEntries, favorites, retained, {
    historicalBans: [...historicalBans.entries()]
      .filter(([filename]) => !neutralFilters.has(filename))
      .map(([filename, timestamp]): [number, string] => [timestamp, filename]),
    feedbackEvents: feedback.events,
    now: snapshotNow,
  });
  const curatedExamples = buildTrainingExamples(metadata, [], favorites, new Set(), {
    feedbackEvents: feedback.events,
    now: snapshotNow,
    reviewOnly: true,
  });
  const hasCuratedFeedback =
    favorites.size > 0 || feedback.events.some((event) => isCuratedPreferenceFeedback(event));
  const curatedReady = hasBothClasses(curatedExamples, MIN_TRAINING_PER_CLASS);
  const useCurated = hasCuratedFeedback && curatedReady;
  const examples = useCurated ? curatedExamples : legacyExamples;
  let favoriteMetadataFiles = 0;
  for (const filename of favorites) {
    const meta = metadata[filename];
    if (isRecord(meta) && Array.isArray(meta.tags) && meta.tags.length > 0) {
      favoriteMetadataFiles += 1;
    }
  }
  return {
    examples,
    feedback_revision: feedback.revision,
    data_signature: trainingDataSignature(examples),
    favorite_files: favorites.size,
    label_source: useCurated ? "model_review" : "legacy",
    favorite_metadata_files: favoriteMetadataFiles,
  };
}

export interface TrainLocalOptions {
  comboMinSupport?: number;
  maxComboFeatures?: number;
  epochs?: number;
  retrainMode?: string;
  semanticModel?: string | null;
}

function applySnapshotSummary(model: PreferenceModel, snapshot: PreferenceTrainingSnapshot): void {
  model.training_summary.favorite_files = snapshot.favorite_files;
  model.training_summary.favorite_metadata_files = snapshot.favorite_metadata_files;
  model.training_summary.favorites_without_usable_metadata = Math.max(
    0,
    snapshot.favorite_files - snapshot.favorite_metadata_files,
  );
}

export async function trainLocalPreferenceModel(
  config: ConfigOrDir,
  options?: TrainLocalOptions,
): Promise<[PreferenceModel, PreferenceTrainingSnapshot]> {
  await bootstrapHistoricalPreferenceBans(config);
  const snapshot = collectPreferenceTrainingSnapshot(config);
  const model = await trainPreferenceModel(snapshot.examples, {
    comboMinSupport: options?.comboMinSupport ?? DEFAULT_COMBO_MIN_SUPPORT,
    maxComboFeatures: options?.maxComboFeatures ?? DEFAULT_MAX_COMBO_FEATURES,
    epochs: options?.epochs ?? DEFAULT_EPOCHS,
    feedbackRevision: snapshot.feedback_revision,
    retrainMode: options?.retrainMode ?? "manual",
    semanticModel:
      options?.semanticModel === undefined ? DEFAULT_SEMANTIC_MODEL : options.semanticModel,
    labelSource: snapshot.label_source,
  });
  applySnapshotSummary(model, snapshot);
  return [model, snapshot];
}

function trainingStateToken(config: ConfigOrDir): string {
  const downloadDir = downloadDirOf(config);
  const paths = [
    path.join(downloadDir, ".metadata.json"),
    path.join(downloadDir, ".blacklist"),
    legacyPreferenceFeedbackPath(config),
    preferenceFeedbackPath(config),
    modelReviewFilePath(config),
    preferenceHistoricalBansPath(config),
  ];
  for (const purity of ALL_PURITIES) {
    for (const orientation of ALL_ORIENTATIONS) {
      paths.push(
        poolDir(downloadDir, purity, orientation),
        favoritesDir(downloadDir, purity, orientation),
      );
    }
  }
  return [Math.floor(Date.now() / 1000 / 86400), ...paths.map(fileVersion)].join("|");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function automaticFitIsCurrent(
  currentModel: PreferenceModel | null,
  model: PreferenceModel,
  snapshot: PreferenceTrainingSnapshot,
): boolean {
  const currentSummary = currentModel?.training_summary ?? {};
  const currentCalibration = currentSummary.decision_calibration;
  const decisionBoundaryCurrent =
    isFiniteNumber(currentSummary.decision_threshold) &&
    isRecord(currentCalibration) &&
    currentCalibration.version === DECISION_CALIBRATION_VERSION;
  const newCalibration = model.training_summary.decision_calibration;
  const tally = (values: boolean[]): number => values.filter(Boolean).length;
  const currentReadiness = tally([
    decisionBoundaryCurrent,
    Boolean(currentModel?.semanticEnabled),
    Boolean(currentModel?.neighborHeadReady),
    isRecord(currentCalibration) && currentCalibration.available === true,
  ]);
  const newReadiness = tally([
    model.semanticEnabled,
    model.neighborHeadReady,
    isRecord(newCalibration) && newCalibration.version === DECISION_CALIBRATION_VERSION,
    isRecord(newCalibration) && newCalibration.available === true,
  ]);
  return (
    currentModel !== null &&
    currentModel.schema_version === MODEL_SCHEMA_VERSION &&
    !isLegacySemanticModel(currentModel.semantic_model) &&
    currentSummary.training_data_signature === snapshot.data_signature &&
    (currentSummary.label_source ?? "legacy") === snapshot.label_source &&
    decisionBoundaryCurrent &&
    currentReadiness >= newReadiness
  );
}

async function commitPreferenceModel(
  config: ConfigOrDir,
  model: PreferenceModel,
  snapshot: PreferenceTrainingSnapshot,
  automatic: boolean,
): Promise<boolean> {
  const modelPath = preferenceModelPath(config);
  fs.mkdirSync(path.dirname(modelPath), { recursive: true });
  return withFileLock(
    preferenceModelLockPath(modelPath),
    async () => {
      const token = trainingStateToken(config);
      const currentModel = loadPreferenceModel(modelPath);
      const current = collectPreferenceTrainingSnapshot(config);
      if (
        current.data_signature !== snapshot.data_signature ||
        current.label_source !== snapshot.label_source
      ) {
        return false;
      }
      const preserveExisting = automatic && automaticFitIsCurrent(currentModel, model, current);
      const payload = preserveExisting ? null : `${JSON.stringify(model.toDict())}\n`;
      return withFileLock(metadataLockPath(config), () =>
        withFileLock(getDefaultLockPath(), () => {
          if (trainingStateToken(config) !== token) return false;
          if (payload !== null) atomicWrite(modelPath, payload);
          return true;
        }),
      );
    },
    { timeoutMs: 60_000 },
  );
}

export async function trainAndSaveLocalPreferenceModel(
  config: ConfigOrDir,
  options?: Omit<TrainLocalOptions, "retrainMode">,
): Promise<[PreferenceModel, PreferenceTrainingSnapshot]> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const [model, snapshot] = await trainLocalPreferenceModel(config, {
      ...options,
      retrainMode: "manual",
    });
    if (await commitPreferenceModel(config, model, snapshot, false)) {
      return [model, snapshot];
    }
  }
  throw new Error("Wallpaper labels changed while training; please run model train again");
}

export function modelReport(
  model: PreferenceModel,
  modelPath?: string | null,
  learning?: Record<string, unknown> | null,
): Record<string, unknown> {
  const training: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(model.training_summary)) {
    if (key !== "example_ids" && key !== "working_example_ids") training[key] = value;
  }
  const report: Record<string, unknown> = {
    schema_version: model.schema_version,
    feature_normalization: model.feature_normalization,
    trained_at: model.trained_at,
    tag_features: Object.keys(model.tag_weights).length,
    combo_features: Object.keys(model.combo_weights).length,
    context_features: Object.keys(model.context_weights).length,
    neighbor_head_ready: model.neighborHeadReady,
    neighbor_k: model.neighbor_k,
    neighbor_min_similarity: DEFAULT_NEIGHBOR_MIN_SIMILARITY,
    neighbor_prototypes: model.neighbor_prototypes.length,
    neighbor_dislikes: model.neighbor_prototypes.filter((prototype) => prototype.label === 1)
      .length,
    neighbor_keeps: model.neighbor_prototypes.filter((prototype) => prototype.label === 0).length,
    semantic_enabled: model.semanticEnabled,
    semantic_model: model.semantic_model || null,
    semantic_dimension: model.semantic_weights.length || null,
    semantic_blend: model.semanticEnabled ? model.semantic_blend : null,
    semantic_neighbor_vote_weight:
      model.neighborHeadReady && model.semanticEnabled ? preferenceNeighborVoteWeight(model) : null,
    decision_threshold: preferenceDecisionThreshold(model),
    decision_calibration: model.training_summary.decision_calibration ?? null,
    decision_strategy: "two_stage_tag_semantic_knn",
    label_source: model.training_summary.label_source ?? "legacy",
    training,
    validation: model.training_summary.decision_calibration ?? null,
  };
  if (modelPath) {
    try {
      report.size_bytes = fs.statSync(modelPath).size;
      report.path = modelPath;
    } catch {
      // The model file can disappear between loading and reporting.
    }
  }
  if (learning !== undefined && learning !== null) report.learning = learning;
  return report;
}

function modelRuntimeCurrent(model: PreferenceModel): boolean {
  return (
    model.schema_version === MODEL_SCHEMA_VERSION && !isLegacySemanticModel(model.semantic_model)
  );
}

export function modelDecisionReady(model: PreferenceModel): boolean {
  const calibration = model.training_summary.decision_calibration;
  return (
    modelRuntimeCurrent(model) &&
    model.semanticEnabled &&
    model.neighborHeadReady &&
    isRecord(calibration) &&
    calibration.available === true &&
    calibration.version === DECISION_CALIBRATION_VERSION
  );
}

export function autoFilterStatus(
  config: ConfigOrDir,
  model?: PreferenceModel | null,
): Record<string, unknown> {
  const modelPath = preferenceModelPath(config);
  const resolved = model ?? loadPreferenceModel(modelPath);
  if (resolved === null) {
    return {
      status: "untrained",
      ready: false,
      reason: "Train a preference model and review enough candidates first.",
      threshold: null,
      model: null,
    };
  }
  const calibration = resolved.training_summary.decision_calibration;
  const schemaReady = modelRuntimeCurrent(resolved);
  const ready = modelDecisionReady(resolved);
  let status: string;
  let reason: string;
  if (ready) {
    status = "ready";
    reason = "Model filtering is active. Likely blocks are held for your review.";
  } else if (schemaReady) {
    status = "calibration_pending";
    reason =
      isRecord(calibration) && calibration.version !== DECISION_CALIBRATION_VERSION
        ? "Refreshing the model's automatic boundary after the ranking upgrade."
        : "More Keep/Dislike decisions are needed before accurate model filtering can start.";
  } else {
    status = "upgrade_pending";
    reason = "Retrain the local model before using it to filter new downloads.";
  }
  return {
    status,
    ready,
    reason,
    threshold: preferenceDecisionThreshold(resolved),
    threshold_kind: "two_stage_tag_semantic_probability",
    decision_calibration: calibration ?? null,
    model: modelReport(resolved, modelPath),
  };
}

export function autoFilterMetadata(metadata: Record<string, unknown>): {
  tags: unknown[];
  metadata: Record<string, unknown>;
} {
  const rawTags = metadata.tags ?? [];
  let tags: unknown[];
  if (typeof rawTags === "string") {
    tags = [rawTags];
  } else if (Array.isArray(rawTags) || rawTags instanceof Set) {
    tags = [...(rawTags as Iterable<unknown>)].map((tag) =>
      isRecord(tag) ? (tag.name ?? "") : tag,
    );
  } else {
    tags = [];
  }
  const modelMetadata: Record<string, unknown> = { ...metadata, tags };
  if (isRecord(modelMetadata.uploader)) {
    modelMetadata.uploader = modelMetadata.uploader.username ?? "";
  }
  return { tags, metadata: modelMetadata };
}

export async function prefetchModelEmbeddings(
  model: PreferenceModel,
  records: Iterable<[Iterable<unknown> | null | undefined, Record<string, unknown> | null | undefined, Iterable<unknown> | string | null | undefined]>,
): Promise<void> {
  if (!model.semanticEnabled || !model.neighborHeadReady) return;
  if (isLegacySemanticModel(model.semantic_model)) return;
  try {
    await prefetchEmbeddings(model.embeddingTexts(records), model.semantic_model);
  } catch {
    // Scoring fails open when the embedding runtime is unavailable.
  }
}

export interface AutoFilterBatchItemResult {
  hit: boolean;
  prediction: Record<string, unknown>;
  decision_score: number;
}

export async function autoFilterBatchPredictions(
  model: PreferenceModel,
  items: ReadonlyArray<{ key: string; metadata: Record<string, unknown> }>,
): Promise<Record<string, AutoFilterBatchItemResult>> {
  if (items.length === 0) return {};
  const prepared = items.map((entry) => ({
    key: entry.key,
    ...autoFilterMetadata(entry.metadata),
  }));
  await prefetchModelEmbeddings(
    model,
    prepared.map((entry): [unknown[], Record<string, unknown>, null] => [
      entry.tags,
      entry.metadata,
      null,
    ]),
  );
  const current = modelRuntimeCurrent(model);
  const out: Record<string, AutoFilterBatchItemResult> = {};
  for (const entry of prepared) {
    const prediction = model.predict(entry.tags, { metadata: entry.metadata, topN: 12 });
    out[entry.key] = {
      hit: current && preferenceCandidate(model, prediction),
      prediction: predictionToDict(prediction),
      decision_score: preferenceDecisionScore(model, prediction),
    };
  }
  return out;
}

export async function autoFilterPrediction(
  model: PreferenceModel,
  metadata: Record<string, unknown>,
): Promise<[boolean, PreferencePrediction]> {
  const prepared = autoFilterMetadata(metadata);
  await prefetchModelEmbeddings(model, [[prepared.tags, prepared.metadata, null]]);
  const prediction = model.predict(prepared.tags, { metadata: prepared.metadata, topN: 12 });
  return [modelRuntimeCurrent(model) && preferenceCandidate(model, prediction), prediction];
}

export function preferenceLearningStatus(
  config: ConfigOrDir,
  model?: PreferenceModel | null,
  snapshot?: PreferenceTrainingSnapshot | null,
): Record<string, unknown> {
  const resolvedModel =
    model === undefined ? loadPreferenceModel(preferenceModelPath(config)) : model;
  const resolvedSnapshot = snapshot ?? collectPreferenceTrainingSnapshot(config);
  const bannedExamples = resolvedSnapshot.examples.filter((example) => example.label === 1).length;
  const retainedExamples = resolvedSnapshot.examples.filter((example) => example.label === 0).length;
  const trainingReady =
    bannedExamples >= MIN_TRAINING_PER_CLASS && retainedExamples >= MIN_TRAINING_PER_CLASS;
  if (resolvedModel === null) {
    return {
      status: "untrained",
      stale: true,
      label_source: resolvedSnapshot.label_source,
      label_source_changed: false,
      pending_feedback: resolvedSnapshot.feedback_revision,
      changed_examples: resolvedSnapshot.examples.length,
      weight_refresh_due: false,
      minimum_feedback: AUTO_RETRAIN_MIN_FEEDBACK,
      minimum_per_class: MIN_TRAINING_PER_CLASS,
      banned_examples: bannedExamples,
      retained_examples: retainedExamples,
      training_ready: trainingReady,
      due: trainingReady,
    };
  }

  const summary = resolvedModel.training_summary;
  const labelSourceChanged = (summary.label_source ?? "legacy") !== resolvedSnapshot.label_source;
  const calibration = summary.decision_calibration;
  const decisionBoundaryUpgradeDue =
    !isFiniteNumber(summary.decision_threshold) ||
    !isRecord(calibration) ||
    calibration.version !== DECISION_CALIBRATION_VERSION;
  const semanticHeadUpgradeDue =
    !resolvedModel.semanticEnabled ||
    !resolvedModel.neighborHeadReady ||
    isLegacySemanticModel(resolvedModel.semantic_model);
  const upgradeDue =
    resolvedModel.schema_version !== MODEL_SCHEMA_VERSION ||
    resolvedModel.feature_normalization !== DEFAULT_FEATURE_NORMALIZATION ||
    labelSourceChanged ||
    decisionBoundaryUpgradeDue ||
    semanticHeadUpgradeDue;
  const previousRevision = isInteger(summary.feedback_revision) ? summary.feedback_revision : 0;
  const storedSignature = summary.training_data_signature;
  const stale =
    upgradeDue ||
    typeof storedSignature !== "string" ||
    storedSignature !== resolvedSnapshot.data_signature;
  const storedIds = summary.working_example_ids;
  let changedExamples: number;
  if (Array.isArray(storedIds)) {
    const stored = new Set(storedIds.map((item) => String(item)));
    const current = new Set(
      trainingExampleIds(
        selectPreferenceExamples(resolvedSnapshot.examples, {
          limit: DEFAULT_TRAINING_MAX_EXAMPLES,
        }),
      ),
    );
    changedExamples = 0;
    for (const id of stored) if (!current.has(id)) changedExamples += 1;
    for (const id of current) if (!stored.has(id)) changedExamples += 1;
  } else {
    changedExamples = stale ? resolvedSnapshot.examples.length : 0;
  }
  const pendingFeedback = Math.max(0, resolvedSnapshot.feedback_revision - previousRevision);
  const weightRefreshDue = stale && Array.isArray(storedIds) && changedExamples === 0;
  return {
    status: upgradeDue ? "upgrade_pending" : "ready",
    stale,
    upgrade_due: upgradeDue,
    label_source: resolvedSnapshot.label_source,
    label_source_changed: labelSourceChanged,
    decision_boundary_upgrade_due: decisionBoundaryUpgradeDue,
    semantic_head_upgrade_due: semanticHeadUpgradeDue,
    pending_feedback: pendingFeedback,
    changed_examples: changedExamples,
    weight_refresh_due: weightRefreshDue,
    minimum_feedback: AUTO_RETRAIN_MIN_FEEDBACK,
    minimum_per_class: MIN_TRAINING_PER_CLASS,
    banned_examples: bannedExamples,
    retained_examples: retainedExamples,
    training_ready: trainingReady,
    due:
      trainingReady &&
      (upgradeDue ||
        (stale &&
          (pendingFeedback >= AUTO_RETRAIN_MIN_FEEDBACK ||
            changedExamples >= AUTO_RETRAIN_MIN_CHANGED_EXAMPLES ||
            weightRefreshDue))),
  };
}

interface RetrainLease {
  token: string;
  created_at: number;
  requested_at?: number;
  pid?: number | null;
  [key: string]: unknown;
}

function retrainLeasePath(config: ConfigOrDir): string {
  return path.join(downloadDirOf(config), ".preference_retrain.worker.json");
}

function retrainLeaseLockPath(config: ConfigOrDir): string {
  return path.join(downloadDirOf(config), ".preference_retrain.worker.lock");
}

function readRetrainLease(config: ConfigOrDir): RetrainLease | null {
  const value = readJson(retrainLeasePath(config));
  if (!isRecord(value) || typeof value.token !== "string") return null;
  if (typeof value.created_at !== "number") return null;
  return value as RetrainLease;
}

function retrainLeaseIsStale(lease: RetrainLease, now: number): boolean {
  const lastActivity = typeof lease.requested_at === "number" ? lease.requested_at : lease.created_at;
  if (isInteger(lease.pid) && lease.pid > 0) {
    if (!isPidAlive(lease.pid)) return true;
    return now - lastActivity > AUTO_RETRAIN_WORKER_STALE_SECONDS;
  }
  return now - lastActivity > Math.max(AUTO_RETRAIN_DELAY_SECONDS * 2, 10);
}

function writeRetrainLease(config: ConfigOrDir, lease: RetrainLease): void {
  atomicWrite(retrainLeasePath(config), `${JSON.stringify(lease)}\n`);
}

async function claimOrTouchRetrainWorker(config: ConfigOrDir): Promise<string | null> {
  const now = Date.now() / 1000;
  return withFileLock(retrainLeaseLockPath(config), () => {
    const lease = readRetrainLease(config);
    if (lease !== null && !retrainLeaseIsStale(lease, now)) {
      lease.requested_at = now;
      writeRetrainLease(config, lease);
      return null;
    }
    try {
      fs.rmSync(retrainLeasePath(config), { force: true });
    } catch {
      return null;
    }
    const token = crypto.randomBytes(16).toString("hex");
    writeRetrainLease(config, { token, created_at: now, requested_at: now, pid: null });
    return token;
  });
}

async function setRetrainWorkerPid(config: ConfigOrDir, token: string, pid: number): Promise<void> {
  if (pid <= 0) return;
  await withFileLock(retrainLeaseLockPath(config), () => {
    const lease = readRetrainLease(config);
    if (lease === null || lease.token !== token) return;
    lease.pid = pid;
    writeRetrainLease(config, lease);
  });
}

export async function releaseRetrainWorker(config: ConfigOrDir, token: string): Promise<void> {
  await withFileLock(retrainLeaseLockPath(config), () => {
    const lease = readRetrainLease(config);
    if (lease === null || lease.token !== token) return;
    try {
      fs.rmSync(retrainLeasePath(config), { force: true });
    } catch {
      // A later worker can clear a lease that could not be removed here.
    }
  });
}

let cliEntryPath: string | null = null;

export function setCliEntryPath(entryPath: string | null): void {
  cliEntryPath = entryPath;
}

export function getCliEntryPath(): string | null {
  return cliEntryPath ?? process.env.WAYPER_CLI_ENTRY ?? null;
}

type RetrainSpawner = (downloadDir: string, token: string) => number | null;

function defaultRetrainSpawner(downloadDir: string, token: string): number | null {
  const entry = getCliEntryPath();
  if (!entry) throw new Error("Wayper CLI entry is not configured");
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
  const child = spawn(
    process.execPath,
    [entry, "model", "refresh", "--download-dir", path.resolve(downloadDir), "--lease-token", token],
    { detached: true, stdio: "ignore", windowsHide: true, env },
  );
  child.on("error", () => undefined);
  child.unref();
  return child.pid ?? null;
}

let retrainSpawner: RetrainSpawner = defaultRetrainSpawner;

export function setRetrainSpawner(spawner: RetrainSpawner | null): void {
  retrainSpawner = spawner ?? defaultRetrainSpawner;
}

function hasPendingFeedbackRefresh(config: ConfigOrDir): boolean {
  const model = loadPreferenceModel(preferenceModelPath(config));
  if (model === null) return false;
  const previous = model.training_summary.feedback_revision;
  const previousRevision = isInteger(previous) ? previous : 0;
  return currentFeedbackRevision(config) - previousRevision >= AUTO_RETRAIN_MIN_FEEDBACK;
}

export async function schedulePreferenceModelRetrain(
  config: ConfigOrDir,
  options?: { force?: boolean },
): Promise<void> {
  const force = options?.force ?? false;
  const model = loadPreferenceModel(preferenceModelPath(config));
  if (model === null) {
    if (!force && currentFeedbackRevision(config) < AUTO_RETRAIN_MIN_FEEDBACK) return;
    const snapshot = collectPreferenceTrainingSnapshot(config);
    if (!hasBothClasses(snapshot.examples, MIN_TRAINING_PER_CLASS)) return;
  } else if (!force && !hasPendingFeedbackRefresh(config)) {
    return;
  }
  const token = await claimOrTouchRetrainWorker(config);
  if (token === null) return;
  try {
    const pid = retrainSpawner(downloadDirOf(config), token);
    if (pid !== null) await setRetrainWorkerPid(config, token, pid);
  } catch {
    await releaseRetrainWorker(config, token);
  }
}

export async function waitForRetrainQuiet(
  config: ConfigOrDir,
  token: string,
  delaySeconds: number,
  signal?: AbortSignal,
): Promise<boolean> {
  for (;;) {
    if (signal?.aborted) return false;
    const lease = readRetrainLease(config);
    if (lease === null || lease.token !== token) return false;
    const requestedAt = lease.requested_at ?? lease.created_at;
    if (typeof requestedAt !== "number") return false;
    const remaining = delaySeconds - (Date.now() / 1000 - requestedAt);
    if (remaining <= 0) return true;
    await new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(done, Math.min(remaining, 1.0) * 1000);
      function done(): void {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}

export async function runAutoRetrain(config: ConfigOrDir): Promise<"settled" | "retry" | "failed"> {
  const model = loadPreferenceModel(preferenceModelPath(config));
  try {
    await bootstrapHistoricalPreferenceBans(config);
    const snapshot = collectPreferenceTrainingSnapshot(config);
    const learning = preferenceLearningStatus(config, model, snapshot);
    if (!learning.due) return "settled";
    const storedEpochs = model?.training_summary.epochs;
    const epochs = isInteger(storedEpochs) ? storedEpochs : DEFAULT_EPOCHS;
    const upgrading = model === null || Boolean(learning.upgrade_due);
    let semanticModel = DEFAULT_SEMANTIC_MODEL;
    if (model !== null && model.semantic_model && !isLegacySemanticModel(model.semantic_model)) {
      semanticModel = model.semantic_model;
    }
    const refreshed = await trainPreferenceModel(snapshot.examples, {
      comboMinSupport:
        upgrading || model === null ? DEFAULT_COMBO_MIN_SUPPORT : model.combo_min_support,
      maxComboFeatures:
        upgrading || model === null ? DEFAULT_MAX_COMBO_FEATURES : model.max_combo_features,
      epochs: Math.max(1, epochs),
      feedbackRevision: snapshot.feedback_revision,
      retrainMode: "automatic",
      semanticModel,
      labelSource: snapshot.label_source,
    });
    applySnapshotSummary(refreshed, snapshot);
    return (await commitPreferenceModel(config, refreshed, snapshot, true)) ? "settled" : "retry";
  } catch {
    return "failed";
  }
}

export async function runScheduledPreferenceModelRetrain(
  config: ConfigOrDir,
  token: string,
  options?: { delaySeconds?: number },
): Promise<void> {
  await setRetrainWorkerPid(config, token, process.pid);
  let outcome: string | null = null;
  try {
    if (await waitForRetrainQuiet(config, token, options?.delaySeconds ?? AUTO_RETRAIN_DELAY_SECONDS)) {
      outcome = await runAutoRetrain(config);
    }
  } catch {
    outcome = "failed";
  } finally {
    await releaseRetrainWorker(config, token);
  }
  if (outcome === "settled" || outcome === "retry") {
    try {
      const model = loadPreferenceModel(preferenceModelPath(config));
      const snapshot = collectPreferenceTrainingSnapshot(config);
      if (preferenceLearningStatus(config, model, snapshot).due) {
        await schedulePreferenceModelRetrain(config, { force: true });
      }
    } catch {
      // A later user action can request a fresh refresh.
    }
  }
}

export type { WayperConfig };
