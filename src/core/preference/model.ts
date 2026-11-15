import { normalizeTag } from "../../shared/tags";
import {
  compareStrings,
  CONTEXT_FIELDS,
  DEFAULT_COMBO_MIN_SUPPORT,
  DEFAULT_DECISION_THRESHOLD,
  DEFAULT_FEATURE_NORMALIZATION,
  DEFAULT_MAX_COMBO_FEATURES,
  DEFAULT_NEIGHBOR_K,
  DEFAULT_NEIGHBOR_MIN_SIMILARITY,
  DEFAULT_SEMANTIC_NEIGHBOR_VOTE_WEIGHT,
  DEFAULT_TRAINING_MAX_EXAMPLES,
  DEFAULT_UPLOADER_MIN_SUPPORT,
  LEGACY_MODEL_SCHEMA_VERSION,
  LEGACY_NEIGHBOR_HEAD_SCHEMA_VERSION,
  MODEL_SCHEMA_VERSION,
  NEIGHBOR_HEAD_SCHEMA_VERSION,
  PAIR_SEPARATOR,
  roundTo,
  SEMANTIC_COARSE_PER_CLASS,
  SEMANTIC_CONTEXT_WEIGHT,
  SEMANTIC_EXACT_PER_CLASS,
  SEMANTIC_EXACT_WEIGHT,
  SEMANTIC_FINE_CACHE_SIZE,
  SEMANTIC_FINE_PER_CLASS,
  SEMANTIC_NEIGHBOR_SIMILARITY_FLOOR,
  SEMANTIC_TAG_WEIGHT,
  SUPPORTED_MODEL_SCHEMA_VERSIONS,
} from "./constants";
import {
  embedPooledTagSets,
  embedTagSets,
  scoreEmbedding,
  SemanticHead,
  maxIdfValue,
  semanticIdf,
  semanticItemsWithContext,
  semanticProbability,
  semanticTagItems,
  semanticTagText,
  tagMaxSim,
  tagMaxSimMany,
  weightedTagJaccard,
  type SemanticTagSet,
  type TagMaxSimMatch,
} from "./semantic";

const NON_PREFERENCE_FEATURE_TAG_SET: ReadonlySet<string> = new Set([
  "portrait",
  "landscape",
  "portrait display",
  "landscape display",
  "vertical",
  "horizontal",
]);

export type SemanticTagItem = readonly [string, string];

export interface PreferenceExample {
  filename: string;
  tags: readonly string[];
  label: number;
  base_weight: number;
  timestamp: number;
  is_favorite: boolean;
  is_explicit_keep: boolean;
  temporal_label_known: boolean;
  context_features: readonly string[];
  is_control: boolean;
  is_explicit_ban: boolean;
  semantic_tags: ReadonlyArray<SemanticTagItem>;
  baseWeight?: number;
  isFavorite?: boolean;
  isExplicitKeep?: boolean;
  isExplicitBan?: boolean;
  contextFeatures?: readonly string[];
  semanticTags?: ReadonlyArray<SemanticTagItem>;
}

export function makeExample(
  init: Pick<PreferenceExample, "filename" | "tags" | "label" | "base_weight" | "timestamp"> &
    Partial<PreferenceExample>,
): PreferenceExample {
  return {
    is_favorite: false,
    is_explicit_keep: false,
    temporal_label_known: true,
    context_features: [],
    is_control: false,
    is_explicit_ban: false,
    semantic_tags: [],
    ...init,
  };
}

export interface PreferenceTrainingSnapshot {
  examples: PreferenceExample[];
  feedback_revision: number;
  data_signature: string;
  favorite_files: number;
  label_source: string;
  favorite_metadata_files: number;
}

export interface FeatureSpace {
  tags: ReadonlySet<string>;
  combos: ReadonlySet<string>;
  context: ReadonlySet<string>;
}

export interface ContributionDict {
  type: string;
  feature: string;
  weight: number;
  coefficient: number;
  direction: "dislike" | "keep";
}

export interface NeighborEvidence {
  filename: string;
  label: string;
  similarity: number;
  exact_similarity: number;
  semantic_similarity: number;
  context_similarity: number;
  tag_matches: Array<{ query: string; prototype: string; similarity: number }>;
}

export interface NeighborVote {
  probability: number;
  count: number;
  dislike_count: number;
  keep_count: number;
  similarity_sum: number;
  max_similarity: number;
  nearest_dislike: NeighborEvidence | null;
  nearest_keep: NeighborEvidence | null;
  exact_max_similarity: number;
  semantic_max_similarity: number;
  preference_gap: number;
}

export interface PreferencePrediction {
  probability: number;
  score: number;
  contributions: ContributionDict[];
  positive_evidence_count: number;
  feature_score: number;
  calibrated: boolean;
  semantic_score: number | null;
  semantic_probability: number | null;
  semantic_available: boolean;
  neighbor_probability: number | null;
  neighbor_available: boolean;
  neighbor_count: number;
  neighbor_dislike_count: number;
  neighbor_keep_count: number;
  neighbor_similarity_sum: number;
  neighbor_max_similarity: number;
  neighbor_nearest_dislike: NeighborEvidence | null;
  neighbor_nearest_keep: NeighborEvidence | null;
  neighbor_exact_max_similarity: number;
  neighbor_semantic_max_similarity: number;
  neighbor_preference_gap: number;
}

function roundOrNull(value: number | null, digits: number): number | null {
  return value === null ? null : roundTo(value, digits);
}

export function predictionToDict(prediction: PreferencePrediction): Record<string, unknown> {
  return {
    probability: roundTo(prediction.probability, 4),
    score: roundTo(prediction.score, 4),
    feature_score: roundTo(prediction.feature_score, 4),
    contributions: [...prediction.contributions],
    dislike_evidence: prediction.contributions.filter((item) => item.direction === "dislike"),
    keep_evidence: prediction.contributions.filter((item) => item.direction === "keep"),
    positive_evidence_count: prediction.positive_evidence_count,
    calibrated: prediction.calibrated,
    semantic_score: roundOrNull(prediction.semantic_score, 4),
    semantic_probability: roundOrNull(prediction.semantic_probability, 4),
    semantic_available: prediction.semantic_available,
    neighbor_probability: roundOrNull(prediction.neighbor_probability, 4),
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
  };
}

export interface PreferenceNeighborPrototype {
  filename: string;
  label: number;
  timestamp: number;
  features: ReadonlyArray<readonly [string, number]>;
  tags: readonly string[];
  context_features: readonly string[];
  semantic_tags: ReadonlyArray<SemanticTagItem>;
}

type Rgb = readonly [number, number, number];

interface ContextProfile {
  categories: ReadonlySet<string>;
  colors: readonly Rgb[];
  purities: ReadonlySet<string>;
}

interface SemanticNeighborRuntime {
  idf: Record<string, number>;
  items: ReadonlyArray<ReadonlyArray<SemanticTagItem>>;
  pooledMatrix: Float32Array;
  dimension: number;
  labelIndices: [number[], number[]];
  tiebreakRank: Int32Array;
  fineSets: Map<number, SemanticTagSet>;
  contextProfiles: ContextProfile[];
}

