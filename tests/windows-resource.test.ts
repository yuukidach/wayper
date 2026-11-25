import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectMonitors,
  invalidateMonitorCache,
  isLocked,
  setBackend,
  setLockStateProvider,
  setMonitorCacheTtl,
  WindowsBackend,
} from "../src/core/backend";
import { NO_TRANSITION } from "../src/core/config";
import { setDefaultHeavyTaskRunner } from "../src/core/heavy-tasks";
import * as httpModule from "../src/core/http";
import * as poolModule from "../src/core/pool";
import {
  DECISION_CALIBRATION_VERSION,
  DEFAULT_FEATURE_NORMALIZATION,
  DEFAULT_SEMANTIC_MODEL,
  MODEL_SCHEMA_VERSION,
} from "../src/core/preference/constants";
import { savePreferenceModelUnlocked, preferenceModelPath } from "../src/core/preference/ledger";
import { PreferenceModel } from "../src/core/preference/model";
import { WayperService } from "../src/core/service";
import { parseWindowsRecycleInfoBuffer, scanWindowsRecycleBinDirs } from "../src/core/trash";
import { WallhavenClient } from "../src/core/wallhaven";
import type { WayperPushEvent } from "../src/shared/types";
import { createSandbox, type Sandbox } from "./helpers/sandbox";

const VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function buildRecycleInfoV1(originalPath: string, deletedAt: bigint, fileSize = 1024n): Buffer {
  const buf = Buffer.alloc(544, 0);
  buf.writeBigInt64LE(1n, 0);
  buf.writeBigInt64LE(fileSize, 8);
  buf.writeBigInt64LE(deletedAt, 16);
  const encoded = Buffer.from(`${originalPath}\u0000`, "utf16le");
  encoded.copy(buf, 24, 0, Math.min(encoded.length, 520));
  return buf;
}

function buildRecycleInfoV2(originalPath: string, deletedAt: bigint, fileSize = 2048n): Buffer {
  const withNul = `${originalPath}\u0000`;
  const pathBytes = Buffer.from(withNul, "utf16le");
  const charCount = pathBytes.byteLength / 2;
  const buf = Buffer.alloc(28 + pathBytes.byteLength, 0);
  buf.writeBigInt64LE(2n, 0);
  buf.writeBigInt64LE(fileSize, 8);
  buf.writeBigInt64LE(deletedAt, 16);
  buf.writeUInt32LE(charCount, 24);
  pathBytes.copy(buf, 28);
  return buf;
}

let sandbox: Sandbox;

beforeEach(() => {
  sandbox = createSandbox();
});

afterEach(() => {
  setLockStateProvider(null);
  setMonitorCacheTtl(null);
  setDefaultHeavyTaskRunner(null);
  vi.restoreAllMocks();
  sandbox.cleanup();
});

describe("Windows backend caching and native assembly loading", () => {
  it("loads a cached WayperNative DLL instead of recompiling C# unconditionally and caches queryCurrent", () => {
    const scripts: string[] = [];
    const backend = new WindowsBackend((script, extraEnv) => {
      scripts.push(script);
      if (extraEnv && "WAYPER_MON" in extraEnv) {
        return "";
      }
      return JSON.stringify({ DISPLAY1: "C:\\Wallpapers\\initial.jpg", DISPLAY2: null });
    });

    expect(backend.queryCurrent()).toEqual({
      DISPLAY1: "C:\\Wallpapers\\initial.jpg",
      DISPLAY2: null,
    });
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("Add-Type -LiteralPath $dllPath");
    expect(scripts[0]).toContain("WayperNative-");

    // Subsequent queries hit the warm in-memory cache with zero PowerShell spawns.
    expect(backend.queryCurrent()).toEqual({
      DISPLAY1: "C:\\Wallpapers\\initial.jpg",
      DISPLAY2: null,
    });
    expect(scripts).toHaveLength(1);

    // Setting a wallpaper updates the cached mapping directly without re-querying COM.
    const nextImg = path.join(sandbox.downloadDir, "sfw", "landscape", "next.jpg");
    backend.setWallpaper("DISPLAY1", nextImg, NO_TRANSITION);
    expect(scripts).toHaveLength(2);
    expect(backend.queryCurrent()).toEqual({
      DISPLAY1: path.resolve(nextImg),
      DISPLAY2: null,
    });
    expect(scripts).toHaveLength(2);

    // Display invalidation clears both monitor and current-wallpaper caches.
    setBackend(backend);
    invalidateMonitorCache();
    backend.queryCurrent();
    expect(scripts).toHaveLength(3);
  });

  it("uses event-driven lock state and extended monitor cache TTL without polling backend", () => {
    const isLockedSpy = vi.spyOn(sandbox.backend, "isLocked");
    const detectSpy = vi.spyOn(sandbox.backend, "detectMonitors");

    let locked = true;
    setLockStateProvider(() => locked);
    expect(isLocked()).toBe(true);
    locked = false;
    expect(isLocked()).toBe(false);
    expect(isLockedSpy).not.toHaveBeenCalled();

    setMonitorCacheTtl(300_000);
    detectMonitors(1_000);
    detectMonitors(60_000);
    expect(detectSpy).toHaveBeenCalledTimes(1);

    invalidateMonitorCache();
    detectMonitors(61_000);
    expect(detectSpy).toHaveBeenCalledTimes(2);
  });
});

