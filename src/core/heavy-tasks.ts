import fs from "node:fs";
import path from "node:path";
import type { ImageMetadata } from "../shared/types";
import { ImageCatalog, loadSuggestionCatalog } from "./catalog";
import type { WayperConfig } from "./config";
import { loadMetadata } from "./pool";
import {
  loadPreferenceModel,
  modelReport,
  prefetchModelEmbeddings,
  preferenceLearningStatus,
  preferenceModelPath,
  trainAndSaveLocalPreferenceModel,
} from "./preference/ledger";
import { predictionToDict, preferenceCandidate, preferenceDecisionScore } from "./preference/model";
import { preferenceDeletionSuggestions } from "./preference/review";
import {
  suggestComboPatterns,
  suggestComboRefinements,
  suggestTagsToExclude,
  suggestUploadersToExclude,
} from "./suggestions";

type JsonRecord = Record<string, unknown>;
type ModelTaskConfig = Pick<WayperConfig, "download_dir">;

const MODEL_DETAIL_KEYS = [
  "schema_version",
  "feature_normalization",
  "trained_at",
  "decision_threshold",
  "decision_strategy",
] as const;

const ITEM_DETAIL_KEYS = [
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
  "rank",
  "percentile",
] as const;

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function modelReviewItemDetails(report: JsonRecord, item: JsonRecord): JsonRecord | null {
  const details: JsonRecord = {};
  for (const key of MODEL_DETAIL_KEYS) {
    if (isPrimitive(report[key])) details[key] = report[key];
  }
  for (const key of ITEM_DETAIL_KEYS) {
    if (isPrimitive(item[key])) details[key] = item[key];
  }
  for (const key of ["neighbor_nearest_dislike", "neighbor_nearest_keep"]) {
    const value = item[key];
    if (!isRecord(value)) continue;
    const nested: JsonRecord = {};
    for (const [name, entry] of Object.entries(value)) {
      if (isPrimitive(entry)) nested[name] = entry;
    }
    details[key] = nested;
  }
  return Object.keys(details).length > 0 ? details : null;
}

let suggestionCatalogMemo: { key: string; catalog: ImageCatalog } | null = null;

/** Tag, combo and uploader suggestions for one library state share a catalog. */
function suggestionCatalog(
  config: ModelTaskConfig,
  purities: string[],
  stateKey: string,
): ImageCatalog {
  if (suggestionCatalogMemo?.key !== stateKey) {
    suggestionCatalogMemo = { key: stateKey, catalog: loadSuggestionCatalog(config, { purities }) };
  }
  return suggestionCatalogMemo.catalog;
}

let searchCatalogMemo: { key: string; catalog: ImageCatalog } | null = null;
let metadataMemo: { key: string; metadata: Record<string, ImageMetadata> } | null = null;