export type PredictRecord = [
  tags: Iterable<unknown> | null | undefined,
  metadata: Record<string, unknown> | null | undefined,
  contextFeatures: Iterable<unknown> | string | null | undefined,
];

type NeighborRecord = [string[], Record<string, unknown> | null | undefined, string[]];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sigmoid(value: number): number {
  if (value >= 35) return 1.0;
  if (value <= -35) return 0.0;
  return 1 / (1 + Math.exp(-value));
}

export function ftrlWeight(
  z: number,
  n: number,
  alpha: number,
  beta: number,
  l1: number,
  l2: number,
): number {
  if (Math.abs(z) <= l1) return 0.0;
  const sign = z < 0 || Object.is(z, -0) ? -1 : 1;
  return -(z - sign * l1) / ((beta + Math.sqrt(n)) / alpha + l2);
}

export function isEligibleTag(tag: string): boolean {
  return Boolean(tag) && !NON_PREFERENCE_FEATURE_TAG_SET.has(tag);
}

export function modelTags(tags: Iterable<unknown> | string | null | undefined): string[] {
  if (tags === null || tags === undefined) return [];
  const iterable: Iterable<unknown> = typeof tags === "string" ? [tags] : tags;
  const normalized = new Set<string>();
  for (const rawTag of iterable) {
    const tag = normalizeTag(rawTag);
    if (tag && isEligibleTag(tag)) {
      normalized.add(tag);
    }
  }
  return [...normalized].sort(compareStrings);
}

export function pairKeys(tags: readonly string[]): string[] {
  const pairs: string[] = [];
  for (let index = 0; index < tags.length; index += 1) {
    for (let other = index + 1; other < tags.length; other += 1) {
      pairs.push(`${tags[index]}${PAIR_SEPARATOR}${tags[other]}`);
    }
  }
  return pairs;
}

export function pairIsEligible(pair: string): boolean {
  const separator = pair.indexOf(PAIR_SEPARATOR);
  if (separator < 0) return false;
  return isEligibleTag(pair.slice(0, separator)) && isEligibleTag(pair.slice(separator + 1));
}

export function comboFeature(pair: string): string {
  return `combo:${pair}`;
}

export function formatPair(pair: string): string {
  return pair.split(PAIR_SEPARATOR).join(" + ");
}

export function contextMinSupport(token: string): number {
  return token.startsWith("uploader:") ? DEFAULT_UPLOADER_MIN_SUPPORT : 2;
}

export function displayContextFeature(token: string): [string, string] {
  const separator = token.indexOf(":");
  const prefix = separator < 0 ? token : token.slice(0, separator);
  const value = separator < 0 ? "" : token.slice(separator + 1);
  return [prefix, `${prefix}: ${value}`];
}

export function storageFeatureKey(namespace: string, name: string): string {
  if (namespace === "combo") return comboFeature(name);
  if (namespace === "context") return `context:${name}`;
  return name;
}

export function normalizeContextFeatures(
  features: Iterable<unknown> | string | null | undefined,
): string[] {
  if (features === null || features === undefined) return [];
  const iterable: Iterable<unknown> = typeof features === "string" ? [features] : features;
  const normalized = new Set<string>();
  for (const raw of iterable) {
    const text = String(raw);
    const separator = text.indexOf(":");
    if (separator < 0) continue;
    const prefix = text.slice(0, separator);
    if (!CONTEXT_FIELDS.has(prefix)) continue;
    const cleanValue = normalizeTag(text.slice(separator + 1));
    if (cleanValue) {
      normalized.add(`${prefix}:${cleanValue}`);
    }
  }
  return [...normalized].sort(compareStrings);
}

function contextRgb(value: string): Rgb | null {
  const clean = value.startsWith("#") ? value.slice(1) : value;
  if (clean.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ];
}

function semanticContextProfile(
  features: Iterable<unknown> | string | null | undefined,
): ContextProfile {
  const categories = new Set<string>();
  const colors: Rgb[] = [];
  const purities = new Set<string>();
  for (const token of normalizeContextFeatures(features)) {
    const separator = token.indexOf(":");
    const field = token.slice(0, separator);
    const value = token.slice(separator + 1);
    if (field === "category") {
      categories.add(value);
    } else if (field === "color") {
      const parsed = contextRgb(value);
      if (parsed !== null) colors.push(parsed);
    } else if (field === "purity") {
      purities.add(value);
    }
  }
  return { categories, colors, purities };
}

const MAX_RGB_DISTANCE = Math.sqrt(3 * 255 ** 2);

function paletteRgbSimilarity(left: readonly Rgb[], right: readonly Rgb[]): number {
  if (left.length === 0 || right.length === 0) return 0.0;
  const directional = (first: readonly Rgb[], second: readonly Rgb[]): number => {
    let total = 0.0;
    for (const color of first) {
      let minimum = Number.POSITIVE_INFINITY;
      for (const candidate of second) {
        const distance = Math.sqrt(
          (color[0] - candidate[0]) ** 2 +
            (color[1] - candidate[1]) ** 2 +
            (color[2] - candidate[2]) ** 2,
        );
        if (distance < minimum) minimum = distance;
      }
      total += 1.0 - minimum / MAX_RGB_DISTANCE;
    }
    return total / first.length;
  };
  return (directional(left, right) + directional(right, left)) / 2;
}