describe("Windows $Recycle.Bin native $I metadata parser", () => {
  it("parses v1 and v2 $I headers and picks the newest recycled file without PowerShell", () => {
    const v1 = parseWindowsRecycleInfoBuffer(
      buildRecycleInfoV1(
        "C:\\Users\\Alice\\Pictures\\wallpaper\\sfw\\landscape\\wallhaven-v1old.jpg",
        133000000000000000n,
      ),
    );
    expect(v1).toEqual({
      originalPath: "C:\\Users\\Alice\\Pictures\\wallpaper\\sfw\\landscape\\wallhaven-v1old.jpg",
      deletedAt: 133000000000000000n,
    });

    const v2 = parseWindowsRecycleInfoBuffer(
      buildRecycleInfoV2(
        "D:\\Library\\favorites\\sfw\\portrait\\wallhaven-v2new.png",
        134000000000000000n,
      ),
    );
    expect(v2).toEqual({
      originalPath: "D:\\Library\\favorites\\sfw\\portrait\\wallhaven-v2new.png",
      deletedAt: 134000000000000000n,
    });

    expect(parseWindowsRecycleInfoBuffer(Buffer.alloc(12))).toBeNull();

    const fakeBinRoot = path.join(sandbox.root, "$Recycle.Bin");
    const sidDir = path.join(fakeBinRoot, "S-1-5-21-1000-2000-3000-1001");
    fs.mkdirSync(sidDir, { recursive: true });

    // Two deleted copies of the same filename: the newer deletion timestamp wins.
    fs.writeFileSync(
      path.join(sidDir, "$IAAA111.png"),
      buildRecycleInfoV2("C:\\Wallpapers\\wallhaven-dup01.png", 100n),
    );
    fs.writeFileSync(path.join(sidDir, "$RAAA111.png"), VALID_PNG);

    fs.writeFileSync(
      path.join(sidDir, "$IBBB222.png"),
      buildRecycleInfoV2("C:\\Wallpapers\\wallhaven-dup01.png", 250n),
    );
    const newestDataPath = path.join(sidDir, "$RBBB222.png");
    fs.writeFileSync(newestDataPath, VALID_PNG);

    // Orphan $I without $R data file is ignored.
    fs.writeFileSync(
      path.join(sidDir, "$IORPHAN.png"),
      buildRecycleInfoV1("C:\\Wallpapers\\wallhaven-orphan.png", 500n),
    );

    const scanned = scanWindowsRecycleBinDirs([fakeBinRoot]);
    expect(scanned).not.toBeNull();
    expect(scanned?.get("wallhaven-dup01.png")).toBe(newestDataPath);
    expect(scanned?.has("wallhaven-orphan.png")).toBe(false);

    expect(scanWindowsRecycleBinDirs([path.join(sandbox.root, "missing-bin")])).toBeNull();
  });
});

