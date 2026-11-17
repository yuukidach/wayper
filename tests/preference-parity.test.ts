import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import {
  buildNeighborPrototypes,
  makeExample,
  preferenceCandidate,
  preferenceDecisionScore,
  selectPreferenceExamples,
  semanticContextSimilarity,
  type PreferenceExample,
  type PredictRecord,
} from "../src/core/preference/model";
import { savePreferenceModel } from "../src/core/preference/ledger";
import { preferenceDeletionSuggestions } from "../src/core/preference/review";
import {
  embedTagSets,
  semanticDiskCacheKey,
  semanticIdf,
  semanticTagItems,
  setCustomTextEmbedder,
  tagMaxSim,
  tagMaxSimMany,
  weightedTagJaccard,
} from "../src/core/preference/semantic";
import {
  buildFeatureSpace,
  decisionCalibrationSplit,
  deterministicShuffleOrder,
  fitFtrl,
  recencyWeight,
  sampleWeights,
  trainPreferenceModelSync,
  wilsonLowerBound,
} from "../src/core/preference/training";

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "preference-e2e.json"), "utf8"),
);
const DIM: number = fixture.dim;

function hashVector(text: string): Float64Array {
  const digest = crypto.createHash("sha256").update(text, "utf8").digest();
  const out = new Float64Array(DIM);
  for (let i = 0; i < DIM; i += 1) out[i] = (digest[i] - 127.5) / 127.5;
  return out;
}

function fakeVector(text: string): Float32Array {
  const words = text
    .toLowerCase()
    .replace(/[;:.]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const base = hashVector(text);
  const vector = new Float64Array(DIM);
  for (let i = 0; i < DIM; i += 1) vector[i] = 0.3 * base[i];
  for (const word of words) {
    const piece = hashVector(word);
    for (let i = 0; i < DIM; i += 1) vector[i] += piece[i];
  }
  let norm = 0;
  for (let i = 0; i < DIM; i += 1) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm);
  const out = new Float32Array(DIM);
  for (let i = 0; i < DIM; i += 1) out[i] = vector[i] / norm;
  return out;
}

const examples: PreferenceExample[] = fixture.examples.map((raw: PreferenceExample) =>
  makeExample(raw),
);

