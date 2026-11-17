import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NON_PREFERENCE_FEATURE_TAGS, normalizeTag, normalizeText } from "../../shared/tags";
import { getLogger } from "../logging";
import {
  compareStrings,
  DEFAULT_SEMANTIC_BLEND,
  DEFAULT_SEMANTIC_MODEL,
  isLegacySemanticModel,
  roundTo,
  SEMANTIC_CACHE_SIZE,
  SEMANTIC_EPOCHS,
  SEMANTIC_MAX_BATCH_RECORDS,
  SEMANTIC_MAX_BATCH_TEXTS,
  SEMANTIC_MAX_TAGS,
  SEMANTIC_MIN_EXAMPLES,
  SEMANTIC_SIMILARITY_FLOOR,
} from "./constants";
import type { PreferenceExample } from "./model";

const log = getLogger("preference.semantic");

export type CustomTextEmbedder = (
  texts: string[],
  modelName: string,
) => Promise<Float32Array[]> | Float32Array[];

export type TagMaxSimMatch = [query: string, prototype: string, similarity: number];
export type TagMaxSimResult = [score: number, matches: TagMaxSimMatch[]] & {
  score: number;
  matches: TagMaxSimMatch[];
};
export type DenseLogisticFit = [bias: number, weights: number[]] & {
  bias: number;
  weights: number[];
};

export class SemanticUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemanticUnavailable";
  }
}

export interface SemanticHeadInit {
  modelName?: string;
  model_name?: string;
  bias: number;
  weights: Iterable<number>;
  blend?: number;
  examples?: number;
  positives?: number;
  negatives?: number;
}

export class SemanticHead {
  readonly modelName: string;
  readonly bias: number;
  readonly weights: readonly number[];
  readonly blend: number;
  readonly examples: number;
  readonly positives: number;
  readonly negatives: number;

  constructor(init: SemanticHeadInit) {
    const modelName = init.modelName ?? init.model_name ?? "";
    this.modelName = modelName;
    this.bias = init.bias;
    this.weights = Object.freeze([...init.weights].map((value) => Number(value)));
    this.blend = init.blend ?? DEFAULT_SEMANTIC_BLEND;
    this.examples = init.examples ?? 0;
    this.positives = init.positives ?? 0;
    this.negatives = init.negatives ?? 0;
  }

  get model_name(): string {
    return this.modelName;
  }

  get dimension(): number {
    return this.weights.length;
  }

  toDict(): Record<string, unknown> {
    return {
      model_name: this.modelName,
      bias: roundTo(this.bias, 8),
      weights: this.weights.map((value) => roundTo(value, 8)),
      blend: roundTo(this.blend, 6),
      examples: this.examples,
      positives: this.positives,
      negatives: this.negatives,
    };
  }

  to_dict(): Record<string, unknown> {
    return this.toDict();
  }
}

export interface SemanticTagSet {
  readonly items: ReadonlyArray<readonly [string, string]>;
  readonly matrix: Float32Array;
  readonly dimension: number;
  readonly pooled: Float32Array;
  /**
   * The shared embedding behind each matrix row. Tags repeat heavily across
   * tag sets, so row identity lets comparisons reuse per-tag products.
   */
  readonly rowVectors?: ReadonlyArray<Float32Array>;
}

function extractEligibleTags(tags: Iterable<unknown> | null | undefined): string[] {
  if (tags === null || tags === undefined) return [];
  const iterable = typeof tags === "string" ? [tags] : tags;
  const unique = new Set<string>();
  for (const rawTag of iterable) {
    const rawValue =
      typeof rawTag === "object" && rawTag !== null && "name" in rawTag
        ? (rawTag as { name: unknown }).name
        : rawTag;
    const normalized = normalizeTag(rawValue);
    if (normalized && !NON_PREFERENCE_FEATURE_TAGS.has(normalized)) {
      unique.add(normalized);
    }
  }
  return [...unique].sort(compareStrings);
}

function sigmoidLocal(value: number): number {
  if (value >= 35) return 1.0;
  if (value <= -35) return 0.0;
  return 1.0 / (1.0 + Math.exp(-value));
}