describe("background resource optimizations in service and Wallhaven client", () => {
  it("caches disk usage, pauses watching while hidden, and emits immediately on control socket actions", async () => {
    const events: WayperPushEvent[] = [];
    const service = new WayperService({ emit: (event) => events.push(event) });
    try {
      sandbox.addImage("sfw", "landscape", "wallhaven-du0001.png");
      const diskSpy = vi.spyOn(poolModule, "diskUsageMb");

      service.getDiskUsage();
      service.getDiskUsage();
      expect(diskSpy).toHaveBeenCalledTimes(1);

      service.setWatchingActive(false);
      service.startWatching();
      events.length = 0;

      // External file change while window is hidden does not poll, then catches up on activation.
      const added = sandbox.addImage("sfw", "landscape", "wallhaven-du0002.png");
      const bump = new Date(Date.now() + 5_000);
      fs.utimesSync(path.dirname(added), bump, bump);
      expect(events).toEqual([]);

      service.setWatchingActive(true);
      expect(events.map((e) => e.type)).toContain("library");
      expect(events.map((e) => e.type)).toContain("wallpaper");

      events.length = 0;
      await service.handleControlRequest({
        protocol: "wayper-control-v2",
        download_dir: sandbox.downloadDir,
        action: "next",
      });
      expect(events.map((e) => e.type)).toEqual(["wallpaper"]);
    } finally {
      service.stopWatching();
    }
  });

  it("delegates download model-filter scoring to the worker runner instead of loading ONNX in main", async () => {
    const config = sandbox.config();
    config.wallhaven.filter_strategy = "model";

    const model = new PreferenceModel({
      schema_version: MODEL_SCHEMA_VERSION,
      feature_normalization: DEFAULT_FEATURE_NORMALIZATION,
      trained_at: "2026-11-25T00:00:00Z",
      bias: -0.5,
      prior_log_odds: -0.5,
      tag_weights: { unwanted: 1.5 },
      combo_weights: {},
      context_weights: {},
      combo_min_support: 3,
      max_combo_features: 200,
      semantic_model: DEFAULT_SEMANTIC_MODEL,
      semantic_bias: 0,
      semantic_weights: [0.5, -0.5],
      semantic_blend: 0.45,
      neighbor_k: 9,
      neighbor_prototypes: [
        {
          filename: "a.png",
          label: 1,
          timestamp: 1,
          features: [["unwanted", 1]],
          tags: ["unwanted"],
          context_features: [],
          semantic_tags: [["unwanted", "unwanted"]],
        },
        {
          filename: "b.png",
          label: 0,
          timestamp: 1,
          features: [["scenic", 1]],
          tags: ["scenic"],
          context_features: [],
          semantic_tags: [["scenic", "scenic"]],
        },
      ],
      training_summary: {
        decision_threshold: 0.5,
        decision_calibration: { version: DECISION_CALIBRATION_VERSION, available: true },
      },
    });
    savePreferenceModelUnlocked(model, preferenceModelPath(config));

    const delegatedCalls: unknown[] = [];
    setDefaultHeavyTaskRunner((async (name: string, args: unknown) => {
      delegatedCalls.push({ name, args });
      return {
        "wallhaven-mod001.png": {
          hit: false,
          prediction: { score: 0.1, probability: 0.1 },
          decision_score: 0.1,
        },
      };
    }) as Parameters<typeof setDefaultHeavyTaskRunner>[0]);

    vi.spyOn(httpModule, "httpGetJson").mockImplementation(async (url) => {
      if (url.includes("/search")) {
        return {
          data: [
            {
              id: "mod001",
              path: "https://w.wallhaven.cc/full/mo/wallhaven-mod001.png",
              purity: "sfw",
              dimension_x: 2560,
              dimension_y: 1440,
            },
          ],
          meta: { last_page: 1 },
        };
      }
      if (url.endsWith("/w/mod001")) {
        return {
          data: {
            id: "mod001",
            path: "https://w.wallhaven.cc/full/mo/wallhaven-mod001.png",
            purity: "sfw",
            tags: [{ id: 1, name: "scenic", category: "Nature", purity: "sfw" }],
          },
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.spyOn(httpModule, "httpGetBytes").mockResolvedValue(VALID_PNG);

    const client = new WallhavenClient(config);
    const summary = await client.downloadFor(["landscape"], ["sfw"]);
    expect(summary.downloaded).toBe(1);
    expect(delegatedCalls).toHaveLength(1);
    expect((delegatedCalls[0] as { name: string }).name).toBe("autoFilterBatch");
  });
});
