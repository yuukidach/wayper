import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectMonitorsAsync,
  invalidateMonitorCache,
  LinuxBackend,
  setBackend,
  type CommandRunnerResult,
} from "../src/core/backend";
import { doNext } from "../src/core/core";
import { heavyTasks } from "../src/core/heavy-tasks";
import * as httpModule from "../src/core/http";
import * as imageProbeModule from "../src/core/image-probe";
import {
  hydrateTagDetails,
  loadMetadata,
  saveMetadataBatchAsync,
  setMetadataPersistHandler,
} from "../src/core/pool";
import {
  appendPreferenceFeedback,
  preferenceModelPath,
  schedulePreferenceModelRetrain,
  setInitialRetrainChecker,
  setRetrainSpawner,
} from "../src/core/preference/ledger";
import { clearModelReviewItems, queueModelReviewItem } from "../src/core/preference/review";
import { WayperService } from "../src/core/service";
import { WallhavenClient } from "../src/core/wallhaven";
import { createSandbox, type Sandbox } from "./helpers/sandbox";

const VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

let sandbox: Sandbox;

beforeEach(() => {
  sandbox = createSandbox();
});

afterEach(() => {
  vi.restoreAllMocks();
  sandbox.cleanup();
});

describe("staged atomic writes and non-blocking retrain scheduling", () => {
  it("stages temporary files outside locks and cleans up cleanly on abort", async () => {
    const target = path.join(sandbox.downloadDir, "staged-model.json");
    fs.writeFileSync(target, '{"version":1}\n', "utf8");

    const aborted = await imageProbeModule.stageAtomicWriteAsync(target, '{"version":2}\n');
    expect(fs.readFileSync(target, "utf8")).toBe('{"version":1}\n');
    await aborted.abort();
    expect(fs.readdirSync(sandbox.downloadDir)).toEqual(["staged-model.json"]);

    const committed = await imageProbeModule.stageAtomicWriteAsync(target, '{"version":3}\n');
    expect(fs.readFileSync(target, "utf8")).toBe('{"version":1}\n');
    await committed.commit();
    expect(fs.readFileSync(target, "utf8")).toBe('{"version":3}\n');
    expect(fs.readdirSync(sandbox.downloadDir)).toEqual(["staged-model.json"]);
  });

  it("computes follow-up due flag in autoRetrain and avoids main-thread snapshot scans", async () => {
    const res = await heavyTasks.autoRetrain({ downloadDir: sandbox.downloadDir });
    expect(res).toEqual({ outcome: "settled", due: false });

    const spawnedTokens: string[] = [];
    setRetrainSpawner((_dir, token) => {
      spawnedTokens.push(token);
      return 424242;
    });

    const readSpy = vi.spyOn(fs, "readFileSync");
    await schedulePreferenceModelRetrain(sandbox.downloadDir, {
      force: true,
      verifiedDue: true,
    });
    expect(spawnedTokens).toHaveLength(1);
    const modelReads = readSpy.mock.calls.filter(([file]) =>
      String(file).endsWith(path.basename(preferenceModelPath(sandbox.downloadDir))),
    );
    expect(modelReads).toHaveLength(0);
  });

  it("delegates untrained initial-retrain eligibility checks to the async checker", async () => {
    for (let i = 0; i < 20; i += 1) {
      appendPreferenceFeedback(sandbox.downloadDir, "dislike", `wallhaven-init${i}.png`);
    }
    const checkedDirs: string[] = [];
    setInitialRetrainChecker(async (dir) => {
      checkedDirs.push(dir);
      return false;
    });
    const spawned: string[] = [];
    setRetrainSpawner((_dir, token) => {
      spawned.push(token);
      return 12345;
    });

    await schedulePreferenceModelRetrain(sandbox.downloadDir);
    expect(checkedDirs).toEqual([sandbox.downloadDir]);
    expect(spawned).toEqual([]);
  });
});

