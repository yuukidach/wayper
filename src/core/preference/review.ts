import fs from "node:fs";
import path from "node:path";
import { PREVIEW_DIMENSIONS, previewCacheDirectory } from "../../shared/media";
import type { FilterStrategy } from "../../shared/types";
import { normalizeFilterStrategy } from "../config";
import { atomicWrite, probeImageDimensions } from "../image-probe";
import { getDefaultLockPath, withFileLock } from "../lock";
import { ALL_ORIENTATIONS, ALL_PURITIES, isOrientation, isPurity, poolDir } from "../paths";
import { clearImageDerivatives, favoriteFilenames, listImagesInDir, loadMetadata } from "../pool";
import { addToBlacklist, listBlacklist, type ConfigOrDir } from "../state";
import { trashAndRecordUndo } from "../trash";
import {
  compareStrings,
  DEFAULT_REVIEW_LIMIT,
  DEFAULT_REVIEW_REASON_LIMIT,
  MODEL_REVIEW_SCHEMA_VERSION,
  MODEL_REVIEW_STATUSES,
  PREFERENCE_PREDICTION_BATCH_SIZE,
  roundTo,
} from "./constants";
import {
  appendPreferenceFeedback,
  autoFilterStatus,
  collectPreferenceTrainingSnapshot,
  hasExplicitPositiveFeedback,
  latestFeedbackByFilename,
  loadPreferenceFeedback,
  loadPreferenceModel,
  modelDecisionReady,
  modelReport,
  modelReviewDirPath,
  modelReviewFilePath,
  preferenceLearningStatus,
  preferenceModelPath,
  prefetchModelEmbeddings,
  schedulePreferenceModelRetrain,
  setNeutralFilterProvider,
} from "./ledger";
import {
  preferenceCandidate,
  preferenceDecisionScore,
  preferenceDecisionThreshold,
  type PreferenceModel,
  type PredictRecord,
  type PreferencePrediction,
} from "./model";

type ReviewRecord = Record<string, unknown>;

function downloadDirOf(config: ConfigOrDir): string {
  return typeof config === "string" ? config : config.download_dir;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is string | number | boolean {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" || typeof value === "boolean";
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function fileToken(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    return `${stat.mtimeNs}:${stat.size}:${stat.ino}`;
  } catch {
    return null;
  }
}

function primitiveFields(value: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isPrimitive(item)) clean[key] = item;
  }
  return clean;
}

function cleanRecord(value: unknown): ReviewRecord | null {
  if (!isRecord(value)) return null;
  const filename = path.basename(String(value.name ?? value.filename ?? "").replace(/\\/g, "/"));
  const status = value.status ?? "pending";
  if (
    !filename ||
    typeof value.path !== "string" ||
    typeof status !== "string" ||
    !MODEL_REVIEW_STATUSES.has(status)
  ) {
    return null;
  }
  const clean: ReviewRecord = {
    name: filename,
    path: value.path.replace(/\\/g, "/"),
    status,
  };
  for (const key of [
    "purity",
    "orientation",
    "strategy",
    "created_at",
    "resolved_at",
    "feedback_recorded",
  ]) {
    const item = value[key];
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      clean[key] = item;
    }
  }
  if (
    typeof value.width === "number" &&
    typeof value.height === "number" &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height) &&
    value.width > 0 &&
    value.height > 0
  ) {
    clean.width = Math.trunc(value.width);
    clean.height = Math.trunc(value.height);
  }
  if (isRecord(value.model)) {
    const cleanModel: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value.model)) {
      if (isPrimitive(item)) {
        cleanModel[key] = item;
      } else if (
        (key === "neighbor_nearest_dislike" || key === "neighbor_nearest_keep") &&
        isRecord(item)
      ) {
        const neighbor = primitiveFields(item);
        if (Array.isArray(item.tag_matches)) {
          const matches = item.tag_matches
            .slice(0, 32)
            .filter(isRecord)
            .map(primitiveFields)
            .filter((entry) => Object.keys(entry).length > 0);
          if (matches.length > 0) neighbor.tag_matches = matches;
        }
        if (Object.keys(neighbor).length > 0) cleanModel[key] = neighbor;
      } else if (
        (key === "dislike_evidence" || key === "keep_evidence" || key === "contributions") &&
        Array.isArray(item)
      ) {
        const evidence = item
          .slice(0, 20)
          .filter(isRecord)
          .map(primitiveFields)
          .filter((entry) => Object.keys(entry).length > 0);
        if (evidence.length > 0) cleanModel[key] = evidence;
      }
    }
    if (Object.keys(cleanModel).length > 0) clean.model = cleanModel;
  }
  return clean;
}