export function semanticTagText(
  name: unknown,
  detail: Record<string, unknown> | null | undefined = null,
): string {
  const cleanName = String(name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
  if (!cleanName) return "";
  const parts = [cleanName];
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const alias = String(detail.alias ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .join(" ")
      .slice(0, 240);
    const category = String(detail.category ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .join(" ")
      .slice(0, 120);
    if (alias && normalizeText(alias) !== normalizeText(cleanName)) {
      parts.push(`aliases: ${alias}`);
    }
    if (category) {
      parts.push(`category: ${category}`);
    }
  }
  return parts.join("; ");
}

export function semanticTagItems(
  tags: Iterable<unknown> | null | undefined,
  metadata: Record<string, unknown> | null | undefined = null,
): Array<[string, string]> {
  const override =
    metadata && typeof metadata === "object" ? metadata._semantic_tag_items : undefined;
  if (Array.isArray(override)) {
    const items: Array<[string, string]> = [];
    const seen = new Set<string>();
    for (const raw of override) {
      if (!Array.isArray(raw) || raw.length !== 2) continue;
      const key = normalizeText(raw[0]);
      const text = String(raw[1] ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .join(" ");
      if (key && text && !seen.has(key)) {
        seen.add(key);
        items.push([key, text]);
      }
      if (items.length >= SEMANTIC_MAX_TAGS) break;
    }
    if (items.length > 0) {
      return items;
    }
  }

  const normalizedTags = extractEligibleTags(tags).slice(0, SEMANTIC_MAX_TAGS);
  const detailsByName = new Map<string, Record<string, unknown>>();
  const rawDetails = metadata && typeof metadata === "object" ? metadata.tag_details : undefined;
  if (Array.isArray(rawDetails)) {
    for (const raw of rawDetails) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const rec = raw as Record<string, unknown>;
      const key = normalizeText(rec.name ?? "");
      if (key) {
        detailsByName.set(key, rec);
      }
    }
  }

  return normalizedTags.map((tag) => [
    tag,
    semanticTagText(tag, detailsByName.get(normalizeText(tag)) ?? null),
  ]);
}

export function semanticItemsWithContext(
  items: ReadonlyArray<readonly [string, string]>,
  contextFeatures: Iterable<unknown> | null | undefined = null,
): Array<[string, string]> {
  let category = "";
  if (contextFeatures !== null && contextFeatures !== undefined) {
    const iterable = typeof contextFeatures === "string" ? [contextFeatures] : contextFeatures;
    for (const token of iterable) {
      const text = String(token ?? "");
      if (text.startsWith("category:")) {
        category = text.slice("category:".length);
        break;
      }
    }
  }
  const copied: Array<[string, string]> = items.map(([key, text]) => [key, text]);
  if (!category) {
    return copied;
  }
  copied.push([`__category__:${category}`, `Wallpaper category: ${category}.`]);
  return copied;
}

let customEmbedder: CustomTextEmbedder | null = null;
const embeddingCache = new Map<string, Float32Array>();

type FeatureExtractorFn = (
  texts: string[],
  options?: { pooling?: "cls" | "mean" | "none"; normalize?: boolean },
) => Promise<{ dims: number[]; data: Float32Array | Float64Array | number[]; dispose?: () => void }>;

let loadedPipeline: FeatureExtractorFn | null = null;
let loadedPipelineModel: string | null = null;
let loadedPipelineError: string | null = null;
let loadingPipelinePromise: Promise<FeatureExtractorFn> | null = null;
let loadingPipelineModel: string | null = null;

export function setCustomTextEmbedder(fn: CustomTextEmbedder | null): void {
  customEmbedder = fn;
  embeddingCache.clear();
}

export function getCustomTextEmbedder(): CustomTextEmbedder | null {
  return customEmbedder;
}

export function clearSemanticEmbeddingCache(): void {
  embeddingCache.clear();
}

function expandHomeDir(raw: string): string {
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

export function semanticCacheDir(): string {
  const configured = process.env.WAYPER_SEMANTIC_CACHE?.trim();
  if (configured) {
    return path.resolve(expandHomeDir(configured));
  }
  return path.join(os.homedir(), ".cache", "wayper", "semantic");
}

export function semanticDiskCachePath(): string {
  return path.join(semanticCacheDir(), "embeddings-ts-v2.sqlite3");
}

export function semanticDiskCacheKey(modelName: string, text: string): string {
  // SHA-256 is the strongest digest shared by Node's OpenSSL and Electron's
  // BoringSSL; BLAKE2 and SHA-3 are missing from the latter.
  return crypto
    .createHash("sha256")
    .update(`${modelName}\x00${text}`, "utf8")
    .digest()
    .subarray(0, 16)
    .toString("hex");
}

let diskCacheFailureReported = false;

function reportDiskCacheFailure(operation: string, error: unknown): void {
  if (diskCacheFailureReported) return;
  diskCacheFailureReported = true;
  log.warn(`Semantic embedding cache ${operation} failed; embeddings are recomputed`, error);
}

function shouldUseDiskCache(): boolean {
  if (customEmbedder === null) {
    return true;
  }
  return Boolean(process.env.WAYPER_SEMANTIC_CACHE?.trim());
}

const IS_LITTLE_ENDIAN = (() => {
  const buf = new ArrayBuffer(2);
  new DataView(buf).setInt16(0, 256, true);
  return new Int16Array(buf)[0] === 256;
})();

function float32ToLittleEndianBytes(vector: Float32Array): Uint8Array {
  if (IS_LITTLE_ENDIAN) {
    return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
  }
  const out = new ArrayBuffer(vector.length * 4);
  const view = new DataView(out);
  for (let i = 0; i < vector.length; i += 1) {
    view.setFloat32(i * 4, vector[i], true);
  }
  return new Uint8Array(out);
}

function littleEndianBytesToFloat32(blob: Uint8Array): Float32Array | null {
  if (blob.byteLength === 0 || blob.byteLength % 4 !== 0) {
    return null;
  }
  if (IS_LITTLE_ENDIAN) {
    const copy = new ArrayBuffer(blob.byteLength);
    new Uint8Array(copy).set(blob);
    return new Float32Array(copy);
  }
  const length = blob.byteLength / 4;
  const out = new Float32Array(length);
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  for (let i = 0; i < length; i += 1) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}

function loadDiskEmbeddings(modelName: string, texts: readonly string[]): Map<string, Float32Array> {
  const found = new Map<string, Float32Array>();
  if (texts.length === 0 || !shouldUseDiskCache()) {
    return found;
  }
  const dbPath = semanticDiskCachePath();
  if (!fs.existsSync(dbPath)) {
    return found;
  }
  let db: DatabaseSync | null = null;
  try {
    const keyToText = new Map<string, string>();
    for (const text of texts) {
      keyToText.set(semanticDiskCacheKey(modelName, text), text);
    }
    const keys = [...keyToText.keys()];
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 2000;");
    for (let start = 0; start < keys.length; start += 500) {
      const chunk = keys.slice(start, start + 500);
      const placeholders = chunk.map(() => "?").join(",");
      const stmt = db.prepare(
        `SELECT cache_key, vector FROM embeddings WHERE model_name = ? AND cache_key IN (${placeholders})`,
      );
      const rows = stmt.all(modelName, ...chunk) as Array<{
        cache_key?: unknown;
        vector?: unknown;
      }>;
      for (const row of rows) {
        const key = String(row.cache_key ?? "");
        const origText = keyToText.get(key);
        if (origText === undefined || !(row.vector instanceof Uint8Array)) continue;
        const parsed = littleEndianBytesToFloat32(row.vector);
        if (parsed && parsed.length > 0) {
          found.set(origText, parsed);
        }
      }
    }
  } catch (error) {
    // Disk cache failures never block ranking or training.
    reportDiskCacheFailure("read", error);
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors.
    }
  }
  return found;
}

function saveDiskEmbeddings(
  modelName: string,
  entries: ReadonlyArray<readonly [string, Float32Array]>,
): void {
  if (entries.length === 0 || !shouldUseDiskCache()) {
    return;
  }
  let db: DatabaseSync | null = null;
  try {
    const dbPath = semanticDiskCachePath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec(
      "CREATE TABLE IF NOT EXISTS embeddings (" +
        "model_name TEXT NOT NULL, cache_key TEXT NOT NULL, " +
        "vector BLOB NOT NULL, PRIMARY KEY (model_name, cache_key))",
    );
    const insert = db.prepare(
      "INSERT OR REPLACE INTO embeddings(model_name, cache_key, vector) VALUES (?, ?, ?)",
    );
    db.exec("BEGIN");
    try {
      for (const [text, vector] of entries) {
        insert.run(
          modelName,
          semanticDiskCacheKey(modelName, text),
          float32ToLittleEndianBytes(vector),
        );
      }
      db.exec("COMMIT");
    } catch (txErr) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback errors.
      }
      throw txErr;
    }
  } catch (error) {
    // Disk cache failures never block ranking or training.
    reportDiskCacheFailure("write", error);
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors.
    }
  }
}