describe("metadata caching, worker persistence, and batched review clearing", () => {
  it("caches parsed .metadata.json across reads and delegates Wallhaven batch writes", async () => {
    await saveMetadataBatchAsync(
      sandbox.downloadDir,
      {
        "wallhaven-meta01.png": {
          id: "meta01",
          tags: [{ id: 10, name: "Landscape", category: "Nature", purity: "sfw" }],
          purity: "sfw",
        },
        "wallhaven-meta02.png": {
          id: "meta02",
          tags: ["landscape"],
          purity: "sfw",
        },
      },
      { complete: false },
    );

    const mf = path.join(sandbox.downloadDir, ".metadata.json");
    const readSpy = vi.spyOn(fs, "readFileSync");
    const first = loadMetadata(sandbox.downloadDir);
    const second = loadMetadata(sandbox.downloadDir);
    expect(second).toBe(first);
    const metadataReads = readSpy.mock.calls.filter(([target]) => path.resolve(String(target)) === mf);
    expect(metadataReads).toHaveLength(0);

    // Hydrating tag details must not mutate previously returned record references in place.
    const previousSecondRecord = first["wallhaven-meta02.png"];
    expect(previousSecondRecord.tag_details_complete).toBe(false);
    const hydrated = hydrateTagDetails(sandbox.downloadDir);
    expect(hydrated.changed_records).toBe(1);
    expect(previousSecondRecord.tag_details_complete).toBe(false);
    expect(loadMetadata(sandbox.downloadDir)["wallhaven-meta02.png"].tag_details_complete).toBe(true);

    // Delegating Wallhaven download metadata saves through setMetadataPersistHandler -> heavyTasks.saveMetadataBatch.
    const delegatedBatches: Array<Record<string, Record<string, unknown>>> = [];
    setMetadataPersistHandler((downloadDir, items, options) => {
      delegatedBatches.push(items);
      return heavyTasks.saveMetadataBatch({
        downloadDir,
        items,
        complete: options?.complete,
        fetchedAt: options?.fetchedAt,
      });
    });

    vi.spyOn(httpModule, "httpGetJson").mockImplementation(async (url) => {
      if (url.includes("/search")) {
        return {
          data: [
            {
              id: "dl0001",
              path: "https://w.wallhaven.cc/full/dl/wallhaven-dl0001.png",
              purity: "sfw",
              dimension_x: 1920,
              dimension_y: 1080,
            },
          ],
          meta: { last_page: 1 },
        };
      }
      return {
        data: {
          id: "dl0001",
          path: "https://w.wallhaven.cc/full/dl/wallhaven-dl0001.png",
          purity: "sfw",
          tags: [{ id: 1, name: "forest", category: "Nature", purity: "sfw" }],
        },
      };
    });
    vi.spyOn(httpModule, "httpGetBytes").mockResolvedValue(VALID_PNG);

    const client = new WallhavenClient(sandbox.config());
    const summary = await client.downloadFor(["landscape"], ["sfw"]);
    expect(summary.downloaded).toBe(1);
    expect(delegatedBatches).toHaveLength(1);
    expect(Object.keys(delegatedBatches[0])).toEqual(["wallhaven-dl0001.png"]);
    expect(loadMetadata(sandbox.downloadDir)["wallhaven-dl0001.png"]?.tags).toEqual(["forest"]);
  });

  it("batches .model-review.json writes when clearing many auto-held items", async () => {
    const quarantineDir = path.join(sandbox.downloadDir, ".model-review", "sfw", "landscape");
    fs.mkdirSync(quarantineDir, { recursive: true });
    for (let i = 0; i < 30; i += 1) {
      const file = path.join(quarantineDir, `wallhaven-clr${String(i).padStart(3, "0")}.png`);
      fs.writeFileSync(file, VALID_PNG);
      await queueModelReviewItem(sandbox.downloadDir, file, {
        purity: "sfw",
        orientation: "landscape",
        strategy: "model",
        prediction: { score: 0.9, decision_score: 0.85, probability: 0.88 },
      });
    }

    const writeSpy = vi.spyOn(imageProbeModule, "atomicWriteAsync");
    const result = await clearModelReviewItems(sandbox.downloadDir, {
      purities: ["sfw"],
      orientation: "landscape",
    });
    expect(result).toMatchObject({
      cleared_count: 30,
      failed_count: 0,
      remaining_count: 0,
    });
    const reviewWrites = writeSpy.mock.calls.filter(([target]) =>
      String(target).endsWith(".model-review.json"),
    );
    // 30 items in chunks of 25 require at most 2 state writes instead of 30.
    expect(reviewWrites.length).toBe(2);
  });
});