interface ReviewState {
  schema_version: number;
  items: Record<string, ReviewRecord>;
}

function emptyState(): ReviewState {
  return { schema_version: MODEL_REVIEW_SCHEMA_VERSION, items: {} };
}

function readReviewFile(config: ConfigOrDir): Record<string, unknown> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(modelReviewFilePath(config), "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.schema_version !== MODEL_REVIEW_SCHEMA_VERSION) return null;
  return isRecord(raw.items) ? raw.items : null;
}

function parseModelReviewState(config: ConfigOrDir): ReviewState {
  const rawItems = readReviewFile(config);
  if (rawItems === null) return emptyState();
  const items: Record<string, ReviewRecord> = {};
  for (const [key, value] of Object.entries(rawItems)) {
    const record = cleanRecord(value);
    if (record !== null) items[key] = record;
  }
  return { schema_version: MODEL_REVIEW_SCHEMA_VERSION, items };
}

const STATE_CACHE_IDLE_MS = 120_000;
let stateCache: { filePath: string; token: string; state: ReviewState } | null = null;
let stateCacheTimer: NodeJS.Timeout | null = null;

function rememberState(filePath: string, token: string, state: ReviewState): void {
  stateCache = { filePath, token, state };
  if (stateCacheTimer !== null) clearTimeout(stateCacheTimer);
  stateCacheTimer = setTimeout(() => {
    stateCache = null;
    stateCacheTimer = null;
  }, STATE_CACHE_IDLE_MS);
  stateCacheTimer.unref?.();
}

/**
 * The review ledger keeps every resolved record, so parsing it is slow.  The
 * parsed state is reused until the file changes on disk.  Callers that modify
 * it must do so synchronously and save right away, which re-validates the cache.
 */
export function loadModelReviewState(config: ConfigOrDir): ReviewState {
  const filePath = path.resolve(modelReviewFilePath(config));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = fileToken(filePath);
    if (token === null) break;
    if (stateCache && stateCache.filePath === filePath && stateCache.token === token) {
      return stateCache.state;
    }
    const state = parseModelReviewState(config);
    if (fileToken(filePath) !== token) continue;
    rememberState(filePath, token, state);
    return state;
  }
  return parseModelReviewState(config);
}

function saveModelReviewState(config: ConfigOrDir, state: ReviewState): void {
  const filePath = path.resolve(modelReviewFilePath(config));
  stateCache = null;
  atomicWrite(modelReviewFilePath(config), `${JSON.stringify(state, null, 2)}\n`);
  const token = fileToken(filePath);
  if (token !== null) rememberState(filePath, token, state);
}

const SUMMARY_CACHE_LIMIT = 8;
const summaryCache = new Map<
  string,
  { token: string; pending: ReviewRecord[]; filtered: Set<string> }
>();

function reviewSummary(config: ConfigOrDir): { pending: ReviewRecord[]; filtered: Set<string> } {
  const filePath = path.resolve(modelReviewFilePath(config));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = fileToken(filePath);
    if (token === null) {
      summaryCache.delete(filePath);
      return { pending: [], filtered: new Set() };
    }
    const cached = summaryCache.get(filePath);
    if (cached && cached.token === token) return cached;
    const pending: ReviewRecord[] = [];
    const filtered = new Set<string>();
    for (const value of Object.values(loadModelReviewState(config).items)) {
      if (value.status !== "pending" && value.status !== "filter") continue;
      const { model: _model, ...record } = value;
      if (record.status === "pending") pending.push(record);
      else filtered.add(String(record.name));
    }
    if (fileToken(filePath) !== token) continue;
    const result = { token, pending, filtered };
    summaryCache.set(filePath, result);
    while (summaryCache.size > SUMMARY_CACHE_LIMIT) {
      summaryCache.delete(summaryCache.keys().next().value as string);
    }
    return result;
  }
  return { pending: [], filtered: new Set() };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function relativeLibraryPath(config: ConfigOrDir, image: string): string {
  const root = path.resolve(downloadDirOf(config));
  const resolved = path.resolve(image);
  if (!isInside(root, resolved)) {
    throw new Error("model review image must be inside the download directory");
  }
  return path.relative(root, resolved).split(path.sep).join("/");
}

