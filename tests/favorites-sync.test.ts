import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSuggestionCatalog } from "../src/core/catalog";
import { doBan, doDislike, doFav, purgeBlacklistedFavorites } from "../src/core/core";
import * as httpModule from "../src/core/http";
import { favoriteFilenames, listLibraryImages } from "../src/core/pool";
import { libraryFilenames } from "../src/core/preference/ledger";
import { WayperService } from "../src/core/service";
import { addToBlacklist, isBlacklisted } from "../src/core/state";
import { findTrashImage } from "../src/core/trash";
import { WallhavenClient } from "../src/core/wallhaven";
import {
  parseFavButtonState,
  removeBlacklistedRemoteFavorites,
  wallhavenWebUnfav,
} from "../src/core/wallhaven-web";
import { createSandbox, type Sandbox } from "./helpers/sandbox";

const VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function mockHtmlResponse(
  html: string,
  options?: { status?: number; url?: string; headers?: Record<string, string | string[]> },
): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(options?.headers ?? {})) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else {
      headers.set(name, value);
    }
  }
  const response = new Response(html, {
    status: options?.status ?? 200,
    headers,
  });
  if (options?.url) {
    Object.defineProperty(response, "url", { value: options.url });
  }
  return response;
}

function hasSandboxTrashCopy(currentSandbox: Sandbox, filename: string): boolean {
  if (process.platform === "linux") {
    return findTrashImage(currentSandbox.config(), filename) !== null;
  }
  return fs.existsSync(path.join(currentSandbox.root, "custom-trash", filename));
}

let sandbox: Sandbox;