function setsIntersect(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function contextProfileSimilarity(left: ContextProfile, right: ContextProfile): number {
  let weighted = 0.0;
  let total = 0.0;
  if (left.categories.size > 0 && right.categories.size > 0) {
    weighted += 0.5 * (setsIntersect(left.categories, right.categories) ? 1.0 : 0.0);
    total += 0.5;
  }
  if (left.colors.length > 0 && right.colors.length > 0) {
    weighted += 0.35 * paletteRgbSimilarity(left.colors, right.colors);
    total += 0.35;
  }
  if (left.purities.size > 0 && right.purities.size > 0) {
    weighted += 0.15 * (setsIntersect(left.purities, right.purities) ? 1.0 : 0.0);
    total += 0.15;
  }
  return total ? weighted / total : 0.0;
}

export function semanticContextSimilarity(
  left: Iterable<unknown> | null | undefined,
  right: Iterable<unknown> | null | undefined,
): number {
  return contextProfileSimilarity(semanticContextProfile(left), semanticContextProfile(right));
}

export function paletteSimilarity(left: readonly string[], right: readonly string[]): number {
  const parse = (values: readonly string[]): Rgb[] =>
    values.map(contextRgb).filter((color): color is Rgb => color !== null);
  return paletteRgbSimilarity(parse(left), parse(right));
}

export function modelContextFeatures(
  metadata: Record<string, unknown> | null | undefined,
): string[] {
  if (!isRecord(metadata)) return [];
  const values: string[] = [];
  let colors: unknown = metadata.colors ?? [];
  if (typeof colors === "string") colors = [colors];
  if (Array.isArray(colors) || colors instanceof Set) {
    for (const color of colors as Iterable<unknown>) {
      values.push(`color:${String(color)}`);
    }
  }
  for (const field of ["category", "purity", "uploader"] as const) {
    const value = metadata[field];
    if (value !== null && value !== undefined && value !== "") {
      values.push(`${field}:${String(value)}`);
    }
  }
  return normalizeContextFeatures(values);
}

export function neighborFeatureValues(
  tags: Iterable<unknown> | null | undefined,
  contextFeatures: Iterable<unknown> | string | null | undefined,
): Array<[string, number]> {
  const normalizedTags = modelTags(tags);
  const normalizedContext = normalizeContextFeatures(contextFeatures);
  const values: Array<[string, number]> = [];
  if (normalizedTags.length > 0) {
    const tagScale = 1.0 / Math.sqrt(normalizedTags.length);
    for (const tag of normalizedTags) values.push([`tag:${tag}`, tagScale]);
  }
  const byField = new Map<string, string[]>();
  for (const token of normalizedContext) {
    const field = token.slice(0, token.indexOf(":"));
    const tokens = byField.get(field);
    if (tokens) tokens.push(token);
    else byField.set(field, [token]);
  }
  for (const field of [...byField.keys()].sort(compareStrings)) {
    const tokens = byField.get(field) ?? [];
    const scale = 1.0 / Math.sqrt(tokens.length);
    for (const token of tokens) values.push([`context:${token}`, scale]);
  }
  let squared = 0.0;
  for (const [, value] of values) squared += value * value;
  const norm = Math.sqrt(squared);
  if (norm <= 0) return [];
  return values
    .sort((left, right) => compareStrings(left[0], right[0]) || left[1] - right[1])
    .map(([feature, value]) => [feature, value / norm]);
}

export function activeFeatureValues(
  tags: Iterable<unknown> | null | undefined,
  contextFeatures: Iterable<unknown> | string | null | undefined,
  featureSpace: FeatureSpace,
  normalization: string,
): Array<[namespace: string, name: string, value: number]> {
  const normalizedTags = modelTags(tags);
  const activeTags = normalizedTags.filter((tag) => featureSpace.tags.has(tag));
  const activePairs =
    featureSpace.combos.size > 0
      ? pairKeys(normalizedTags).filter((pair) => featureSpace.combos.has(pair))
      : [];
  const activeContext = normalizeContextFeatures(contextFeatures).filter((token) =>
    featureSpace.context.has(token),
  );
  const fieldL2 = normalization === DEFAULT_FEATURE_NORMALIZATION;
  const values: Array<[string, string, number]> = [];
  const tagScale = fieldL2 && activeTags.length > 0 ? 1.0 / Math.sqrt(activeTags.length) : 1.0;
  for (const tag of activeTags) values.push(["tag", tag, tagScale]);
  const pairScale = fieldL2 && activePairs.length > 0 ? 1.0 / Math.sqrt(activePairs.length) : 1.0;
  for (const pair of activePairs) values.push(["combo", pair, pairScale]);

  const byField = new Map<string, string[]>();
  for (const token of activeContext) {
    const field = token.slice(0, token.indexOf(":"));
    const tokens = byField.get(field);
    if (tokens) tokens.push(token);
    else byField.set(field, [token]);
  }
  for (const [field, tokens] of byField) {
    const scale =
      field === "color" && fieldL2 && tokens.length > 0 ? 1.0 / Math.sqrt(tokens.length) : 1.0;
    for (const token of tokens) values.push(["context", token, scale]);
  }
  return values;
}

export function activeFeatures(tags: readonly string[], featureSpace: FeatureSpace): string[] {
  return activeFeatureValues(tags, [], featureSpace, "none").map(([namespace, name]) =>
    storageFeatureKey(namespace, name),
  );
}

function recencyCompare(left: PreferenceExample, right: PreferenceExample): number {
  return (
    left.timestamp - right.timestamp ||
    compareStrings(left.filename, right.filename) ||
    left.label - right.label
  );
}

export function nLargest<T>(count: number, items: readonly T[], compare: (a: T, b: T) => number): T[] {
  if (count <= 0) return [];
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => compare(right.item, left.item) || left.index - right.index)
    .slice(0, count)
    .map((entry) => entry.item);
}

export function groupExamplesByPurity(
  examples: Iterable<PreferenceExample>,
): Map<string, PreferenceExample[]> {
  const groups = new Map<string, PreferenceExample[]>();
  for (const example of examples) {
    const purity = example.context_features.find((token) => token.startsWith("purity:")) ?? "";
    const group = groups.get(purity);
    if (group) group.push(example);
    else groups.set(purity, [example]);
  }
  return groups;
}

function selectRecentPurityExamples(
  examples: Iterable<PreferenceExample>,
  limit: number,
): PreferenceExample[] {
  const groups = groupExamplesByPurity(examples);
  const quotas = new Map<string, number>();
  let available = 0;
  for (const [purity, group] of groups) {
    quotas.set(purity, 0);
    available += group.length;
  }
  let remaining = Math.min(Math.max(0, limit), available);
  while (remaining > 0) {
    const active = [...groups.keys()]
      .filter((purity) => (quotas.get(purity) ?? 0) < (groups.get(purity)?.length ?? 0))
      .sort(compareStrings);
    const share = Math.max(1, Math.floor(remaining / active.length));
    for (const purity of active) {
      const quota = quotas.get(purity) ?? 0;
      const added = Math.min(share, remaining, (groups.get(purity)?.length ?? 0) - quota);
      quotas.set(purity, quota + added);
      remaining -= added;
    }
  }
  const selected: PreferenceExample[] = [];
  for (const [purity, group] of groups) {
    selected.push(...nLargest(quotas.get(purity) ?? 0, group, recencyCompare));
  }
  return selected;
}

function isExplicitExample(example: PreferenceExample): boolean {
  return example.is_explicit_ban || example.is_explicit_keep || example.is_favorite;
}

export function selectPreferenceExamples(
  examples: Iterable<PreferenceExample>,
  options?: { limit?: number; explicitOnly?: boolean },
): PreferenceExample[] {
  const limit = options?.limit ?? DEFAULT_TRAINING_MAX_EXAMPLES;
  const explicitOnly = options?.explicitOnly ?? false;
  if (limit < 2) return [];
  const candidates = [...examples].filter((example) => !explicitOnly || isExplicitExample(example));
  const perClass = Math.floor(limit / 2);
  const negatives = selectRecentPurityExamples(
    candidates.filter((example) => example.label === 0),
    perClass,
  );
  const positives = selectRecentPurityExamples(
    candidates.filter((example) => example.label === 1),
    perClass,
  );
  if (negatives.length === 0 || positives.length === 0) return [];
  const selected = [...negatives, ...positives];
  const selectedSet = new Set<PreferenceExample>(selected);
  const remainder = selectRecentPurityExamples(
    candidates.filter((example) => !selectedSet.has(example)),
    Math.max(0, limit - selected.length),
  );
  selected.push(...remainder);
  return selected.sort(recencyCompare);
}

