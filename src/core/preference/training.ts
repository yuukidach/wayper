import crypto from "node:crypto";
import {
  compareStrings,
  DECISION_CALIBRATION_FRACTION,
  DECISION_CALIBRATION_MAX_PER_CLASS,
  DECISION_CALIBRATION_OBJECTIVE,
  DECISION_CALIBRATION_VERSION,
  DECISION_MINIMUM_BOUNDARY,
  DECISION_TARGET_PRECISION,
  DEFAULT_COMBO_MIN_SUPPORT,
  DEFAULT_DECISION_THRESHOLD,
  DEFAULT_EPOCHS,
  DEFAULT_FEATURE_NORMALIZATION,
  DEFAULT_MAX_COMBO_FEATURES,
  DEFAULT_SEMANTIC_NEIGHBOR_VOTE_WEIGHT,
  DEFAULT_TRAINING_MAX_EXAMPLES,
  MIN_TRAINING_PER_CLASS,
  MIN_VALIDATION_PER_CLASS,
  MODEL_SCHEMA_VERSION,
  roundTo,
} from "./constants";
import {
  activeFeatureValues,
  buildNeighborPrototypes,
  contextMinSupport,
  ftrlWeight,
  groupExamplesByPurity,
  hasDislikeNeighborEvidence,
  modelTags,
  nLargest,
  normalizeContextFeatures,
  pairIsEligible,
  pairKeys,
  preferenceDecisionScore,
  PreferenceModel,
  selectPreferenceExamples,
  sigmoid,
  storageFeatureKey,
  type FeatureSpace,
  type PreferenceExample,
  type PredictRecord,
} from "./model";
import {
  fitSemanticHead,
  prefetchEmbeddings,
  semanticItemsWithContext,
  semanticTagItems,
  type SemanticHead,
} from "./semantic";

class MersenneTwister {
  private readonly state = new Uint32Array(624);
  private index = 625;

  constructor(seed: number) {
    this.initByArray([seed >>> 0]);
  }

  private initGenrand(seed: number): void {
    const mt = this.state;
    mt[0] = seed >>> 0;
    for (let i = 1; i < 624; i += 1) {
      const previous = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (Math.imul(1812433253, previous) + i) >>> 0;
    }
    this.index = 624;
  }