function reviewPath(config: ConfigOrDir, rawPath: string): string {
  const root = path.resolve(downloadDirOf(config));
  const candidate = path.resolve(root, rawPath);
  const reviewRoot = path.resolve(modelReviewDirPath(config));
  if (!isInside(reviewRoot, candidate) || candidate === reviewRoot) {
    throw new Error("model review path must point inside the quarantine");
  }
  return candidate;
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function activePurities(purities: Iterable<string> | null | undefined): Set<string> {
  const active = new Set<string>();
  for (const purity of purities ?? ALL_PURITIES) {
    if (isPurity(purity)) active.add(purity);
  }
  if (active.size === 0) active.add("sfw");
  return active;
}

export interface ReviewScope {
  purities?: Iterable<string> | null;
  orientation?: string | null;
}

export function pendingModelReviewCount(config: ConfigOrDir, scope?: ReviewScope): number {
  const active = activePurities(scope?.purities);
  let count = 0;
  for (const record of reviewSummary(config).pending) {
    if (typeof record.path !== "string") continue;
    if (!active.has(String(record.purity ?? "sfw"))) continue;
    if (scope?.orientation && record.orientation !== scope.orientation) continue;
    try {
      if (isFile(reviewPath(config, record.path))) count += 1;
    } catch {
      continue;
    }
  }
  return count;
}

export function filteredModelReviewFilenames(config: ConfigOrDir): Set<string> {
  return new Set(reviewSummary(config).filtered);
}

setNeutralFilterProvider(filteredModelReviewFilenames);

const LIFTED_MODEL_KEYS = [
  "probability",
  "calibrated",
  "score",
  "feature_score",
  "decision_score",
  "review_score",
  "hybrid_score",
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
  "neighbor_nearest_dislike",
  "neighbor_nearest_keep",
  "neighbor_exact_max_similarity",
  "neighbor_semantic_max_similarity",
  "neighbor_preference_gap",
  "threshold",
  "contributions",
  "dislike_evidence",
  "keep_evidence",
];

function reviewSortKey(item: ReviewRecord): [number, number, string] {
  let score = 0.0;
  if (isRecord(item.model)) {
    const neighborScore = item.model.neighbor_probability;
    if (typeof neighborScore === "number") {
      score = neighborScore;
    } else {
      for (const key of ["probability", "review_score", "feature_score"]) {
        const value = item.model[key];
        if (typeof value === "number") score = Math.max(score, value);
      }
    }
  }
  const created = typeof item.created_at === "number" ? item.created_at : 0;
  return [-score, -created, String(item.name)];
}

const DIMENSION_CACHE_LIMIT = 2048;
const dimensionProbeCache = new Map<string, { token: string; width: number; height: number }>();

function resolveCandidateDimensions(
  fullPath: string,
  meta?: Record<string, unknown> | null,
): { width: number; height: number } | null {
  const metaW = meta?.dimension_x;
  const metaH = meta?.dimension_y;
  if (
    typeof metaW === "number" &&
    typeof metaH === "number" &&
    Number.isFinite(metaW) &&
    Number.isFinite(metaH) &&
    metaW > 0 &&
    metaH > 0
  ) {
    return { width: Math.trunc(metaW), height: Math.trunc(metaH) };
  }
  const resolved = path.resolve(fullPath);
  const token = fileToken(resolved);
  if (token !== null) {
    const cached = dimensionProbeCache.get(resolved);
    if (cached && cached.token === token) {
      return { width: cached.width, height: cached.height };
    }
  }
  const probed = probeImageDimensions(resolved);
  if (!probed || probed.width <= 0 || probed.height <= 0) return null;
  if (token !== null) {
    dimensionProbeCache.set(resolved, { token, width: probed.width, height: probed.height });
    while (dimensionProbeCache.size > DIMENSION_CACHE_LIMIT) {
      const oldest = dimensionProbeCache.keys().next().value;
      if (oldest === undefined) break;
      dimensionProbeCache.delete(oldest);
    }
  }
  return { width: probed.width, height: probed.height };
}

function relocateImageDerivatives(
  downloadDir: string,
  fromRelPath: string,
  toRelPath: string,
): void {
  const root = path.resolve(downloadDir);
  const fromParsed = path.parse(fromRelPath);
  const toParsed = path.parse(toRelPath);
  if (!fromParsed.name || !toParsed.name) return;
  for (const cacheName of [".thumbnails", ...PREVIEW_DIMENSIONS.map(previewCacheDirectory)]) {
    const src = path.join(root, cacheName, fromParsed.dir, `${fromParsed.name}.jpg`);
    if (!isFile(src)) continue;
    const dst = path.join(root, cacheName, toParsed.dir, `${toParsed.name}.jpg`);
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
    } catch {
      try {
        fs.rmSync(src, { force: true });
      } catch {
        // Ignore best-effort cache cleanup
      }
    }
  }
}

