import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { nativeImage, net, protocol } from "electron";
import type { WayperConfig } from "../core/config";
import { findTrashImage } from "../core/trash";
import { PREVIEW_DIMENSIONS, previewCacheDirectory } from "../shared/media";

export function registerWayperSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "wayper",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

function resolveSafeLibraryFile(downloadDir: string, relPathRaw: string): string | null {
  const rootResolved = path.resolve(downloadDir);
  const cleaned = relPathRaw.replace(/^\/+/, "");
  const candidate = path.resolve(rootResolved, cleaned);
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + path.sep)) {
    return null;
  }
  return candidate;
}

type SharpFactory = typeof import("sharp");

const MAX_DERIVATIVE_JOBS = 2;
let sharpLoader: Promise<SharpFactory | null> | null = null;
let activeDerivativeJobs = 0;
const queuedDerivativeJobs: Array<() => void> = [];
const pendingDerivatives = new Map<string, Promise<string>>();

/**
 * sharp resizes on the libuv thread pool, so thumbnails and previews never
 * stall the main process (which also presents frames on Wayland).
 */
function loadSharp(): Promise<SharpFactory | null> {
  sharpLoader ??= import("sharp")
    .then((mod) => ((mod as { default?: SharpFactory }).default ?? mod) as SharpFactory)
    .catch(() => null);
  return sharpLoader;
}

async function withDerivativeSlot<T>(job: () => Promise<T>): Promise<T> {
  if (activeDerivativeJobs >= MAX_DERIVATIVE_JOBS) {
    await new Promise<void>((resolve) => queuedDerivativeJobs.push(resolve));
  }
  activeDerivativeJobs += 1;
  try {
    return await job();
  } finally {
    activeDerivativeJobs -= 1;
    queuedDerivativeJobs.shift()?.();
  }
}