export function buildNeighborPrototypes(
  examples: Iterable<PreferenceExample>,
): PreferenceNeighborPrototype[] {
  const selected = [...examples].filter(isExplicitExample).sort(recencyCompare);
  if (selected.length === 0) return [];
  const prototypes: PreferenceNeighborPrototype[] = [];
  const labels = new Set<number>();
  for (const example of selected) {
    const features = neighborFeatureValues(example.tags, example.context_features);
    if (features.length === 0) continue;
    const tags = modelTags(example.tags);
    prototypes.push({
      filename: example.filename,
      label: example.label,
      timestamp: example.timestamp,
      features,
      tags,
      context_features: normalizeContextFeatures(example.context_features),
      semantic_tags:
        example.semantic_tags.length > 0
          ? example.semantic_tags
          : tags.map((tag): SemanticTagItem => [tag, tag]),
    });
    labels.add(example.label);
  }
  if (!(labels.size === 2 && labels.has(0) && labels.has(1))) return [];
  return prototypes;
}

interface FineNeighbor {
  prototype: PreferenceNeighborPrototype;
  similarity: number;
  exact_similarity: number;
  semantic_similarity: number;
  context_similarity: number;
  matches: TagMaxSimMatch[];
  prototype_index: number;
}

export interface PreferenceModelInit {
  bias: number;
  prior_log_odds: number;
  tag_weights: Record<string, number>;
  combo_weights: Record<string, number>;
  trained_at: string;
  training_summary: Record<string, unknown>;
  combo_min_support: number;
  max_combo_features: number;
  context_weights?: Record<string, number>;
  schema_version?: number;
  feature_normalization?: string;
  semantic_model?: string;
  semantic_bias?: number;
  semantic_weights?: readonly number[];
  semantic_blend?: number;
  neighbor_k?: number;
  neighbor_prototypes?: PreferenceNeighborPrototype[];
}

export interface PredictOptions {
  metadata?: Record<string, unknown> | null;
  contextFeatures?: Iterable<unknown> | string | null;
  topN?: number;
  semanticEmbedding?: ArrayLike<number> | null;
  neighborPrediction?: NeighborVote | null;
  skipNeighbors?: boolean;
}

export class PreferenceModel {
  bias: number;
  prior_log_odds: number;
  tag_weights: Record<string, number>;
  combo_weights: Record<string, number>;
  trained_at: string;
  training_summary: Record<string, unknown>;
  combo_min_support: number;
  max_combo_features: number;
  context_weights: Record<string, number>;
  schema_version: number;
  feature_normalization: string;
  semantic_model: string;
  semantic_bias: number;
  semantic_weights: readonly number[];
  semantic_blend: number;
  neighbor_k: number;
  neighbor_prototypes: PreferenceNeighborPrototype[];

  private neighborFeatureIndex: Map<string, { indices: Int32Array; values: Float64Array }> | null =
    null;
  private semanticNeighborRuntime: SemanticNeighborRuntime | null = null;
  private semanticNeighborFailed = false;
  private cachedFeatureSpace: FeatureSpace | null = null;
  private cachedSemanticHead: SemanticHead | null = null;

  constructor(init: PreferenceModelInit) {
    this.bias = init.bias;
    this.prior_log_odds = init.prior_log_odds;
    this.tag_weights = init.tag_weights;
    this.combo_weights = init.combo_weights;
    this.trained_at = init.trained_at;
    this.training_summary = init.training_summary;
    this.combo_min_support = init.combo_min_support;
    this.max_combo_features = init.max_combo_features;
    this.context_weights = init.context_weights ?? {};
    this.schema_version = init.schema_version ?? MODEL_SCHEMA_VERSION;
    this.feature_normalization = init.feature_normalization ?? DEFAULT_FEATURE_NORMALIZATION;
    this.semantic_model = init.semantic_model ?? "";
    this.semantic_bias = init.semantic_bias ?? 0.0;
    this.semantic_weights = init.semantic_weights ?? [];
    this.semantic_blend = init.semantic_blend ?? 0.0;
    this.neighbor_k = init.neighbor_k ?? DEFAULT_NEIGHBOR_K;
    this.neighbor_prototypes = init.neighbor_prototypes ?? [];
  }

  get featureSpace(): FeatureSpace {
    if (this.cachedFeatureSpace === null) {
      this.cachedFeatureSpace = {
        tags: new Set(Object.keys(this.tag_weights)),
        combos: new Set(Object.keys(this.combo_weights)),
        context: new Set(Object.keys(this.context_weights)),
      };
    }
    return this.cachedFeatureSpace;
  }

  get semanticEnabled(): boolean {
    return Boolean(this.semantic_model) && this.semantic_weights.length > 0;
  }

  get neighborHeadReady(): boolean {
    let hasKeep = false;
    let hasDislike = false;
    for (const prototype of this.neighbor_prototypes) {
      if (prototype.label === 0) hasKeep = true;
      else if (prototype.label === 1) hasDislike = true;
      else return false;
    }
    return hasKeep && hasDislike && this.neighbor_k > 0;
  }

  resetRuntime(): void {
    this.neighborFeatureIndex = null;
    this.semanticNeighborRuntime = null;
    this.semanticNeighborFailed = false;
    this.cachedFeatureSpace = null;
    this.cachedSemanticHead = null;
  }

  setNeighborHead(prototypes: PreferenceNeighborPrototype[], neighborK = DEFAULT_NEIGHBOR_K): void {
    this.neighbor_k = neighborK;
    this.neighbor_prototypes = prototypes;
    this.resetRuntime();
  }

  setSemanticHead(head: SemanticHead): void {
    this.semantic_model = head.modelName;
    this.semantic_bias = head.bias;
    this.semantic_weights = head.weights;
    this.semantic_blend = head.blend;
    this.resetRuntime();
  }

  prototypeSemanticRecords(): Array<ReadonlyArray<SemanticTagItem>> {
    return this.neighbor_prototypes.map((prototype) =>
      prototype.semantic_tags.length > 0
        ? prototype.semantic_tags
        : prototype.tags.map((tag): SemanticTagItem => [tag, semanticTagText(tag)]),
    );
  }

  embeddingTexts(records: Iterable<PredictRecord> = []): string[] {
    const texts = new Set<string>();
    if (!this.semanticEnabled || !this.neighborHeadReady) return [];
    for (const record of this.prototypeSemanticRecords()) {
      for (const [, text] of record) texts.add(text);
    }
    for (const [tags, metadata, context] of records) {
      const normalized = modelTags(tags);
      const normalizedContext =
        context !== null && context !== undefined
          ? normalizeContextFeatures(context)
          : modelContextFeatures(metadata);
      const items = semanticTagItems(normalized, metadata ?? null);
      for (const [, text] of semanticItemsWithContext(items, normalizedContext)) texts.add(text);
    }
    return [...texts];
  }