beforeEach(() => {
  sandbox = createSandbox({
    extraToml: 'api_key = "test-key"\nwallhaven_username = "tester"\n',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  sandbox.cleanup();
});

describe("deleting favorites and preventing remote resurrection", () => {
  it("removes a banned favorite from favorites, clears derivatives and duplicates, and updates service views", async () => {
    const favPath = sandbox.addImage("sfw", "landscape", "wallhaven-v9p6qp.png", true);
    const duplicatePoolPath = sandbox.addImage("sketchy", "landscape", "wallhaven-v9p6qp.png", false);
    const replacementPath = sandbox.addImage("sfw", "landscape", "wallhaven-keep99.png", true);
    sandbox.backend.current["TEST-1"] = favPath;

    const favThumb = path.join(
      sandbox.downloadDir,
      ".thumbnails",
      "favorites",
      "sfw",
      "landscape",
      "wallhaven-v9p6qp.jpg",
    );
    const favPreview = path.join(
      sandbox.downloadDir,
      ".previews",
      "favorites",
      "sfw",
      "landscape",
      "wallhaven-v9p6qp.jpg",
    );
    fs.mkdirSync(path.dirname(favThumb), { recursive: true });
    fs.mkdirSync(path.dirname(favPreview), { recursive: true });
    fs.writeFileSync(favThumb, "thumb");
    fs.writeFileSync(favPreview, "preview");

    vi.spyOn(httpModule, "httpFetch").mockResolvedValue(
      mockHtmlResponse("<html><a href='/login'>Login</a></html>", { status: 401 }),
    );

    const service = new WayperService();
    try {
      expect(service.getImagesPage({ mode: "favorites", purity: "sfw" }).total).toBe(2);

      await service.banImage("favorites/sfw/landscape/wallhaven-v9p6qp.png");

      expect(fs.existsSync(favPath)).toBe(false);
      expect(fs.existsSync(duplicatePoolPath)).toBe(false);
      expect(fs.existsSync(favThumb)).toBe(false);
      expect(fs.existsSync(favPreview)).toBe(false);
      expect(isBlacklisted(sandbox.config(), "wallhaven-v9p6qp.png")).toBe(true);
      expect(sandbox.backend.current["TEST-1"]).toBe(replacementPath);

      const favoritesPage = service.getImagesPage({ mode: "favorites", purity: "sfw" });
      expect(favoritesPage.items.map((entry) => entry.name)).toEqual(["wallhaven-keep99.png"]);
      expect(service.getStatus({ monitor: "TEST-1" })).toMatchObject({
        favorites_count: 1,
        blocklist_count: 1,
      });
    } finally {
      service.stopWatching();
    }
  });

  it("never re-downloads or moves blacklisted wallpapers during syncRemoteFavorites", async () => {
    const favBanned = sandbox.addImage("sfw", "landscape", "wallhaven-banfav.png", true);
    await doDislike(sandbox.config(), { image: favBanned, waitRemote: false });
    expect(fs.existsSync(favBanned)).toBe(false);
    expect(isBlacklisted(sandbox.config(), "wallhaven-banfav.png")).toBe(true);

    const poolBlacklisted = sandbox.addImage("sfw", "landscape", "wallhaven-poolbl.png", false);
    addToBlacklist(sandbox.config(), "wallhaven-poolbl.png");

    sandbox.addImage("sfw", "landscape", "wallhaven-purity.png", true);

    const getJsonSpy = vi.spyOn(httpModule, "httpGetJson").mockImplementation(async (url) => {
      if (url.endsWith("/collections")) {
        return { data: [{ id: 77, label: "Default" }] };
      }
      if (url.includes("/collections/tester/77")) {
        return {
          data: [
            {
              id: "banfav",
              path: "https://w.wallhaven.cc/full/ba/wallhaven-banfav.png",
              purity: "sfw",
              resolution: "2560x1440",
            },
            {
              id: "poolbl",
              path: "https://w.wallhaven.cc/full/po/wallhaven-poolbl.png",
              purity: "sfw",
              resolution: "2560x1440",
            },
            {
              id: "purity",
              path: "https://w.wallhaven.cc/full/pu/wallhaven-purity.png",
              purity: "sketchy",
              resolution: "2560x1440",
            },
            {
              id: "fresh1",
              path: "https://w.wallhaven.cc/full/fr/wallhaven-fresh1.png",
              purity: "sfw",
              resolution: "2560x1440",
            },
          ],
          meta: { last_page: 1 },
        };
      }
      if (url.endsWith("/w/fresh1")) {
        return {
          data: {
            id: "fresh1",
            path: "https://w.wallhaven.cc/full/fr/wallhaven-fresh1.png",
            purity: "sfw",
            tags: [{ id: 1, name: "landscape", category: "Nature", purity: "sfw" }],
          },
        };
      }
      throw new Error(`Unexpected JSON request: ${url}`);
    });
    const getBytesSpy = vi.spyOn(httpModule, "httpGetBytes").mockResolvedValue(VALID_PNG);

    const client = new WallhavenClient(sandbox.config());
    const [synced, remoteFiles] = await client.syncRemoteFavorites();

    expect(synced).toBe(1);
    expect([...remoteFiles].sort()).toEqual([
      "wallhaven-banfav.png",
      "wallhaven-fresh1.png",
      "wallhaven-poolbl.png",
      "wallhaven-purity.png",
    ]);
    expect(fs.existsSync(favBanned)).toBe(false);
    expect(
      fs.existsSync(
        path.join(sandbox.downloadDir, "favorites", "sfw", "landscape", "wallhaven-poolbl.png"),
      ),
    ).toBe(false);
    expect(fs.existsSync(poolBlacklisted)).toBe(true);
    expect(
      fs.existsSync(
        path.join(sandbox.downloadDir, "favorites", "sketchy", "landscape", "wallhaven-purity.png"),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(sandbox.downloadDir, "favorites", "sfw", "landscape", "wallhaven-fresh1.png"),
      ),
    ).toBe(true);
    expect(getBytesSpy).toHaveBeenCalledTimes(1);
    expect(getJsonSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("/w/banfav"),
      expect.anything(),
    );
  });

  it("excludes already-resurrected blacklisted files at read time and purges them safely", async () => {
    const original = sandbox.addImage("sfw", "landscape", "wallhaven-resur1.png", true);
    await doBan(sandbox.config(), { image: original, waitRemote: false });
    expect(hasSandboxTrashCopy(sandbox, "wallhaven-resur1.png")).toBe(true);

    const resurrectedWithTrash = sandbox.addImage("sfw", "landscape", "wallhaven-resur1.png", true);
    const resurrectedWithoutTrash = sandbox.addImage(
      "sfw",
      "landscape",
      "wallhaven-resur2.png",
      true,
    );
    addToBlacklist(sandbox.config(), "wallhaven-resur2.png");

    fs.writeFileSync(
      path.join(sandbox.downloadDir, ".metadata.json"),
      JSON.stringify({
        "wallhaven-resur1.png": { tags: [" unwanted "] },
        "wallhaven-resur2.png": { tags: [" unwanted "] },
      }),
      "utf8",
    );

    const config = sandbox.config();
    expect(favoriteFilenames(config).size).toBe(0);
    expect(listLibraryImages(config, "favorites", ["sfw"])).toEqual([]);
    expect(libraryFilenames(config).favorites.size).toBe(0);
    const catalog = loadSuggestionCatalog(config);
    expect(catalog.favoriteFilenames.size).toBe(0);
    expect(catalog.bannedFilenames.has("wallhaven-resur1.png")).toBe(true);
    expect(catalog.bannedFilenames.has("wallhaven-resur2.png")).toBe(true);

    const purged = await purgeBlacklistedFavorites(config);
    expect(purged).toBe(2);
    expect(fs.existsSync(resurrectedWithTrash)).toBe(false);
    expect(fs.existsSync(resurrectedWithoutTrash)).toBe(false);
    expect(hasSandboxTrashCopy(sandbox, "wallhaven-resur1.png")).toBe(true);
    expect(hasSandboxTrashCopy(sandbox, "wallhaven-resur2.png")).toBe(true);
  });

  it("clears a stale blacklist entry when explicitly favorited again", async () => {
    const poolImage = sandbox.addImage("sfw", "landscape", "wallhaven-refav1.png", false);
    addToBlacklist(sandbox.config(), "wallhaven-refav1.png");
    expect(isBlacklisted(sandbox.config(), "wallhaven-refav1.png")).toBe(true);

    const outcome = await doFav(sandbox.config(), { image: poolImage, waitRemote: false });
    expect(outcome.ok).toBe(true);
    expect(isBlacklisted(sandbox.config(), "wallhaven-refav1.png")).toBe(false);
    expect(favoriteFilenames(sandbox.config()).has("wallhaven-refav1.png")).toBe(true);
  });
});

describe("Wallhaven web favorite parsing and session persistence", () => {
  it("parses Wallhaven favorite button variants accurately", () => {
    expect(
      parseFavButtonState(
        '<a id="fav-button" class="button fav-button rm-fav" href="#" data-href="/wallpaper/fav/12345">In Favorites</a>',
      ),
    ).toEqual({
      isFaved: true,
      actionUrl: "https://wallhaven.cc/wallpaper/fav/12345",
    });

    expect(
      parseFavButtonState(
        '<section id="fav-button" class="fav-button"><a class="button rm-fav" href="//wallhaven.cc/wallpaper/fav/67890">Remove</a></section>',
      ),
    ).toEqual({
      isFaved: true,
      actionUrl: "https://wallhaven.cc/wallpaper/fav/67890",
    });

    expect(
      parseFavButtonState(
        '<div id="fav-button" class="fav-button add-button"><a class="add-fav" href="/wallpaper/fav/12345?c=99&amp;mode=1">Default</a></div>',
      ),
    ).toEqual({
      isFaved: false,
      actionUrl: "https://wallhaven.cc/wallpaper/fav/12345?c=99&mode=1",
    });

    expect(
      parseFavButtonState(
        '<a id="fav-button" class="button fav-button add-button" href="https://wallhaven.cc/login">Add to Favorites</a>',
      ),
    ).toEqual({
      isFaved: false,
      actionUrl: null,
    });
  });

  it("keeps cached sessions older than 24h when still valid and unfavs blacklisted remote items", async () => {
    const sessionPath = path.join(sandbox.configDir, ".wh_session.json");
    const sevenDaysAgoSec = Math.floor(Date.now() / 1000) - 7 * 86_400;
    fs.writeFileSync(
      sessionPath,
      JSON.stringify({
        cookies: [
          { name: "wallhaven_session", value: "initial-token", domain: ".wallhaven.cc", path: "/" },
          { name: "remember_web", value: "persistent-token", domain: ".wallhaven.cc", path: "/" },
        ],
        timestamp: sevenDaysAgoSec,
        username: "tester",
      }),
      "utf8",
    );

    addToBlacklist(sandbox.config(), "wallhaven-oldfav.png");

    const postedUrls: string[] = [];
    vi.spyOn(httpModule, "httpFetch").mockImplementation(async (url, init) => {
      const method = init?.method ?? "GET";
      if (url === "https://wallhaven.cc/" && method === "GET") {
        expect(init?.headers?.cookie ?? init?.headers?.Cookie).toContain(
          "wallhaven_session=initial-token",
        );
        return mockHtmlResponse("<html><body><a href='/auth/logout'>Logout</a></body></html>", {
          url,
          headers: { "Set-Cookie": "wallhaven_session=rotated-token; Path=/" },
        });
      }
      if (url === "https://wallhaven.cc/w/oldfav" && method === "GET") {
        return mockHtmlResponse(
          '<html><head><meta name="csrf-token" content="csrf-123"></head>' +
            '<body><a href="/auth/logout">Logout</a>' +
            '<a id="fav-button" class="button fav-button rm-fav" href="#" data-href="/wallpaper/fav/98765">In Favorites</a>' +
            "</body></html>",
          { url },
        );
      }
      if (url === "https://wallhaven.cc/wallpaper/fav/98765" && method === "POST") {
        postedUrls.push(url);
        return mockHtmlResponse(JSON.stringify({ status: true }), {
          url,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected HTTP call: ${method} ${url}`);
    });

    const removed = await removeBlacklistedRemoteFavorites(
      sandbox.config(),
      new Set(["wallhaven-oldfav.png", "wallhaven-other.png"]),
    );
    expect(removed).toBe(1);
    expect(postedUrls).toEqual(["https://wallhaven.cc/wallpaper/fav/98765"]);

    const persisted = JSON.parse(fs.readFileSync(sessionPath, "utf8")) as {
      cookies: Array<{ name: string; value: string }>;
    };
    expect(persisted.cookies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "wallhaven_session", value: "rotated-token" }),
      ]),
    );
  });

  it("re-authenticates when a wallpaper page is served as an unauthenticated guest page", async () => {
    const sessionPath = path.join(sandbox.configDir, ".wh_session.json");
    fs.writeFileSync(
      sessionPath,
      JSON.stringify({
        cookies: [{ name: "wallhaven_session", value: "valid-token", domain: ".wallhaven.cc", path: "/" }],
        timestamp: Math.floor(Date.now() / 1000),
        username: "tester",
      }),
      "utf8",
    );

    let pageHits = 0;
    let verifyHits = 0;
    vi.spyOn(httpModule, "httpFetch").mockImplementation(async (url, init) => {
      const method = init?.method ?? "GET";
      if (url === "https://wallhaven.cc/" && method === "GET") {
        verifyHits += 1;
        return mockHtmlResponse("<html><body>Logout</body></html>", { url });
      }
      if (url === "https://wallhaven.cc/w/guest1" && method === "GET") {
        pageHits += 1;
        if (pageHits === 1) {
          return mockHtmlResponse(
            '<html><head><meta name="csrf-token" content="guest-csrf"></head>' +
              '<body><a href="https://wallhaven.cc/login">Login</a></body></html>',
            { url },
          );
        }
        return mockHtmlResponse(
          '<html><head><meta name="csrf-token" content="auth-csrf"></head>' +
            '<body>Logout<a id="fav-button" class="button rm-fav" href="/wallpaper/fav/555">Fav</a></body></html>',
          { url },
        );
      }
      if (url === "https://wallhaven.cc/wallpaper/fav/555" && method === "POST") {
        return mockHtmlResponse(JSON.stringify({ status: true }), { url });
      }
      throw new Error(`Unexpected HTTP call: ${method} ${url}`);
    });

    expect(await wallhavenWebUnfav(sandbox.config(), "wallhaven-guest1.png")).toBe(true);
    expect(verifyHits).toBe(2);
    expect(pageHits).toBe(2);
  });
});