function memoryCacheKey(modelName: string, text: string): string {
  return `${modelName}\x00${text}`;
}

function getMemoryCached(modelName: string, text: string): Float32Array | undefined {
  const key = memoryCacheKey(modelName, text);
  const cached = embeddingCache.get(key);
  if (cached !== undefined) {
    embeddingCache.delete(key);
    embeddingCache.set(key, cached);
  }
  return cached;
}

function setMemoryCached(modelName: string, text: string, vector: Float32Array): void {
  const key = memoryCacheKey(modelName, text);
  if (embeddingCache.has(key)) {
    embeddingCache.delete(key);
  }
  embeddingCache.set(key, vector);
  while (embeddingCache.size > SEMANTIC_CACHE_SIZE) {
    const oldest = embeddingCache.keys().next().value;
    if (oldest === undefined) break;
    embeddingCache.delete(oldest);
  }
}

function normalizeUnitRow(raw: ArrayLike<number>): Float32Array {
  const length = raw.length;
  const out = new Float32Array(length);
  let sumSq = 0;
  for (let i = 0; i < length; i += 1) {
    const v = Math.fround(Number(raw[i]));
    out[i] = v;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (norm > 0) {
    for (let i = 0; i < length; i += 1) {
      out[i] = out[i] / norm;
    }
  }
  return out;
}

function normalizeRows(rows: ReadonlyArray<ArrayLike<number>>): Float32Array[] {
  if (rows.length === 0) return [];
  return rows.map((row) => normalizeUnitRow(row));
}

function isPromiseLike<T>(value: Promise<T> | T): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

async function loadTransformersEmbedder(modelName: string): Promise<FeatureExtractorFn> {
  if (isLegacySemanticModel(modelName)) {
    throw new SemanticUnavailable(
      `Legacy semantic model ${modelName} requires retraining with ${DEFAULT_SEMANTIC_MODEL}`,
    );
  }
  if (loadedPipeline !== null && loadedPipelineModel === modelName) {
    return loadedPipeline;
  }
  if (loadedPipelineError !== null && loadedPipelineModel === modelName) {
    throw new SemanticUnavailable(loadedPipelineError);
  }
  if (loadingPipelinePromise !== null && loadingPipelineModel === modelName) {
    return loadingPipelinePromise;
  }

  loadingPipelineModel = modelName;
  loadingPipelinePromise = (async () => {
    try {
      const transformers = await import("@huggingface/transformers");
      const cacheDir = semanticCacheDir();
      fs.mkdirSync(cacheDir, { recursive: true });
      transformers.env.cacheDir = cacheDir;
      const threads = Math.max(1, Math.min(4, os.cpus().length || 1));
      if (transformers.env.backends?.onnx?.wasm) {
        transformers.env.backends.onnx.wasm.numThreads = threads;
      }
      const options = {
        quantized: true,
        dtype: "q8" as const,
        cache_dir: cacheDir,
        session_options: {
          intraOpNumThreads: threads,
          interOpNumThreads: 1,
        },
      };
      const extractor = (await transformers.pipeline(
        "feature-extraction",
        modelName,
        options as unknown as Parameters<typeof transformers.pipeline>[2],
      )) as unknown as FeatureExtractorFn;
      loadedPipeline = extractor;
      loadedPipelineModel = modelName;
      loadedPipelineError = null;
      return extractor;
    } catch (error) {
      const message =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      loadedPipeline = null;
      loadedPipelineModel = modelName;
      loadedPipelineError = message;
      throw new SemanticUnavailable(message);
    } finally {
      loadingPipelinePromise = null;
      loadingPipelineModel = null;
    }
  })();

  return loadingPipelinePromise;
}

async function runTransformersBatch(
  extractor: FeatureExtractorFn,
  batch: string[],
  batchSize: number,
): Promise<Float32Array[]> {
  const results: Float32Array[] = [];
  const step = Math.max(1, batchSize);
  for (let start = 0; start < batch.length; start += step) {
    const subBatch = batch.slice(start, start + step);
    const tensor = await extractor(subBatch, { pooling: "cls", normalize: true });
    try {
      const dims = tensor.dims;
      const data = tensor.data;
      if (!Array.isArray(dims) || dims.length !== 2 || dims[0] !== subBatch.length || dims[1] <= 0) {
        throw new SemanticUnavailable("embedding runtime returned unexpected tensor dimensions");
      }
      const width = dims[1];
      for (let row = 0; row < subBatch.length; row += 1) {
        const offset = row * width;
        const slice = new Float32Array(width);
        for (let col = 0; col < width; col += 1) {
          slice[col] = Number(data[offset + col]);
        }
        results.push(normalizeUnitRow(slice));
      }
    } finally {
      tensor.dispose?.();
    }
  }
  return results;
}

export async function prefetchEmbeddings(
  texts: Iterable<string>,
  modelName: string = DEFAULT_SEMANTIC_MODEL,
  batchSize = 64,
): Promise<Map<string, Float32Array>> {
  const resolved = new Map<string, Float32Array>();
  if (!modelName || isLegacySemanticModel(modelName)) {
    return resolved;
  }
  const uniqueTexts: string[] = [];
  const seen = new Set<string>();
  for (const raw of texts) {
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    const cached = getMemoryCached(modelName, raw);
    if (cached !== undefined) {
      resolved.set(raw, cached);
    } else {
      uniqueTexts.push(raw);
    }
  }
  if (uniqueTexts.length === 0) {
    return resolved;
  }

  const diskValues = loadDiskEmbeddings(modelName, uniqueTexts);
  const missing: string[] = [];
  for (const text of uniqueTexts) {
    const fromDisk = diskValues.get(text);
    if (fromDisk !== undefined) {
      setMemoryCached(modelName, text, fromDisk);
      resolved.set(text, fromDisk);
    } else {
      missing.push(text);
    }
  }

  if (missing.length > 0) {
    const embedded: Float32Array[] = [];
    if (customEmbedder !== null) {
      for (let start = 0; start < missing.length; start += SEMANTIC_MAX_BATCH_TEXTS) {
        const batch = missing.slice(start, start + SEMANTIC_MAX_BATCH_TEXTS);
        const rawOut = await customEmbedder(batch, modelName);
        embedded.push(...normalizeRows(rawOut));
      }
    } else {
      const extractor = await loadTransformersEmbedder(modelName);
      for (let start = 0; start < missing.length; start += SEMANTIC_MAX_BATCH_TEXTS) {
        const batch = missing.slice(start, start + SEMANTIC_MAX_BATCH_TEXTS);
        const subVectors = await runTransformersBatch(extractor, batch, batchSize);
        embedded.push(...subVectors);
      }
    }
    if (embedded.length !== missing.length) {
      throw new SemanticUnavailable("embedding runtime returned an incomplete batch");
    }
    const toSave: Array<[string, Float32Array]> = [];
    for (let i = 0; i < missing.length; i += 1) {
      const text = missing[i];
      const vec = embedded[i];
      setMemoryCached(modelName, text, vec);
      resolved.set(text, vec);
      toSave.push([text, vec]);
    }
    saveDiskEmbeddings(modelName, toSave);
  }

  return resolved;
}

export function embedTexts(
  texts: readonly string[],
  options?: { modelName?: string; batchSize?: number } | string,
): Float32Array[] {
  if (texts.length === 0) return [];
  const modelName =
    typeof options === "string" ? options : (options?.modelName ?? DEFAULT_SEMANTIC_MODEL);
  if (isLegacySemanticModel(modelName)) {
    throw new SemanticUnavailable(
      `Legacy semantic model ${modelName} requires retraining with ${DEFAULT_SEMANTIC_MODEL}`,
    );
  }

  const result: Array<Float32Array | null> = new Array(texts.length).fill(null);
  const pending = new Map<string, number[]>();

  for (let index = 0; index < texts.length; index += 1) {
    const text = texts[index];
    const cached = getMemoryCached(modelName, text);
    if (cached !== undefined) {
      result[index] = cached;
    } else {
      const indices = pending.get(text);
      if (indices) {
        indices.push(index);
      } else {
        pending.set(text, [index]);
      }
    }
  }

  if (pending.size > 0) {
    const diskValues = loadDiskEmbeddings(modelName, [...pending.keys()]);
    for (const [text, vec] of diskValues) {
      setMemoryCached(modelName, text, vec);
      const indices = pending.get(text);
      if (indices) {
        for (const index of indices) {
          result[index] = vec;
        }
        pending.delete(text);
      }
    }
  }

  if (pending.size > 0) {
    if (customEmbedder === null) {
      throw new SemanticUnavailable(
        "Embeddings are not cached in memory or on disk; call prefetchEmbeddings() before synchronous scoring",
      );
    }
    const missing = [...pending.keys()];
    const embedded: Float32Array[] = [];
    for (let start = 0; start < missing.length; start += SEMANTIC_MAX_BATCH_TEXTS) {
      const batch = missing.slice(start, start + SEMANTIC_MAX_BATCH_TEXTS);
      const rawOut = customEmbedder(batch, modelName);
      if (isPromiseLike(rawOut)) {
        throw new SemanticUnavailable(
          "Async custom embedder requires prefetchEmbeddings() before synchronous scoring",
        );
      }
      embedded.push(...normalizeRows(rawOut));
    }
    if (embedded.length !== missing.length) {
      throw new SemanticUnavailable("embedding runtime returned an incomplete batch");
    }
    const toSave: Array<[string, Float32Array]> = [];
    for (let i = 0; i < missing.length; i += 1) {
      const text = missing[i];
      const vec = embedded[i];
      setMemoryCached(modelName, text, vec);
      toSave.push([text, vec]);
      const indices = pending.get(text) ?? [];
      for (const index of indices) {
        result[index] = vec;
      }
    }
    saveDiskEmbeddings(modelName, toSave);
  }

  const finalized: Float32Array[] = [];
  for (const vec of result) {
    if (vec === null) {
      throw new SemanticUnavailable("embedding cache returned an incomplete batch");
    }
    finalized.push(vec);
  }
  return finalized;
}

export function semanticIdf(
  records: ReadonlyArray<ReadonlyArray<readonly [string, string]>>,
): Record<string, number> {
  const documentCount = records.length;
  if (documentCount === 0) {
    return {};
  }
  const frequencies = new Map<string, number>();
  for (const record of records) {
    const seenKeys = new Set<string>();
    for (const [key] of record) {
      seenKeys.add(key);
    }
    for (const key of seenKeys) {
      frequencies.set(key, (frequencies.get(key) ?? 0) + 1);
    }
  }
  // Tags are arbitrary user-visible strings, so the table must not inherit
  // Object.prototype members such as "constructor".
  const idf: Record<string, number> = Object.create(null);
  for (const [key, count] of frequencies) {
    idf[key] = Math.min(5.0, 1.0 + Math.log((documentCount + 1) / (count + 1)));
  }
  return idf;
}

// IDF tables hold thousands of tags and are never mutated once built, while
// the fallback weight is requested once per scored tag set.
const maxIdfCache = new WeakMap<Record<string, number>, number>();

export function maxIdfValue(idf: Record<string, number> | null | undefined): number {
  if (!idf) return 1.0;
  const cached = maxIdfCache.get(idf);
  if (cached !== undefined) return cached;
  let maxVal = -Infinity;
  for (const key in idf) {
    const val = idf[key];
    if (val > maxVal) maxVal = val;
  }
  const result = Number.isFinite(maxVal) ? maxVal : 1.0;
  maxIdfCache.set(idf, result);
  return result;
}

export function pooledVector(
  items: ReadonlyArray<readonly [string, string]>,
  matrix: ReadonlyArray<ArrayLike<number>> | Float32Array,
  idf: Record<string, number> | null | undefined = null,
  explicitDimension?: number,
): Float32Array {
  const rowCount = items.length;
  if (rowCount === 0) {
    return new Float32Array(0);
  }

  let flat: Float32Array;
  let dimension: number;
  if (matrix instanceof Float32Array) {
    dimension = explicitDimension ?? Math.floor(matrix.length / rowCount);
    if (dimension <= 0 || dimension * rowCount !== matrix.length) {
      return new Float32Array(0);
    }
    flat = matrix;
  } else {
    if (matrix.length !== rowCount || matrix.length === 0) {
      return new Float32Array(0);
    }
    dimension = matrix[0].length;
    if (dimension <= 0) {
      return new Float32Array(0);
    }
    flat = new Float32Array(rowCount * dimension);
    for (let r = 0; r < rowCount; r += 1) {
      const row = matrix[r];
      if (row.length !== dimension) {
        return new Float32Array(0);
      }
      const base = r * dimension;
      for (let c = 0; c < dimension; c += 1) {
        flat[base + c] = Number(row[c]);
      }
    }
  }

  const defaultIdf = maxIdfValue(idf);
  const weights = new Float32Array(rowCount);
  let weightSum = 0;
  for (let r = 0; r < rowCount; r += 1) {
    const key = items[r][0];
    const rawW = idf !== null && idf !== undefined ? Math.max(0.05, idf[key] ?? defaultIdf) : 1.0;
    const w = Math.fround(rawW);
    weights[r] = w;
    weightSum += w;
  }
  if (weightSum <= 0) {
    return new Float32Array(0);
  }

  const pooled = new Float32Array(dimension);
  for (let r = 0; r < rowCount; r += 1) {
    const w = weights[r] / weightSum;
    const base = r * dimension;
    for (let c = 0; c < dimension; c += 1) {
      pooled[c] += flat[base + c] * w;
    }
  }

  let normSq = 0;
  for (let c = 0; c < dimension; c += 1) {
    normSq += pooled[c] * pooled[c];
  }
  const norm = Math.sqrt(normSq);
  if (norm <= 0) {
    return new Float32Array(0);
  }
  for (let c = 0; c < dimension; c += 1) {
    pooled[c] = pooled[c] / norm;
  }
  return pooled;
}

export function embedTagSets(
  records: ReadonlyArray<ReadonlyArray<readonly [string, string]>>,
  options: { modelName: string; idf?: Record<string, number> | null },
): SemanticTagSet[] {
  const materialized = records.map((record) => [...record]);
  const uniqueTexts: string[] = [];
  const seenTexts = new Set<string>();
  for (const record of materialized) {
    for (const [, text] of record) {
      if (text && !seenTexts.has(text)) {
        seenTexts.add(text);
        uniqueTexts.push(text);
      }
    }
  }
  const vectors = embedTexts(uniqueTexts, { modelName: options.modelName });
  const byText = new Map<string, Float32Array>();
  for (let i = 0; i < uniqueTexts.length; i += 1) {
    byText.set(uniqueTexts[i], vectors[i]);
  }

  return materialized.map((record) => {
    const cleanItems: Array<[string, string]> = [];
    for (const [key, text] of record) {
      if (byText.has(text)) {
        cleanItems.push([key, text]);
      }
    }
    if (cleanItems.length === 0) {
      return {
        items: cleanItems,
        matrix: new Float32Array(0),
        dimension: 0,
        pooled: new Float32Array(0),
      };
    }
    const firstVec = byText.get(cleanItems[0][1])!;
    const dimension = firstVec.length;
    const matrix = new Float32Array(cleanItems.length * dimension);
    const rowVectors: Float32Array[] = new Array(cleanItems.length);
    for (let r = 0; r < cleanItems.length; r += 1) {
      const vec = byText.get(cleanItems[r][1])!;
      matrix.set(vec, r * dimension);
      rowVectors[r] = vec;
    }
    return {
      items: cleanItems,
      matrix,
      dimension,
      pooled: pooledVector(cleanItems, matrix, options.idf ?? null, dimension),
      rowVectors,
    };
  });
}

export function embedPooledTagSets(
  records: ReadonlyArray<ReadonlyArray<readonly [string, string]>>,
  options: { modelName: string; idf?: Record<string, number> | null },
): { matrix: Float32Array; rows: number; dimension: number } {
  let dimension = 0;
  const rowVectors: Float32Array[] = [];
  for (let start = 0; start < records.length; start += SEMANTIC_MAX_BATCH_RECORDS) {
    const batch = embedTagSets(records.slice(start, start + SEMANTIC_MAX_BATCH_RECORDS), options);
    if (dimension === 0) {
      for (const tagSet of batch) {
        if (tagSet.pooled.length > 0) {
          dimension = tagSet.pooled.length;
          break;
        }
      }
    }
    for (const tagSet of batch) {
      rowVectors.push(
        dimension > 0 && tagSet.pooled.length === dimension
          ? tagSet.pooled
          : new Float32Array(dimension),
      );
    }
  }
  if (dimension === 0) {
    return { matrix: new Float32Array(0), rows: records.length, dimension: 0 };
  }
  const matrix = new Float32Array(records.length * dimension);
  for (let r = 0; r < rowVectors.length; r += 1) {
    matrix.set(rowVectors[r], r * dimension);
  }
  return { matrix, rows: records.length, dimension };
}

export interface TagSetLike {
  readonly items: ReadonlyArray<readonly [string, string]>;
  readonly matrix: Float32Array | ReadonlyArray<ArrayLike<number>>;
  readonly dimension?: number;
  readonly rowVectors?: ReadonlyArray<Float32Array>;
}

function ensureFlatMatrix(set: TagSetLike): { flat: Float32Array; dimension: number } {
  const count = set.items.length;
  if (count === 0) {
    return { flat: new Float32Array(0), dimension: 0 };
  }
  if (set.matrix instanceof Float32Array) {
    const dim = set.dimension ?? Math.floor(set.matrix.length / count);
    if (dim <= 0 || dim * count !== set.matrix.length) {
      return { flat: new Float32Array(0), dimension: 0 };
    }
    return { flat: set.matrix, dimension: dim };
  }
  if (set.matrix.length !== count) {
    return { flat: new Float32Array(0), dimension: 0 };
  }
  const dim = set.matrix[0].length;
  const flat = new Float32Array(count * dim);
  for (let r = 0; r < count; r += 1) {
    const row = set.matrix[r];
    const base = r * dim;
    for (let c = 0; c < dim; c += 1) {
      flat[base + c] = Number(row[c]);
    }
  }
  return { flat, dimension: dim };
}

function makeTagMaxSimResult(score: number, matches: TagMaxSimMatch[]): TagMaxSimResult {
  return Object.assign([score, matches] as [number, TagMaxSimMatch[]], {
    score,
    matches,
  });
}

function directionalMaxSim(
  leftItems: ReadonlyArray<readonly [string, string]>,
  leftFlat: Float32Array,
  rightItems: ReadonlyArray<readonly [string, string]>,
  rightFlat: Float32Array,
  dimension: number,
  idf: Record<string, number>,
  defaultIdf: number,
  collectMatches: boolean,
): { score: number; matches: TagMaxSimMatch[] } {
  const leftLen = leftItems.length;
  const rightLen = rightItems.length;
  if (leftLen === 0 || rightLen === 0 || dimension <= 0) {
    return { score: 0.0, matches: [] };
  }

  let weightedSum = 0;
  let weightTotal = 0;
  const matches: TagMaxSimMatch[] = collectMatches ? new Array(leftLen) : [];

  for (let i = 0; i < leftLen; i += 1) {
    const leftOffset = i * dimension;
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let j = 0; j < rightLen; j += 1) {
      const rightOffset = j * dimension;
      let dot = 0;
      for (let d = 0; d < dimension; d += 1) {
        dot += leftFlat[leftOffset + d] * rightFlat[rightOffset + d];
      }
      const score32 = Math.fround(dot);
      if (score32 > bestScore) {
        bestScore = score32;
        bestIndex = j;
      }
    }
    const key = leftItems[i][0];
    const w = Math.fround(Math.max(0.05, idf[key] ?? defaultIdf));
    weightedSum += w * bestScore;
    weightTotal += w;
    if (collectMatches) {
      matches[i] = [key, rightItems[bestIndex][0], bestScore];
    }
  }

  const score = weightedSum / Math.max(weightTotal, 1e-12);
  return { score, matches };
}

