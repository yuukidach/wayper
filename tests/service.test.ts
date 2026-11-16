import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveControlEndpoint,
  startControlServer,
  trySendControlAction,
} from "../src/core/control-ipc";
import { ServiceError, WayperService } from "../src/core/service";
import { listBlacklist, readMode } from "../src/core/state";
import type { WayperPushEvent } from "../src/shared/types";
import { createSandbox, type Sandbox } from "./helpers/sandbox";

let sandbox: Sandbox;
let events: WayperPushEvent[];
let service: WayperService;

beforeEach(() => {
  sandbox = createSandbox();
  events = [];
  service = new WayperService({ emit: (event) => events.push(event) });
});

afterEach(() => {
  service.stopWatching();
  sandbox.cleanup();
});

describe("desktop service", () => {
  it("serves the library by page, newest first, with stable relative paths", () => {
    const older = sandbox.addImage("sfw", "landscape", "wallhaven-old001.png");
    fs.utimesSync(older, new Date(1_000_000), new Date(1_000_000));
    sandbox.addImage("sfw", "landscape", "wallhaven-new001.png");
    sandbox.addImage("sfw", "portrait", "wallhaven-por001.png");
    sandbox.addImage("nsfw", "landscape", "wallhaven-nsf001.png");
    sandbox.addImage("sfw", "landscape", "wallhaven-fav001.png", true);

    const page = service.getImagesPage({
      mode: "pool",
      purity: "sfw",
      orient: "landscape",
      offset: 0,
      limit: 1,
    });
    expect(page.total).toBe(2);
    expect(page.next_offset).toBe(1);
    expect(page.items).toEqual([
      {
        path: "sfw/landscape/wallhaven-new001.png",
        name: "wallhaven-new001.png",
        is_favorite: false,
        orientation: "landscape",
      },
    ]);

    const favorites = service.getImagesPage({ mode: "favorites", purity: "sfw,nsfw" });
    expect(favorites.items.map((item) => item.path)).toEqual([
      "favorites/sfw/landscape/wallhaven-fav001.png",
    ]);

    const status = service.getStatus({ monitor: "TEST-1" });
    expect(status).toMatchObject({
      monitor: "TEST-1",
      orientation: "landscape",
      pool_count: 2,
      favorites_count: 1,
      mode: ["sfw"],
      auto_rotation: false,
    });
  });

  it("applies wallpaper actions and reports paths relative to the library", async () => {
    sandbox.addImage("sfw", "landscape", "wallhaven-one001.png");
    const next = await service.controlAction("next");
    expect(next).toMatchObject({
      status: "ok",
      monitor: "TEST-1",
      current_image: "sfw/landscape/wallhaven-one001.png",
    });

    const toggled = await service.toggleFavorite("sfw/landscape/wallhaven-one001.png");
    expect(toggled).toMatchObject({
      new_path: "favorites/sfw/landscape/wallhaven-one001.png",
      is_favorite: true,
    });
    // The moved file stays on the monitor that was showing it.
    expect(sandbox.backend.current["TEST-1"]).toBe(
      path.join(sandbox.downloadDir, "favorites", "sfw", "landscape", "wallhaven-one001.png"),
    );
    await expect(service.controlAction("explode")).rejects.toBeInstanceOf(ServiceError);
  });

  it("rejects paths that escape the library", async () => {
    const outside = path.join(sandbox.root, "outside.png");
    fs.writeFileSync(outside, "x");
    await expect(service.banImage("../outside.png")).rejects.toBeInstanceOf(ServiceError);
    await expect(service.setWallpaper("TEST-1", outside)).rejects.toBeInstanceOf(ServiceError);
    expect(fs.existsSync(outside)).toBe(true);
    await expect(service.removeBlocklistEntry("../x.png")).rejects.toThrow(
      "filename must be a single image filename",
    );
  });

  it("dislikes from the library view and keeps the blocklist in sync", async () => {
    sandbox.addImage("sfw", "landscape", "wallhaven-bad001.png");
    const response = await service.dislikeImage("sfw/landscape/wallhaven-bad001.png");
    expect(response.status).toBe("ok");
    expect(listBlacklist(sandbox.config()).map((entry) => entry.filename)).toEqual([
      "wallhaven-bad001.png",
    ]);
    expect(service.getBlocklist().entries.map((entry) => entry.filename)).toEqual([
      "wallhaven-bad001.png",
    ]);

    expect(await service.removeBlocklistEntry("wallhaven-bad001.png")).toEqual({
      status: "ok",
      removed: true,
    });
    expect(service.getBlocklist().entries).toEqual([]);
  });

  it("searches by tag, uploader and free text, and follows metadata changes", async () => {
    const metadataFile = path.join(sandbox.downloadDir, ".metadata.json");
    fs.mkdirSync(sandbox.downloadDir, { recursive: true });
    fs.writeFileSync(
      metadataFile,
      JSON.stringify({
        "wallhaven-aaa001.png": {
          tags: ["Mountain Lake", "sunset"],
          category: "general",
          uploader: "AlpineFan",
        },
        "wallhaven-bbb002.png": { tags: ["mountain", "night"], uploader: "someone" },
      }),
    );

    expect(await service.searchImages({})).toEqual({ matches: [], suggestions: [] });
    expect(await service.searchImages({ tags: ["sunset"] })).toEqual({
      matches: ["wallhaven-aaa001.png"],
      suggestions: [],
    });
    expect((await service.searchImages({ uploader: "alpinefan" })).matches).toEqual([
      "wallhaven-aaa001.png",
    ]);

    const text = await service.searchImages({ query: "MOUNT" });
    expect([...text.matches].sort()).toEqual(["wallhaven-aaa001.png", "wallhaven-bbb002.png"]);
    expect([...text.suggestions].sort()).toEqual(["Mountain Lake", "mountain"]);
    expect((await service.searchImages({ query: "alpine" })).uploader_suggestions).toEqual([
      "AlpineFan",
    ]);
    expect((await service.searchImages({ query: "bbb002" })).matches).toEqual([
      "wallhaven-bbb002.png",
    ]);

    fs.writeFileSync(
      metadataFile,
      JSON.stringify({ "wallhaven-ccc003.png": { tags: ["sunset", "beach", "palm trees"] } }),
    );
    expect((await service.searchImages({ tags: ["sunset"] })).matches).toEqual([
      "wallhaven-ccc003.png",
    ]);
  });

  it("switches mode, honours safe mode and persists config patches", async () => {
    expect(await service.setMode(["nsfw", "sketchy", "bogus"])).toEqual({
      status: "ok",
      purities: ["nsfw", "sketchy"],
    });
    expect(readMode(sandbox.config())).toEqual(["sketchy", "nsfw"]);
    await expect(service.setMode(["bogus"])).rejects.toThrow("At least one valid purity required");

    await service.patchConfig({ safe_mode: true, quota_mb: 1234, language: "zh" });
    const payload = service.getConfigPayload();
    expect(payload).toMatchObject({ safe_mode: true, quota_mb: 1234, language: "zh" });
    expect(await service.setMode(["nsfw"])).toEqual({ status: "ok", purities: ["sfw"] });
    expect(events.some((event) => event.type === "config")).toBe(true);
  });
});

