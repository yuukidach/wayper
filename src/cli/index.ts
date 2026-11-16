import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutostartError, setAutostart, type AutostartCommand } from "../core/autostart";
import { notify } from "../core/backend";
import { loadSuggestionCatalog } from "../core/catalog";
import { loadConfig, type WayperConfig } from "../core/config";
import { resolveControlEndpoint, trySendControlAction } from "../core/control-ipc";
import {
  doBackfillMetadata,
  doBan,
  doDislike,
  doFav,
  doNext,
  doPrev,
  doUnban,
  doUnfav,
  metadataBackfillStatus,
  statusSnapshot,
  type CoreResult,
} from "../core/core";
import { applyGlobalProxy } from "../core/http";
import { setupLogging } from "../core/logging";
import { ALL_PURITIES, getConfigDir, isPurity } from "../core/paths";
import { loadMetadata } from "../core/pool";
import {
  collectPreferenceTrainingSnapshot,
  loadPreferenceModel,
  modelReport,
  prefetchModelEmbeddings,
  preferenceLearningStatus,
  preferenceModelPath,
  runScheduledPreferenceModelRetrain,
  setCliEntryPath,
  trainAndSaveLocalPreferenceModel,
} from "../core/preference/ledger";
import {
  preferenceCandidate,
  preferenceDecisionScore,
  preferenceDecisionThreshold,
} from "../core/preference/model";
import { readMode, toggleBase, togglePurity, writeMode } from "../core/state";
import { suggestTagsToExclude } from "../core/suggestions";
import { checkForUpdates } from "../core/update";
import { refillPool } from "../core/wallhaven";
import type { Purity } from "../shared/types";
import { WAYPER_VERSION } from "../shared/version";

type JsonRecord = Record<string, unknown>;
type OptionValue = string | number | boolean;

class UsageError extends Error {}

class CliExit extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

interface OptionSpec {
  flag: string;
  key: string;
  type: "flag" | "string" | "int" | "float";
  min?: number;
  help: string;
  hidden?: boolean;
}

interface CommandSpec {
  path: string[];
  summary: string;
  args?: string;
  maxPositionals?: number;
  options?: OptionSpec[];
  hidden?: boolean;
  /** Skip display detection for commands that never touch monitors. */
  needsDisplays?: boolean;
  loadsConfig?: boolean;
  run: (context: CliContext, input: ParsedCommand) => Promise<void> | void;
}

interface ParsedCommand {
  positionals: string[];
  options: Record<string, OptionValue>;
}

interface CliContext {
  config: WayperConfig;
  configPath: string | null;
  json: boolean;
}

const DESKTOP_ACTIONS = ["next", "prev", "fav", "unfav", "ban", "dislike"] as const;
type DesktopAction = (typeof DESKTOP_ACTIONS)[number];

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

function err(text: string): void {
  process.stderr.write(`${text}\n`);
}

function emitJson(payload: unknown, pretty = false): void {
  out(JSON.stringify(payload, null, pretty ? 2 : undefined));
}

/** Render a machine- or human-readable error and stop with ``code``. */
function fail(context: Pick<CliContext, "json">, message: string, code = 1, prefix = ""): never {
  if (context.json) emitJson({ error: message });
  else err(`${prefix}${message}`);
  throw new CliExit(code);
}

function requireSuccess(context: CliContext, result: CoreResult): void {
  if (!result.ok) fail(context, result.error ?? `${result.action} failed`);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function signed(value: number, digits: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function general(value: unknown): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(Number(numeric.toPrecision(6))) : String(value);
}

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function coreResult(action: string, fields: Partial<CoreResult>): CoreResult {
  return {
    action,
    ok: true,
    monitor: null,
    image: null,
    status: null,
    error: null,
    extra: {},
    ...fields,
  };
}

/**
 * Hand hotkey actions to the running desktop app.  ``null`` means nothing was
 * submitted, so running the action locally is safe.  A failed reply after
 * submission is never retried: the wallpaper may already have changed.
 */
async function tryDesktopAction(
  context: CliContext,
  action: DesktopAction,
  openUrl = false,
): Promise<CoreResult | null> {
  if (context.configPath !== null) return null;
  const response = await trySendControlAction(resolveControlEndpoint(getConfigDir()), {
    protocol: "wayper-control-v2",
    download_dir: path.resolve(context.config.download_dir),
    action,
    open_url: openUrl,
  });
  if (response === null) return null;
  return coreResult(action, {
    ok: response.ok,
    monitor: response.monitor ?? null,
    image: response.image ?? null,
    status: response.status && response.status !== "ok" ? response.status : null,
    error: response.ok ? null : (response.error ?? `Wayper could not complete ${action}`),
    extra: { opened: response.opened === true },
  });
}

async function desktopAction(
  context: CliContext,
  action: Exclude<DesktopAction, "next">,
  openUrl = false,
): Promise<CoreResult> {
  const handled = await tryDesktopAction(context, action, openUrl);
  if (handled !== null) return handled;
  switch (action) {
    case "prev":
      return doPrev(context.config);
    case "fav":
      return doFav(context.config, { openUrl });
    case "unfav":
      return doUnfav(context.config);
    case "ban":
      return doBan(context.config);
    case "dislike":
      return doDislike(context.config);
  }
}

function autostartCommandFromEnv(): AutostartCommand | undefined {
  const raw = process.env.WAYPER_AUTOSTART_COMMAND;
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed as string[];
    }
  } catch {
    // Fall back to automatic discovery.
  }
  return undefined;
}

