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
  beforeWrite: null as ((target: string, dimension: number) => Promise<void>) | null,
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
      toFile: async (target: string) => {
        if (media.beforeWrite) {
          await media.beforeWrite(target, dimension);
        }
        await fs.writeFile(target, `preview:${dimension}`);
      },
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
  media.beforeWrite = null;
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

  it("runs queued previews in FIFO order ahead of queued thumbnails", async () => {
    const names = ["a.png", "b.png", "c.png", "d.png", "e.png"];
    for (const name of names) {
      const full = path.join(library, "sfw/landscape", name);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, `img:${name}`);
    }

    const startedOrder: string[] = [];
    const gates: Array<() => void> = [];
    media.beforeWrite = async (target, dimension) => {
      const base = path.basename(target).split(".")[0];
      startedOrder.push(`${base}:${dimension}`);
      if (gates.length < 2) {
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
      }
    };

    const pA = imageBody("wayper://media/thumb?path=sfw%2Flandscape%2Fa.png");
    const pB = imageBody("wayper://media/thumb?path=sfw%2Flandscape%2Fb.png");
    while (gates.length < 2) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }

    // Slot capacity (2) is full: queue one normal thumb, then two high-priority previews.
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 25));
    const pThumbC = imageBody("wayper://media/thumb?path=sfw%2Flandscape%2Fc.png");
    await settle();
    const pPrevD = imageBody("wayper://media/preview?path=sfw%2Flandscape%2Fd.png&size=1920");
    await settle();
    const pPrevE = imageBody("wayper://media/preview?path=sfw%2Flandscape%2Fe.png&size=1920");
    await settle();

    // Free one slot so queued jobs drain strictly one at a time without fs.mkdir races.
    gates[0]();
    await Promise.all([pA, pThumbC, pPrevD, pPrevE]);
    gates[1]();
    await pB;

    expect(startedOrder.slice(2)).toEqual(["d:1920", "e:1920", "c:420"]);
  });
});