describe("CLI control endpoint", () => {
  it("hands hotkey actions to the running service and ignores other libraries", async () => {
    sandbox.addImage("sfw", "landscape", "wallhaven-ctl001.png");
    const endpoint = resolveControlEndpoint(sandbox.configDir);
    expect(
      await trySendControlAction(endpoint, {
        protocol: "wayper-control-v2",
        download_dir: sandbox.downloadDir,
        action: "next",
      }),
    ).toBeNull();

    const server = await startControlServer(endpoint, (request) =>
      service.handleControlRequest(request),
    );
    try {
      const handled = await trySendControlAction(endpoint, {
        protocol: "wayper-control-v2",
        download_dir: sandbox.downloadDir,
        action: "next",
      });
      expect(handled).toMatchObject({
        matched: true,
        ok: true,
        action: "next",
        monitor: "TEST-1",
        image: path.join(sandbox.downloadDir, "sfw", "landscape", "wallhaven-ctl001.png"),
      });

      // A CLI pointed at a different library must fall back to local execution.
      expect(
        await trySendControlAction(endpoint, {
          protocol: "wayper-control-v2",
          download_dir: path.join(sandbox.root, "elsewhere"),
          action: "ban",
        }),
      ).toBeNull();
      expect(listBlacklist(sandbox.config())).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