export function tagMaxSim(
  left: TagSetLike,
  right: TagSetLike,
  idf: Record<string, number>,
  options?: { floor?: number } | number,
): TagMaxSimResult {
  const floor =
    typeof options === "number" ? options : (options?.floor ?? SEMANTIC_SIMILARITY_FLOOR);
  if (left.items.length === 0 || right.items.length === 0) {
    return makeTagMaxSimResult(0.0, []);
  }
  const leftMat = ensureFlatMatrix(left);
  const rightMat = ensureFlatMatrix(right);
  if (leftMat.dimension <= 0 || leftMat.dimension !== rightMat.dimension) {
    return makeTagMaxSimResult(0.0, []);
  }
  const defaultIdf = maxIdfValue(idf);
  const forward = directionalMaxSim(
    left.items,
    leftMat.flat,
    right.items,
    rightMat.flat,
    leftMat.dimension,
    idf,
    defaultIdf,
    true,
  );
  const reverse = directionalMaxSim(
    right.items,
    rightMat.flat,
    left.items,
    leftMat.flat,
    leftMat.dimension,
    idf,
    defaultIdf,
    false,
  );
  const raw = (forward.score + reverse.score) / 2;
  const adjusted = Math.max(0.0, Math.min(1.0, (raw - floor) / Math.max(1e-9, 1.0 - floor)));
  const strongest = [...forward.matches]
    .sort((a, b) => b[2] - a[2] || compareStrings(a[0], b[0]) || compareStrings(a[1], b[1]))
    .slice(0, 4);
  return makeTagMaxSimResult(adjusted, strongest);
}