function modeLabel(purities: Iterable<unknown>): string {
  const active = new Set(purities);
  return ALL_PURITIES.filter((purity) => active.has(purity)).join(", ");
}

function printModelSummary(report: JsonRecord, includeSchema: boolean): void {
  const training = record(report.training);
  const banned = training.banned;
  const retained = training.retained;
  const favorites = training.favorite_metadata_files ?? training.favorites;
  const favoriteFiles = training.favorite_files ?? favorites;
  if ([banned, retained, favorites, favoriteFiles].every((value) => Number.isInteger(value))) {
    out(
      `Training: ${banned} banned, ${retained} retained ` +
        `(${training.controls ?? 0} controls), ` +
        `${favorites} / ${favoriteFiles} favorites with usable metadata`,
    );
  }
  if (includeSchema) {
    out(
      `Model schema: ${report.schema_version ?? 1} (${report.feature_normalization ?? "legacy"})`,
    );
  }
  out(
    `Features: ${report.tag_features} tags, ${report.context_features ?? 0} context, ` +
      `${report.combo_features} experimental combos`,
  );
  if (report.neighbor_head_ready) {
    out(
      `Content-neighbor head: ${report.neighbor_prototypes ?? 0} explicit prototypes, ` +
        `k=${report.neighbor_k}`,
    );
    out(`Decision boundary: >= ${Number(report.decision_threshold ?? 0.8).toFixed(3)}`);
  } else {
    out("Content-neighbor head: waiting for explicit Keep/Dislike feedback");
  }
  out(`Labels: ${report.label_source ?? "legacy"}`);
  if (report.semantic_enabled) {
    out(`Semantic head: ${report.semantic_model} (${report.semantic_dimension} dimensions)`);
  } else {
    const status = training.semantic_status;
    const unavailable = Boolean(status) && String(status).startsWith("unavailable");
    out(`Semantic head: ${unavailable ? "unavailable" : "not trained"}`);
  }
  const calibration = record(report.decision_calibration);
  if (calibration.available) {
    out(
      `Held-out calibration: precision ${calibration.precision}, recall ${calibration.recall}`,
    );
  } else {
    out("Held-out calibration: insufficient labelled data");
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const COMMANDS: CommandSpec[] = [
  {
    path: ["autostart"],
    summary: "Enable, disable, or show GUI autostart.",
    args: "[enable|disable|status]",
    maxPositionals: 1,
    run(context, input) {
      const state = input.positionals[0] ?? "status";
      if (!["enable", "disable", "status"].includes(state)) {
        throw new UsageError(`Invalid state '${state}'. Choose enable, disable, or status.`);
      }
      let payload: JsonRecord;
      if (state === "status") {
        payload = { autostart: context.config.autostart };
      } else {
        try {
          const result = setAutostart(
            context.config,
            state === "enable",
            autostartCommandFromEnv(),
            context.configPath ? { configPath: context.configPath } : undefined,
          );
          payload = { autostart: result.enabled, unit: result.unit };
        } catch (error) {
          if (!(error instanceof AutostartError)) throw error;
          fail(context, error.message, 1, "Error: ");
        }
      }
      if (context.json) emitJson(payload);
      else out(`Autostart is ${payload.autostart ? "enabled" : "disabled"}`);
    },
  },
  {
    path: ["next"],
    summary: "Change wallpaper on the focused monitor.",
    needsDisplays: true,
    async run(context) {
      const handled = await tryDesktopAction(context, "next");
      const result = handled ?? (await doNext(context.config));
      requireSuccess(context, result);
      if (context.json) {
        emitJson({ action: "next", monitor: result.monitor, image: result.image });
      } else {
        notify("Wallpaper", "Next wallpaper");
      }
      if (handled === null) await refillPool(context.config, readMode(context.config));
    },
  },
  {
    path: ["prev"],
    summary: "Go back to the previous wallpaper.",
    needsDisplays: true,
    async run(context) {
      const result = await desktopAction(context, "prev");
      requireSuccess(context, result);
      if (result.status === "at_oldest") {
        if (context.json) emitJson({ action: "prev", status: "at_oldest" });
        else notify("Wallpaper", "Already at oldest");
      } else if (context.json) {
        emitJson({ action: "prev", monitor: result.monitor, image: result.image });
      } else {
        notify("Wallpaper", "Previous wallpaper");
      }
    },
  },
  {
    path: ["fav"],
    summary: "Favorite the current wallpaper.",
    needsDisplays: true,
    options: [{ flag: "--open", key: "open", type: "flag", help: "Open on Wallhaven." }],
    async run(context, input) {
      const openUrl = input.options.open === true;
      const result = await desktopAction(context, "fav", openUrl);
      requireSuccess(context, result);
      if (result.status === "already_favorite") {
        if (context.json) emitJson({ action: "fav", status: "already_favorite" });
        else notify("Wallpaper", "Already in favorites");
        return;
      }
      if (context.json) emitJson({ action: "fav", image: result.image, opened: openUrl });
      else notify("Wallpaper", openUrl ? "Saved & opened on Wallhaven" : "Saved to favorites");
    },
  },
  {
    path: ["unfav"],
    summary: "Remove current wallpaper from favorites.",
    needsDisplays: true,
    async run(context) {
      const result = await desktopAction(context, "unfav");
      requireSuccess(context, result);
      if (result.status === "not_favorite") {
        if (context.json) emitJson({ action: "unfav", status: "not_favorite" });
        else notify("Wallpaper", "Not a favorite");
        return;
      }
      if (context.json) emitJson({ action: "unfav", image: result.image });
      else notify("Wallpaper", "Removed from favorites");
    },
  },
  {
    path: ["ban"],
    summary: "Block the current wallpaper without teaching the preference model.",
    needsDisplays: true,
    async run(context) {
      const result = await desktopAction(context, "ban");
      requireSuccess(context, result);
      if (result.status === "is_favorite") {
        if (context.json) emitJson({ action: "ban", status: "is_favorite" });
        else notify("Wallpaper", "Can't ban a favorite");
        return;
      }
      if (context.json) emitJson({ action: "ban", image: result.image });
      else notify("Wallpaper", "Banned");
    },
  },
  {
    path: ["dislike"],
    summary: "Mark the current wallpaper as disliked and teach the preference model.",
    needsDisplays: true,
    async run(context) {
      const result = await desktopAction(context, "dislike");
      requireSuccess(context, result);
      if (context.json) emitJson({ action: "dislike", image: result.image });
      else notify("Wallpaper", "Disliked — preference saved");
    },
  },
  {
    path: ["unban"],
    summary: "Undo the last ban or dislike.",
    needsDisplays: true,
    async run(context) {
      const result = await doUnban(context.config);
      requireSuccess(context, result);
      if (result.status === "nothing_to_undo" || result.status === "file_missing") {
        if (context.json) emitJson({ action: "unban", status: result.status });
        else {
          notify(
            "Wallpaper",
            result.status === "file_missing" ? "Can't restore (file missing)" : "Nothing to undo",
          );
        }
        return;
      }
      if (context.json) emitJson({ action: "unban", image: result.image });
      else notify("Wallpaper", `Restored: ${result.image ? path.basename(result.image) : "unknown"}`);
    },
  },
  {
    path: ["mode"],
    summary: "Show or switch purity mode (no argument toggles sfw/nsfw).",
    args: "[sfw|nsfw|sketchy|a,b]",
    maxPositionals: 1,
    run(context, input) {
      const requested = input.positionals[0];
      const current = readMode(context.config);
      let next: Purity[];
      if (requested === undefined) {
        next = toggleBase(current);
      } else if (requested === "sketchy") {
        next = togglePurity(current, "sketchy");
      } else if (requested.includes(",")) {
        next = requested
          .split(",")
          .map((item) => item.trim())
          .filter(isPurity);
        if (next.length === 0) {
          err("Invalid mode. Use: sfw, sketchy, nsfw");
          throw new CliExit(1);
        }
      } else if (requested === "sfw" || requested === "nsfw") {
        next = [...current.filter((purity) => purity === "sketchy"), requested];
      } else {
        err(`Unknown mode: ${requested}. Use: sfw, sketchy, nsfw`);
        throw new CliExit(1);
      }
      const written = writeMode(context.config, next);
      if (context.json) emitJson({ action: "mode", mode: [...written].sort() });
      else notify("Wallpaper", `Mode: ${modeLabel(written)}`);
    },
  },
  {
    path: ["status"],
    summary: "Show current wallpapers, mode, and pool counts.",
    needsDisplays: true,
    run(context) {
      const snapshot = statusSnapshot(context.config);
      if (context.json) {
        emitJson(snapshot, true);
        return;
      }
      out(`Mode: ${modeLabel(snapshot.mode as string[])}`);
      out(`Disk: ${Number(snapshot.disk_mb).toFixed(0)} MB / ${snapshot.quota_mb} MB`);
      for (const monitor of snapshot.monitors as JsonRecord[]) {
        out(`  ${monitor.name} (${monitor.orientation}): ${monitor.image || "none"}`);
        out(`    Pool: ${monitor.pool_count}, Favorites: ${monitor.favorites_count}`);
      }
    },
  },
  {
    path: ["metadata", "status"],
    summary: "Show completeness of locally cached Wallhaven metadata.",
    options: [
      {
        flag: "--include-history",
        key: "includeHistory",
        type: "flag",
        help: "Inspect every historical record.",
      },
    ],
    run(context, input) {
      const result = metadataBackfillStatus(context.config, {
        includeHistory: input.options.includeHistory === true,
      });
      if (context.json) {
        emitJson(result, true);
        return;
      }
      out(
        `Metadata: ${result.complete_records}/${result.records} complete; ` +
          `${result.missing_tag_inputs} missing tag inputs, ` +
          `${result.incomplete_records} need full details, ` +
          `${result.unavailable_records} unavailable on last check`,
      );
      out(
        `Tag details: ${result.tag_details_complete_records} complete, ` +
          `${result.partial_tag_detail_records} partial, ` +
          `${result.missing_tag_detail_records} missing`,
      );
    },
  },
  {
    path: ["metadata", "backfill"],
    summary: "Backfill complete Wallhaven details for local images and preference labels.",
    options: [
      {
        flag: "--include-history",
        key: "includeHistory",
        type: "flag",
        help: "Include every historical metadata record, not only live/model-relevant images.",
      },
      {
        flag: "--missing-tags-only",
        key: "missingTagsOnly",
        type: "flag",
        help: "Fetch only records with no usable tags.",
      },
      { flag: "--limit", key: "limit", type: "int", min: 1, help: "Process at most N records." },
      {
        flag: "--delay",
        key: "delay",
        type: "float",
        min: 0,
        help: "Delay between API requests in seconds (default: 1.4).",
      },
    ],
    async run(context, input) {
      const result = await doBackfillMetadata(context.config, {
        includeHistory: input.options.includeHistory === true,
        missingTagsOnly: input.options.missingTagsOnly === true,
        limit: typeof input.options.limit === "number" ? input.options.limit : null,
        delaySeconds: typeof input.options.delay === "number" ? input.options.delay : 1.4,
        progress: (state) => {
          if (context.json) return;
          out(
            `Metadata: ${state.attempted}/${state.targeted} checked, ` +
              `${state.updated} updated, ${state.failed} failed`,
          );
        },
      });
      if (context.json) {
        emitJson({ action: result.action, status: result.status, ...result.extra });
      } else {
        out(
          `Metadata backfill ${result.status}: ${result.extra.updated} updated, ` +
            `${result.extra.failed} failed, ${result.extra.remaining} remaining`,
        );
      }
    },
  },
  {
    path: ["suggest"],
    summary: "Show tag exclusion suggestions.",
    async run(context) {
      const catalog = loadSuggestionCatalog(context.config);
      const suggestions = suggestTagsToExclude(
        catalog.metadata,
        new Set(catalog.bannedFilenames),
        context.config.wallhaven.exclude_tags,
        context.config.wallhaven.exclude_combos,
        new Set(catalog.favoriteFilenames),
      );
      if (context.json) {
        emitJson({ suggestions }, true);
      } else if (suggestions.length > 0) {
        out("Suggested exclusions (by ban frequency):");
        for (const item of suggestions) {
          out(
            `  ${item.tag} (${item.banned}/${item.kept}/${item.favorites}, ` +
              `net benefit: ${general(item.net_benefit)})`,
          );
        }
      } else {
        out("No suggestions at this time.");
      }
    },
  },
  {
    path: ["model", "train"],
    summary: "Train the lightweight local metadata preference model.",
    options: [
      {
        flag: "--combo-min-support",
        key: "comboMinSupport",
        type: "int",
        min: 2,
        help: "Minimum labelled images containing a tag pair (default: 20; experiments only).",
      },
      {
        flag: "--max-combos",
        key: "maxCombos",
        type: "int",
        min: 0,
        help: "Number of pair features; 0 (default) uses the recommended tag-only model.",
      },
      { flag: "--epochs", key: "epochs", type: "int", min: 1, help: "Training epochs (default: 6)." },
    ],
    async run(context, input) {
      const modelPath = preferenceModelPath(context.config);
      let report: JsonRecord;
      try {
        const [model, snapshot] = await trainAndSaveLocalPreferenceModel(context.config, {
          comboMinSupport: (input.options.comboMinSupport as number | undefined) ?? 20,
          maxComboFeatures: (input.options.maxCombos as number | undefined) ?? 0,
          epochs: (input.options.epochs as number | undefined) ?? 6,
        });
        report = modelReport(
          model,
          modelPath,
          preferenceLearningStatus(context.config, model, snapshot),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fail(context, message, 1, "Could not train preference model: ");
      }
      if (context.json) {
        emitJson(report, true);
        return;
      }
      out(`Saved preference model: ${modelPath}`);
      printModelSummary(report, false);
    },
  },
  {
    path: ["model", "refresh"],
    summary: "Run the detached local preference-model refresh worker.",
    hidden: true,
    loadsConfig: false,
    options: [
      { flag: "--download-dir", key: "downloadDir", type: "string", help: "Wallpaper directory." },
      { flag: "--lease-token", key: "leaseToken", type: "string", help: "Worker lease token." },
    ],
    async run(_context, input) {
      const downloadDir = input.options.downloadDir;
      const leaseToken = input.options.leaseToken;
      if (typeof downloadDir !== "string" || typeof leaseToken !== "string") {
        throw new UsageError("model refresh requires --download-dir and --lease-token");
      }
      await runScheduledPreferenceModelRetrain({ download_dir: downloadDir }, leaseToken);
    },
  },
  {
    path: ["model", "status"],
    summary: "Show the local preference model's training and validation summary.",
    run(context) {
      const modelPath = preferenceModelPath(context.config);
      const model = loadPreferenceModel(modelPath);
      if (model === null) {
        if (context.json) emitJson({ status: "untrained", path: modelPath }, true);
        else out("No preference model trained yet. Run: wayper model train");
        return;
      }
      const snapshot = collectPreferenceTrainingSnapshot(context.config);
      const learning = preferenceLearningStatus(context.config, model, snapshot);
      const report = modelReport(model, modelPath, learning);
      if (context.json) {
        emitJson(report, true);
        return;
      }
      out(`Preference model: ${modelPath}`);
      printModelSummary(report, true);
      if (learning.stale) {
        out(
          `Online refresh: ${learning.pending_feedback} new feedback events, ` +
            `${learning.changed_examples} changed examples ` +
            `(automatic refresh at ${learning.minimum_feedback} feedback events)`,
        );
      }
      if (learning.upgrade_due) {
        out("Model refresh: ranking/schema or label-source upgrade pending");
      }
    },
  },
  {
    path: ["model", "score"],
    summary: "Score a metadata record or ad-hoc comma-separated tags.",
    args: "[FILENAME]",
    maxPositionals: 1,
    options: [
      {
        flag: "--tags",
        key: "tags",
        type: "string",
        help: "Comma-separated tags to score without a saved image.",
      },
    ],
    async run(context, input) {
      const model = loadPreferenceModel(preferenceModelPath(context.config));
      if (model === null) fail(context, "No preference model trained yet. Run: wayper model train");

      const rawTags = typeof input.options.tags === "string" ? input.options.tags : "";
      const filename = input.positionals[0];
      let tags: unknown[];
      let metadata: JsonRecord | null = null;
      let label: string | null = null;
      if (rawTags) {
        tags = rawTags
          .split(",")
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0);
      } else if (filename) {
        const stored = loadMetadata(context.config)[filename] as JsonRecord | undefined;
        if (!stored) fail(context, `No metadata found for ${filename}`);
        tags = Array.isArray(stored.tags) ? stored.tags : [];
        metadata = stored;
        label = filename;
      } else {
        if (context.json) fail(context, "Provide FILENAME or --tags tag1,tag2", 2);
        throw new UsageError("Provide FILENAME or --tags tag1,tag2");
      }

      await prefetchModelEmbeddings(model, [[tags, metadata, null]]);
      const prediction = model.predict(tags, { metadata });
      const candidate = preferenceCandidate(model, prediction);
      const decisionScore = preferenceDecisionScore(model, prediction);
      const threshold = preferenceDecisionThreshold(model);
      if (context.json) {
        emitJson(
          {
            filename: label,
            probability: prediction.probability,
            calibrated: prediction.calibrated,
            score: prediction.score,
            feature_score: prediction.feature_score,
            semantic_score: prediction.semantic_score,
            semantic_probability: prediction.semantic_probability,
            semantic_available: prediction.semantic_available,
            neighbor_probability: prediction.neighbor_probability,
            neighbor_available: prediction.neighbor_available,
            neighbor_count: prediction.neighbor_count,
            neighbor_dislike_count: prediction.neighbor_dislike_count,
            neighbor_keep_count: prediction.neighbor_keep_count,
            neighbor_max_similarity: prediction.neighbor_max_similarity,
            neighbor_exact_max_similarity: prediction.neighbor_exact_max_similarity,
            neighbor_semantic_max_similarity: prediction.neighbor_semantic_max_similarity,
            neighbor_preference_gap: prediction.neighbor_preference_gap,
            neighbor_nearest_dislike: prediction.neighbor_nearest_dislike,
            neighbor_nearest_keep: prediction.neighbor_nearest_keep,
            decision_score: decisionScore,
            decision_threshold: threshold,
            would_auto_hold: candidate,
            contributions: prediction.contributions,
            dislike_evidence: prediction.contributions.filter(
              (item) => item.direction === "dislike",
            ),
            keep_evidence: prediction.contributions.filter((item) => item.direction === "keep"),
          },
          true,
        );
        return;
      }
      if (prediction.calibrated) {
        out(`Calibrated dislike probability: ${percent(prediction.probability)}`);
      } else {
        out(`Uncalibrated dislike score: ${signed(prediction.score, 3)}`);
      }
      if (prediction.neighbor_available && prediction.neighbor_probability !== null) {
        out(
          `Content-neighbor vote: ${percent(prediction.neighbor_probability)} ` +
            `(${prediction.neighbor_dislike_count} Dislike / ` +
            `${prediction.neighbor_keep_count} Keep neighbours)`,
        );
      }
      out(
        `Semantic decision: ${candidate ? "candidate" : "keep"} ` +
          `(${percent(decisionScore)} / ${percent(threshold)})`,
      );
      if (prediction.contributions.length > 0) {
        out("Top evidence:");
        for (const item of prediction.contributions) {
          out(`  ${item.direction}: ${item.feature} (${signed(Number(item.weight), 3)})`);
        }
      }
    },
  },
  {
    path: ["update-check"],
    summary: "Check GitHub Releases for a newer Wayper version.",
    options: [{ flag: "--force", key: "force", type: "flag", help: "Bypass cached update check." }],
    async run(context, input) {
      const result = await checkForUpdates(context.config, {
        force: input.options.force === true,
      });
      if (context.json) {
        emitJson(result, true);
        return;
      }
      if (result.error) {
        err(`Update check failed: ${result.error}`);
        throw new CliExit(1);
      }
      if (result.update_available) {
        out(
          `Wayper ${result.latest_version || "unknown"} is available ` +
            `(current: ${result.current_version})`,
        );
        out(`Get the update: ${result.release_url}`);
      } else {
        out(`Wayper is up to date (${result.current_version})`);
      }
    },
  },
  {
    path: ["setup"],
    summary: "Install .desktop entry (Linux).",
    loadsConfig: false,
    run() {
      const desktop = path.join(os.homedir(), ".local", "share", "applications", "wayper.desktop");
      fs.mkdirSync(path.dirname(desktop), { recursive: true });
      fs.writeFileSync(
        desktop,
        "[Desktop Entry]\n" +
          "Name=Wayper\n" +
          `Exec=${desktopExecCommand()}\n` +
          "Icon=preferences-desktop-wallpaper\n" +
          "Type=Application\n" +
          "Categories=Utility;\n",
        "utf8",
      );
      out(`Installed ${desktop}`);
    },
  },
];

function desktopExecCommand(): string {
  const quote = (value: string): string => (/\s/.test(value) ? `"${value}"` : value);
  const fromEnv = autostartCommandFromEnv();
  if (Array.isArray(fromEnv)) {
    return fromEnv
      .filter((argument) => argument !== "--hidden")
      .map(quote)
      .join(" ");
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, "wayper");
    try {
      if (fs.statSync(candidate).isFile()) return quote(candidate);
    } catch {
      // Keep searching PATH.
    }
  }
  if (process.env.APPIMAGE) return quote(process.env.APPIMAGE);
  const launcher = path.resolve(__dirname, "../../bin/wayper.cjs");
  if (!process.versions.electron && fs.existsSync(launcher)) {
    return `${quote(process.execPath)} ${quote(launcher)}`;
  }
  return quote(process.execPath);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function commandLabel(command: CommandSpec): string {
  return ["wayper", ...command.path].join(" ");
}

function rootHelp(): string {
  const visible = COMMANDS.filter((command) => !command.hidden);
  const width = Math.max(...visible.map((command) => command.path.join(" ").length));
  return [
    "Usage: wayper [OPTIONS] [COMMAND] [ARGS]...",
    "",
    "  Wayper wallpaper manager. Run without a command to open the app.",
    "",
    "Options:",
    "  --hidden       Start the app in the system tray.",
    "  --json         Output in JSON format.",
    "  --config PATH  Use an alternative config file.",
    "  --version      Show the version and exit.",
    "  --help         Show this message and exit.",
    "",
    "Commands:",
    ...visible.map(
      (command) => `  ${command.path.join(" ").padEnd(width)}  ${command.summary}`,
    ),
  ].join("\n");
}

function commandHelp(command: CommandSpec): string {
  const options = command.options ?? [];
  const lines = [
    `Usage: ${commandLabel(command)} [OPTIONS]${command.args ? ` ${command.args}` : ""}`,
    "",
    `  ${command.summary}`,
    "",
    "Options:",
  ];
  const labels = options.map(
    (option) => `${option.flag}${option.type === "flag" ? "" : ` ${option.type.toUpperCase()}`}`,
  );
  const width = Math.max(6, ...labels.map((label) => label.length));
  options.forEach((option, index) => {
    lines.push(`  ${labels[index].padEnd(width)}  ${option.help}`);
  });
  lines.push(`  ${"--help".padEnd(width)}  Show this message and exit.`);
  return lines.join("\n");
}

function parseOptionValue(option: OptionSpec, raw: string): OptionValue {
  if (option.type === "string") return raw;
  const value = Number(raw);
  const valid = option.type === "int" ? /^-?\d+$/.test(raw.trim()) : Number.isFinite(value);
  if (!valid || raw.trim() === "") {
    throw new UsageError(`Invalid value for '${option.flag}': '${raw}' is not a valid number.`);
  }
  if (option.min !== undefined && value < option.min) {
    throw new UsageError(`Invalid value for '${option.flag}': ${raw} is smaller than ${option.min}.`);
  }
  return value;
}

interface ParsedInvocation {
  json: boolean;
  hidden: boolean;
  help: boolean;
  version: boolean;
  configPath: string | null;
  command: CommandSpec | null;
  input: ParsedCommand;
}

function parseArguments(argv: readonly string[]): ParsedInvocation {
  const parsed: ParsedInvocation = {
    json: false,
    hidden: false,
    help: false,
    version: false,
    configPath: null,
    command: null,
    input: { positionals: [], options: {} },
  };
  const words: string[] = [];
  const pending: Array<{ flag: string; value: string | null }> = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      words.push(...argv.slice(index + 1));
      break;
    }
    if (!argument.startsWith("-") || argument === "-") {
      words.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const flag = equals === -1 ? argument : argument.slice(0, equals);
    const inline = equals === -1 ? null : argument.slice(equals + 1);
    if (flag === "--json") parsed.json = true;
    else if (flag === "--hidden") parsed.hidden = true;
    else if (flag === "--help" || flag === "-h") parsed.help = true;
    else if (flag === "--version") parsed.version = true;
    else if (flag === "--config") {
      const value = inline ?? argv[(index += 1)];
      if (value === undefined) throw new UsageError("Option '--config' requires an argument.");
      parsed.configPath = value;
    } else {
      pending.push({ flag, value: inline });
      // Remember the following word: whether it is this option's value is
      // only known once the command (and thus the option type) is resolved.
      words.push(`\u0000${pending.length - 1}`);
    }
  }

  const realWords = words.filter((word) => !word.startsWith("\u0000"));
  if (realWords.length === 0) {
    if (pending.length > 0) throw new UsageError(`No such option: ${pending[0].flag}`);
    return parsed;
  }

  const groups = new Set(COMMANDS.filter((item) => item.path.length > 1).map((item) => item.path[0]));
  const depth = groups.has(realWords[0]) ? 2 : 1;
  const commandPath = realWords.slice(0, depth);
  const command =
    COMMANDS.find(
      (item) =>
        item.path.length === commandPath.length &&
        item.path.every((part, index) => part === commandPath[index]),
    ) ?? null;
  if (command === null) {
    if (depth === 2 && commandPath.length < 2) {
      if (parsed.help) {
        parsed.command = null;
        return { ...parsed, input: { positionals: [realWords[0]], options: {} } };
      }
      const choices = COMMANDS.filter((item) => item.path[0] === realWords[0] && !item.hidden)
        .map((item) => item.path[1])
        .join(", ");
      throw new UsageError(`Missing command for '${realWords[0]}'. Choose one of: ${choices}`);
    }
    throw new UsageError(`No such command '${commandPath.join(" ")}'.`);
  }
  parsed.command = command;

  let consumedCommandWords = 0;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (!word.startsWith("\u0000")) {
      if (consumedCommandWords < depth) consumedCommandWords += 1;
      else parsed.input.positionals.push(word);
      continue;
    }
    const entry = pending[Number(word.slice(1))];
    const option = (command.options ?? []).find((item) => item.flag === entry.flag);
    if (!option) throw new UsageError(`No such option: ${entry.flag}`);
    if (option.type === "flag") {
      if (entry.value !== null) {
        throw new UsageError(`Option '${option.flag}' does not take a value.`);
      }
      parsed.input.options[option.key] = true;
      continue;
    }
    let raw = entry.value;
    if (raw === null) {
      const following = words[index + 1];
      if (following === undefined || following.startsWith("\u0000")) {
        throw new UsageError(`Option '${option.flag}' requires an argument.`);
      }
      raw = following;
      index += 1;
    }
    parsed.input.options[option.key] = parseOptionValue(option, raw);
  }

  const maxPositionals = command.maxPositionals ?? 0;
  if (parsed.input.positionals.length > maxPositionals) {
    const extra = parsed.input.positionals.slice(maxPositionals).join(" ");
    throw new UsageError(`Got unexpected extra argument (${extra})`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function run(argv: readonly string[]): Promise<number> {
  const jsonRequested = argv.includes("--json");
  let invocation: ParsedInvocation;
  try {
    invocation = parseArguments(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    if (jsonRequested) emitJson({ error: error.message });
    else err(`Usage: wayper [OPTIONS] [COMMAND] [ARGS]...\nTry 'wayper --help' for help.\n\nError: ${error.message}`);
    return 2;
  }

  if (invocation.version) {
    out(`wayper, version ${WAYPER_VERSION}`);
    return 0;
  }
  const { command } = invocation;
  if (command === null) {
    const group = invocation.input.positionals[0];
    if (invocation.help && group) {
      out(`Usage: wayper ${group} COMMAND [ARGS]...\n\nCommands:`);
      for (const item of COMMANDS) {
        if (item.path[0] === group && !item.hidden) out(`  ${item.path[1]}  ${item.summary}`);
      }
      return 0;
    }
    if (invocation.help) {
      out(rootHelp());
      return 0;
    }
    const message = invocation.hidden
      ? "The CLI cannot open the app; run `wayper --hidden` through the Wayper launcher."
      : "--json and --config require a CLI subcommand.";
    if (invocation.json) emitJson({ error: message });
    else err(`Error: ${message}`);
    return 2;
  }
  if (invocation.help) {
    out(commandHelp(command));
    return 0;
  }

  const context: CliContext = {
    config: null as unknown as WayperConfig,
    configPath: null,
    json: invocation.json,
  };
  try {
    if (invocation.hidden) {
      throw new UsageError("--hidden starts the app and cannot be used with a subcommand.");
    }
    if (invocation.configPath !== null) {
      const resolved = path.resolve(invocation.configPath);
      if (!fs.existsSync(resolved)) {
        throw new UsageError(
          `Invalid value for '--config': Path '${invocation.configPath}' does not exist.`,
        );
      }
      context.configPath = resolved;
    }

    setupLogging();
    setCliEntryPath(__filename);
    if (command.loadsConfig !== false) {
      context.config = loadConfig(context.configPath ?? undefined, {
        detectDisplays: command.needsDisplays === true,
      });
      applyGlobalProxy(context.config.proxy);
    }
    await command.run(context, invocation.input);
    return 0;
  } catch (error) {
    if (error instanceof CliExit) return error.code;
    if (error instanceof UsageError) {
      if (context.json) emitJson({ error: error.message });
      else {
        err(
          `Usage: ${commandLabel(command)} [OPTIONS]${command.args ? ` ${command.args}` : ""}\n` +
            `Try '${commandLabel(command)} --help' for help.\n\nError: ${error.message}`,
        );
      }
      return 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (context.json) emitJson({ error: message });
    else err(`Error: ${message}`);
    return 1;
  }
}

function flush(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed || !stream.writable) resolve();
    else stream.write("", () => resolve());
  });
}

void run(process.argv.slice(2))
  .catch((error: unknown) => {
    err(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  })
  .then(async (code) => {
    await Promise.all([flush(process.stdout), flush(process.stderr)]);
    process.exit(code);
  });
