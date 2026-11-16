import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, saveConfig } from "../src/core/config";
import {
  doBan,
  doDislike,
  doFav,
  doNext,
  doPrev,
  doUnban,
  doUnfav,
  statusSnapshot,
} from "../src/core/core";
import { loadPreferenceFeedback } from "../src/core/preference/ledger";
import { clearImageDerivatives } from "../src/core/pool";
import { isBlacklisted, readMode, toggleBase, togglePurity, writeMode } from "../src/core/state";
import { createSandbox, type Sandbox } from "./helpers/sandbox";

let sandbox: Sandbox;

beforeEach(() => {
  sandbox = createSandbox();
});

afterEach(() => {
  sandbox.cleanup();
});

describe("wallpaper actions", () => {
  it("clears every preview size without touching the source image", () => {
    const image = sandbox.addImage("sfw", "landscape", "wallhaven-cache1.png");
    const derivatives = [".thumbnails", ".previews", ".previews/2560", ".previews/3840"].map(
      (cache) => path.join(sandbox.downloadDir, cache, "sfw", "landscape", "wallhaven-cache1.jpg"),
    );
    for (const derivative of derivatives) {
      fs.mkdirSync(path.dirname(derivative), { recursive: true });
      fs.writeFileSync(derivative, "cached");
    }
    clearImageDerivatives(sandbox.config(), image);
    expect(derivatives.some((derivative) => fs.existsSync(derivative))).toBe(false);
    expect(fs.existsSync(image)).toBe(true);
  });

  it("rotates forward and walks back through history", async () => {
    sandbox.addImage("sfw", "landscape", "wallhaven-aaa111.png");
    sandbox.addImage("sfw", "landscape", "wallhaven-bbb222.png");
    const config = sandbox.config();
    // Random picks may repeat; force two distinct choices.
    const random = vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.99);

    const first = await doNext(config);
    expect(first.ok).toBe(true);
    expect(first.monitor).toBe("TEST-1");
    expect(sandbox.backend.current["TEST-1"]).toBe(first.image);

    const second = await doNext(config);
    random.mockRestore();
    expect(second.ok).toBe(true);
    expect(second.image).not.toBe(first.image);

    const back = await doPrev(config);
    expect(back.image).toBe(first.image);
    expect(sandbox.backend.current["TEST-1"]).toBe(first.image);

    expect((await doPrev(config)).status).toBe("at_oldest");
    // Going forward again replays history instead of picking a new image.
    expect((await doNext(config)).image).toBe(second.image);
  });

  it("reports a clear error when the pool is empty", async () => {
    const result = await doNext(sandbox.config());
    expect(result.ok).toBe(false);
    expect(result.error).toBe("No images available");
    expect(sandbox.backend.calls).toHaveLength(0);
  });

  it("only picks images matching the monitor orientation and active mode", async () => {
    sandbox.addImage("sfw", "portrait", "wallhaven-por001.png");
    sandbox.addImage("nsfw", "landscape", "wallhaven-nsf001.png");
    const config = sandbox.config();

    expect((await doNext(config, "TEST-1")).ok).toBe(false);
    const portrait = await doNext(config, "TEST-2");
    expect(path.basename(portrait.image ?? "")).toBe("wallhaven-por001.png");

    writeMode(config, ["nsfw"]);
    const landscape = await doNext(config, "TEST-1");
    expect(path.basename(landscape.image ?? "")).toBe("wallhaven-nsf001.png");
  });

  it("moves the current wallpaper in and out of favorites", async () => {
    const image = sandbox.addImage("sfw", "landscape", "wallhaven-fav001.png");
    const config = sandbox.config();
    await doNext(config);

    const favorited = await doFav(config, { openUrl: true });
    const expected = path.join(
      sandbox.downloadDir,
      "favorites",
      "sfw",
      "landscape",
      "wallhaven-fav001.png",
    );
    expect(favorited.image).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
    expect(fs.existsSync(image)).toBe(false);
    expect(sandbox.backend.current["TEST-1"]).toBe(expected);
    expect(sandbox.openedUrls).toEqual(["https://wallhaven.cc/w/fav001"]);

    expect((await doFav(config)).status).toBe("already_favorite");
    const restored = await doUnfav(config);
    expect(restored.image).toBe(image);
    expect(fs.existsSync(image)).toBe(true);
    expect((await doUnfav(config)).status).toBe("not_favorite");

    const actions = loadPreferenceFeedback(config).events.map((event) => event.action);
    expect(actions).toEqual(["favorite", "unfavorite"]);
  });

  it("bans to the trash, replaces the wallpaper and can undo", async () => {
    const banned = sandbox.addImage("sfw", "landscape", "wallhaven-ban001.png");
    const other = sandbox.addImage("sfw", "landscape", "wallhaven-keep01.png");
    const config = sandbox.config();
    sandbox.backend.current["TEST-1"] = banned;

    const result = await doBan(config);
    expect(result.ok).toBe(true);
    expect(result.image).toBe(banned);
    expect(fs.existsSync(banned)).toBe(false);
    expect(isBlacklisted(config, "wallhaven-ban001.png")).toBe(true);
    expect(result.extra.replacement_image).toBe(other);
    expect(sandbox.backend.current["TEST-1"]).toBe(other);
    // The library never grows a project-managed trash directory.
    expect(fs.existsSync(path.join(sandbox.downloadDir, ".trash"))).toBe(false);

    const undone = await doUnban(config);
    if (process.platform === "linux") {
      expect(undone.image).toBe(banned);
      expect(fs.existsSync(banned)).toBe(true);
    }
    expect(isBlacklisted(config, "wallhaven-ban001.png")).toBe(false);
    expect((await doUnban(config)).status).toBe("nothing_to_undo");
  });

  it("refuses to move or trash a current wallpaper from outside the library", async () => {
    sandbox.addImage("sfw", "landscape", "wallhaven-keep02.png");
    const config = sandbox.config();
    const foreign = path.join(sandbox.root, "wallhaven-foreign.png");
    fs.writeFileSync(foreign, "set by another tool");
    sandbox.backend.current["TEST-1"] = foreign;

    for (const action of [doFav, doUnfav, doBan, doDislike]) {
      const result = await action(config);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("Current wallpaper is not in the Wayper library");
    }
    expect(fs.readFileSync(foreign, "utf8")).toBe("set by another tool");
    expect(isBlacklisted(config, "wallhaven-foreign.png")).toBe(false);
    expect(sandbox.backend.current["TEST-1"]).toBe(foreign);
    expect(loadPreferenceFeedback(config).events).toEqual([]);
  });

  it("records dislikes as model feedback but plain bans only as bans", async () => {
    const disliked = sandbox.addImage("sfw", "landscape", "wallhaven-dis001.png");
    const banned = sandbox.addImage("sfw", "landscape", "wallhaven-ban002.png");
    const config = sandbox.config();

    expect((await doDislike(config, { image: disliked })).ok).toBe(true);
    expect((await doBan(config, { image: banned })).ok).toBe(true);

    const events = loadPreferenceFeedback(config).events;
    expect(events.map((event) => [event.action, event.filename])).toEqual([
      ["dislike", "wallhaven-dis001.png"],
      ["ban", "wallhaven-ban002.png"],
    ]);
    expect((await doBan(config, { image: banned })).error).toBe("Image is no longer available");
  });

  it("summarises the library per monitor", async () => {
    sandbox.addImage("sfw", "landscape", "wallhaven-s00001.png");
    sandbox.addImage("sfw", "landscape", "wallhaven-s00002.png", true);
    sandbox.addImage("sfw", "portrait", "wallhaven-s00003.png");
    const snapshot = statusSnapshot(sandbox.config());
    expect(snapshot.mode).toEqual(["sfw"]);
    expect(snapshot.monitors).toEqual([
      { name: "TEST-1", orientation: "landscape", image: null, pool_count: 1, favorites_count: 1 },
      { name: "TEST-2", orientation: "portrait", image: null, pool_count: 1, favorites_count: 0 },
    ]);
  });
});