export function tagMaxSimMany(
  left: TagSetLike,
  rights: ReadonlyArray<TagSetLike>,
  idf: Record<string, number>,
  options?: { floor?: number; includeMatches?: boolean; include_matches?: boolean },
): TagMaxSimResult[] {
  if (rights.length === 0) return [];
  const floor = options?.floor ?? SEMANTIC_SIMILARITY_FLOOR;
  const includeMatches = options?.includeMatches ?? options?.include_matches ?? true;
  if (left.items.length === 0) {
    return rights.map(() => makeTagMaxSimResult(0.0, []));
  }
  const leftMat = ensureFlatMatrix(left);
  if (leftMat.dimension <= 0) {
    return rights.map(() => makeTagMaxSimResult(0.0, []));
  }
  const dimension = leftMat.dimension;
  const defaultIdf = maxIdfValue(idf);
  const leftLen = left.items.length;
  const leftWeights = new Float32Array(leftLen);
  let leftWeightTotal = 0;
  for (let i = 0; i < leftLen; i += 1) {
    const w = Math.fround(Math.max(0.05, idf[left.items[i][0]] ?? defaultIdf));
    leftWeights[i] = w;
    leftWeightTotal += w;
  }
  leftWeightTotal = Math.max(leftWeightTotal, 1e-12);

  // Row views keep the innermost product on plain typed-array reads.
  const leftRows: Float32Array[] = new Array(leftLen);
  for (let i = 0; i < leftLen; i += 1) {
    leftRows[i] = leftMat.flat.subarray(i * dimension, (i + 1) * dimension);
  }

  // Similarities of every left tag against one shared right-hand embedding.
  const columnCache = new Map<Float32Array, Float32Array>();
  const columns: Float32Array[] = [];

  const results: TagMaxSimResult[] = new Array(rights.length);
  const bestRightIndices = new Int32Array(leftLen);
  const forwardScores = new Float32Array(leftLen);
  const reverseScores = new Float32Array(SEMANTIC_MAX_TAGS + 4);

  for (let rIdx = 0; rIdx < rights.length; rIdx += 1) {
    const right = rights[rIdx];
    const rightLen = right.items.length;
    if (rightLen === 0) {
      results[rIdx] = makeTagMaxSimResult(0.0, []);
      continue;
    }
    const rightMat = ensureFlatMatrix(right);
    if (rightMat.dimension !== dimension) {
      results[rIdx] = makeTagMaxSimResult(0.0, []);
      continue;
    }
    const revBuf = rightLen <= reverseScores.length ? reverseScores : new Float32Array(rightLen);
    for (let j = 0; j < rightLen; j += 1) {
      revBuf[j] = -Infinity;
    }

    const rightFlat = rightMat.flat;
    const rightVectors =
      right.rowVectors !== undefined && right.rowVectors.length === rightLen
        ? right.rowVectors
        : null;
    for (let j = 0; j < rightLen; j += 1) {
      const shared = rightVectors === null ? undefined : rightVectors[j];
      let column = shared === undefined ? undefined : columnCache.get(shared);
      if (column === undefined) {
        column = new Float32Array(leftLen);
        const rightOffset = j * dimension;
        for (let i = 0; i < leftLen; i += 1) {
          const leftRow = leftRows[i];
          let dot = 0;
          for (let d = 0; d < dimension; d += 1) {
            dot += leftRow[d] * rightFlat[rightOffset + d];
          }
          column[i] = dot;
        }
        if (shared !== undefined) columnCache.set(shared, column);
      }
      columns[j] = column;
    }

    let forwardWeighted = 0;
    for (let i = 0; i < leftLen; i += 1) {
      let bestJ = 0;
      let bestScore = -Infinity;
      for (let j = 0; j < rightLen; j += 1) {
        const score32 = columns[j][i];
        if (score32 > bestScore) {
          bestScore = score32;
          bestJ = j;
        }
        if (score32 > revBuf[j]) {
          revBuf[j] = score32;
        }
      }
      bestRightIndices[i] = bestJ;
      forwardScores[i] = bestScore;
      forwardWeighted += leftWeights[i] * bestScore;
    }

    const forward = forwardWeighted / leftWeightTotal;
    let reverseWeighted = 0;
    let rightWeightTotal = 0;
    for (let j = 0; j < rightLen; j += 1) {
      const rw = Math.fround(Math.max(0.05, idf[right.items[j][0]] ?? defaultIdf));
      reverseWeighted += rw * revBuf[j];
      rightWeightTotal += rw;
    }
    const reverse = reverseWeighted / Math.max(rightWeightTotal, 1e-12);
    const adjusted = Math.max(
      0.0,
      Math.min(1.0, ((forward + reverse) / 2 - floor) / Math.max(1e-9, 1.0 - floor)),
    );

    let strongest: TagMaxSimMatch[] = [];
    if (includeMatches) {
      const matches: TagMaxSimMatch[] = new Array(leftLen);
      for (let i = 0; i < leftLen; i += 1) {
        matches[i] = [
          left.items[i][0],
          right.items[bestRightIndices[i]][0],
          forwardScores[i],
        ];
      }
      strongest = matches
        .sort((a, b) => b[2] - a[2] || compareStrings(a[0], b[0]) || compareStrings(a[1], b[1]))
        .slice(0, 4);
    }
    results[rIdx] = makeTagMaxSimResult(adjusted, strongest);
  }
  return results;
}

