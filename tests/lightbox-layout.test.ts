import { describe, expect, it } from "vitest";
import { fitImage, imageOriginTransform, previewDimension } from "../src/renderer/lib/lightbox-layout";

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
});