describe("non-blocking async wallpaper backend execution", () => {
  it("runs monitor detection, current queries, and wallpaper transitions via async runner without sync spawns", async () => {
    const syncCalls: string[] = [];
    const asyncCalls: Array<{ cmd: string; args: string[] }> = [];
    let currentImage = "";
    let releaseQuery!: () => void;
    let blockNextQuery = false;

    const syncRunner = (cmd: string): CommandRunnerResult => {
      syncCalls.push(cmd);
      throw new Error(`Unexpected synchronous command on main thread: ${cmd}`);
    };

    const asyncRunner = async (cmd: string, args: string[]): Promise<CommandRunnerResult> => {
      asyncCalls.push({ cmd, args });
      if (cmd === "hyprctl" && args[0] === "monitors") {
        return {
          status: 0,
          stdout: JSON.stringify([
            { name: "DP-1", width: 3840, height: 2160, transform: 0, active: true },
          ]),
          stderr: "",
        };
      }
      if (cmd === "hyprctl" && args[0] === "activeworkspace") {
        return {
          status: 0,
          stdout: JSON.stringify({ id: 1, monitor: "DP-1" }),
          stderr: "",
        };
      }
      if (cmd === "awww" && args[0] === "query") {
        if (blockNextQuery) {
          blockNextQuery = false;
          await new Promise<void>((resolve) => {
            releaseQuery = resolve;
          });
        }
        return {
          status: 0,
          stdout: currentImage
            ? `: DP-1: 3840x2160, scale: 1.5, currently displaying: image: ${currentImage}\n`
            : "",
          stderr: "",
        };
      }
      if (cmd === "awww" && args[0] === "img") {
        currentImage = args[1];
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    };

    const backend = new LinuxBackend(syncRunner, asyncRunner);
    setBackend(backend);
    invalidateMonitorCache();

    const image = sandbox.addImage("sfw", "landscape", "wallhaven-async1.png");

    // Concurrent detectMonitorsAsync calls share a single hyprctl spawn.
    const [m1, m2] = await Promise.all([detectMonitorsAsync(), detectMonitorsAsync()]);
    expect(m1).toEqual([{ name: "DP-1", width: 3840, height: 2160, orientation: "landscape" }]);
    expect(m2).toEqual(m1);
    expect(asyncCalls.filter((c) => c.cmd === "hyprctl" && c.args[0] === "monitors")).toHaveLength(
      1,
    );

    const service = new WayperService();
    const config = await service.getConfigAsync();
    const rotated = await doNext(config);
    expect(rotated.ok).toBe(true);
    expect(rotated.image).toBe(image);

    // Concurrent queryCurrentAsync calls coalesce into a single awww query process.
    blockNextQuery = true;
    const q1 = backend.queryCurrentAsync();
    const q2 = backend.queryCurrentAsync();
    releaseQuery();
    const [r1, r2] = await Promise.all([q1, q2]);
    expect(r1).toEqual({ "DP-1": image });
    expect(r2).toEqual({ "DP-1": image });
    expect(asyncCalls.filter((c) => c.cmd === "awww" && c.args[0] === "query")).toHaveLength(1);

    const monitors = await service.getMonitorsAsync();
    expect(monitors).toEqual([
      {
        name: "DP-1",
        width: 3840,
        height: 2160,
        orientation: "landscape",
        current_image: "sfw/landscape/wallhaven-async1.png",
      },
    ]);
    const status = await service.getStatusAsync({ monitor: "DP-1", include_recoverable: false });
    expect(status.pool_count).toBe(1);
    expect(syncCalls).toEqual([]);
  });
});