export function weightedTagJaccard(
  left: ReadonlyArray<readonly [string, string] | string>,
  right: ReadonlyArray<readonly [string, string] | string>,
  idf: Record<string, number>,
  options?: { defaultIdf?: number | null } | number | null,
): number {
  const leftLen = left.length;
  const rightLen = right.length;
  if (leftLen === 0 && rightLen === 0) {
    return 0.0;
  }
  const resolvedDefault =
    typeof options === "number"
      ? options
      : (options?.defaultIdf ?? maxIdfValue(idf));

  // Tag sets from semanticTagItems are already deduplicated and sorted with
  // compareStrings; scan in lockstep to avoid allocating Sets on every pair.
  let sortedUnique = true;
  let leftSum = 0;
  let prevLeft = "";
  for (let i = 0; i < leftLen; i += 1) {
    const item = left[i];
    const key = typeof item === "string" ? item : item[0];
    if (i > 0 && !(prevLeft < key)) {
      sortedUnique = false;
      break;
    }
    prevLeft = key;
    leftSum += idf[key] ?? resolvedDefault;
  }
  if (sortedUnique) {
    let prevRight = "";
    for (let j = 0; j < rightLen; j += 1) {
      const item = right[j];
      const key = typeof item === "string" ? item : item[0];
      if (j > 0 && !(prevRight < key)) {
        sortedUnique = false;
        break;
      }
      prevRight = key;
    }
  }
  if (sortedUnique) {
    let denominator = leftSum;
    let numerator = 0;
    let i = 0;
    let j = 0;
    while (i < leftLen && j < rightLen) {
      const leftItem = left[i];
      const rightItem = right[j];
      const lk = typeof leftItem === "string" ? leftItem : leftItem[0];
      const rk = typeof rightItem === "string" ? rightItem : rightItem[0];
      if (lk === rk) {
        numerator += idf[lk] ?? resolvedDefault;
        i += 1;
        j += 1;
      } else if (lk < rk) {
        i += 1;
      } else {
        denominator += idf[rk] ?? resolvedDefault;
        j += 1;
      }
    }
    while (j < rightLen) {
      const rightItem = right[j];
      const rk = typeof rightItem === "string" ? rightItem : rightItem[0];
      denominator += idf[rk] ?? resolvedDefault;
      j += 1;
    }
    return numerator / Math.max(denominator, 1e-12);
  }

  const leftKeys = new Set<string>();
  for (const item of left) {
    leftKeys.add(typeof item === "string" ? item : item[0]);
  }
  const rightKeys = new Set<string>();
  for (const item of right) {
    rightKeys.add(typeof item === "string" ? item : item[0]);
  }
  if (leftKeys.size === 0 && rightKeys.size === 0) {
    return 0.0;
  }
  const union = new Set<string>(leftKeys);
  for (const key of rightKeys) {
    union.add(key);
  }
  if (union.size === 0) {
    return 0.0;
  }
  let denominator = 0;
  for (const key of union) {
    denominator += idf[key] ?? resolvedDefault;
  }
  let numerator = 0;
  for (const key of leftKeys) {
    if (rightKeys.has(key)) {
      numerator += idf[key] ?? resolvedDefault;
    }
  }
  return numerator / Math.max(denominator, 1e-12);
}