function temporaryPath(targetPath: string): string {
  return `${targetPath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
}

/** Synchronous fallback for platforms where sharp could not be loaded. */
function renderWithNativeImage(sourcePath: string, maxDimension: number, quality: number): Buffer | null {
  const img = nativeImage.createFromPath(sourcePath);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  if (width <= 0 || height <= 0) return null;
  let resized = img;
  if (width > maxDimension || height > maxDimension) {
    resized =
      width >= height
        ? img.resize({ width: maxDimension, quality: "good" })
        : img.resize({ height: maxDimension, quality: "good" });
  }
  const jpegBytes = resized.toJPEG(quality);
  return jpegBytes && jpegBytes.length > 0 ? jpegBytes : null;
}

async function renderDerivative(
  sourcePath: string,
  targetPath: string,
  maxDimension: number,
  quality: number,
): Promise<string> {
  const tmpPath = temporaryPath(targetPath);
  try {
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    const sharp = await loadSharp();
    let written = false;
    if (sharp) {
      try {
        await sharp(sourcePath, { failOn: "none" })
          .rotate()
          .resize({
            width: maxDimension,
            height: maxDimension,
            fit: "inside",
            withoutEnlargement: true,
          })
          .flatten({ background: "#000000" })
          .jpeg({ quality })
          .toFile(tmpPath);
        written = true;
      } catch {
        written = false;
      }
    }
    if (!written) {
      const jpegBytes = renderWithNativeImage(sourcePath, maxDimension, quality);
      if (!jpegBytes) return sourcePath;
      await fs.promises.writeFile(tmpPath, jpegBytes);
    }
    await fs.promises.rename(tmpPath, targetPath);
    return targetPath;
  } catch {
    await fs.promises.unlink(tmpPath).catch(() => undefined);
    return sourcePath;
  }
}

async function ensureDerivative(
  sourcePath: string,
  targetPath: string,
  maxDimension: number,
  quality = 82,
): Promise<string> {
  try {
    const [srcStat, dstStat] = await Promise.all([
      fs.promises.stat(sourcePath),
      fs.promises.stat(targetPath).catch(() => null),
    ]);
    if (dstStat && dstStat.size > 0 && dstStat.mtimeMs >= srcStat.mtimeMs) {
      return targetPath;
    }
  } catch {
    return sourcePath;
  }
  const pending = pendingDerivatives.get(targetPath);
  if (pending) return pending;
  const task = withDerivativeSlot(() =>
    renderDerivative(sourcePath, targetPath, maxDimension, quality),
  ).finally(() => {
    pendingDerivatives.delete(targetPath);
  });
  pendingDerivatives.set(targetPath, task);
  return task;
}

async function serveLocalFile(
  filePath: string,
  cacheable = true,
): Promise<Response> {
  const upstream = await net.fetch(pathToFileURL(filePath).toString());
  const headers = new Headers(upstream.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  if (cacheable) {
    headers.set("Cache-Control", "public, max-age=86400");
  } else {
    headers.set("Cache-Control", "no-store");
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function errorResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function servePreview(
  sourcePath: string,
  downloadDir: string,
  relativePath: string,
  url: URL,
): Promise<Response> {
  const requestedSize = Number(url.searchParams.get("size"));
  const size = PREVIEW_DIMENSIONS.find((dimension) => dimension === requestedSize) ?? PREVIEW_DIMENSIONS[0];
  const target = path.join(
    downloadDir,
    previewCacheDirectory(size),
    path.dirname(relativePath),
    `${path.parse(relativePath).name}.jpg`,
  );
  return serveLocalFile(await ensureDerivative(sourcePath, target, size, 86), true);
}

export function installWayperMediaProtocol(getConfig: () => WayperConfig): void {
  protocol.handle("wayper", async (request) => {
    try {
      const url = new URL(request.url);
      const route = url.pathname.replace(/^\/+/, "");
      const config = getConfig();
      const downloadDir = config.download_dir;

      if (route === "trash" || route === "trash-thumb" || route === "trash-preview") {
        const rawName = url.searchParams.get("name") || "";
        const safeName = path.basename(rawName);
        if (!safeName || safeName !== rawName || safeName === "." || safeName === "..") {
          return errorResponse(400, "Invalid trash filename");
        }
        let trashed: string | null = null;
        try {
          trashed = findTrashImage(config, safeName);
        } catch {
          return errorResponse(403, "Trash folder is not readable");
        }
        if (!trashed) {
          return errorResponse(404, "File not found in system trash");
        }
        try {
          fs.accessSync(trashed, fs.constants.R_OK);
        } catch {
          return errorResponse(403, "Trash image is not readable");
        }
        if (route === "trash") {
          return serveLocalFile(trashed, false);
        }
        if (route === "trash-preview") {
          return servePreview(trashed, downloadDir, path.join("__trash", safeName), url);
        }
        const stem = path.parse(safeName).name;
        const thumbTarget = path.join(downloadDir, ".thumbnails", "__trash", `${stem}.jpg`);
        return serveLocalFile(await ensureDerivative(trashed, thumbTarget, 420, 80), true);
      }

      const rawPath = url.searchParams.get("path") || "";
      if (rawPath.startsWith("__trash/")) {
        const fname = path.basename(rawPath.slice("__trash/".length));
        const trashed = findTrashImage(config, fname);
        if (!trashed) return errorResponse(404, "Trash image missing");
        if (route === "thumb") {
          const stem = path.parse(fname).name;
          const thumbTarget = path.join(downloadDir, ".thumbnails", "__trash", `${stem}.jpg`);
          return serveLocalFile(await ensureDerivative(trashed, thumbTarget, 420, 80), true);
        }
        if (route === "preview") {
          return servePreview(trashed, downloadDir, path.join("__trash", fname), url);
        }
        return serveLocalFile(trashed, false);
      }

      const resolved = resolveSafeLibraryFile(downloadDir, rawPath);
      if (!resolved) {
        return errorResponse(403, "Forbidden path");
      }
      const resolvedStat = await fs.promises.stat(resolved).catch(() => null);
      if (!resolvedStat?.isFile()) {
        return errorResponse(404, "Image not found");
      }

      if (route === "img") {
        return serveLocalFile(resolved, true);
      }

      const rel = path.relative(path.resolve(downloadDir), resolved);
      const relDir = path.dirname(rel);
      const stem = path.parse(rel).name;

      if (route === "thumb") {
        const thumbTarget = path.join(downloadDir, ".thumbnails", relDir, `${stem}.jpg`);
        return serveLocalFile(await ensureDerivative(resolved, thumbTarget, 420, 80), true);
      }

      if (route === "preview") {
        return servePreview(resolved, downloadDir, rel, url);
      }

      return errorResponse(404, "Unknown media route");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return errorResponse(500, msg);
    }
  });
}
