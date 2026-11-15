import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Orientation, Purity } from "../shared/types";

export const ALL_PURITIES: Purity[] = ["sfw", "sketchy", "nsfw"];
export const ALL_ORIENTATIONS: Orientation[] = ["landscape", "portrait"];
export const IMAGE_EXTENSIONS: Set<string> = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export function isPurity(value: unknown): value is Purity {
  return value === "sfw" || value === "sketchy" || value === "nsfw";
}

export function isOrientation(value: unknown): value is Orientation {
  return value === "landscape" || value === "portrait";
}

export function expandPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  const withEnv = trimmed
    .replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced: string | undefined, plain: string | undefined) => {
      const key = braced ?? plain ?? "";
      const envVal = process.env[key];
      return envVal !== undefined ? envVal : match;
    })
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, key: string) => {
      const envVal = process.env[key];
      return envVal !== undefined ? envVal : match;
    });

  const home = os.homedir();
  if (withEnv === "~") {
    return path.normalize(home);
  }
  if (withEnv.startsWith("~/") || withEnv.startsWith("~\\")) {
    return path.normalize(path.join(home, withEnv.slice(2)));
  }
  return path.normalize(withEnv);
}

export function compactHome(p: string): string {
  if (!p) return p;
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return p;
  }
  const home = path.resolve(os.homedir());
  const resolved = path.resolve(p);
  if (resolved === home) {
    return "~";
  }
  const rel = path.relative(home, resolved);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return path.join("~", rel);
  }
  return p;
}

export function getConfigDir(): string {
  const override = process.env.WAYPER_CONFIG_DIR?.trim();
  if (override) {
    return path.resolve(expandPath(override));
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim() || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "wayper");
  }
  return path.join(os.homedir(), ".config", "wayper");
}

export function getConfigFile(): string {
  return path.join(getConfigDir(), "config.toml");
}

export function getControlSocketPath(configDir?: string): string {
  const dir = configDir ? path.resolve(expandPath(configDir)) : getConfigDir();
  if (process.platform === "win32") {
    const hash = crypto.createHash("sha256").update(dir.toLowerCase()).digest("hex").slice(0, 12);
    return `\\\\.\\pipe\\wayper-control-${hash}`;
  }
  return path.join(dir, "control.sock");
}

export function isImageFile(p: string): boolean {
  const ext = path.extname(p).toLowerCase();
  return Boolean(ext) && IMAGE_EXTENSIONS.has(ext);
}

export function poolDir(downloadDir: string, purity: string, orient: string): string {
  return path.join(downloadDir, purity, orient);
}

export function favoritesDir(downloadDir: string, purity: string, orient: string): string {
  return path.join(downloadDir, "favorites", purity, orient);
}

export function quarantineDir(downloadDir: string, purity: string, orient: string): string {
  return path.join(downloadDir, ".model-review", purity, orient);
}

function relativeSegments(downloadDir: string, imgPath: string): string[] | null {
  const root = path.resolve(downloadDir);
  const target = path.isAbsolute(imgPath) ? path.resolve(imgPath) : path.resolve(root, imgPath);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return rel.split(/[\\/]+/).filter(Boolean);
}

export function purityFromPath(downloadDir: string, imgPath: string): Purity {
  const parts = relativeSegments(downloadDir, imgPath);
  if (!parts || parts.length === 0) {
    return "sfw";
  }
  if (parts[0] === "favorites" || parts[0] === ".model-review") {
    return parts.length > 1 && isPurity(parts[1]) ? parts[1] : "sfw";
  }
  return isPurity(parts[0]) ? parts[0] : "sfw";
}

export function orientationFromPath(downloadDir: string, imgPath: string): Orientation {
  const parts = relativeSegments(downloadDir, imgPath);
  if (parts) {
    for (const part of parts) {
      if (isOrientation(part)) {
        return part;
      }
    }
  }
  return "landscape";
}