  private neighborIndex(): Map<string, { indices: Int32Array; values: Float64Array }> {
    if (this.neighborFeatureIndex !== null) return this.neighborFeatureIndex;
    const postings = new Map<string, Array<[number, number]>>();
    this.neighbor_prototypes.forEach((prototype, index) => {
      for (const [feature, value] of prototype.features) {
        const entries = postings.get(feature);
        if (entries) entries.push([index, value]);
        else postings.set(feature, [[index, value]]);
      }
    });
    const built = new Map<string, { indices: Int32Array; values: Float64Array }>();
    for (const [feature, entries] of postings) {
      built.set(feature, {
        indices: Int32Array.from(entries, (entry) => entry[0]),
        values: Float64Array.from(entries, (entry) => entry[1]),
      });
    }
    this.neighborFeatureIndex = built;
    return built;
  }

  private exactNeighborScores(tags: readonly string[], context: readonly string[]): Float64Array | null {
    if (!this.neighborHeadReady) return null;
    const query = neighborFeatureValues(tags, context);
    if (query.length === 0) return null;
    const scores = new Float64Array(this.neighbor_prototypes.length);
    const postings = this.neighborIndex();
    for (const [feature, queryValue] of query) {
      const posting = postings.get(feature);
      if (!posting) continue;
      for (let position = 0; position < posting.indices.length; position += 1) {
        scores[posting.indices[position]] += queryValue * posting.values[position];
      }
    }
    return scores;
  }

  private semanticRuntime(): SemanticNeighborRuntime {
    if (this.semanticNeighborRuntime !== null) return this.semanticNeighborRuntime;
    if (this.semanticNeighborFailed) {
      throw new Error("semantic neighbour runtime is unavailable");
    }
    try {
      const records = this.prototypeSemanticRecords();
      const idf = semanticIdf(records);
      const pooled = embedPooledTagSets(records, { modelName: this.semantic_model, idf });
      if (!pooled.dimension || pooled.rows !== records.length) {
        throw new Error("semantic prototypes produced no vectors");
      }
      const labelIndices: [number[], number[]] = [[], []];
      this.neighbor_prototypes.forEach((prototype, index) => {
        labelIndices[prototype.label === 1 ? 1 : 0].push(index);
      });
      const order = this.neighbor_prototypes
        .map((_, index) => index)
        .sort((left, right) => this.compareRecency(left, right));
      const tiebreakRank = new Int32Array(order.length);
      order.forEach((prototypeIndex, rank) => {
        tiebreakRank[prototypeIndex] = rank;
      });
      this.semanticNeighborRuntime = {
        idf,
        items: records,
        pooledMatrix: pooled.matrix,
        dimension: pooled.dimension,
        labelIndices,
        tiebreakRank,
        fineSets: new Map(),
        contextProfiles: this.neighbor_prototypes.map((prototype) =>
          semanticContextProfile(prototype.context_features),
        ),
      };
      return this.semanticNeighborRuntime;
    } catch (error) {
      this.semanticNeighborFailed = true;
      throw error;
    }
  }

  private compareRecency(left: number, right: number): number {
    const first = this.neighbor_prototypes[left];
    const second = this.neighbor_prototypes[right];
    return second.timestamp - first.timestamp || compareStrings(first.filename, second.filename);
  }

  private predictSemanticNeighborsMany(
    records: readonly NeighborRecord[],
  ): Array<[NeighborVote | null, Float32Array | null]> {
    const empty = (): Array<[NeighborVote | null, Float32Array | null]> =>
      records.map(() => [null, null]);
    if (records.length === 0 || !this.semanticEnabled || !this.neighborHeadReady) {
      return empty();
    }
    try {
      const runtime = this.semanticRuntime();
      const queryItems = records.map(([tags, metadata]) => semanticTagItems(tags, metadata ?? null));
      const denseItems = queryItems.map((items, index) =>
        semanticItemsWithContext(items, records[index][2]),
      );
      const querySets = embedTagSets(queryItems, {
        modelName: this.semantic_model,
        idf: runtime.idf,
      });
      const denseSets = embedTagSets(denseItems, { modelName: this.semantic_model });
      const dimension = runtime.dimension;
      const prototypeCount = this.neighbor_prototypes.length;
      const prototypeRows = runtime.pooledMatrix;
      return records.map(([tags, , context], index) => {
        const querySet = querySets[index];
        const coarse = new Float32Array(prototypeCount);
        if (querySet.pooled.length === dimension) {
          const query = querySet.pooled;
          for (let row = 0; row < prototypeCount; row += 1) {
            const offset = row * dimension;
            let dot = 0.0;
            for (let column = 0; column < dimension; column += 1) {
              dot += query[column] * prototypeRows[offset + column];
            }
            coarse[row] = dot;
          }
        }
        return [
          this.fineSemanticNeighborVote(
            querySet,
            context,
            this.exactNeighborScores(tags, context),
            coarse,
            runtime,
          ),
          denseSets[index].pooled,
        ];
      });
    } catch {
      this.semanticNeighborFailed = true;
      return empty();
    }
  }