function closeTo(actual: number, expected: number, tolerance: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

beforeAll(() => {
  delete process.env.WAYPER_SEMANTIC_CACHE;
  setCustomTextEmbedder((texts) => texts.map(fakeVector));
});

afterAll(() => {
  setCustomTextEmbedder(null);
});

describe("python parity: deterministic pieces", () => {
  it("reproduces random.Random(0).shuffle", () => {
    for (const [length, order] of Object.entries(fixture.orders)) {
      expect(deterministicShuffleOrder(Number(length))).toEqual(order);
    }
    expect(deterministicShuffleOrder(examples.length)).toEqual(fixture.order);
  });

  it("matches the fake embedder", () => {
    for (const [text, expected] of Object.entries(fixture.embed_samples)) {
      const actual = fakeVector(text);
      (expected as number[]).forEach((value, index) => closeTo(actual[index], value, 1e-7));
    }
  });

  it("builds the same feature space and class weights", () => {
    const space = buildFeatureSpace(examples, 3, 12);
    expect([...space.tags].sort()).toEqual(fixture.feature_space.tags);
    expect([...space.combos].sort()).toEqual(fixture.feature_space.combos);
    expect([...space.context].sort()).toEqual(fixture.feature_space.context);
    const [weights, prior] = sampleWeights(examples);
    closeTo(prior, fixture.prior, 1e-12);
    weights.forEach((value, index) => closeTo(value, fixture.sample_weights[index], 1e-12));
  });

  it("fits identical FTRL weights", () => {
    const space = buildFeatureSpace(examples, 3, 12);
    const [weights] = sampleWeights(examples);
    const [bias, fitted] = fitFtrl(examples, space, weights, 6);
    closeTo(bias, fixture.ftrl.bias, 1e-9);
    expect(Object.keys(fitted).sort()).toEqual(Object.keys(fixture.ftrl.weights).sort());
    for (const [name, value] of Object.entries(fixture.ftrl.weights)) {
      closeTo(fitted[name], value as number, 1e-9);
    }
  });

  it("splits and selects the same examples", () => {
    const [train, holdout] = decisionCalibrationSplit(examples);
    expect(train.map((example) => example.filename)).toEqual(fixture.split.train);
    expect(holdout.map((example) => example.filename)).toEqual(fixture.split.holdout);
    for (const [limit, expected] of Object.entries(fixture.select)) {
      expect(
        selectPreferenceExamples(examples, { limit: Number(limit) }).map((e) => e.filename),
      ).toEqual(expected);
    }
    expect(
      selectPreferenceExamples(examples, { limit: 60, explicitOnly: true }).map((e) => e.filename),
    ).toEqual(fixture.select_explicit_60);
  });

  it("builds identical neighbour prototypes", () => {
    const prototypes = buildNeighborPrototypes(examples);
    expect(prototypes.length).toBe(fixture.prototype_count);
    fixture.prototypes.forEach(
      (expected: { filename: string; label: number; features: [string, number][] }, index: number) => {
        expect(prototypes[index].filename).toBe(expected.filename);
        expect(prototypes[index].label).toBe(expected.label);
        expect(prototypes[index].features.map(([name]) => name)).toEqual(
          expected.features.map(([name]) => name),
        );
        expected.features.forEach(([, value], position) =>
          closeTo(prototypes[index].features[position][1], value, 1e-12),
        );
      },
    );
  });

  it("matches scalar helpers", () => {
    for (const [left, right, expected] of fixture.context_similarity) {
      closeTo(semanticContextSimilarity(left, right), expected, 1e-12);
    }
    for (const [successes, total, expected] of fixture.wilson) {
      closeTo(wilsonLowerBound(successes, total), expected, 1e-12);
    }
    for (const [timestamp, now, halfLife, expected] of fixture.recency) {
      closeTo(recencyWeight(timestamp, now, halfLife), expected, 1e-12);
    }
  });
});

describe("python parity: semantic retrieval", () => {
  const records = examples
    .slice(0, 30)
    .map((example) =>
      semanticTagItems(example.tags, { _semantic_tag_items: example.semantic_tags }),
    );

  it("matches idf, pooling, MaxSim and weighted Jaccard", () => {
    const idf = semanticIdf(records);
    expect(Object.keys(idf).sort()).toEqual(Object.keys(fixture.idf).sort());
    for (const [key, value] of Object.entries(fixture.idf)) closeTo(idf[key], value as number, 1e-12);
    const sets = embedTagSets(records.slice(0, 6), { modelName: "x", idf });
    fixture.pooled0.forEach((value: number, index: number) =>
      closeTo(sets[0].pooled[index], value, 1e-5),
    );
    const [score, matches] = tagMaxSim(sets[0], sets[2], idf);
    closeTo(score, fixture.maxsim_0_2.score, 1e-5);
    expect(matches.map(([query, prototype]) => [query, prototype])).toEqual(
      fixture.maxsim_0_2.matches.map(([query, prototype]: [string, string]) => [query, prototype]),
    );
    tagMaxSimMany(sets[0], sets.slice(1, 6), idf, { includeMatches: false }).forEach(
      ([value], index) => closeTo(value, fixture.maxsim_many_0[index], 1e-5),
    );
    let defaultIdf = 0;
    for (const value of Object.values(idf)) defaultIdf = Math.max(defaultIdf, value);
    closeTo(
      weightedTagJaccard(sets[0].items, sets[2].items, idf, { defaultIdf }),
      fixture.jaccard_0_2,
      1e-12,
    );
  });

  it("scores identically with and without shared row vectors", () => {
    const idf = semanticIdf(records);
    const sets = embedTagSets(records.slice(0, 12), { modelName: "x", idf });
    const plain = sets.map(({ items, matrix, dimension }) => ({ items, matrix, dimension }));
    const shared = tagMaxSimMany(sets[0], sets.slice(1), idf);
    const unshared = tagMaxSimMany(plain[0], plain.slice(1), idf);
    expect(shared.map(([score, matches]) => [score, matches])).toEqual(
      unshared.map(([score, matches]) => [score, matches]),
    );
  });

  it("keys the embedding cache with a digest Electron's BoringSSL provides", () => {
    // BLAKE2 and SHA-3 exist in Node's OpenSSL but not in Electron, where an
    // unsupported digest silently disabled the cache.
    const expected = crypto
      .createHash("sha256")
      .update("model\x00tag text", "utf8")
      .digest()
      .subarray(0, 16)
      .toString("hex");
    expect(semanticDiskCacheKey("model", "tag text")).toBe(expected);
  });
});

describe("python parity: end-to-end training", () => {
  let model: ReturnType<typeof trainPreferenceModelSync>;
  const expected = fixture.model;

  beforeAll(() => {
    model = trainPreferenceModelSync(examples, {
      comboMinSupport: 3,
      maxComboFeatures: 12,
      epochs: 6,
      feedbackRevision: 7,
      semanticModel: "x",
      labelSource: "model_review",
    });
  });

  it("fits the same sparse and semantic heads", () => {
    closeTo(model.bias, expected.bias, 1e-9);
    for (const key of ["tag_weights", "combo_weights", "context_weights"] as const) {
      expect(Object.keys(model[key]).sort()).toEqual(Object.keys(expected[key]).sort());
      for (const [name, value] of Object.entries(expected[key])) {
        closeTo(model[key][name], value as number, 1e-9);
      }
    }
    closeTo(model.semantic_bias, expected.semantic_bias, 1e-4);
    expect(model.semantic_weights.length).toBe(expected.semantic_weights.length);
    expected.semantic_weights.forEach((value: number, index: number) =>
      closeTo(model.semantic_weights[index], value, 1e-4),
    );
    closeTo(model.semantic_blend, expected.semantic_blend, 1e-12);
  });

  it("calibrates the same decision policy", () => {
    const summary = model.training_summary;
    for (const [key, value] of Object.entries(expected.summary)) {
      expect(summary[key]).toEqual(value);
    }
    const calibration = summary.decision_calibration as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected.decision_calibration)) {
      if (typeof value === "number") closeTo(calibration[key] as number, value, 2e-3);
      else expect(calibration[key]).toEqual(value);
    }
    const blend = summary.decision_blend as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected.decision_blend)) {
      if (typeof value === "number") closeTo(blend[key] as number, value, 1e-3);
      else expect(blend[key]).toEqual(value);
    }
    closeTo(summary.decision_threshold as number, expected.decision_threshold, 2e-3);
  });

  it("scores unseen records identically", () => {
    const records: PredictRecord[] = fixture.queries.map(
      (meta: Record<string, unknown>): PredictRecord => [meta.tags as string[], meta, null],
    );
    const predictions = model.predictMany(records, { topN: 6 });
    predictions.forEach((prediction, index) => {
      const want = fixture.predictions[index];
      closeTo(prediction.score, want.raw.score, 1e-3);
      closeTo(prediction.probability, want.raw.probability, 1e-3);
      closeTo(prediction.feature_score, want.raw.feature_score, 1e-9);
      expect(prediction.semantic_available).toBe(want.semantic_available);
      if (want.raw.semantic_score !== null) {
        closeTo(prediction.semantic_score as number, want.raw.semantic_score, 1e-3);
      }
      expect(prediction.neighbor_available).toBe(want.neighbor_available);
      expect(prediction.neighbor_count).toBe(want.neighbor_count);
      expect(prediction.neighbor_dislike_count).toBe(want.neighbor_dislike_count);
      expect(prediction.neighbor_keep_count).toBe(want.neighbor_keep_count);
      if (want.raw.neighbor_probability !== null) {
        closeTo(prediction.neighbor_probability as number, want.raw.neighbor_probability, 1e-4);
      }
      closeTo(prediction.neighbor_max_similarity, want.raw.neighbor_max_similarity, 1e-4);
      closeTo(prediction.neighbor_similarity_sum, want.raw.neighbor_similarity_sum, 1e-3);
      expect(prediction.neighbor_nearest_dislike?.filename ?? null).toBe(
        want.neighbor_nearest_dislike?.filename ?? null,
      );
      expect(prediction.neighbor_nearest_keep?.filename ?? null).toBe(
        want.neighbor_nearest_keep?.filename ?? null,
      );
      closeTo(preferenceDecisionScore(model, prediction), want.raw.decision_score, 1e-3);
      expect(preferenceCandidate(model, prediction)).toBe(want.raw.candidate);
      expect(prediction.contributions.map((item) => `${item.type}:${item.feature}`)).toEqual(
        want.contributions.map((item: { type: string; feature: string }) => `${item.type}:${item.feature}`),
      );
    });
    const single = model.predict(fixture.queries[0].tags, { metadata: fixture.queries[0], topN: 6 });
    closeTo(single.score, predictions[0].score, 1e-9);
  });

  it("round-trips through JSON", async () => {
    const { PreferenceModel } = await import("../src/core/preference/model");
    const restored = PreferenceModel.fromDict(JSON.parse(JSON.stringify(model.toDict())));
    const record: PredictRecord = [fixture.queries[3].tags, fixture.queries[3], null];
    const before = model.predictMany([record])[0];
    const after = restored.predictMany([record])[0];
    closeTo(after.score, before.score, 1e-9);
    expect(after.neighbor_count).toBe(before.neighbor_count);
  });

  it("keeps cached deletion suggestions identical across library updates and attaches dimensions", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wayper-pref-cache-"));
    try {
      const pool = path.join(tmpRoot, "sfw", "landscape");
      fs.mkdirSync(pool, { recursive: true });
      const metadata: Record<string, Record<string, unknown>> = {};
      fixture.queries.forEach((query: Record<string, unknown>, idx: number) => {
        const name = `wallhaven-q${String(idx).padStart(4, "0")}.jpg`;
        fs.writeFileSync(path.join(pool, name), "x");
        metadata[name] = {
          ...query,
          dimension_x: 3840,
          dimension_y: 2160,
        };
      });
      fs.writeFileSync(path.join(tmpRoot, ".metadata.json"), JSON.stringify(metadata));
      await savePreferenceModel(model, path.join(tmpRoot, ".preference_model.json"));

      const cold = await preferenceDeletionSuggestions(tmpRoot, {
        purities: ["sfw"],
        orientation: "landscape",
        limit: 60,
        includeLearning: false,
        metadataSnapshot: metadata,
      });
      const warm = await preferenceDeletionSuggestions(tmpRoot, {
        purities: ["sfw"],
        orientation: "landscape",
        limit: 60,
        includeLearning: false,
        metadataSnapshot: metadata,
      });
      expect(warm).toEqual(cold);
      const items = cold.items as Array<{ width?: number; height?: number }>;
      for (const item of items) {
        expect(item.width).toBe(3840);
        expect(item.height).toBe(2160);
      }

      // Reloaded metadata objects (same values, new object references) must also match.
      const clonedMeta = JSON.parse(JSON.stringify(metadata)) as Record<
        string,
        Record<string, unknown>
      >;
      const reloaded = await preferenceDeletionSuggestions(tmpRoot, {
        purities: ["sfw"],
        orientation: "landscape",
        limit: 60,
        includeLearning: false,
        metadataSnapshot: clonedMeta,
      });
      expect(reloaded).toEqual(cold);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