  private initByArray(key: number[]): void {
    const mt = this.state;
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(624, key.length); k > 0; k -= 1) {
      const previous = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(previous, 1664525)) + key[j] + j) >>> 0;
      i += 1;
      j += 1;
      if (i >= 624) {
        mt[0] = mt[623];
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = 623; k > 0; k -= 1) {
      const previous = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(previous, 1566083941)) - i) >>> 0;
      i += 1;
      if (i >= 624) {
        mt[0] = mt[623];
        i = 1;
      }
    }
    mt[0] = 0x80000000;
  }

  private nextUint32(): number {
    const mt = this.state;
    if (this.index >= 624) {
      let kk = 0;
      for (; kk < 624 - 397; kk += 1) {
        const y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
        mt[kk] = mt[kk + 397] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      for (; kk < 623; kk += 1) {
        const y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
        mt[kk] = mt[kk + (397 - 624)] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      const y = (mt[623] & 0x80000000) | (mt[0] & 0x7fffffff);
      mt[623] = mt[396] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      this.index = 0;
    }
    let y = mt[this.index];
    this.index += 1;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  randBelow(limit: number): number {
    if (limit <= 1) return 0;
    const bits = 32 - Math.clz32(limit);
    let value = this.nextUint32() >>> (32 - bits);
    while (value >= limit) {
      value = this.nextUint32() >>> (32 - bits);
    }
    return value;
  }
}

export function deterministicShuffleOrder(length: number, seed = 0): number[] {
  const order = Array.from({ length }, (_, index) => index);
  const generator = new MersenneTwister(seed);
  for (let i = length - 1; i >= 1; i -= 1) {
    const j = generator.randBelow(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function pyRoundInt(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

function isExplicit(example: PreferenceExample): boolean {
  return example.is_explicit_ban || example.is_explicit_keep || example.is_favorite;
}

export function hasBothClasses(examples: Iterable<PreferenceExample>, minimum: number): boolean {
  let negatives = 0;
  let positives = 0;
  for (const example of examples) {
    if (example.label === 0) negatives += 1;
    else if (example.label === 1) positives += 1;
  }
  return negatives >= minimum && positives >= minimum;
}

export function validateTrainingExamples(examples: Iterable<PreferenceExample>): void {
  if (!hasBothClasses(examples, MIN_TRAINING_PER_CLASS)) {
    throw new Error(
      `Need at least ${MIN_TRAINING_PER_CLASS} banned and retained metadata examples`,
    );
  }
}

export function wilsonLowerBound(successes: number, total: number, z = 1.96): number {
  if (total <= 0) return 0.0;
  const proportion = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = proportion + (z * z) / (2 * total);
  const margin = z * Math.sqrt((proportion * (1 - proportion) + (z * z) / (4 * total)) / total);
  return Math.max(0.0, (center - margin) / denominator);
}

export function recencyWeight(timestamp: number, now: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 1.0;
  const ageDays = Math.max(0, now - timestamp) / 86400;
  return 0.25 + 0.75 * 0.5 ** (ageDays / halfLifeDays);
}

export function metadataTimestamp(meta: Record<string, unknown>, fallback: number): number {
  const raw = meta.downloaded_at ?? fallback;
  const value = typeof raw === "string" && raw.trim() ? Number(raw) : raw;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  return fallback;
}

export function sampleWeights(examples: readonly PreferenceExample[]): [number[], number] {
  let positiveTotal = 0.0;
  let negativeTotal = 0.0;
  for (const example of examples) {
    if (example.label === 1) positiveTotal += example.base_weight;
    else if (example.label === 0) negativeTotal += example.base_weight;
  }
  if (!positiveTotal || !negativeTotal) {
    throw new Error("Need both banned and retained examples");
  }
  const target = (positiveTotal + negativeTotal) / 2;
  const positiveFactor = target / positiveTotal;
  const negativeFactor = target / negativeTotal;
  return [
    examples.map(
      (example) => example.base_weight * (example.label ? positiveFactor : negativeFactor),
    ),
    Math.log(positiveTotal / negativeTotal),
  ];
}

export function buildFeatureSpace(
  examples: Iterable<PreferenceExample>,
  comboMinSupport: number,
  maxComboFeatures: number,
): FeatureSpace {
  const tagCounts = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  const contextCounts = new Map<string, number>();
  const bump = (counts: Map<string, number>, key: string): void => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (const example of examples) {
    const tags = modelTags(example.tags);
    for (const tag of tags) bump(tagCounts, tag);
    if (maxComboFeatures) {
      for (const pair of pairKeys(tags)) bump(pairCounts, pair);
    }
    for (const token of normalizeContextFeatures(example.context_features)) {
      bump(contextCounts, token);
    }
  }
  const tags = new Set<string>();
  for (const [tag, count] of tagCounts) {
    if (count >= 2) tags.add(tag);
  }
  let orderedPairs = [...pairCounts.entries()]
    .filter(([pair, count]) => count >= comboMinSupport && pairIsEligible(pair))
    .sort((left, right) => right[1] - left[1] || compareStrings(left[0], right[0]))
    .map(([pair]) => pair);
  orderedPairs = maxComboFeatures ? orderedPairs.slice(0, maxComboFeatures) : [];
  const context = new Set<string>();
  for (const [token, count] of contextCounts) {
    if (count >= contextMinSupport(token)) context.add(token);
  }
  return { tags, combos: new Set(orderedPairs), context };
}

export function fitFtrl(
  examples: readonly PreferenceExample[],
  featureSpace: FeatureSpace,
  weights: readonly number[],
  epochs: number,
  options?: { normalization?: string; order?: readonly number[] },
): [number, Record<string, number>] {
  const normalization = options?.normalization ?? DEFAULT_FEATURE_NORMALIZATION;
  const alpha = 0.12;
  const beta = 1.0;
  const l1 = 0.08;
  const l2 = 0.15;
  const z = new Map<string, number>();
  const n = new Map<string, number>();
  let biasZ = 0.0;
  let biasN = 0.0;
  const order = options?.order ?? deterministicShuffleOrder(examples.length, 0);
  const features = examples.map((example) =>
    activeFeatureValues(example.tags, example.context_features, featureSpace, normalization).map(
      ([namespace, name, value]): [string, number] => [storageFeatureKey(namespace, name), value],
    ),
  );

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    for (const index of order) {
      const example = examples[index];
      const featureValues = features[index];
      const bias = ftrlWeight(biasZ, biasN, alpha, beta, 0.0, l2);
      let score = 0.0;
      for (const [name, value] of featureValues) {
        score += ftrlWeight(z.get(name) ?? 0.0, n.get(name) ?? 0.0, alpha, beta, l1, l2) * value;
      }
      score = bias + score;
      const gradient = (sigmoid(score) - example.label) * weights[index];

      let sigma = (Math.sqrt(biasN + gradient * gradient) - Math.sqrt(biasN)) / alpha;
      biasZ += gradient - sigma * bias;
      biasN += gradient * gradient;
      for (const [name, value] of featureValues) {
        const oldN = n.get(name) ?? 0.0;
        const oldZ = z.get(name) ?? 0.0;
        const weight = ftrlWeight(oldZ, oldN, alpha, beta, l1, l2);
        const featureGradient = gradient * value;
        sigma = (Math.sqrt(oldN + featureGradient * featureGradient) - Math.sqrt(oldN)) / alpha;
        z.set(name, oldZ + featureGradient - sigma * weight);
        n.set(name, oldN + featureGradient * featureGradient);
      }
    }
  }

  const fitted: Record<string, number> = {};
  for (const [name, zValue] of z) {
    const weight = ftrlWeight(zValue, n.get(name) ?? 0.0, alpha, beta, l1, l2);
    if (weight !== 0.0) fitted[name] = weight;
  }
  return [ftrlWeight(biasZ, biasN, alpha, beta, 0.0, l2), fitted];
}

export function fitSparseModel(
  examples: readonly PreferenceExample[],
  options: { comboMinSupport: number; maxComboFeatures: number; epochs: number },
): PreferenceModel {
  const featureSpace = buildFeatureSpace(examples, options.comboMinSupport, options.maxComboFeatures);
  const [weights] = sampleWeights(examples);
  const [bias, fitted] = fitFtrl(examples, featureSpace, weights, options.epochs, {
    normalization: DEFAULT_FEATURE_NORMALIZATION,
  });
  const pick = (names: ReadonlySet<string>, namespace: string): Record<string, number> => {
    const selected: Record<string, number> = {};
    for (const name of names) {
      const weight = fitted[storageFeatureKey(namespace, name)] ?? 0.0;
      if (weight) selected[name] = weight;
    }
    return selected;
  };
  const tagWeights = pick(featureSpace.tags, "tag");
  const comboWeights = pick(featureSpace.combos, "combo");
  const contextWeights = pick(featureSpace.context, "context");
  const count = (predicate: (example: PreferenceExample) => boolean): number =>
    examples.filter(predicate).length;
  return new PreferenceModel({
    bias,
    prior_log_odds: 0.0,
    tag_weights: tagWeights,
    combo_weights: comboWeights,
    context_weights: contextWeights,
    trained_at: new Date().toISOString().replace("Z", "+00:00"),
    training_summary: {
      examples: examples.length,
      banned: count((example) => example.label === 1),
      retained: count((example) => example.label === 0),
      controls: count((example) => example.is_control),
      favorites: count((example) => example.is_favorite),
      tag_features: Object.keys(tagWeights).length,
      combo_features: Object.keys(comboWeights).length,
      context_features: Object.keys(contextWeights).length,
      combo_min_support: options.comboMinSupport,
      max_combo_features: options.maxComboFeatures,
      feature_normalization: DEFAULT_FEATURE_NORMALIZATION,
      epochs: options.epochs,
      semantic_status: "disabled",
    },
    combo_min_support: options.comboMinSupport,
    max_combo_features: options.maxComboFeatures,
    schema_version: MODEL_SCHEMA_VERSION,
    feature_normalization: DEFAULT_FEATURE_NORMALIZATION,
  });
}

export function attachNeighborHead(
  model: PreferenceModel,
  examples: readonly PreferenceExample[],
): string {
  model.setNeighborHead(buildNeighborPrototypes(examples));
  return model.neighborHeadReady ? "ready" : "insufficient_explicit_feedback";
}

export function attachSemanticHead(
  model: PreferenceModel,
  examples: readonly PreferenceExample[],
  semanticModel: string | null,
): [string, SemanticHead | null] {
  if (semanticModel === null) return ["disabled", null];
  let head: SemanticHead | null;
  try {
    head = fitSemanticHead(examples, { modelName: semanticModel });
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error))
      .trim()
      .split(/\s+/)
      .join(" ")
      .slice(0, 180);
    const name = error instanceof Error ? error.name : "Error";
    return [`unavailable: ${name}${detail ? `: ${detail}` : ""}`, null];
  }
  if (head === null) return ["insufficient_feedback", null];
  model.setSemanticHead(head);
  return ["trained", head];
}

export function decisionCalibrationSplit(
  examples: readonly PreferenceExample[],
): [PreferenceExample[], PreferenceExample[]] {
  const explicit = examples.filter(isExplicit);
  const grouped: Record<number, PreferenceExample[]> = {
    0: explicit.filter((example) => example.label === 0),
    1: explicit.filter((example) => example.label === 1),
  };
  if (grouped[0].length < MIN_TRAINING_PER_CLASS * 2 || grouped[1].length < MIN_TRAINING_PER_CLASS * 2) {
    return [[], []];
  }

  const training: PreferenceExample[] = [];
  const holdout: PreferenceExample[] = [];
  for (const label of [0, 1]) {
    const group = grouped[label];
    let holdoutCount = Math.max(
      MIN_VALIDATION_PER_CLASS,
      pyRoundInt(group.length * DECISION_CALIBRATION_FRACTION),
    );
    holdoutCount = Math.min(
      holdoutCount,
      DECISION_CALIBRATION_MAX_PER_CLASS,
      group.length - MIN_TRAINING_PER_CLASS,
    );
    const purityGroups = groupExamplesByPurity(group);
    const capacities = new Map<string, number>();
    let capacityTotal = 0;
    for (const [purity, members] of purityGroups) {
      const capacity = Math.max(0, members.length - MIN_TRAINING_PER_CLASS);
      capacities.set(purity, capacity);
      capacityTotal += capacity;
    }
    holdoutCount = Math.min(holdoutCount, capacityTotal);
    const targets = new Map<string, number>();
    const quotas = new Map<string, number>();
    let quotaTotal = 0;
    for (const [purity, members] of purityGroups) {
      const target = (holdoutCount * members.length) / group.length;
      targets.set(purity, target);
      const quota = Math.min(Math.trunc(target), capacities.get(purity) ?? 0);
      quotas.set(purity, quota);
      quotaTotal += quota;
    }
    for (let extra = holdoutCount - quotaTotal; extra > 0; extra -= 1) {
      let best: string | null = null;
      let bestGap = 0;
      for (const [purity, quota] of quotas) {
        if (quota >= (capacities.get(purity) ?? 0)) continue;
        const gap = quota - (targets.get(purity) ?? 0);
        if (best === null || gap < bestGap || (gap === bestGap && compareStrings(purity, best) < 0)) {
          best = purity;
          bestGap = gap;
        }
      }
      if (best === null) break;
      quotas.set(best, (quotas.get(best) ?? 0) + 1);
    }
    const recent: PreferenceExample[] = [];
    for (const [purity, members] of purityGroups) {
      recent.push(
        ...nLargest(
          quotas.get(purity) ?? 0,
          members,
          (left, right) =>
            left.timestamp - right.timestamp || compareStrings(left.filename, right.filename),
        ),
      );
    }
    const recentSet = new Set(recent);
    training.push(...group.filter((example) => !recentSet.has(example)));
    holdout.push(...recent);
  }
  if (!hasBothClasses(holdout, MIN_VALIDATION_PER_CLASS)) return [[], []];
  return [
    selectPreferenceExamples(training, { limit: DEFAULT_TRAINING_MAX_EXAMPLES }),
    holdout.sort(
      (left, right) =>
        left.timestamp - right.timestamp ||
        compareStrings(left.filename, right.filename) ||
        left.label - right.label,
    ),
  ];
}

function holdoutRecords(holdout: readonly PreferenceExample[]): PredictRecord[] {
  return holdout.map(
    (example): PredictRecord => [
      example.tags,
      { _semantic_tag_items: example.semantic_tags },
      example.context_features,
    ],
  );
}

export function calibrateDecisionBoundary(
  model: PreferenceModel,
  holdout: readonly PreferenceExample[],
): Record<string, unknown> {
  const predictions = model.predictMany(holdoutRecords(holdout), { topN: 12 });
  const scored = holdout.map((example, index) => ({
    score: preferenceDecisionScore(model, predictions[index]),
    evidence: hasDislikeNeighborEvidence(predictions[index]),
    label: example.label,
  }));
  const values = [...new Set(scored.filter((row) => row.evidence).map((row) => row.score))].sort(
    (left, right) => left - right,
  );
  if (values.length === 0) {
    return {
      version: DECISION_CALIBRATION_VERSION,
      available: false,
      reason: "holdout produced no scores",
      threshold: DEFAULT_DECISION_THRESHOLD,
      objective: DECISION_CALIBRATION_OBJECTIVE,
    };
  }

  const candidates = [values[values.length - 1] + 1e-9];
  for (let index = 0; index + 1 < values.length; index += 1) {
    candidates.push((values[index] + values[index + 1]) / 2);
  }
  candidates.push(DECISION_MINIMUM_BOUNDARY, values[0] - 1e-9);
  const thresholds = [
    ...new Set(candidates.filter((boundary) => boundary >= DECISION_MINIMUM_BOUNDARY)),
  ].sort((left, right) => right - left);

  const positives = scored.filter((row) => row.label === 1).length;
  const minimumPredictions = Math.min(MIN_VALIDATION_PER_CLASS, positives);
  interface Row {
    precision: number;
    recall: number;
    accuracy: number;
    falsePositive: number;
    payload: Record<string, unknown>;
  }
  const rows: Row[] = [];
  for (const boundary of thresholds) {
    let truePositive = 0;
    let falsePositive = 0;
    let trueNegative = 0;
    let falseNegative = 0;
    for (const row of scored) {
      const candidate = row.evidence && row.score >= boundary;
      if (candidate && row.label === 1) truePositive += 1;
      else if (candidate && row.label === 0) falsePositive += 1;
      else if (!candidate && row.label === 0) trueNegative += 1;
      else if (!candidate && row.label === 1) falseNegative += 1;
    }
    const predicted = truePositive + falsePositive;
    if (predicted < minimumPredictions) continue;
    const precision = truePositive / predicted;
    const recall = truePositive / Math.max(1, truePositive + falseNegative);
    const accuracy = (truePositive + trueNegative) / scored.length;
    const fHalf =
      precision && recall ? (1.25 * precision * recall) / (0.25 * precision + recall) : 0.0;
    rows.push({
      precision,
      recall,
      accuracy,
      falsePositive,
      payload: {
        version: DECISION_CALIBRATION_VERSION,
        available: true,
        source: "stratified_recent_holdout",
        method: "two_stage_tag_semantic_knn",
        objective: DECISION_CALIBRATION_OBJECTIVE,
        target_precision: DECISION_TARGET_PRECISION,
        threshold: roundTo(boundary, 6),
        examples: scored.length,
        banned: positives,
        retained: scored.length - positives,
        predicted,
        true_positive: truePositive,
        false_positive: falsePositive,
        precision: roundTo(precision, 3),
        precision_lower_bound: roundTo(wilsonLowerBound(truePositive, predicted), 3),
        recall: roundTo(recall, 3),
        accuracy: roundTo(accuracy, 3),
        f0_5: roundTo(fHalf, 3),
      },
    });
  }

  if (rows.length === 0) {
    return {
      version: DECISION_CALIBRATION_VERSION,
      available: false,
      reason: "holdout had too few positive predictions",
      threshold: DEFAULT_DECISION_THRESHOLD,
      objective: DECISION_CALIBRATION_OBJECTIVE,
    };
  }
  const precise = rows.filter((row) => row.precision >= DECISION_TARGET_PRECISION);
  if (precise.length === 0) {
    return {
      version: DECISION_CALIBRATION_VERSION,
      available: false,
      reason: "held-out precision target was not reached",
      threshold: roundTo(values[values.length - 1] + 1e-6, 6),
      objective: DECISION_CALIBRATION_OBJECTIVE,
      target_precision: DECISION_TARGET_PRECISION,
      examples: scored.length,
    };
  }
  let best = precise[0];
  for (const row of precise.slice(1)) {
    const better =
      row.recall - best.recall ||
      row.accuracy - best.accuracy ||
      row.precision - best.precision ||
      best.falsePositive - row.falsePositive;
    if (better > 0) best = row;
  }
  return best.payload;
}

export function learnDecisionBlend(
  model: PreferenceModel,
  holdout: readonly PreferenceExample[],
): Record<string, unknown> {
  const predictions = model.predictMany(holdoutRecords(holdout), { topN: 0 });
  const rows: Array<[number, number, number]> = [];
  holdout.forEach((example, index) => {
    const prediction = predictions[index];
    if (
      prediction.semantic_available &&
      prediction.neighbor_available &&
      prediction.neighbor_probability !== null
    ) {
      rows.push([prediction.probability, prediction.neighbor_probability, example.label]);
    }
  });
  const counts: Record<number, number> = { 0: 0, 1: 0 };
  for (const [, , label] of rows) counts[label] = (counts[label] ?? 0) + 1;
  if (counts[0] < MIN_VALIDATION_PER_CLASS || counts[1] < MIN_VALIDATION_PER_CLASS) {
    return {
      available: false,
      neighbor_weight: DEFAULT_SEMANTIC_NEIGHBOR_VOTE_WEIGHT,
      reason: "not enough held-out semantic predictions",
    };
  }
  let numerator = 0.0;
  let denominator = 0.0;
  for (const [globalScore, neighbor, label] of rows) {
    numerator += ((neighbor - globalScore) * (label - globalScore)) / counts[label];
    denominator += (neighbor - globalScore) ** 2 / counts[label];
  }
  const weight =
    denominator > 1e-12
      ? Math.min(1.0, Math.max(0.0, numerator / denominator))
      : DEFAULT_SEMANTIC_NEIGHBOR_VOTE_WEIGHT;
  const loss = (blend: number): number => {
    let total = 0.0;
    for (const [globalScore, neighbor, label] of rows) {
      total += (blend * neighbor + (1.0 - blend) * globalScore - label) ** 2 / counts[label];
    }
    return total / 2;
  };
  return {
    available: true,
    source: "nested_recent_holdout",
    objective: "balanced_brier_loss",
    examples: rows.length,
    neighbor_weight: weight,
    loss: roundTo(loss(weight), 6),
    default_loss: roundTo(loss(DEFAULT_SEMANTIC_NEIGHBOR_VOTE_WEIGHT), 6),
  };
}

export function trainingExamplePayload(example: PreferenceExample, includeWeight: boolean): string {
  const values: unknown[] = [
    example.filename,
    [...example.tags],
    example.label,
    example.timestamp,
    example.is_favorite,
    example.is_explicit_keep,
    example.is_control,
    example.temporal_label_known,
    example.is_explicit_ban,
    [...example.context_features],
    example.semantic_tags.map(([key, text]) => [key, text]),
  ];
  if (includeWeight) values.push(roundTo(example.base_weight, 10));
  return JSON.stringify(values);
}

export function trainingExampleIds(examples: Iterable<PreferenceExample>): string[] {
  const ids: string[] = [];
  for (const example of examples) {
    ids.push(
      crypto
        .createHash("sha256")
        .update(trainingExamplePayload(example, false), "utf8")
        .digest("hex")
        .slice(0, 16),
    );
  }
  return ids.sort(compareStrings);
}

export function trainingDataSignature(examples: Iterable<PreferenceExample>): string {
  const payloads: string[] = [];
  for (const example of examples) payloads.push(trainingExamplePayload(example, true));
  payloads.sort(compareStrings);
  const digest = crypto.createHash("sha256");
  for (const payload of payloads) {
    digest.update(payload, "utf8");
    digest.update("\n");
  }
  return digest.digest("hex");
}

export function trainingEmbeddingTexts(examples: Iterable<PreferenceExample>): string[] {
  const texts = new Set<string>();
  for (const example of examples) {
    const items =
      example.semantic_tags.length > 0 ? example.semantic_tags : semanticTagItems(example.tags);
    for (const [, text] of semanticItemsWithContext(items, example.context_features)) {
      texts.add(text);
    }
    for (const [, text] of semanticTagItems(example.tags, {
      _semantic_tag_items: example.semantic_tags,
    })) {
      texts.add(text);
    }
    for (const tag of modelTags(example.tags)) texts.add(tag);
  }
  return [...texts];
}

export interface TrainPreferenceModelOptions {
  comboMinSupport?: number;
  maxComboFeatures?: number;
  epochs?: number;
  feedbackRevision?: number;
  retrainMode?: string;
  semanticModel?: string | null;
  labelSource?: string;
}

export function trainPreferenceModelSync(
  examples: readonly PreferenceExample[],
  options?: TrainPreferenceModelOptions,
): PreferenceModel {
  const comboMinSupport = options?.comboMinSupport ?? DEFAULT_COMBO_MIN_SUPPORT;
  const maxComboFeatures = options?.maxComboFeatures ?? DEFAULT_MAX_COMBO_FEATURES;
  const epochs = options?.epochs ?? DEFAULT_EPOCHS;
  const semanticModel = options?.semanticModel ?? null;
  validateTrainingExamples(examples);
  if (comboMinSupport < 2) throw new Error("combo_min_support must be at least 2");
  if (maxComboFeatures < 0) throw new Error("max_combo_features cannot be negative");
  if (epochs < 1) throw new Error("epochs must be positive");
  const fitOptions = { comboMinSupport, maxComboFeatures, epochs };

  const [calibrationTraining, calibrationHoldout] = decisionCalibrationSplit(examples);
  let decisionCalibration: Record<string, unknown> = {
    version: DECISION_CALIBRATION_VERSION,
    available: false,
    reason: "not enough explicit Keep/Dislike decisions",
    threshold: DEFAULT_DECISION_THRESHOLD,
    objective: DECISION_CALIBRATION_OBJECTIVE,
  };
  let decisionBlend: Record<string, unknown> = {
    available: false,
    neighbor_weight: DEFAULT_SEMANTIC_NEIGHBOR_VOTE_WEIGHT,
    reason: "not enough explicit decisions for an inner holdout",
  };
  if (calibrationTraining.length > 0 && calibrationHoldout.length > 0) {
    const [blendTraining, blendHoldout] = decisionCalibrationSplit(calibrationTraining);
    if (semanticModel !== null && blendTraining.length > 0 && blendHoldout.length > 0) {
      const blendModel = fitSparseModel(blendTraining, fitOptions);
      attachNeighborHead(blendModel, blendTraining);
      attachSemanticHead(blendModel, blendTraining, semanticModel);
      decisionBlend = learnDecisionBlend(blendModel, blendHoldout);
    }
    const calibrationModel = fitSparseModel(calibrationTraining, fitOptions);
    attachNeighborHead(calibrationModel, calibrationTraining);
    attachSemanticHead(calibrationModel, calibrationTraining, semanticModel);
    calibrationModel.training_summary.decision_blend = decisionBlend;
    decisionCalibration = calibrateDecisionBoundary(calibrationModel, calibrationHoldout);
  }

  const workingExamples = selectPreferenceExamples(examples, {
    limit: DEFAULT_TRAINING_MAX_EXAMPLES,
  });
  const model = fitSparseModel(workingExamples, fitOptions);
  const neighborStatus = attachNeighborHead(model, examples);
  const [semanticStatus, semanticHead] = attachSemanticHead(model, workingExamples, semanticModel);
  if (semanticHead !== null) {
    Object.assign(model.training_summary, {
      semantic_examples: semanticHead.examples,
      semantic_positives: semanticHead.positives,
      semantic_negatives: semanticHead.negatives,
      semantic_dimension: semanticHead.dimension,
    });
  }
  const count = (predicate: (example: PreferenceExample) => boolean): number =>
    examples.filter(predicate).length;
  Object.assign(model.training_summary, {
    feedback_revision: options?.feedbackRevision ?? 0,
    training_data_signature: trainingDataSignature(examples),
    working_example_ids: trainingExampleIds(workingExamples),
    retrain_mode: options?.retrainMode ?? "manual",
    total_examples: examples.length,
    working_examples: workingExamples.length,
    banned: count((example) => example.label === 1),
    retained: count((example) => example.label === 0),
    explicit_keeps: count((example) => example.is_explicit_keep),
    explicit_bans: count((example) => example.is_explicit_ban),
    controls: count((example) => example.is_control),
    semantic_model: semanticModel ?? "",
    semantic_status: semanticStatus,
    neighbor_status: neighborStatus,
    neighbor_examples: model.neighbor_prototypes.length,
    neighbor_dislikes: model.neighbor_prototypes.filter((prototype) => prototype.label === 1)
      .length,
    neighbor_keeps: model.neighbor_prototypes.filter((prototype) => prototype.label === 0).length,
    neighbor_k: model.neighbor_k,
    label_source: options?.labelSource ?? "legacy",
    decision_threshold: decisionCalibration.threshold,
    decision_calibration: decisionCalibration,
    decision_blend: decisionBlend,
  });
  return model;
}

export async function trainPreferenceModel(
  examples: readonly PreferenceExample[],
  options?: TrainPreferenceModelOptions,
): Promise<PreferenceModel> {
  validateTrainingExamples(examples);
  const semanticModel = options?.semanticModel ?? null;
  let resolvedSemanticModel = semanticModel;
  if (semanticModel !== null) {
    try {
      await prefetchEmbeddings(trainingEmbeddingTexts(examples), semanticModel);
    } catch (error) {
      const model = trainPreferenceModelSync(examples, { ...options, semanticModel: null });
      const detail = (error instanceof Error ? error.message : String(error))
        .trim()
        .split(/\s+/)
        .join(" ")
        .slice(0, 180);
      const name = error instanceof Error ? error.name : "Error";
      model.training_summary.semantic_model = semanticModel;
      model.training_summary.semantic_status = `unavailable: ${name}${detail ? `: ${detail}` : ""}`;
      return model;
    }
    resolvedSemanticModel = semanticModel;
  }
  return trainPreferenceModelSync(examples, { ...options, semanticModel: resolvedSemanticModel });
}