export function balancedWeights(examples: ReadonlyArray<PreferenceExample>): number[] {
  let total0 = 0;
  let total1 = 0;
  for (const example of examples) {
    const baseWeight = example.base_weight ?? example.baseWeight ?? 1.0;
    if (example.label === 1) {
      total1 += baseWeight;
    } else if (example.label === 0) {
      total0 += baseWeight;
    }
  }
  if (total0 <= 0 || total1 <= 0) {
    throw new SemanticUnavailable("semantic head needs both explicit feedback classes");
  }
  const target = (total0 + total1) / 2;
  return examples.map((example) => {
    const baseWeight = example.base_weight ?? example.baseWeight ?? 1.0;
    const classTotal = example.label === 1 ? total1 : total0;
    return (baseWeight * target) / classTotal;
  });
}

export function fitDenseLogistic(
  embeddings: ReadonlyArray<ArrayLike<number>>,
  labels: ArrayLike<number>,
  sampleWeights: ArrayLike<number>,
  options?: { epochs?: number } | number,
): DenseLogisticFit {
  const epochs = typeof options === "number" ? options : (options?.epochs ?? SEMANTIC_EPOCHS);
  const rowCount = embeddings.length;
  if (rowCount === 0 || rowCount !== labels.length || labels.length !== sampleWeights.length) {
    throw new SemanticUnavailable("invalid semantic training matrix");
  }
  const dimension = embeddings[0].length;
  if (dimension <= 0) {
    throw new SemanticUnavailable("invalid semantic training matrix");
  }

  const x = new Float64Array(rowCount * dimension);
  for (let r = 0; r < rowCount; r += 1) {
    const row = embeddings[r];
    if (row.length !== dimension) {
      throw new SemanticUnavailable("invalid semantic training matrix");
    }
    const base = r * dimension;
    for (let c = 0; c < dimension; c += 1) {
      x[base + c] = Number(row[c]);
    }
  }

  const y = new Float64Array(rowCount);
  const weights = new Float64Array(rowCount);
  let weightTotal = 0;
  for (let r = 0; r < rowCount; r += 1) {
    y[r] = Number(labels[r]);
    const w = Number(sampleWeights[r]);
    weights[r] = w;
    weightTotal += w;
  }
  const meanWeight = Math.max(weightTotal / rowCount, 1e-12);
  for (let r = 0; r < rowCount; r += 1) {
    weights[r] = weights[r] / meanWeight;
  }

  const coefficients = new Float64Array(dimension);
  let bias = 0.0;
  const first = new Float64Array(dimension);
  const second = new Float64Array(dimension);
  let firstBias = 0.0;
  let secondBias = 0.0;

  const regularization = 0.08;
  const learningRate = 0.035;
  const beta1 = 0.9;
  const beta2 = 0.999;
  const epsilon = 1e-8;
  const residual = new Float64Array(rowCount);
  const gradient = new Float64Array(dimension);
  const denomN = Math.max(rowCount, 1.0);

  for (let step = 1; step <= epochs; step += 1) {
    let gradientBias = 0.0;
    for (let r = 0; r < rowCount; r += 1) {
      const base = r * dimension;
      let dot = bias;
      for (let c = 0; c < dimension; c += 1) {
        dot += x[base + c] * coefficients[c];
      }
      const logit = dot < -35 ? -35 : dot > 35 ? 35 : dot;
      const prob = 1.0 / (1.0 + Math.exp(-logit));
      const res = ((prob - y[r]) * weights[r]) / denomN;
      residual[r] = res;
      gradientBias += res;
    }

    for (let c = 0; c < dimension; c += 1) {
      gradient[c] = regularization * coefficients[c];
    }
    for (let r = 0; r < rowCount; r += 1) {
      const res = residual[r];
      const base = r * dimension;
      for (let c = 0; c < dimension; c += 1) {
        gradient[c] += x[base + c] * res;
      }
    }

    const correction1 = 1.0 - beta1 ** step;
    const correction2 = 1.0 - beta2 ** step;

    for (let c = 0; c < dimension; c += 1) {
      const g = gradient[c];
      first[c] = beta1 * first[c] + (1.0 - beta1) * g;
      second[c] = beta2 * second[c] + (1.0 - beta2) * g * g;
      const mHat = first[c] / correction1;
      const vHat = second[c] / correction2;
      coefficients[c] -= (learningRate * mHat) / (Math.sqrt(vHat) + epsilon);
    }

    firstBias = beta1 * firstBias + (1.0 - beta1) * gradientBias;
    secondBias = beta2 * secondBias + (1.0 - beta2) * gradientBias * gradientBias;
    bias -=
      (learningRate * (firstBias / correction1)) /
      (Math.sqrt(secondBias / correction2) + epsilon);
  }

  const weightsOut = Array.from(coefficients);
  return Object.assign([bias, weightsOut] as [number, number[]], {
    bias,
    weights: weightsOut,
  });
}

