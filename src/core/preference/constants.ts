export const MODEL_SCHEMA_VERSION = 6;
export const LEGACY_MODEL_SCHEMA_VERSION = 1;
export const SPARSE_MODEL_SCHEMA_VERSION = 2;
export const CALIBRATED_MODEL_SCHEMA_VERSION = 3;
export const CONTENT_NEIGHBOR_MODEL_SCHEMA_VERSION = 4;
export const TAG_SEMANTIC_MODEL_SCHEMA_VERSION = 5;

export const SUPPORTED_MODEL_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([
  LEGACY_MODEL_SCHEMA_VERSION,
  SPARSE_MODEL_SCHEMA_VERSION,
  CALIBRATED_MODEL_SCHEMA_VERSION,
  CONTENT_NEIGHBOR_MODEL_SCHEMA_VERSION,
  TAG_SEMANTIC_MODEL_SCHEMA_VERSION,
  MODEL_SCHEMA_VERSION,
]);

export const NEIGHBOR_HEAD_SCHEMA_VERSION = 2;
export const LEGACY_NEIGHBOR_HEAD_SCHEMA_VERSION = 1;

export const DECISION_CALIBRATION_VERSION = 8;
export const DECISION_CALIBRATION_OBJECTIVE = "two_stage_precision_at_least_0_80";

export const DEFAULT_COMBO_MIN_SUPPORT = 20;
export const DEFAULT_MAX_COMBO_FEATURES = 0;
export const DEFAULT_UPLOADER_MIN_SUPPORT = 10;
export const DEFAULT_EPOCHS = 6;
export const DEFAULT_NEIGHBOR_K = 35;
export const DEFAULT_TRAINING_MAX_EXAMPLES = 2048;
export const DEFAULT_NEIGHBOR_MIN_SIMILARITY = 0.15;
export const DEFAULT_DECISION_THRESHOLD = 0.80;
export const DECISION_TARGET_PRECISION = 0.80;
export const DECISION_MINIMUM_BOUNDARY = 0.50;
export const DECISION_CALIBRATION_FRACTION = 0.20;
export const DECISION_CALIBRATION_MAX_PER_CLASS = 320;
export const DEFAULT_SEMANTIC_NEIGHBOR_VOTE_WEIGHT = 0.80;
export const DEFAULT_FAVORITE_WEIGHT = 4.0;
export const DEFAULT_RECENCY_HALF_LIFE_DAYS = 90;
export const DEFAULT_FEATURE_NORMALIZATION = "field_l2";
export const MIN_TRAINING_PER_CLASS = 10;
export const MIN_VALIDATION_PER_CLASS = 5;

export const DEFAULT_SEMANTIC_MODEL = "Xenova/bge-small-en-v1.5";
export const LEGACY_SEMANTIC_MODEL_NAMES: ReadonlySet<string> = new Set([
  "BAAI/bge-small-en-v1.5",
]);
export const SEMANTIC_DIMENSION = 384;
export const DEFAULT_SEMANTIC_BLEND = 0.65;
export const SEMANTIC_MIN_EXAMPLES = 20;
export const SEMANTIC_EPOCHS = 160;
export const SEMANTIC_CACHE_SIZE = 8192;
export const SEMANTIC_MAX_BATCH_TEXTS = 256;
export const SEMANTIC_MAX_BATCH_RECORDS = 256;
export const SEMANTIC_MAX_TAGS = 32;
export const SEMANTIC_COARSE_PER_CLASS = 48;
export const SEMANTIC_EXACT_PER_CLASS = 32;
export const SEMANTIC_FINE_PER_CLASS = 16;
export const SEMANTIC_FINE_CACHE_SIZE = 4096;
export const SEMANTIC_SIMILARITY_FLOOR = 0.65;
export const SEMANTIC_EXACT_WEIGHT = 0.45;
export const SEMANTIC_TAG_WEIGHT = 0.45;
export const SEMANTIC_CONTEXT_WEIGHT = 0.10;
export const SEMANTIC_NEIGHBOR_SIMILARITY_FLOOR = 0.12;

export const DEFAULT_REVIEW_LIMIT = 24;
export const DEFAULT_REVIEW_REASON_LIMIT = 2;
export const PREFERENCE_PREDICTION_BATCH_SIZE = 64;
export const AUTO_RETRAIN_MIN_FEEDBACK = 10;
export const AUTO_RETRAIN_MIN_CHANGED_EXAMPLES = 12;
export const AUTO_RETRAIN_DELAY_SECONDS = 5;
export const AUTO_RETRAIN_WORKER_STALE_SECONDS = 30 * 60;

export const MODEL_REVIEW_SCHEMA_VERSION = 1;
export const FEEDBACK_SCHEMA_VERSION = 2;
export const LEGACY_FEEDBACK_SCHEMA_VERSION = 1;
export const HISTORICAL_BAN_SCHEMA_VERSION = 1;

export const PAIR_SEPARATOR = "\x1f";
export const CONTEXT_FIELDS: ReadonlySet<string> = new Set([
  "color",
  "category",
  "purity",
  "uploader",
]);
export const FEEDBACK_ACTIONS: ReadonlySet<string> = new Set([
  "ban",
  "dislike",
  "unban",
  "favorite",
  "unfavorite",
  "keep",
]);
export const MODEL_REVIEW_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "keep",
  "ban",
  "filter",
]);

export const PREFERENCE_PURITIES = ["sfw", "sketchy", "nsfw"] as const;
export const PREFERENCE_ORIENTATIONS = ["landscape", "portrait"] as const;
export const PREFERENCE_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
]);

export function isLegacySemanticModel(modelName: string | null | undefined): boolean {
  return typeof modelName === "string" && LEGACY_SEMANTIC_MODEL_NAMES.has(modelName);
}

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}