  private fineSemanticNeighborVote(
    querySet: SemanticTagSet,
    queryContext: readonly string[],
    exactScores: Float64Array | null,
    coarseScores: Float32Array,
    runtime: SemanticNeighborRuntime,
  ): NeighborVote | null {
    const candidateIndices = new Set<number>();
    for (const label of [0, 1] as const) {
      const labelIndices = runtime.labelIndices[label];
      const semanticRank = labelIndices
        .filter((index) => coarseScores[index] > 0)
        .sort(
          (left, right) =>
            coarseScores[right] - coarseScores[left] || this.compareRecency(left, right),
        )
        .slice(0, SEMANTIC_COARSE_PER_CLASS);
      for (const index of semanticRank) candidateIndices.add(index);
      if (exactScores !== null) {
        const exactRank = labelIndices
          .filter((index) => exactScores[index] > 0)
          .sort(
            (left, right) =>
              exactScores[right] - exactScores[left] ||
              runtime.tiebreakRank[left] - runtime.tiebreakRank[right],
          )
          .slice(0, SEMANTIC_EXACT_PER_CLASS);
        for (const index of exactRank) candidateIndices.add(index);
      }
    }

    const orderedIndices = [...candidateIndices].sort((left, right) => left - right);
    const missingIndices = orderedIndices.filter((index) => !runtime.fineSets.has(index));
    if (missingIndices.length > 0) {
      const missingSets = embedTagSets(
        missingIndices.map((index) => runtime.items[index]),
        { modelName: this.semantic_model, idf: runtime.idf },
      );
      missingIndices.forEach((index, position) => {
        runtime.fineSets.set(index, missingSets[position]);
      });
    }
    const tagSetsByIndex = new Map<number, SemanticTagSet>();
    for (const index of orderedIndices) {
      const tagSet = runtime.fineSets.get(index) as SemanticTagSet;
      runtime.fineSets.delete(index);
      runtime.fineSets.set(index, tagSet);
      tagSetsByIndex.set(index, tagSet);
    }
    while (runtime.fineSets.size > SEMANTIC_FINE_CACHE_SIZE) {
      const oldest = runtime.fineSets.keys().next().value as number;
      runtime.fineSets.delete(oldest);
    }

    const semanticResults = tagMaxSimMany(
      querySet,
      orderedIndices.map((index) => tagSetsByIndex.get(index) as SemanticTagSet),
      runtime.idf,
      { includeMatches: false },
    );
    const queryContextProfile = semanticContextProfile(queryContext);
    const defaultIdf = maxIdfValue(runtime.idf);

    const fine: FineNeighbor[] = [];
    orderedIndices.forEach((index, position) => {
      const prototype = this.neighbor_prototypes[index];
      const prototypeSet = tagSetsByIndex.get(index) as SemanticTagSet;
      const semanticScore = semanticResults[position][0];
      const contextScore = contextProfileSimilarity(
        queryContextProfile,
        runtime.contextProfiles[index],
      );
      const exactScore = weightedTagJaccard(querySet.items, prototypeSet.items, runtime.idf, {
        defaultIdf,
      });
      const similarity =
        SEMANTIC_EXACT_WEIGHT * exactScore +
        SEMANTIC_TAG_WEIGHT * semanticScore +
        SEMANTIC_CONTEXT_WEIGHT * contextScore;
      if (similarity <= SEMANTIC_NEIGHBOR_SIMILARITY_FLOOR) return;
      fine.push({
        prototype,
        similarity: Math.min(1.0, similarity),
        exact_similarity: exactScore,
        semantic_similarity: semanticScore,
        context_similarity: contextScore,
        matches: [],
        prototype_index: index,
      });
    });

    const selectByLabel = (label: number): FineNeighbor[] =>
      fine
        .filter((item) => item.prototype.label === label)
        .sort(
          (left, right) =>
            right.similarity - left.similarity ||
            right.prototype.timestamp - left.prototype.timestamp ||
            compareStrings(left.prototype.filename, right.prototype.filename),
        )
        .slice(0, SEMANTIC_FINE_PER_CLASS);
    const dislikeNeighbors = selectByLabel(1);
    const keepNeighbors = selectByLabel(0);
    if (dislikeNeighbors.length === 0 && keepNeighbors.length === 0) return null;

    for (const nearest of [dislikeNeighbors[0], keepNeighbors[0]]) {
      if (!nearest) continue;
      nearest.matches = tagMaxSim(
        querySet,
        tagSetsByIndex.get(nearest.prototype_index) as SemanticTagSet,
        runtime.idf,
      )[1];
    }

    const evidenceMass = (items: FineNeighbor[]): number => {
      if (items.length === 0) return 0.0;
      let total = 0.0;
      for (const item of items) {
        total += Math.max(0.0, item.similarity - SEMANTIC_NEIGHBOR_SIMILARITY_FLOOR) ** 2;
      }
      return total / items.length;
    };
    const dislikeMass = evidenceMass(dislikeNeighbors);
    const keepMass = evidenceMass(keepNeighbors);
    const massTotal = dislikeMass + keepMass;
    if (massTotal <= 0) return null;

    const evidence = (item: FineNeighbor | undefined): NeighborEvidence | null => {
      if (!item) return null;
      return {
        filename: item.prototype.filename,
        label: item.prototype.label ? "dislike" : "keep",
        similarity: roundTo(item.similarity, 4),
        exact_similarity: roundTo(item.exact_similarity, 4),
        semantic_similarity: roundTo(item.semantic_similarity, 4),
        context_similarity: roundTo(item.context_similarity, 4),
        tag_matches: item.matches.map(([query, prototype, similarity]) => ({
          query,
          prototype,
          similarity: roundTo(similarity, 4),
        })),
      };
    };

    const combined = [...dislikeNeighbors, ...keepNeighbors];
    let similaritySum = 0.0;
    let maxSimilarity = Number.NEGATIVE_INFINITY;
    let exactMax = Number.NEGATIVE_INFINITY;
    let semanticMax = Number.NEGATIVE_INFINITY;
    for (const item of combined) {
      similaritySum += item.similarity;
      maxSimilarity = Math.max(maxSimilarity, item.similarity);
      exactMax = Math.max(exactMax, item.exact_similarity);
      semanticMax = Math.max(semanticMax, item.semantic_similarity);
    }
    const dislikeBest = dislikeNeighbors[0]?.similarity ?? 0.0;
    const keepBest = keepNeighbors[0]?.similarity ?? 0.0;
    return {
      probability: dislikeMass / massTotal,
      count: combined.length,
      dislike_count: dislikeNeighbors.length,
      keep_count: keepNeighbors.length,
      similarity_sum: similaritySum,
      max_similarity: maxSimilarity,
      nearest_dislike: evidence(dislikeNeighbors[0]),
      nearest_keep: evidence(keepNeighbors[0]),
      exact_max_similarity: exactMax,
      semantic_max_similarity: semanticMax,
      preference_gap: dislikeBest - keepBest,
    };
  }

  private semanticHead(): SemanticHead {
    if (this.cachedSemanticHead === null) {
      this.cachedSemanticHead = new SemanticHead({
        modelName: this.semantic_model,
        bias: this.semantic_bias,
        weights: this.semantic_weights,
        blend: this.semantic_blend,
      });
    }
    return this.cachedSemanticHead;
  }