function metadataStateKey(config: ModelTaskConfig): string {
  const root = path.resolve(config.download_dir);
  const target = path.join(root, ".metadata.json");
  try {
    const stat = fs.statSync(target);
    return `${root}|${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  } catch {
    return `${root}|0:0:0`;
  }
}

function cachedMetadata(config: ModelTaskConfig): Record<string, ImageMetadata> {
  const key = metadataStateKey(config);
  if (metadataMemo?.key !== key) {
    metadataMemo = { key, metadata: loadMetadata(config) };
  }
  return metadataMemo.metadata;
}

/** Search only needs metadata, so its catalog outlives blacklist and pool changes. */
function searchCatalog(config: ModelTaskConfig, stateKey: string): ImageCatalog {
  if (searchCatalogMemo?.key !== stateKey) {
    searchCatalogMemo = { key: stateKey, catalog: new ImageCatalog(cachedMetadata(config)) };
  }
  return searchCatalogMemo.catalog;
}

export const heavyTasks = {
  async searchImages(args: {
    config: ModelTaskConfig;
    stateKey: string;
    query: string;
    tags: string[];
    uploader: string;
  }): Promise<{ matches: string[]; suggestions: string[]; uploader_suggestions?: string[] }> {
    const result = searchCatalog(args.config, args.stateKey).search({
      query: args.query,
      tags: args.tags,
      uploader: args.uploader,
    });
    if (args.tags.length > 0 || args.uploader) {
      return { matches: [...result.matches], suggestions: [] };
    }
    return {
      matches: [...result.matches],
      suggestions: [...result.tag_suggestions],
      uploader_suggestions: [...result.uploader_suggestions],
    };
  },

  async tagSuggestions(args: {
    config: ModelTaskConfig;
    purities: string[];
    stateKey: string;
    contextTags: string[];
    excludeTags: string[];
    excludeCombos: string[][];
  }): Promise<JsonRecord> {
    const catalog = suggestionCatalog(args.config, args.purities, args.stateKey);
    const { metadata, bannedFilenames: banned, favoriteFilenames: favorites } = catalog;
    if (args.contextTags.length > 0) {
      return {
        suggestions: suggestComboRefinements(
          metadata,
          banned,
          args.contextTags,
          args.excludeTags,
          args.excludeCombos,
          favorites,
        ),
        context: args.contextTags,
      };
    }
    return {
      suggestions: suggestTagsToExclude(
        metadata,
        banned,
        args.excludeTags,
        args.excludeCombos,
        favorites,
      ),
      combo_suggestions: suggestComboPatterns(
        metadata,
        banned,
        args.excludeTags,
        args.excludeCombos,
        favorites,
      ),
    };
  },

  async uploaderSuggestions(args: {
    config: ModelTaskConfig;
    purities: string[];
    stateKey: string;
    excludeUploaders: string[];
  }): Promise<JsonRecord> {
    const catalog = suggestionCatalog(args.config, args.purities, args.stateKey);
    return {
      suggestions: suggestUploadersToExclude(
        catalog.metadata,
        catalog.bannedFilenames,
        args.excludeUploaders,
        catalog.favoriteFilenames,
      ),
    };
  },

  async preferenceSuggestions(args: {
    config: ModelTaskConfig;
    purities: string[];
    orientation: string | null;
    limit: number | null;
  }): Promise<JsonRecord> {
    return preferenceDeletionSuggestions(args.config, {
      purities: args.purities,
      orientation: args.orientation,
      limit: args.limit,
      includeLearning: false,
      metadataSnapshot: cachedMetadata(args.config) as Record<string, Record<string, unknown>>,
    });
  },

  async reviewFeedbackDetails(args: {
    config: ModelTaskConfig;
    filename: string;
  }): Promise<JsonRecord | null> {
    const metadata = cachedMetadata(args.config)[args.filename] as JsonRecord | undefined;
    if (!isRecord(metadata) || !Array.isArray(metadata.tags) || metadata.tags.length === 0) {
      return null;
    }
    const modelPath = preferenceModelPath(args.config);
    const model = loadPreferenceModel(modelPath);
    if (model === null) return null;
    await prefetchModelEmbeddings(model, [[metadata.tags, metadata, null]]);
    const prediction = model.predict(metadata.tags, { metadata, topN: 20 });
    if (!preferenceCandidate(model, prediction)) return null;
    return modelReviewItemDetails(modelReport(model, modelPath), {
      ...predictionToDict(prediction),
      decision_score: preferenceDecisionScore(model, prediction),
    });
  },

  async trainNow(args: {
    config: ModelTaskConfig;
    comboMinSupport?: number;
    maxComboFeatures?: number;
    epochs?: number;
  }): Promise<JsonRecord> {
    const [model, snapshot] = await trainAndSaveLocalPreferenceModel(args.config, {
      comboMinSupport: args.comboMinSupport,
      maxComboFeatures: args.maxComboFeatures,
      epochs: args.epochs,
    });
    return modelReport(
      model,
      preferenceModelPath(args.config),
      preferenceLearningStatus(args.config, model, snapshot),
    );
  },
};

export type HeavyTaskName = keyof typeof heavyTasks;
export type HeavyTaskArgs<Name extends HeavyTaskName> = Parameters<(typeof heavyTasks)[Name]>[0];
export type HeavyTaskResult<Name extends HeavyTaskName> = Awaited<
  ReturnType<(typeof heavyTasks)[Name]>
>;

export type HeavyTaskRunner = <Name extends HeavyTaskName>(
  name: Name,
  args: HeavyTaskArgs<Name>,
) => Promise<HeavyTaskResult<Name>>;

export const runHeavyTaskInProcess: HeavyTaskRunner = (name, args) =>
  (heavyTasks[name] as (input: unknown) => Promise<unknown>)(args) as Promise<never>;