export function listModelReviewItems(
  config: ConfigOrDir,
  options?: ReviewScope & { limit?: number; includeResolved?: boolean },
): ReviewRecord[] {
  const active = activePurities(options?.purities);
  const state = loadModelReviewState(config);
  const result: Array<{ item: ReviewRecord; image: string }> = [];
  for (const record of Object.values(state.items)) {
    if (!options?.includeResolved && record.status !== "pending") continue;
    if (!active.has(String(record.purity ?? "sfw"))) continue;
    if (options?.orientation && record.orientation !== options.orientation) continue;
    if (typeof record.path !== "string") continue;
    let image: string;
    try {
      image = reviewPath(config, record.path);
    } catch {
      continue;
    }
    if (record.status === "pending" && !isFile(image)) continue;
    const item: ReviewRecord = { ...record, review_only: true, auto_filtered: true };
    if (isRecord(record.model)) {
      for (const key of LIFTED_MODEL_KEYS) {
        if (key in record.model) item[key] = record.model[key];
      }
    }
    result.push({ item, image });
  }
  result.sort((left, right) => {
    const first = reviewSortKey(left.item);
    const second = reviewSortKey(right.item);
    return first[0] - second[0] || first[1] - second[1] || compareStrings(first[2], second[2]);
  });
  const limit = Math.max(1, Math.min(500, Math.trunc(options?.limit ?? 100)));
  return result.slice(0, limit).map(({ item, image }) => {
    if (typeof item.width !== "number" || typeof item.height !== "number") {
      const dims = resolveCandidateDimensions(image);
      if (dims) {
        item.width = dims.width;
        item.height = dims.height;
      }
    }
    return item;
  });
}

export async function queueModelReviewItem(
  config: ConfigOrDir,
  image: string,
  options: {
    purity: string;
    orientation: string;
    prediction: Record<string, unknown>;
    strategy: string;
  },
): Promise<ReviewRecord> {
  if (!isPurity(options.purity) || !isOrientation(options.orientation)) {
    throw new Error("Invalid model review location");
  }
  if (!isFile(image)) throw new Error(`Model review image not found: ${image}`);
  const strategy: FilterStrategy = normalizeFilterStrategy(options.strategy);
  const relativePath = relativeLibraryPath(config, image);
  const name = path.basename(image);
  const cleanModel = cleanRecord({
    name,
    path: relativePath,
    status: "pending",
    model: options.prediction,
  });
  const record: ReviewRecord = {
    name,
    path: relativePath,
    purity: options.purity,
    orientation: options.orientation,
    strategy,
    status: "pending",
    created_at: nowSeconds(),
    model: cleanModel?.model ?? {},
  };
  const dims = resolveCandidateDimensions(image);
  if (dims) {
    record.width = dims.width;
    record.height = dims.height;
  }
  await withFileLock(getDefaultLockPath(), () => {
    const state = loadModelReviewState(config);
    for (const [key, value] of Object.entries(state.items)) {
      if (value.path === relativePath && key !== relativePath) delete state.items[key];
    }
    state.items[relativePath] = record;
    saveModelReviewState(config, state);
  });
  return { ...record, review_only: true, auto_filtered: true };
}

export class ModelReviewError extends Error {
  readonly code: "not_found" | "conflict" | "invalid";

  constructor(code: "not_found" | "conflict" | "invalid", message: string) {
    super(message);
    this.name = "ModelReviewError";
    this.code = code;
  }
}

