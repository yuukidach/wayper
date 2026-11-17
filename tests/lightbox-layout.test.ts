import { afterEach, describe, expect, it } from "vitest";
import {
  clearDecodedImageCache,
  decodeImage,
  getDecodedImage,
} from "../src/renderer/lib/decoded-image";
import {
  defaultLightboxBounds,
  fallbackPreviewDimension,
  fitImage,
  imageOriginTransform,
  previewDimension,
} from "../src/renderer/lib/lightbox-layout";
import {
  lightboxPreviewUrls,
  waitForFirstReadyPreview,
} from "../src/renderer/lib/lightbox-preview";

afterEach(() => {
  clearDecodedImageCache();
  Reflect.deleteProperty(globalThis, "Image");
});

describe("lightbox image geometry", () => {
  it("fits wide and portrait images without changing their aspect ratio", () => {
    const bounds = { width: 2400, height: 1200 };
    const landscape = fitImage(16 / 9, bounds);
    expect(landscape.width).toBeCloseTo(2133.333, 3);
    expect(landscape.height).toBe(1200);
    expect(fitImage(9 / 16, bounds)).toEqual({ width: 675, height: 1200 });
    expect(fitImage(4, bounds)).toEqual({ width: 2400, height: 600 });
    expect(fitImage(0, bounds)).toEqual({ width: 1200, height: 1200 });
  });

  it("maps the fitted image back to the tile center with a uniform scale", () => {
    const tile = { left: 100, top: 300, width: 320, height: 200 };
    const image = { left: 200, top: 50, width: 1600, height: 900 };
    expect(imageOriginTransform(tile, image)).toBe("translate3d(-740px, -100px, 0) scale(0.2)");
  });

  it("accounts for display density while keeping fitted previews bounded", () => {
    expect(previewDimension({ width: 1280, height: 720 }, 1)).toBe(1920);
    expect(previewDimension({ width: 1600, height: 900 }, 1.5)).toBe(2560);
    expect(previewDimension({ width: 1728, height: 1296 }, 1.5)).toBe(3840);
    expect(previewDimension({ width: 10000, height: 6000 }, 2)).toBe(3840);
  });

  it("computes stage bounds and cached-fallback preview URLs", () => {
    expect(defaultLightboxBounds(2560, 1440)).toEqual({
      left: 64,
      top: 56,
      width: 2432,
      height: 1296,
    });
    expect(fallbackPreviewDimension(3840)).toBe(2560);
    expect(fallbackPreviewDimension(2560)).toBe(1920);
    expect(fallbackPreviewDimension(1920)).toBeNull();
    expect(
      lightboxPreviewUrls({ path: "sfw/landscape/sample.jpg", name: "sample.jpg" }, "library", 3840),
    ).toEqual({
      targetUrl: "wayper://media/preview?path=sfw%2Flandscape%2Fsample.jpg&size=3840",
      fallbackUrl: "wayper://media/preview?path=sfw%2Flandscape%2Fsample.jpg&size=2560&cached=1",
    });
    expect(
      lightboxPreviewUrls({ path: "__trash/sample.jpg", name: "sample.jpg" }, "trash", 1920),
    ).toEqual({
      targetUrl: "wayper://media/trash-preview?name=sample.jpg&size=1920",
      fallbackUrl: null,
    });
  });

  it("deduplicates in-flight image decodes and reuses the decoded LRU cache", async () => {
    let constructed = 0;
    class FakeImage {
      decoding = "async";
      src = "";
      naturalWidth = 3840;
      naturalHeight = 2160;
      constructor() {
        constructed += 1;
      }
      async decode(): Promise<void> {
        if (this.src.includes("broken")) {
          throw new Error("decode failed");
        }
      }
    }
    Object.defineProperty(globalThis, "Image", {
      value: FakeImage,
      configurable: true,
      writable: true,
    });

    const targetUrl = "wayper://media/preview?path=sample.jpg&size=3840";
    const [first, second] = await Promise.all([decodeImage(targetUrl), decodeImage(targetUrl)]);
    expect(constructed).toBe(1);
    expect(first).toEqual({ source: targetUrl, width: 3840, height: 2160 });
    expect(second).toBe(first);
    expect(getDecodedImage(targetUrl)).toBe(first);
    expect(await decodeImage("wayper://media/preview?path=broken.jpg&size=3840")).toBeNull();
  });

  it("waits past null fallback misses for a real decoded preview within the budget", async () => {
    const slowSharp = new Promise<{ source: string; width: number; height: number }>((resolve) => {
      setTimeout(() => resolve({ source: "sharp", width: 3840, height: 2160 }), 20);
    });
    const instantMiss = Promise.resolve(null);
    const ready = await waitForFirstReadyPreview([instantMiss, slowSharp], 120);
    expect(ready).toEqual({ source: "sharp", width: 3840, height: 2160 });
  });
});
