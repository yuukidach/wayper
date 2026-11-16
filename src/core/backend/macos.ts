import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import type { MonitorConfig, Orientation } from "../../shared/types";
import type { TransitionConfig } from "../config";
import { expandPath } from "../paths";
import type { WallpaperBackend } from "./base";

const DETECT_MONITORS_JXA = `
ObjC.import("AppKit");
ObjC.import("CoreGraphics");
const screens = $.NSScreen.screens;
const count = screens ? Number(screens.count) : 0;
const out = [];
for (let i = 0; i < count; i++) {
  const screen = screens.objectAtIndex(i);
  const desc = screen.deviceDescription;
  const rawId = ObjC.unwrap(desc.objectForKey($("NSScreenNumber")));
  const displayId = Number(rawId);
  let width = 0;
  let height = 0;
  try {
    if (Number.isFinite(displayId) && displayId > 0) {
      const mode = $.CGDisplayCopyDisplayMode(displayId);
      if (mode) {
        width = Number($.CGDisplayModeGetPixelWidth(mode));
        height = Number($.CGDisplayModeGetPixelHeight(mode));
      }
    }
  } catch (e) {}
  if (!(width > 0 && height > 0)) {
    const frame = screen.frame;
    const backing = screen.convertRectToBacking(frame);
    width = Math.round(Number(backing.size.width));
    height = Math.round(Number(backing.size.height));
  }
  if (width > 0 && height > 0) {
    out.push({
      name: String(rawId),
      width,
      height,
      orientation: height > width ? "portrait" : "landscape",
    });
  }
}
JSON.stringify(out);
`;

const FOCUSED_MONITOR_JXA = `
ObjC.import("AppKit");
const main = $.NSScreen.mainScreen;
if (!main || main.isNil()) {
  "";
} else {
  String(ObjC.unwrap(main.deviceDescription.objectForKey($("NSScreenNumber"))));
}
`;

const SET_WALLPAPER_JXA = `
function run(argv) {
  ObjC.import("AppKit");
  ObjC.import("Foundation");
  const targetId = String(argv[0] || "");
  const imgPath = String(argv[1] || "");
  const screens = $.NSScreen.screens;
  const count = screens ? Number(screens.count) : 0;
  let target = null;
  for (let i = 0; i < count; i++) {
    const s = screens.objectAtIndex(i);
    const id = String(ObjC.unwrap(s.deviceDescription.objectForKey($("NSScreenNumber"))));
    if (id === targetId) {
      target = s;
      break;
    }
  }
  if (!target) return "not_found";
  const ws = $.NSWorkspace.sharedWorkspace;
  const opts = ws.desktopImageOptionsForScreen(target);
  const url = $.NSURL.fileURLWithPath($(imgPath));
  const err = Ref();
  const ok = ws.setDesktopImageURLForScreenOptionsError(url, target, opts, err);
  return ok ? "ok" : "failed";
}
`;

const QUERY_CURRENT_JXA = `
ObjC.import("AppKit");
const ws = $.NSWorkspace.sharedWorkspace;
const screens = $.NSScreen.screens;
const count = screens ? Number(screens.count) : 0;
const out = {};
for (let i = 0; i < count; i++) {
  const s = screens.objectAtIndex(i);
  const id = String(ObjC.unwrap(s.deviceDescription.objectForKey($("NSScreenNumber"))));
  const url = ws.desktopImageURLForScreen(s);
  out[id] = url && !url.isNil() ? String(ObjC.unwrap(url.path)) : null;
}
JSON.stringify(out);
`;

const IS_LOCKED_JXA = `
ObjC.import("CoreGraphics");
const dict = $.CGSessionCopyCurrentDictionary();
if (!dict || dict.isNil()) {
  "false";
} else {
  const unwrapped = ObjC.unwrap(dict);
  unwrapped && unwrapped.CGSSessionScreenIsLocked ? "true" : "false";
}
`;

export type JxaRunner = (script: string, argv?: string[], timeoutMs?: number) => string | null;

function defaultJxaRunner(script: string, argv: string[] = [], timeoutMs = 8_000): string | null {
  const args = ["-l", "JavaScript", "-e", script];
  if (argv.length > 0) {
    args.push("--", ...argv);
  }
  const res = spawnSync("osascript", args, {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (res.error || res.status !== 0) {
    return null;
  }
  return (res.stdout ?? "").trim();
}

export class MacOSBackend implements WallpaperBackend {
  private readonly runJxa: JxaRunner;

  constructor(runJxa: JxaRunner = defaultJxaRunner) {
    this.runJxa = runJxa;
  }

  detectMonitors(): MonitorConfig[] {
    const raw = this.runJxa(DETECT_MONITORS_JXA);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      const monitors: MonitorConfig[] = [];
      for (const item of parsed) {
        if (typeof item !== "object" || item === null) continue;
        const rec = item as Record<string, unknown>;
        const name = String(rec.name ?? "");
        const width = Math.round(Number(rec.width));
        const height = Math.round(Number(rec.height));
        if (!name || !(width > 0 && height > 0)) continue;
        const orientation: Orientation = height > width ? "portrait" : "landscape";
        monitors.push({ name, width, height, orientation });
      }
      return monitors;
    } catch {
      return [];
    }
  }

  getFocusedMonitor(): string | null {
    const out = this.runJxa(FOCUSED_MONITOR_JXA);
    return out || null;
  }

  setWallpaper(monitor: string, imagePath: string, _transition: TransitionConfig): void {
    const resolved = path.resolve(expandPath(imagePath));
    this.runJxa(SET_WALLPAPER_JXA, [monitor, resolved], 10_000);
  }

  queryCurrent(): Record<string, string | null> {
    const raw = this.runJxa(QUERY_CURRENT_JXA);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {};
      }
      const current: Record<string, string | null> = {};
      for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
        current[key] = typeof val === "string" && val ? val : null;
      }
      return current;
    } catch {
      return {};
    }
  }

  isLocked(): boolean {
    return this.runJxa(IS_LOCKED_JXA, [], 4_000) === "true";
  }

  notify(title: string, message: string, _timeoutMs = 2000): void {
    try {
      const child = spawn(
        "osascript",
        [
          "-e",
          "on run argv",
          "-e",
          "display notification (item 2 of argv) with title (item 1 of argv)",
          "-e",
          "end run",
          "--",
          title,
          message,
        ],
        {
          detached: true,
          stdio: "ignore",
        },
      );
      child.on("error", () => {
        // Ignore notification errors
      });
      child.unref();
    } catch {
      // Ignore
    }
  }
}
