import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WayperConfig } from "./config";
import { atomicWrite } from "./image-probe";
import { appendUndo, type ConfigOrDir } from "./state";

export type TrashHandler = (filePath: string) => Promise<void>;

let customTrashHandler: TrashHandler | null = null;

const WINDOWS_RECYCLE_CACHE_TTL_MS = 30_000;
let windowsRecycleCache: { completedAt: number; rootsKey: string; items: Map<string, string> } | null = null;
let trashCacheGeneration = 0;

export function setTrashHandler(fn: TrashHandler | null): void {
  customTrashHandler = fn;
}

export function getTrashHandler(): TrashHandler | null {
  return customTrashHandler;
}

export function getTrashCacheGeneration(): number {
  return trashCacheGeneration;
}

export function invalidateWindowsRecycleCache(): void {
  windowsRecycleCache = null;
  trashCacheGeneration += 1;
}

function resolveDownloadDir(target: ConfigOrDir): string {
  return typeof target === "string" ? target : target.download_dir;
}

function trashMapFilePath(target: ConfigOrDir): string {
  return path.join(resolveDownloadDir(target), ".trash_paths");
}

function readTrashMap(config: ConfigOrDir): Record<string, string> {
  const mapFile = trashMapFilePath(config);
  if (!fs.existsSync(mapFile)) {
    return {};
  }
  try {
    const raw = JSON.parse(fs.readFileSync(mapFile, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string" && v) {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

let trashMapLookupCache: { token: string; mapping: Record<string, string> } | null = null;

/** Read-only lookups reuse the parsed map until the file changes on disk. */
function trashMapForLookup(config: ConfigOrDir): Record<string, string> {
  const mapFile = trashMapFilePath(config);
  let token: string;
  try {
    const stat = fs.statSync(mapFile);
    token = `${mapFile}|${stat.mtimeMs}|${stat.size}`;
  } catch {
    trashMapLookupCache = null;
    return {};
  }
  if (trashMapLookupCache?.token !== token) {
    trashMapLookupCache = { token, mapping: readTrashMap(config) };
  }
  return trashMapLookupCache.mapping;
}

function writeTrashMap(config: ConfigOrDir, mapping: Record<string, string>): void {
  atomicWrite(trashMapFilePath(config), JSON.stringify(mapping));
}

function existingAncestor(targetPath: string): string {
  let current = path.resolve(targetPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function deviceId(targetPath: string): number | null {
  try {
    return fs.statSync(existingAncestor(targetPath)).dev;
  } catch {
    return null;
  }
}

function mountPoint(targetPath: string): string {
  let current = existingAncestor(targetPath);
  let currentDev = deviceId(current);
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) break;
    const parentDev = deviceId(parent);
    if (parentDev === null || parentDev !== currentDev) {
      break;
    }
    current = parent;
    currentDev = parentDev;
  }
  return current;
}

function xdgTrashBase(): string {
  const xdgData = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
  return path.join(xdgData, "Trash");
}

export function systemTrashDirs(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "darwin") {
    return [path.join(os.homedir(), ".Trash")];
  }
  if (platform === "win32") {
    return [];
  }
  return [path.join(xdgTrashBase(), "files")];
}

function volumeTrashDirs(
  config: ConfigOrDir,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "darwin" || platform === "win32") {
    return [];
  }
  const dlDir = resolveDownloadDir(config);
  const sourceDev = deviceId(dlDir);
  const homeDev = deviceId(os.homedir());
  if (sourceDev === null || sourceDev === homeDev) {
    return [];
  }
  const mount = mountPoint(dlDir);
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  return [
    path.join(mount, ".Trash", String(uid), "files"),
    path.join(mount, `.Trash-${uid}`, "files"),
  ];
}

export function trashSearchDirs(
  config?: ConfigOrDir,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const dirs = [...systemTrashDirs(platform)];
  if (config !== undefined) {
    dirs.push(...volumeTrashDirs(config, platform));
  }
  return [...new Set(dirs)];
}

function formatTrashDeletionDate(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function encodeTrashInfoPath(absPath: string): string {
  const bytes = Buffer.from(absPath, "utf8");
  let out = "";
  for (const byte of bytes) {
    // Unreserved RFC 3986 chars + '/'
    if (
      byte === 0x2f || // /
      (byte >= 0x41 && byte <= 0x5a) || // A-Z
      (byte >= 0x61 && byte <= 0x7a) || // a-z
      (byte >= 0x30 && byte <= 0x39) || // 0-9
      byte === 0x2d || // -
      byte === 0x2e || // .
      byte === 0x5f || // _
      byte === 0x7e // ~
    ) {
      out += String.fromCharCode(byte);
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

function moveFileAcrossDevices(srcPath: string, dstPath: string): void {
  try {
    fs.renameSync(srcPath, dstPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "EXDEV") {
      throw error;
    }
    fs.copyFileSync(srcPath, dstPath);
    fs.unlinkSync(srcPath);
  }
}

function selectLinuxTrashBase(srcPath: string): string {
  const homeTrash = xdgTrashBase();
  const srcDev = deviceId(srcPath);
  const homeDev = deviceId(homeTrash);
  if (srcDev !== null && homeDev !== null && srcDev !== homeDev) {
    const mount = mountPoint(srcPath);
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const perUserTopTrash = path.join(mount, `.Trash-${uid}`);
    try {
      fs.mkdirSync(path.join(perUserTopTrash, "files"), { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(perUserTopTrash, "info"), { recursive: true, mode: 0o700 });
      return perUserTopTrash;
    } catch {
      // Fall back to XDG home trash with copy+unlink
    }
  }
  return homeTrash;
}

function trashFileLinux(srcPath: string): string {
  const absSrc = path.resolve(srcPath);
  const trashBase = selectLinuxTrashBase(absSrc);
  const filesDir = path.join(trashBase, "files");
  const infoDir = path.join(trashBase, "info");
  fs.mkdirSync(filesDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(infoDir, { recursive: true, mode: 0o700 });

  const origName = path.basename(absSrc);
  const ext = path.extname(origName);
  const stem = ext ? origName.slice(0, -ext.length) : origName;
  const infoPayload =
    `[Trash Info]\n` +
    `Path=${encodeTrashInfoPath(absSrc)}\n` +
    `DeletionDate=${formatTrashDeletionDate()}\n`;

  let attempt = 1;
  while (true) {
    const candidateName = attempt === 1 ? origName : `${stem}.${attempt}${ext}`;
    const destFile = path.join(filesDir, candidateName);
    const infoFile = path.join(infoDir, `${candidateName}.trashinfo`);
    attempt += 1;

    if (fs.existsSync(destFile)) {
      continue;
    }

    let infoFd: number;
    try {
      infoFd = fs.openSync(infoFile, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") {
        continue;
      }
      throw error;
    }

    try {
      fs.writeSync(infoFd, infoPayload, 0, "utf8");
    } finally {
      fs.closeSync(infoFd);
    }

    try {
      moveFileAcrossDevices(absSrc, destFile);
      return destFile;
    } catch (moveErr) {
      try {
        fs.unlinkSync(infoFile);
      } catch {
        // Ignore cleanup error
      }
      throw moveErr;
    }
  }
}

function trashFileMacOS(srcPath: string): string | null {
  const absSrc = path.resolve(srcPath);
  const jxa = `
function run(argv) {
  ObjC.import("Foundation");
  const fm = $.NSFileManager.defaultManager;
  const url = $.NSURL.fileURLWithPath($(String(argv[0])));
  const outUrl = Ref();
  const err = Ref();
  const ok = fm.trashItemAtURLResultingItemURLError(url, outUrl, err);
  if (!ok) {
    throw new Error("trashItemAtURL failed");
  }
  return outUrl[0] && !outUrl[0].isNil() ? String(ObjC.unwrap(outUrl[0].path)) : "";
}
`;
  const jxaRes = spawnSync("osascript", ["-l", "JavaScript", "-e", jxa, "--", absSrc], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (!jxaRes.error && jxaRes.status === 0 && !fs.existsSync(absSrc)) {
    const resulting = (jxaRes.stdout ?? "").trim();
    return resulting || null;
  }

  const finderRes = spawnSync(
    "osascript",
    [
      "-e",
      "on run argv",
      "-e",
      'tell application "Finder" to delete POSIX file (item 1 of argv)',
      "-e",
      "end run",
      "--",
      absSrc,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (!finderRes.error && finderRes.status === 0 && !fs.existsSync(absSrc)) {
    const candidate = path.join(os.homedir(), ".Trash", path.basename(absSrc));
    return fs.existsSync(candidate) ? candidate : null;
  }

  // Direct fallback to ~/.Trash
  const trashDir = path.join(os.homedir(), ".Trash");
  fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
  const origName = path.basename(absSrc);
  const ext = path.extname(origName);
  const stem = ext ? origName.slice(0, -ext.length) : origName;
  let dest = path.join(trashDir, origName);
  let n = 2;
  while (fs.existsSync(dest)) {
    dest = path.join(trashDir, `${stem} ${n}${ext}`);
    n += 1;
  }
  moveFileAcrossDevices(absSrc, dest);
  return dest;
}

function trashFileWindows(srcPath: string): void {
  const absSrc = path.resolve(srcPath);
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Microsoft.VisualBasic
[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
  $env:WAYPER_TRASH_TARGET,
  'OnlyErrorDialogs',
  'SendToRecycleBin'
)
`;
  const res = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      env: { ...process.env, WAYPER_TRASH_TARGET: absSrc },
    },
  );
  invalidateWindowsRecycleCache();
  if (res.error) {
    throw res.error;
  }
  if (res.status !== 0) {
    throw new Error((res.stderr ?? "").trim() || `PowerShell RecycleBin failed (${res.status})`);
  }
}

const MAX_RECYCLE_INFO_BYTES = 65_536;

/**
 * Parses a Windows $Recycle.Bin $Ixxxxxx metadata header (version 1: Vista/7
 * fixed 520-byte UTF-16LE path; version 2: Windows 8/10/11 length-prefixed
 * UTF-16LE path) without spawning PowerShell or COM Shell.Application.
 */
export function parseWindowsRecycleInfoBuffer(
  buf: Buffer,
): { originalPath: string; deletedAt: bigint } | null {
  if (buf.byteLength < 28) return null;
  const version = buf.readBigInt64LE(0);
  const deletedAt = buf.readBigInt64LE(16);
  let rawUtf16: Buffer;
  if (version === 1n) {
    if (buf.byteLength < 544) return null;
    rawUtf16 = buf.subarray(24, 544);
  } else if (version === 2n) {
    const charCount = buf.readUInt32LE(24);
    const byteLength = charCount * 2;
    if (charCount === 0 || charCount > 32_768 || buf.byteLength < 28 + byteLength) return null;
    rawUtf16 = buf.subarray(28, 28 + byteLength);
  } else {
    return null;
  }
  const decoded = rawUtf16.toString("utf16le");
  const nulIndex = decoded.indexOf("\u0000");
  const originalPath = (nulIndex >= 0 ? decoded.slice(0, nulIndex) : decoded).trim();
  if (!originalPath) return null;
  return { originalPath, deletedAt };
}

/**
 * Scans accessible <drive>:\$Recycle.Bin\<SID> directories directly via fs.
 * Returns null only when no readable user Recycle Bin directory was found,
 * allowing callers to fall back to Shell.Application when needed.
 */
export function scanWindowsRecycleBinDirs(
  recycleBinRoots: Iterable<string>,
): Map<string, string> | null {
  let readableSidDirs = 0;
  const bestByName = new Map<string, { fullPath: string; deletedAt: bigint }>();

  for (const binRoot of recycleBinRoots) {
    let sidEntries: fs.Dirent[];
    try {
      sidEntries = fs.readdirSync(binRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sidEntry of sidEntries) {
      if (!sidEntry.isDirectory()) continue;
      const sidDir = path.join(binRoot, sidEntry.name);
      let files: fs.Dirent[];
      try {
        files = fs.readdirSync(sidDir, { withFileTypes: true });
        readableSidDirs += 1;
      } catch {
        // Other users' SID folders throw EPERM/EACCES; skip them silently.
        continue;
      }
      const namesInSid = new Set<string>();
      for (const fileEntry of files) {
        if (fileEntry.isFile()) namesInSid.add(fileEntry.name);
      }
      for (const fileName of namesInSid) {
        if (!fileName.startsWith("$I") || fileName.length <= 2) continue;
        const dataFileName = `$R${fileName.slice(2)}`;
        if (!namesInSid.has(dataFileName)) continue;
        const infoPath = path.join(sidDir, fileName);
        let parsed: { originalPath: string; deletedAt: bigint } | null = null;
        try {
          const stat = fs.statSync(infoPath);
          if (stat.size < 28 || stat.size > MAX_RECYCLE_INFO_BYTES) continue;
          parsed = parseWindowsRecycleInfoBuffer(fs.readFileSync(infoPath));
        } catch {
          continue;
        }
        if (!parsed) continue;
        const originalName = path.win32.basename(parsed.originalPath);
        if (!originalName || originalName === "." || originalName === "..") continue;
        const existing = bestByName.get(originalName);
        if (!existing || parsed.deletedAt >= existing.deletedAt) {
          bestByName.set(originalName, {
            fullPath: path.join(sidDir, dataFileName),
            deletedAt: parsed.deletedAt,
          });
        }
      }
    }
  }

  if (readableSidDirs === 0) return null;
  const found = new Map<string, string>();
  for (const [name, entry] of bestByName) {
    found.set(name, entry.fullPath);
  }
  return found;
}

function windowsRecycleBinRoots(config?: ConfigOrDir): string[] {
  const candidates = [
    config !== undefined ? resolveDownloadDir(config) : "",
    os.homedir(),
    process.env.SystemDrive ? `${process.env.SystemDrive}\\` : "C:\\",
  ];
  const roots = new Set<string>();
  for (const raw of candidates) {
    if (!raw) continue;
    const parsed = path.win32.parse(path.win32.resolve(raw));
    if (parsed.root && /^[A-Za-z]:\\$/.test(parsed.root)) {
      roots.add(path.win32.join(parsed.root.toUpperCase(), "$Recycle.Bin"));
    }
  }
  return [...roots].sort();
}

function scanWindowsRecycleBinPowerShell(): Map<string, string> {
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject Shell.Application
$recycle = $shell.Namespace(10)
if ($null -eq $recycle) { exit 1 }
$items = @($recycle.Items() | ForEach-Object {
    [PSCustomObject]@{ Name = $_.Name; Path = $_.Path }
})
ConvertTo-Json -Compress -InputObject @($items)
`;
  const res = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    },
  );
  const found = new Map<string, string>();
  if (res.error || res.status !== 0 || !(res.stdout ?? "").trim()) {
    return found;
  }
  try {
    const parsed = JSON.parse(res.stdout) as unknown;
    if (!Array.isArray(parsed)) {
      return found;
    }
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const name = rec.Name;
      const itemPath = rec.Path;
      if (typeof name === "string" && name && typeof itemPath === "string" && itemPath) {
        if (!found.has(name)) {
          found.set(name, itemPath);
        }
      }
    }
  } catch {
    return found;
  }
  return found;
}

function getWindowsRecycleBinItems(
  config?: ConfigOrDir,
  nowMs: number = performance.now(),
): Map<string, string> {
  const roots = windowsRecycleBinRoots(config);
  const rootsKey = roots.join("|");
  if (
    windowsRecycleCache !== null &&
    windowsRecycleCache.rootsKey === rootsKey &&
    nowMs - windowsRecycleCache.completedAt < WINDOWS_RECYCLE_CACHE_TTL_MS
  ) {
    return windowsRecycleCache.items;
  }
  const items = scanWindowsRecycleBinDirs(roots) ?? scanWindowsRecycleBinPowerShell();
  windowsRecycleCache = { completedAt: performance.now(), rootsKey, items };
  return items;
}

export async function moveToSystemTrash(
  config: ConfigOrDir,
  imagePath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const dlDir = resolveDownloadDir(config);
  const resolvedSrc = path.isAbsolute(imagePath)
    ? path.resolve(imagePath)
    : path.resolve(dlDir, imagePath);

  if (!fs.existsSync(resolvedSrc)) {
    return;
  }

  const filename = path.basename(resolvedSrc);
  let recordedTrashPath: string | null = null;

  if (customTrashHandler) {
    await customTrashHandler(resolvedSrc);
    if (platform === "win32") {
      invalidateWindowsRecycleCache();
    } else {
      trashCacheGeneration += 1;
      for (const dir of trashSearchDirs(config, platform)) {
        const candidate = path.join(dir, filename);
        if (fs.existsSync(candidate)) {
          recordedTrashPath = candidate;
          break;
        }
      }
    }
  } else if (platform === "win32") {
    trashFileWindows(resolvedSrc);
  } else if (platform === "darwin") {
    recordedTrashPath = trashFileMacOS(resolvedSrc);
    trashCacheGeneration += 1;
  } else {
    recordedTrashPath = trashFileLinux(resolvedSrc);
    trashCacheGeneration += 1;
  }

  if (recordedTrashPath) {
    const mapping = readTrashMap(config);
    mapping[filename] = recordedTrashPath;
    writeTrashMap(config, mapping);
  }
}

export async function trashAndRecordUndo(
  config: Pick<WayperConfig, "download_dir"> | string,
  imagePath: string,
): Promise<void> {
  const dlDir = resolveDownloadDir(config);
  const resolvedSrc = path.isAbsolute(imagePath)
    ? path.resolve(imagePath)
    : path.resolve(dlDir, imagePath);
  const filename = path.basename(resolvedSrc);
  const originalDir = path.dirname(resolvedSrc);

  await moveToSystemTrash(config, resolvedSrc);
  appendUndo(config, filename, originalDir);
}

export function findTrashImage(
  config: ConfigOrDir,
  filename: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const cleanName = path.basename(filename);
  if (!cleanName) return null;

  if (platform === "win32") {
    return getWindowsRecycleBinItems(config).get(cleanName) ?? null;
  }

  const stored = trashMapForLookup(config)[cleanName];
  if (stored && fs.existsSync(stored)) {
    return stored;
  }

  for (const dir of trashSearchDirs(config, platform)) {
    const candidate = path.join(dir, cleanName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isAccessDeniedError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM";
}

export function checkTrashAccess(
  config: ConfigOrDir,
  filename: string,
  platform: NodeJS.Platform = process.platform,
): { readable: boolean; forbidden: boolean } {
  const trashed = findTrashImage(config, filename, platform);
  if (trashed) {
    try {
      fs.accessSync(trashed, fs.constants.R_OK);
      return { readable: true, forbidden: false };
    } catch (error) {
      return { readable: false, forbidden: isAccessDeniedError(error) || true };
    }
  }

  if (platform !== "win32") {
    for (const dir of trashSearchDirs(config, platform)) {
      try {
        if (fs.existsSync(dir)) {
          fs.accessSync(dir, fs.constants.R_OK);
        }
      } catch (error) {
        if (isAccessDeniedError(error)) {
          return { readable: false, forbidden: true };
        }
      }
    }
  }

  return { readable: false, forbidden: false };
}

export function listRecoverableTrash(
  config: ConfigOrDir,
  blacklistedNames: Iterable<string>,
  platform: NodeJS.Platform = process.platform,
): Map<string, string> {
  const orderedNames: string[] = [];
  const seen = new Set<string>();
  for (const raw of blacklistedNames) {
    const clean = path.basename(raw);
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      orderedNames.push(clean);
    }
  }
  if (orderedNames.length === 0) {
    return new Map();
  }

  if (platform === "win32") {
    const recycleItems = getWindowsRecycleBinItems(config);
    const out = new Map<string, string>();
    for (const name of orderedNames) {
      const hit = recycleItems.get(name);
      if (hit) {
        out.set(name, hit);
      }
    }
    return out;
  }

  const found = new Map<string, string>();
  const mapping = readTrashMap(config);
  const storedByParent = new Map<string, Array<{ filename: string; fullPath: string }>>();
  for (const filename of orderedNames) {
    const stored = mapping[filename];
    if (!stored) continue;
    const parent = path.dirname(stored);
    const bucket = storedByParent.get(parent) ?? [];
    bucket.push({ filename, fullPath: stored });
    storedByParent.set(parent, bucket);
  }

  for (const [parent, entries] of storedByParent) {
    try {
      const namesInParent = new Set(fs.readdirSync(parent));
      for (const entry of entries) {
        if (namesInParent.has(path.basename(entry.fullPath))) {
          found.set(entry.filename, entry.fullPath);
        }
      }
    } catch {
      for (const entry of entries) {
        if (fs.existsSync(entry.fullPath)) {
          found.set(entry.filename, entry.fullPath);
        }
      }
    }
  }

  const remaining = new Set(orderedNames.filter((name) => !found.has(name)));
  if (remaining.size > 0) {
    for (const dir of trashSearchDirs(config, platform)) {
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
        const dirNames = new Set(fs.readdirSync(dir));
        for (const name of [...remaining]) {
          if (dirNames.has(name)) {
            found.set(name, path.join(dir, name));
            remaining.delete(name);
          }
        }
        if (remaining.size === 0) break;
      } catch {
        continue;
      }
    }
  }

  // Preserve caller's input order
  const orderedResult = new Map<string, string>();
  for (const name of orderedNames) {
    const hit = found.get(name);
    if (hit) {
      orderedResult.set(name, hit);
    }
  }
  return orderedResult;
}

function cleanupTrashinfo(
  filename: string,
  trashedPath: string | null,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "darwin" || platform === "win32") {
    return;
  }
  const infoFiles = new Set<string>();
  if (trashedPath && path.basename(path.dirname(trashedPath)) === "files") {
    const trashBase = path.dirname(path.dirname(trashedPath));
    infoFiles.add(path.join(trashBase, "info", `${path.basename(trashedPath)}.trashinfo`));
  }
  infoFiles.add(path.join(xdgTrashBase(), "info", `${filename}.trashinfo`));
  for (const infoFile of infoFiles) {
    try {
      fs.rmSync(infoFile, { force: true });
    } catch {
      // Ignore
    }
  }
}

function restoreFromWindowsRecycleBin(filename: string, destDir: string): string | null {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$targetName = $env:WAYPER_RESTORE_NAME
$dest = $env:WAYPER_RESTORE_DEST
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$shell = New-Object -ComObject Shell.Application
$recycle = $shell.Namespace(10)
if ($null -eq $recycle) { exit 1 }
$items = @($recycle.Items() | Where-Object { $_.Name -eq $targetName })
if ($items.Count -eq 0) { exit 1 }
$item = $items[0]
$origFolder = $recycle.GetDetailsOf($item, 1)
$item.InvokeVerb('undelete')
$targetDestPath = Join-Path $dest $targetName
$origCandidate = if ($origFolder) { Join-Path $origFolder $targetName } else { $null }
$deadline = (Get-Date).AddSeconds(8)
do {
    if (Test-Path -LiteralPath $targetDestPath) {
        Write-Output $targetDestPath
        exit 0
    }
    if ($origCandidate -and (Test-Path -LiteralPath $origCandidate)) {
        if ($origCandidate -ne $targetDestPath) {
            Move-Item -LiteralPath $origCandidate -Destination $targetDestPath -Force
        }
        if (Test-Path -LiteralPath $targetDestPath) {
            Write-Output $targetDestPath
            exit 0
        }
    }
    $found = Get-ChildItem -Path $dest -Filter $targetName -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) {
        Write-Output $found.FullName
        exit 0
    }
    Start-Sleep -Milliseconds 200
} while ((Get-Date) -lt $deadline)
exit 2
`;
  const res = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      encoding: "utf8",
      timeout: 12_000,
      windowsHide: true,
      env: {
        ...process.env,
        WAYPER_RESTORE_NAME: filename,
        WAYPER_RESTORE_DEST: destDir,
      },
    },
  );
  if (res.error || res.status !== 0) {
    return null;
  }
  const lines = (res.stdout ?? "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  const restored = lines[lines.length - 1];
  return restored && fs.existsSync(restored) ? restored : null;
}

export function restoreFromTrash(
  config: ConfigOrDir,
  filename: string,
  destDir: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const cleanName = path.basename(filename);
  if (!cleanName) return null;

  if (platform === "win32") {
    const restored = restoreFromWindowsRecycleBin(cleanName, destDir);
    if (!restored) return null;
    invalidateWindowsRecycleCache();
    const mapping = readTrashMap(config);
    if (cleanName in mapping) {
      delete mapping[cleanName];
      writeTrashMap(config, mapping);
    }
    return restored;
  }

  const trashed = findTrashImage(config, cleanName, platform);
  if (!trashed) {
    return null;
  }

  fs.mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, cleanName);
  moveFileAcrossDevices(trashed, destPath);
  cleanupTrashinfo(cleanName, trashed, platform);
  trashCacheGeneration += 1;

  const mapping = readTrashMap(config);
  if (cleanName in mapping) {
    delete mapping[cleanName];
    writeTrashMap(config, mapping);
  }
  return destPath;
}