  predict(tags: Iterable<unknown> | string | null | undefined, options?: PredictOptions): PreferencePrediction {
    const topN = options?.topN ?? 8;
    const metadata = options?.metadata ?? null;
    const normalized = modelTags(tags);
    const normalizedContext =
      options?.contextFeatures !== null && options?.contextFeatures !== undefined
        ? normalizeContextFeatures(options.contextFeatures)
        : modelContextFeatures(metadata);
    let neighbor: NeighborVote | null = options?.neighborPrediction ?? null;
    let semanticEmbedding: ArrayLike<number> | null = options?.semanticEmbedding ?? null;
    if (neighbor === null && this.semanticEnabled && !options?.skipNeighbors) {
      const [vote, pooled] = this.predictSemanticNeighborsMany([
        [normalized, metadata, normalizedContext],
      ])[0];
      neighbor = vote;
      if (semanticEmbedding === null) semanticEmbedding = pooled;
    }

    let score = this.bias + this.prior_log_odds;
    let featureScore = 0.0;
    const contributions: Array<[string, string, number, number]> = [];
    for (const [namespace, name, value] of activeFeatureValues(
      normalized,
      normalizedContext,
      this.featureSpace,
      this.feature_normalization,
    )) {
      let weight: number;
      let featureType: string;
      let displayName: string;
      if (namespace === "tag") {
        weight = this.tag_weights[name];
        featureType = "tag";
        displayName = name;
      } else if (namespace === "combo") {
        weight = this.combo_weights[name];
        featureType = "combo";
        displayName = formatPair(name);
      } else {
        weight = this.context_weights[name];
        [featureType, displayName] = displayContextFeature(name);
      }
      const contribution = weight * value;
      score += contribution;
      featureScore += contribution;
      contributions.push([featureType, displayName, contribution, weight]);
    }

    const sparsePositiveEvidence = contributions.filter((item) => item[2] > 0).length;
    let semanticScore: number | null = null;
    let semanticProb: number | null = null;
    let semanticAvailable = false;
    if (this.semanticEnabled && semanticEmbedding !== null) {
      try {
        semanticScore = scoreEmbedding(this.semanticHead(), semanticEmbedding);
        semanticProb = semanticProbability(semanticScore);
        semanticAvailable = true;
        const semanticContribution = this.semantic_blend * semanticScore;
        score += semanticContribution;
        if (semanticContribution) {
          contributions.push([
            "semantic",
            "metadata semantic head",
            semanticContribution,
            semanticScore,
          ]);
        }
      } catch {
        semanticScore = null;
        semanticProb = null;
        semanticAvailable = false;
      }
    }

    const ordered = contributions
      .sort(
        (left, right) =>
          Math.abs(right[2]) - Math.abs(left[2]) ||
          compareStrings(left[0], right[0]) ||
          compareStrings(left[1], right[1]),
      )
      .slice(0, Math.max(0, topN));
    const explanation: ContributionDict[] = ordered.map(
      ([featureType, name, contribution, coefficient]) => ({
        type: featureType,
        feature: name,
        weight: roundTo(contribution, 4),
        coefficient: roundTo(coefficient, 4),
        direction: contribution > 0 ? "dislike" : "keep",
      }),
    );
    const calibration = this.training_summary.decision_calibration;
    return {
      probability: sigmoid(score),
      score,
      feature_score: featureScore,
      contributions: explanation,
      positive_evidence_count: sparsePositiveEvidence,
      calibrated: isRecord(calibration) && calibration.available === true,
      semantic_score: semanticScore,
      semantic_probability: semanticProb,
      semantic_available: semanticAvailable,
      neighbor_probability: neighbor ? neighbor.probability : null,
      neighbor_available: neighbor !== null,
      neighbor_count: neighbor?.count ?? 0,
      neighbor_dislike_count: neighbor?.dislike_count ?? 0,
      neighbor_keep_count: neighbor?.keep_count ?? 0,
      neighbor_similarity_sum: neighbor?.similarity_sum ?? 0.0,
      neighbor_max_similarity: neighbor?.max_similarity ?? 0.0,
      neighbor_nearest_dislike: neighbor?.nearest_dislike ?? null,
      neighbor_nearest_keep: neighbor?.nearest_keep ?? null,
      neighbor_exact_max_similarity: neighbor?.exact_max_similarity ?? 0.0,
      neighbor_semantic_max_similarity: neighbor?.semantic_max_similarity ?? 0.0,
      neighbor_preference_gap: neighbor?.preference_gap ?? 0.0,
    };
  }

  predictMany(records: Iterable<PredictRecord>, options?: { topN?: number }): PreferencePrediction[] {
    const materialized = [...records].map(([tags, metadata, context]) => {
      const normalized = modelTags(tags);
      const normalizedContext =
        context !== null && context !== undefined
          ? normalizeContextFeatures(context)
          : modelContextFeatures(metadata);
      return [normalized, metadata, normalizedContext] as NeighborRecord;
    });
    const semanticResults = this.predictSemanticNeighborsMany(materialized);
    return materialized.map(([tags, metadata, context], index) => {
      const [neighbor, embedding] = semanticResults[index];
      return this.predict(tags, {
        metadata: metadata ?? null,
        contextFeatures: context,
        topN: options?.topN ?? 8,
        semanticEmbedding: embedding,
        neighborPrediction: neighbor,
        skipNeighbors: true,
      });
    });
  }

  toDict(): Record<string, unknown> {
    return {
      schema_version: this.schema_version,
      trained_at: this.trained_at,
      bias: this.bias,
      prior_log_odds: this.prior_log_odds,
      tag_weights: this.tag_weights,
      combo_weights: this.combo_weights,
      context_weights: this.context_weights,
      combo_min_support: this.combo_min_support,
      max_combo_features: this.max_combo_features,
      feature_normalization: this.feature_normalization,
      training_summary: this.training_summary,
      semantic_head: this.semanticEnabled
        ? {
            model_name: this.semantic_model,
            bias: this.semantic_bias,
            weights: [...this.semantic_weights],
            blend: this.semantic_blend,
          }
        : {},
      neighbor_head: {
        version: NEIGHBOR_HEAD_SCHEMA_VERSION,
        k: this.neighbor_k,
        prototypes: this.neighbor_prototypes.map((prototype) => ({
          filename: prototype.filename,
          label: prototype.label,
          timestamp: prototype.timestamp,
          features: prototype.features.map(([feature, value]) => [feature, value]),
          tags: [...prototype.tags],
          context_features: [...prototype.context_features],
          semantic_tags: prototype.semantic_tags.map(([key, text]) => [key, text]),
        })),
      },
    };
  }