export function fitSemanticHead(
  examples: ReadonlyArray<PreferenceExample>,
  options?: { modelName?: string } | string,
): SemanticHead | null {
  const modelName =
    typeof options === "string" ? options : (options?.modelName ?? DEFAULT_SEMANTIC_MODEL);
  const explicit = examples.filter((example) => {
    const isBan = example.is_explicit_ban ?? example.isExplicitBan ?? false;
    const isKeep = example.is_explicit_keep ?? example.isExplicitKeep ?? false;
    const isFav = example.is_favorite ?? example.isFavorite ?? false;
    return isBan || isKeep || isFav;
  });
  if (explicit.length < SEMANTIC_MIN_EXAMPLES) {
    return null;
  }
  let count0 = 0;
  let count1 = 0;
  for (const example of explicit) {
    if (example.label === 1) count1 += 1;
    else if (example.label === 0) count0 += 1;
  }
  if (Math.min(count0, count1) < Math.floor(SEMANTIC_MIN_EXAMPLES / 2)) {
    return null;
  }

  const semanticRecords = explicit.map((example) => {
    const semTags = example.semantic_tags ?? example.semanticTags;
    const baseItems =
      semTags && semTags.length > 0 ? semTags : semanticTagItems(example.tags);
    const ctx = example.context_features ?? example.contextFeatures ?? [];
    return semanticItemsWithContext(baseItems, ctx);
  });

  const tagSets = embedTagSets(semanticRecords, { modelName });
  const vectors = tagSets.map((set) => set.pooled);
  if (vectors.length === 0 || vectors[0].length === 0) {
    return null;
  }
  const [bias, coefficients] = fitDenseLogistic(
    vectors,
    explicit.map((example) => example.label),
    balancedWeights(explicit),
  );
  return new SemanticHead({
    modelName,
    bias,
    weights: coefficients,
    examples: explicit.length,
    positives: count1,
    negatives: count0,
  });
}

export function scoreEmbedding(
  head: SemanticHead,
  embedding: ArrayLike<number> | null | undefined,
): number {
  if (!embedding || embedding.length !== head.dimension || head.dimension === 0) {
    return 0.0;
  }
  let dot = 0.0;
  for (let i = 0; i < head.dimension; i += 1) {
    dot += Math.fround(head.weights[i]) * Math.fround(Number(embedding[i]));
  }
  return head.bias + dot;
}

export function semanticProbability(score: number): number {
  return sigmoidLocal(score);
}