describe("mode and config state", () => {
  it("toggles purity modes like the CLI contract", () => {
    const config = sandbox.config();
    expect(readMode(config)).toEqual(["sfw"]);
    expect(toggleBase(["sfw"])).toEqual(["nsfw"]);
    expect(toggleBase(["sketchy", "nsfw"])).toEqual(["sfw", "sketchy"]);
    expect(togglePurity(["sfw"], "sketchy")).toEqual(["sfw", "sketchy"]);
    expect(togglePurity(["sketchy"], "sketchy")).toEqual(["sketchy"]);
    expect(writeMode(config, [])).toEqual(["sfw"]);
    expect(writeMode(config, ["nsfw", "sfw"])).toEqual(["sfw", "nsfw"]);
    expect(readMode(config)).toEqual(["sfw", "nsfw"]);
  });

  it("round-trips config.toml without losing rules or credentials", () => {
    const config = sandbox.config();
    config.api_key = 'key"with\\quotes';
    config.proxy = "http://127.0.0.1:7890";
    config.wallhaven.exclude_tags = ["Video Games", 'say "hi"'];
    config.wallhaven.exclude_combos = [["tattoo", "brunette"], ["a", "b", "c"]];
    config.wallhaven.exclude_uploaders = ["someone"];
    config.wallhaven.filter_strategy = "rules+model";
    saveConfig(config);

    const reloaded = loadConfig(undefined, { detectDisplays: false });
    expect(reloaded.api_key).toBe(config.api_key);
    expect(reloaded.proxy).toBe(config.proxy);
    expect(reloaded.download_dir).toBe(sandbox.downloadDir);
    expect(reloaded.wallhaven).toEqual(config.wallhaven);
  });

  it("falls back to configured monitors when detection finds nothing", () => {
    sandbox.backend.monitors = [];
    fs.appendFileSync(
      path.join(sandbox.configDir, "config.toml"),
      '\n[[monitors]]\nname = "MANUAL-1"\nwidth = 1080\nheight = 1920\n',
    );
    const config = loadConfig();
    expect(config.monitors).toEqual([
      { name: "MANUAL-1", width: 1080, height: 1920, orientation: "portrait" },
    ]);
  });
});