export async function resolveModelReviewItem(
  config: ConfigOrDir,
  rawPath: string,
  action: string,
): Promise<ReviewRecord> {
  if (action !== "keep" && action !== "ban" && action !== "filter") {
    throw new ModelReviewError("invalid", "Model review action must be keep, ban, or filter");
  }
  const downloadDir = downloadDirOf(config);

  const result = await withFileLock(getDefaultLockPath(), async () => {
    let image: string;
    try {
      image = reviewPath(config, rawPath);
    } catch (error) {
      throw new ModelReviewError("invalid", (error as Error).message);
    }
    const state = loadModelReviewState(config);
    const canonicalPath = relativeLibraryPath(config, image);
    let key: string | null = null;
    let record: ReviewRecord | null = null;
    for (const [candidateKey, candidate] of Object.entries(state.items)) {
      if (candidate.path === canonicalPath) {
        key = candidateKey;
        record = candidate;
        break;
      }
    }
    if (key === null || record === null || record.status !== "pending") {
      throw new ModelReviewError("not_found", "Model review item is no longer pending");
    }
    if (!isFile(image)) {
      throw new ModelReviewError("not_found", "Model review image is no longer available");
    }

    const purity = String(record.purity ?? "sfw");
    const orientation = String(record.orientation ?? "landscape");
    if (!isPurity(purity) || !isOrientation(orientation)) {
      throw new ModelReviewError("invalid", "Model review item has an invalid library location");
    }
    const destinationDir = poolDir(downloadDir, purity, orientation);
    fs.mkdirSync(destinationDir, { recursive: true });
    const name = path.basename(image);
    const destination = path.join(destinationDir, name);
    if (fs.existsSync(destination)) {
      throw new ModelReviewError("conflict", `A library image named ${name} already exists`);
    }
    try {
      fs.renameSync(image, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      fs.copyFileSync(image, destination);
      fs.unlinkSync(image);
    }

    const model: Record<string, unknown> = isRecord(record.model) ? { ...record.model } : {};
    model.filter_strategy = String(record.strategy ?? "model");
    const nextPoolRel = path.relative(path.resolve(downloadDir), destination).split(path.sep).join("/");
    if (action === "ban" || action === "filter") {
      addToBlacklist(config, name);
      await trashAndRecordUndo(config, destination);
      clearImageDerivatives(config, canonicalPath);
    } else if (action === "keep") {
      relocateImageDerivatives(downloadDir, canonicalPath, nextPoolRel);
    }
    let feedbackRecorded = false;
    if (action !== "filter") {
      try {
        appendPreferenceFeedback(config, action === "ban" ? "dislike" : action, name, {
          source: "model_filter",
          context: "model_review",
          model,
        });
        feedbackRecorded = true;
      } catch {
        feedbackRecorded = false;
      }
    }

    record.status = action;
    record.resolved_at = nowSeconds();
    record.feedback_recorded = feedbackRecorded;
    record.path = canonicalPath;
    state.items[key] = record;
    saveModelReviewState(config, state);
    return {
      ...record,
      new_path: action === "keep" ? nextPoolRel : null,
    };
  });

  if (action !== "filter") {
    try {
      await schedulePreferenceModelRetrain(config);
    } catch {
      // The next feedback event requests another refresh.
    }
  }
  return result;
}

export async function clearModelReviewItems(
  config: ConfigOrDir,
  scope?: ReviewScope,
): Promise<Record<string, unknown>> {
  const pending = listModelReviewItems(config, { ...scope, limit: 500 });
  if (pendingModelReviewCount(config, scope) > pending.length) {
    const active = activePurities(scope?.purities);
    const seen = new Set(pending.map((item) => String(item.path)));
    for (const record of Object.values(loadModelReviewState(config).items)) {
      if (record.status !== "pending") continue;
      if (typeof record.path !== "string" || seen.has(record.path)) continue;
      if (!active.has(String(record.purity ?? "sfw"))) continue;
      if (scope?.orientation && record.orientation !== scope.orientation) continue;
      pending.push(record);
      seen.add(record.path);
    }
  }

  const cleared: string[] = [];
  const failures: Array<{ path: string; error: string }> = [];
  for (const item of pending) {
    const rawPath = String(item.path ?? "");
    if (!rawPath) continue;
    try {
      await resolveModelReviewItem(config, rawPath, "filter");
      cleared.push(rawPath);
    } catch (error) {
      failures.push({ path: rawPath, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    cleared_count: cleared.length,
    cleared_paths: cleared,
    failed_count: failures.length,
    failures,
    remaining_count: pendingModelReviewCount(config, scope),
  };
}

export function modelReviewStatus(
  config: ConfigOrDir,
  options?: ReviewScope & { includeLearning?: boolean },
): Record<string, unknown> {
  const model = loadPreferenceModel(preferenceModelPath(config));
  const status = autoFilterStatus(config, model);
  if (options?.includeLearning ?? true) {
    try {
      status.learning = preferenceLearningStatus(config, model);
    } catch {
      status.learning = null;
    }
  }
  status.pending_count = pendingModelReviewCount(config, options);
  return status;
}

interface RankedItem {
  path: string;
  image: string;
  name: string;
  meta: Record<string, unknown>;
  prediction: PreferencePrediction;
  decision_score: number;
}

interface CachedPredictionEntry {
  sig: string;
  prediction: PreferencePrediction;
  decisionScore: number;
  candidate: boolean;
}

interface ModelPredictionCache {
  byMeta: WeakMap<object, CachedPredictionEntry>;
  byName: Map<string, CachedPredictionEntry>;
}

const MODEL_PREDICTION_CACHE_LIMIT = 16_384;
const modelPredictionCaches = new WeakMap<PreferenceModel, ModelPredictionCache>();

function getModelPredictionCache(model: PreferenceModel): ModelPredictionCache {
  let cache = modelPredictionCaches.get(model);
  if (!cache) {
    cache = { byMeta: new WeakMap(), byName: new Map() };
    modelPredictionCaches.set(model, cache);
  }
  return cache;
}

function metadataPredictionSignature(meta: Record<string, unknown>): string {
  return JSON.stringify([
    meta.tags ?? null,
    meta.tag_details ?? null,
    meta.colors ?? null,
    meta.category ?? null,
    meta.purity ?? null,
    meta.uploader ?? null,
    meta._semantic_tag_items ?? null,
  ]);
}

function diversifyReviewRank(ranked: RankedItem[]): RankedItem[] {
  if (ranked.length <= DEFAULT_REVIEW_LIMIT) return ranked;
  const head: RankedItem[] = [];
  const deferred: RankedItem[] = [];
  const reasonCounts = new Map<string, number>();
  for (const item of ranked) {
    const evidence = item.prediction.neighbor_nearest_dislike;
    const reason = evidence ? `neighbor\x1f${evidence.filename}` : "\x1f";
    const count = reasonCounts.get(reason) ?? 0;
    if (head.length < DEFAULT_REVIEW_LIMIT && count < DEFAULT_REVIEW_REASON_LIMIT) {
      head.push(item);
      reasonCounts.set(reason, count + 1);
    } else {
      deferred.push(item);
    }
  }
  const target = Math.min(DEFAULT_REVIEW_LIMIT, ranked.length);
  if (head.length < target) head.push(...deferred.slice(0, target - head.length));
  const selected = new Set(head);
  return [
    ...ranked.filter((item) => selected.has(item)),
    ...ranked.filter((item) => !selected.has(item)),
  ];
}

function nullableRound(value: number | null, digits: number): number | null {
  return value === null ? null : roundTo(value, digits);
}

export interface DeletionSuggestionOptions extends ReviewScope {
  limit?: number | null;
  includeLearning?: boolean;
  metadataSnapshot?: Record<string, Record<string, unknown>> | null;
}

export async function preferenceDeletionSuggestions(
  config: ConfigOrDir,
  options?: DeletionSuggestionOptions,
): Promise<Record<string, unknown>> {
  const downloadDir = path.resolve(downloadDirOf(config));
  const modelPath = preferenceModelPath(config);
  const model = loadPreferenceModel(modelPath);
  const limit = options?.limit === undefined ? DEFAULT_REVIEW_LIMIT : options.limit;
  let learning: Record<string, unknown> | null = null;
  if (options?.includeLearning ?? true) {
    learning = preferenceLearningStatus(config, model, collectPreferenceTrainingSnapshot(config));
  }
  const reviewStrategy = "two_stage_tag_semantic_rank";
  if (model === null) {
    return { status: "untrained", items: [], learning, review_strategy: reviewStrategy };
  }
  if (!modelDecisionReady(model)) {
    const upgradePending = autoFilterStatus(config, model).status === "upgrade_pending";
    return {
      status: upgradePending ? "upgrade_pending" : "learning",
      items: [],
      learning,
      model: modelReport(model, modelPath, learning),
      review_strategy: reviewStrategy,
    };
  }

  const active = ALL_PURITIES.filter((purity) => activePurities(options?.purities).has(purity));
  const orientations =
    options?.orientation && isOrientation(options.orientation)
      ? [options.orientation]
      : ALL_ORIENTATIONS;
  const metadata = (options?.metadataSnapshot ?? loadMetadata(config)) as Record<
    string,
    Record<string, unknown>
  >;
  const blacklisted = new Set(listBlacklist(config).map((entry) => entry.filename));
  const favorites = favoriteFilenames(config);
  const latestFeedback = latestFeedbackByFilename(loadPreferenceFeedback(config).events);
  const records: Array<{ image: string; name: string; meta: Record<string, unknown> }> = [];
  let poolImages = 0;
  let metadataImages = 0;
  for (const purity of active) {
    for (const orient of orientations) {
      for (const image of listImagesInDir(poolDir(downloadDir, purity, orient))) {
        const name = path.basename(image);
        if (
          blacklisted.has(name) ||
          favorites.has(name) ||
          hasExplicitPositiveFeedback(latestFeedback.get(name))
        ) {
          continue;
        }
        poolImages += 1;
        const meta = metadata[name];
        if (!isRecord(meta) || !Array.isArray(meta.tags) || meta.tags.length === 0) continue;
        metadataImages += 1;
        records.push({ image, name, meta });
      }
    }
  }

  const scoredImages = records.length;
  let positiveEvidenceImages = 0;
  let semanticEvidenceImages = 0;
  let semanticScoredImages = 0;
  let neighborScoredImages = 0;
  let neighborCandidateImages = 0;
  let bestScore: number | null = null;
  let bestDecisionScore: number | null = null;
  let bestSemanticScore: number | null = null;
  let bestNeighborProbability: number | null = null;
  let bestNeighborSimilarity: number | null = null;
  const scored: RankedItem[] = [];
  const predictionCache = getModelPredictionCache(model);
  const resolvedEntries: Array<CachedPredictionEntry | null> = new Array(records.length).fill(null);
  const uncachedIndices: number[] = [];
  const uncachedSigs: string[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const { name, meta } = records[index];
    const direct = predictionCache.byMeta.get(meta);
    if (direct) {
      resolvedEntries[index] = direct;
      continue;
    }
    const sig = metadataPredictionSignature(meta);
    const byName = predictionCache.byName.get(name);
    if (byName && byName.sig === sig) {
      predictionCache.byMeta.set(meta, byName);
      predictionCache.byName.delete(name);
      predictionCache.byName.set(name, byName);
      resolvedEntries[index] = byName;
      continue;
    }
    uncachedIndices.push(index);
    uncachedSigs.push(sig);
  }

  if (uncachedIndices.length > 0) {
    const allUncachedRecords: PredictRecord[] = uncachedIndices.map((recordIndex) => {
      const { meta } = records[recordIndex];
      return [meta.tags as unknown[], meta, null];
    });
    await prefetchModelEmbeddings(model, allUncachedRecords);

    for (let start = 0; start < uncachedIndices.length; start += PREFERENCE_PREDICTION_BATCH_SIZE) {
      const batchIndices = uncachedIndices.slice(start, start + PREFERENCE_PREDICTION_BATCH_SIZE);
      const predictRecords = batchIndices.map((recordIndex): PredictRecord => {
        const { meta } = records[recordIndex];
        return [meta.tags as unknown[], meta, null];
      });
      const predictions = model.predictMany(predictRecords, { topN: 20 });
      for (let offset = 0; offset < batchIndices.length; offset += 1) {
        const recordIndex = batchIndices[offset];
        const { name, meta } = records[recordIndex];
        const prediction = predictions[offset];
        const decisionScore = preferenceDecisionScore(model, prediction);
        const candidate = preferenceCandidate(model, prediction);
        const entry: CachedPredictionEntry = {
          sig: uncachedSigs[start + offset],
          prediction,
          decisionScore,
          candidate,
        };
        predictionCache.byMeta.set(meta, entry);
        predictionCache.byName.delete(name);
        predictionCache.byName.set(name, entry);
        while (predictionCache.byName.size > MODEL_PREDICTION_CACHE_LIMIT) {
          const oldest = predictionCache.byName.keys().next().value;
          if (oldest === undefined) break;
          predictionCache.byName.delete(oldest);
        }
        resolvedEntries[recordIndex] = entry;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  for (let index = 0; index < records.length; index += 1) {
    const entry = resolvedEntries[index];
    if (!entry) continue;
    const { image, name, meta } = records[index];
    const { prediction, decisionScore, candidate } = entry;
    if (prediction.positive_evidence_count > 0) {
      positiveEvidenceImages += 1;
      if (bestScore === null || prediction.feature_score > bestScore) {
        bestScore = prediction.feature_score;
      }
    }
    if (prediction.semantic_available && prediction.semantic_score !== null) {
      semanticScoredImages += 1;
      if (prediction.semantic_score > 0) semanticEvidenceImages += 1;
      if (bestSemanticScore === null || prediction.semantic_score > bestSemanticScore) {
        bestSemanticScore = prediction.semantic_score;
      }
    }
    if (bestDecisionScore === null || decisionScore > bestDecisionScore) {
      bestDecisionScore = decisionScore;
    }
    if (prediction.neighbor_available) {
      neighborScoredImages += 1;
      if (
        bestNeighborProbability === null ||
        (prediction.neighbor_probability ?? 0.0) > bestNeighborProbability
      ) {
        bestNeighborProbability = prediction.neighbor_probability;
      }
      if (
        bestNeighborSimilarity === null ||
        prediction.neighbor_max_similarity > bestNeighborSimilarity
      ) {
        bestNeighborSimilarity = prediction.neighbor_max_similarity;
      }
    }
    if (!candidate) continue;
    neighborCandidateImages += 1;
    scored.push({
      path: path.relative(downloadDir, image).split(path.sep).join("/"),
      image,
      name,
      meta,
      prediction,
      decision_score: decisionScore,
    });
  }

  const rankedAll = diversifyReviewRank(
    scored.sort(
      (left, right) =>
        right.decision_score - left.decision_score ||
        right.prediction.neighbor_max_similarity - left.prediction.neighbor_max_similarity ||
        right.prediction.neighbor_similarity_sum - left.prediction.neighbor_similarity_sum ||
        compareStrings(left.name, right.name),
    ),
  );
  const rankedPage =
    limit === null || limit === undefined ? rankedAll : rankedAll.slice(0, Math.max(1, limit));
  const candidates = rankedPage.map((item, index) => {
    const prediction = item.prediction;
    const rank = index + 1;
    const dims = resolveCandidateDimensions(item.image, item.meta);
    return {
      path: item.path,
      name: item.name,
      ...(dims ? { width: dims.width, height: dims.height } : {}),
      score: roundTo(prediction.score, 4),
      feature_score: roundTo(prediction.feature_score, 4),
      decision_score: roundTo(item.decision_score, 4),
      neighbor_probability: nullableRound(prediction.neighbor_probability, 4),
      neighbor_available: prediction.neighbor_available,
      neighbor_count: prediction.neighbor_count,
      neighbor_dislike_count: prediction.neighbor_dislike_count,
      neighbor_keep_count: prediction.neighbor_keep_count,
      neighbor_similarity_sum: roundTo(prediction.neighbor_similarity_sum, 4),
      neighbor_max_similarity: roundTo(prediction.neighbor_max_similarity, 4),
      neighbor_nearest_dislike: prediction.neighbor_nearest_dislike,
      neighbor_nearest_keep: prediction.neighbor_nearest_keep,
      neighbor_exact_max_similarity: roundTo(prediction.neighbor_exact_max_similarity, 4),
      neighbor_semantic_max_similarity: roundTo(prediction.neighbor_semantic_max_similarity, 4),
      neighbor_preference_gap: roundTo(prediction.neighbor_preference_gap, 4),
      semantic_score: nullableRound(prediction.semantic_score, 4),
      semantic_probability: nullableRound(prediction.semantic_probability, 4),
      semantic_available: prediction.semantic_available,
      probability: roundTo(prediction.probability, 4),
      calibrated: prediction.calibrated,
      rank,
      percentile: roundTo(100.0 * (1.0 - (rank - 1) / Math.max(1, scoredImages - 1)), 1),
      contributions: [...prediction.contributions],
      dislike_evidence: prediction.contributions.filter((item2) => item2.direction === "dislike"),
      keep_evidence: prediction.contributions.filter((item2) => item2.direction === "keep"),
      positive_evidence_count: prediction.positive_evidence_count,
    };
  });
  const threshold = preferenceDecisionThreshold(model);
  return {
    status: "ready",
    items: candidates,
    learning,
    model: modelReport(model, modelPath, learning),
    decision_threshold: threshold,
    review_strategy: reviewStrategy,
    diagnostics: {
      pool_images: poolImages,
      metadata_images: metadataImages,
      scored_images: scoredImages,
      positive_evidence_images: positiveEvidenceImages,
      neighbor_scored_images: neighborScoredImages,
      neighbor_candidate_images: neighborCandidateImages,
      semantic_evidence_images: semanticEvidenceImages,
      semantic_scored_images: semanticScoredImages,
      candidate_count: rankedAll.length,
      returned_count: candidates.length,
      ranked_pool_count: rankedAll.length,
      best_feature_score: nullableRound(bestScore, 4),
      best_decision_score: nullableRound(bestDecisionScore, 4),
      decision_threshold: threshold,
      best_neighbor_probability: nullableRound(bestNeighborProbability, 4),
      best_neighbor_similarity: nullableRound(bestNeighborSimilarity, 4),
      best_semantic_score: nullableRound(bestSemanticScore, 4),
    },
  };
}
