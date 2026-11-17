import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WayperConfig } from "../src/core/config";
import { installWayperMediaProtocol } from "../src/main/protocol";

const media = vi.hoisted(() => ({
  handler: null as ((request: Request) => Promise<Response>) | null,
  trashed: "",
  resize: vi.fn(),
}));

vi.mock("electron", () => ({
  nativeImage: { createFromPath: vi.fn() },
  net: {
    fetch: async (url: string) => new Response(await fs.readFile(fileURLToPath(url))),
  },
  protocol: {
    handle: (_scheme: string, handler: (request: Request) => Promise<Response>) => {
      media.handler = handler;
    },
  },
}));

vi.mock("../src/core/trash", () => ({
  findTrashImage: () => media.trashed,
}));

vi.mock("sharp", () => ({
  default: () => {
    let dimension = 0;
    const decoder = {
      rotate: () => decoder,
      resize: (options: { width: number }) => {
        media.resize(options);
        dimension = options.width;
        return decoder;
      },
      flatten: () => decoder,
      jpeg: () => decoder,
      toFile: (target: string) => fs.writeFile(target, `preview:${dimension}`),
    };
    return decoder;
  },
}));

let root: string;
let library: string;
const relativePath = "sfw/landscape/large.png";

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "wayper-media-"));
  library = path.join(root, "library");
  const source = path.join(library, relativePath);
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, "original");
  media.trashed = source;
  media.resize.mockClear();
  installWayperMediaProtocol(() => ({ download_dir: library }) as WayperConfig);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function imageBody(url: string): Promise<string> {
  const response = await media.handler!(new Request(url));
  expect(response.status).toBe(200);
  return response.text();
}

describe("bounded media previews", () => {
  it("keeps high DPI derivatives separate and reuses the matching cache", async () => {
    const url = `wayper://media/preview?path=${encodeURIComponent(relativePath)}`;
    expect(await imageBody(url)).toBe("preview:1920");
    expect(await imageBody(`${url}&size=3840`)).toBe("preview:3840");
    expect(await imageBody(`${url}&size=2560`)).toBe("preview:2560");
    expect(await imageBody(url)).toBe("preview:1920");
    expect(media.resize).toHaveBeenCalledTimes(3);
    expect(media.resize).toHaveBeenCalledWith({
      width: 3840, height: 3840, fit: "inside", withoutEnlargement: true,
    });
    expect(await imageBody(`wayper://media/img?path=${encodeURIComponent(relativePath)}`))
      .toBe("original");
  });

  it("bounds unrecognized sizes instead of creating unrestricted derivatives", async () => {
    for (const size of ["999999", "-1", "NaN"]) {
      expect(await imageBody(`wayper://media/preview?path=${relativePath}&size=${size}`))
        .toBe("preview:1920");
    }
    expect(media.resize).toHaveBeenCalledTimes(1);
  });

  it("also bounds previews of recoverable images", async () => {
    expect(await imageBody("wayper://media/trash-preview?name=large.png&size=2560"))
      .toBe("preview:2560");
    expect(await imageBody("wayper://media/preview?path=__trash/large.png&size=3840"))
      .toBe("preview:3840");
    const response = await media.handler!(new Request("wayper://media/trash-preview?name=../large.png"));
    expect(response.status).toBe(400);
  });

  it("serves the sharpest already-cached preview without rendering on cached-only requests", async () => {
    const encoded = encodeURIComponent(relativePath);
    const cold = await media.handler!(
      new Request(`wayper://media/preview?path=${encoded}&size=2560&cached=1`),
    );
    expect(cold.status).toBe(404);
    expect(media.resize).not.toHaveBeenCalled();

    expect(await imageBody(`wayper://media/preview?path=${encoded}&size=1920`))
      .toBe("preview:1920");
    expect(media.resize).toHaveBeenCalledTimes(1);

    expect(await imageBody(`wayper://media/preview?path=${encoded}&size=2560&cached=1`))
      .toBe("preview:1920");
    expect(media.resize).toHaveBeenCalledTimes(1);

    expect(await imageBody(`wayper://media/preview?path=${encoded}&size=2560`))
      .toBe("preview:2560");
    expect(await imageBody(`wayper://media/preview?path=${encoded}&size=3840&cached=1`))
      .toBe("preview:2560");
    expect(media.resize).toHaveBeenCalledTimes(2);
  });
});