  static fromDict(raw: unknown): PreferenceModel {
    if (!isRecord(raw)) throw new Error("Unsupported preference model file");
    const rawSchemaVersion = raw.schema_version;
    if (
      typeof rawSchemaVersion !== "number" ||
      !SUPPORTED_MODEL_SCHEMA_VERSIONS.has(rawSchemaVersion)
    ) {
      throw new Error("Unsupported preference model file");
    }
    const schemaVersion = rawSchemaVersion;

    const weights = (key: string): Record<string, number> => {
      const values = raw[key] ?? {};
      if (!isRecord(values)) throw new Error(`Invalid preference model ${key}`);
      const result: Record<string, number> = {};
      for (const [name, weight] of Object.entries(values)) {
        const numeric = Number(weight);
        if (Number.isNaN(numeric)) throw new Error(`Invalid preference model ${key}`);
        result[name] = numeric;
      }
      return result;
    };
    const requireNumber = (value: unknown, label: string): number => {
      if (typeof value !== "number" || Number.isNaN(value)) {
        throw new Error(`Invalid preference model ${label}`);
      }
      return value;
    };

    const summary = raw.training_summary ?? {};
    if (!isRecord(summary)) throw new Error("Invalid preference model summary");
    const semanticRaw = raw.semantic_head ?? {};
    if (!isRecord(semanticRaw)) throw new Error("Invalid preference model semantic head");
    const semanticWeights = semanticRaw.weights ?? [];
    if (!Array.isArray(semanticWeights)) {
      throw new Error("Invalid preference model semantic weights");
    }
    const neighborRaw = raw.neighbor_head ?? {};
    if (!isRecord(neighborRaw)) throw new Error("Invalid preference model neighbor head");
    const neighborVersion = neighborRaw.version ?? NEIGHBOR_HEAD_SCHEMA_VERSION;
    if (
      neighborVersion !== LEGACY_NEIGHBOR_HEAD_SCHEMA_VERSION &&
      neighborVersion !== NEIGHBOR_HEAD_SCHEMA_VERSION
    ) {
      throw new Error("Invalid preference model neighbor head version");
    }
    const neighborK = neighborRaw.k ?? DEFAULT_NEIGHBOR_K;
    if (
      typeof neighborK !== "number" ||
      !Number.isInteger(neighborK) ||
      neighborK < 1 ||
      neighborK > 512
    ) {
      throw new Error("Invalid preference model neighbor k");
    }
    const rawPrototypes = neighborRaw.prototypes ?? [];
    if (!Array.isArray(rawPrototypes)) {
      throw new Error("Invalid preference model neighbor prototypes");
    }
    const neighborPrototypes: PreferenceNeighborPrototype[] = [];
    for (const rawPrototype of rawPrototypes) {
      if (!isRecord(rawPrototype)) {
        throw new Error("Invalid preference model neighbor prototype");
      }
      const { label, timestamp, filename } = rawPrototype;
      const rawFeatures = rawPrototype.features;
      if (
        (label !== 0 && label !== 1) ||
        typeof timestamp !== "number" ||
        !Number.isInteger(timestamp) ||
        typeof filename !== "string" ||
        !filename ||
        !Array.isArray(rawFeatures)
      ) {
        throw new Error("Invalid preference model neighbor prototype");
      }
      if (rawFeatures.length > 512) {
        throw new Error("Preference model neighbor prototype is too large");
      }
      const features: Array<[string, number]> = [];
      for (const rawFeature of rawFeatures) {
        if (!Array.isArray(rawFeature) || rawFeature.length !== 2) {
          throw new Error("Invalid preference model neighbor feature");
        }
        const [feature, rawValue] = rawFeature as [unknown, unknown];
        if (typeof feature !== "string" || !feature) {
          throw new Error("Invalid preference model neighbor feature");
        }
        const value = Number(rawValue);
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error("Invalid preference model neighbor feature");
        }
        features.push([feature, value]);
      }
      if (features.length === 0) continue;
      const rawTags = rawPrototype.tags ?? [];
      const rawContext = rawPrototype.context_features ?? [];
      const rawSemanticTags = rawPrototype.semantic_tags ?? [];
      if (!Array.isArray(rawTags) || !Array.isArray(rawContext)) {
        throw new Error("Invalid preference model neighbor metadata");
      }
      if (!Array.isArray(rawSemanticTags)) {
        throw new Error("Invalid preference model semantic tags");
      }
      let tags = modelTags(rawTags);
      let contextFeatures = normalizeContextFeatures(rawContext);
      if (neighborVersion === LEGACY_NEIGHBOR_HEAD_SCHEMA_VERSION) {
        tags = features
          .filter(([feature]) => feature.startsWith("tag:"))
          .map(([feature]) => feature.slice("tag:".length));
        contextFeatures = features
          .filter(([feature]) => feature.startsWith("context:"))
          .map(([feature]) => feature.slice("context:".length));
      }
      let semanticTags: Array<[string, string]> = [];
      for (const rawItem of rawSemanticTags) {
        if (!Array.isArray(rawItem) || rawItem.length !== 2) {
          throw new Error("Invalid preference model semantic tag");
        }
        const key = normalizeTag(rawItem[0]);
        const text = String(rawItem[1]).trim();
        if (key && text) semanticTags.push([key, text]);
      }
      if (semanticTags.length === 0) {
        semanticTags = tags.map((tag) => [tag, tag]);
      }
      neighborPrototypes.push({
        filename,
        label,
        timestamp,
        features,
        tags,
        context_features: contextFeatures,
        semantic_tags: semanticTags,
      });
    }

    const legacy = schemaVersion === LEGACY_MODEL_SCHEMA_VERSION;
    return new PreferenceModel({
      bias: requireNumber(raw.bias, "bias"),
      prior_log_odds: requireNumber(raw.prior_log_odds, "prior_log_odds"),
      tag_weights: weights("tag_weights"),
      combo_weights: weights("combo_weights"),
      context_weights: weights("context_weights"),
      trained_at: String(raw.trained_at ?? ""),
      training_summary: summary,
      combo_min_support: Math.trunc(
        requireNumber(
          raw.combo_min_support ?? (legacy ? 5 : DEFAULT_COMBO_MIN_SUPPORT),
          "combo_min_support",
        ),
      ),
      max_combo_features: Math.trunc(
        requireNumber(raw.max_combo_features ?? DEFAULT_MAX_COMBO_FEATURES, "max_combo_features"),
      ),
      schema_version: schemaVersion,
      feature_normalization: String(
        raw.feature_normalization ?? (legacy ? "none" : DEFAULT_FEATURE_NORMALIZATION),
      ),
      semantic_model: String(semanticRaw.model_name ?? ""),
      semantic_bias: requireNumber(semanticRaw.bias ?? 0.0, "semantic bias"),
      semantic_weights: semanticWeights.map((value) => requireNumber(value, "semantic weights")),
      semantic_blend: requireNumber(semanticRaw.blend ?? 0.0, "semantic blend"),
      neighbor_k: neighborK,
      neighbor_prototypes: neighborPrototypes,
    });
  }
}

export function preferenceNeighborVoteWeight(model: PreferenceModel): number {
  const blend = model.training_summary.decision_blend;
  const value = isRecord(blend) ? blend.neighbor_weight : null;
  if (isFiniteNumber(value) && value >= 0.0 && value <= 1.0) {
    return value;
  }
  return DEFAULT_SEMANTIC_NEIGHBOR_VOTE_WEIGHT;
}

export function preferenceDecisionScore(
  model: PreferenceModel,
  prediction: PreferencePrediction,
): number {
  if (!prediction.neighbor_available || prediction.neighbor_probability === null) {
    return 0.0;
  }
  const weight = preferenceNeighborVoteWeight(model);
  return weight * prediction.neighbor_probability + (1.0 - weight) * prediction.probability;
}

export function preferenceDecisionThreshold(model: PreferenceModel): number {
  const value = model.training_summary.decision_threshold;
  if (isFiniteNumber(value)) {
    return Math.min(1.0, Math.max(0.0, value));
  }
  return DEFAULT_DECISION_THRESHOLD;
}

export function hasDislikeNeighborEvidence(prediction: PreferencePrediction): boolean {
  return (
    prediction.neighbor_available &&
    prediction.neighbor_probability !== null &&
    prediction.neighbor_max_similarity >= DEFAULT_NEIGHBOR_MIN_SIMILARITY &&
    prediction.neighbor_dislike_count > 0
  );
}

export function preferenceCandidate(
  model: PreferenceModel,
  prediction: PreferencePrediction,
): boolean {
  return (
    hasDislikeNeighborEvidence(prediction) &&
    preferenceDecisionScore(model, prediction) >= preferenceDecisionThreshold(model)
  );
}
