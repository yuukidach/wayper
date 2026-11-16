import { spawn, spawnSync } from "node:child_process";
import type { MonitorConfig, Orientation } from "../../shared/types";
import type { TransitionConfig } from "../config";
import type { WallpaperBackend } from "./base";

const ROTATED_TRANSFORMS = new Set([
  "1",
  "3",
  "5",
  "7",
  "90",
  "270",
  "flipped-90",
  "flipped-270",
]);

const LOCKERS = ["hyprlock", "swaylock", "gtklock", "waylock", "i3lock"];
const VALID_RESIZE_MODES = new Set(["crop", "fit", "stretch", "no"]);
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseLinuxMonitors(
  data: unknown,
  options: { sway?: boolean } = {},
): MonitorConfig[] {
  if (!Array.isArray(data)) {
    return [];
  }
  const monitors: MonitorConfig[] = [];
  for (const item of data) {
    if (!isRecord(item) || item.active === false) {
      continue;
    }
    const mode = options.sway ? item.current_mode : item;
    const physicalDimensions = isRecord(mode);
    const dimensions = physicalDimensions ? mode : item.rect;
    const name = item.name;
    if (!isRecord(dimensions) || typeof name !== "string" || !name) {
      continue;
    }
    const rawWidth = Number(dimensions.width);
    const rawHeight = Number(dimensions.height);
    if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight)) {
      continue;
    }
    let width = Math.trunc(rawWidth);
    let height = Math.trunc(rawHeight);
    const transform = String(item.transform ?? "normal").toLowerCase();
    if (physicalDimensions && ROTATED_TRANSFORMS.has(transform)) {
      [width, height] = [height, width];
    }
    if (width > 0 && height > 0) {
      const orientation: Orientation = height > width ? "portrait" : "landscape";
      monitors.push({
        name,
        width,
        height,
        orientation,
      });
    }
  }
  return monitors;
}

export function parseFocusedOutput(data: unknown): string | null {
  if (isRecord(data)) {
    const monitor = data.monitor;
    return typeof monitor === "string" && monitor ? monitor : null;
  }
  if (Array.isArray(data)) {
    for (const workspace of data) {
      if (isRecord(workspace) && workspace.focused === true && typeof workspace.output === "string" && workspace.output) {
        return workspace.output;
      }
    }
  }
  return null;
}

export function parseAwwwQuery(output: string): Record<string, string | null> {
  const current: Record<string, string | null> = {};
  for (const line of output.trim().split(/\r?\n/)) {
    const match = line.match(/^(?::\s*)?(\S+?):\s.*image:\s*(.*)$/);
    if (match) {
      const monitor = match[1].replace(/:+$/, "");
      const imgPath = match[2].trim();
      current[monitor] = imgPath || null;
    }
  }
  return current;
}

export interface CommandRunnerResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type CommandRunner = (
  cmd: string,
  args: string[],
  options?: { timeoutMs?: number },
) => CommandRunnerResult;

function defaultCommandRunner(
  cmd: string,
  args: string[],
  options?: { timeoutMs?: number },
): CommandRunnerResult {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: options?.timeoutMs ?? 5_000,
    windowsHide: true,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error,
  };
}

export class LinuxBackend implements WallpaperBackend {
  private readonly runCommand: CommandRunner;

  constructor(runCommand: CommandRunner = defaultCommandRunner) {
    this.runCommand = runCommand;
  }

  private sessionOrder(): readonly ["sway", "hyprland"] | readonly ["hyprland", "sway"] {
    return process.env.SWAYSOCK ? (["sway", "hyprland"] as const) : (["hyprland", "sway"] as const);
  }

  private jsonCommand(cmd: string, args: string[]): unknown {
    const res = this.runCommand(cmd, args, { timeoutMs: 5_000 });
    if (res.error || res.status !== 0 || !res.stdout.trim()) {
      return null;
    }
    try {
      return JSON.parse(res.stdout);
    } catch {
      return null;
    }
  }

  detectMonitors(): MonitorConfig[] {
    for (const session of this.sessionOrder()) {
      if (session === "hyprland") {
        const parsed = parseLinuxMonitors(this.jsonCommand("hyprctl", ["monitors", "-j"]));
        if (parsed.length > 0) return parsed;
      } else {
        const parsed = parseLinuxMonitors(
          this.jsonCommand("swaymsg", ["-t", "get_outputs", "-r"]),
          { sway: true },
        );
        if (parsed.length > 0) return parsed;
      }
    }
    return [];
  }

  getFocusedMonitor(): string | null {
    for (const session of this.sessionOrder()) {
      if (session === "hyprland") {
        const focused = parseFocusedOutput(this.jsonCommand("hyprctl", ["activeworkspace", "-j"]));
        if (focused) return focused;
      } else {
        const focused = parseFocusedOutput(
          this.jsonCommand("swaymsg", ["-t", "get_workspaces", "-r"]),
        );
        if (focused) return focused;
      }
    }
    return null;
  }

  private isDaemonRunning(): boolean {
    const res = this.runCommand("awww", ["query"], { timeoutMs: 3_000 });
    return !res.error && res.status === 0;
  }

  ensureReady(): void {
    if (this.isDaemonRunning()) {
      return;
    }
    try {
      const child = spawn("awww-daemon", [], {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => {
        // Ignore missing daemon binary
      });
      child.unref();
    } catch {
      return;
    }
    for (let i = 0; i < 10; i += 1) {
      sleepSync(500);
      if (this.isDaemonRunning()) {
        return;
      }
    }
  }

  setWallpaper(monitor: string, imagePath: string, transition: TransitionConfig): void {
    const rawResize = String(transition.resize ?? "crop").trim().toLowerCase();
    const resize = VALID_RESIZE_MODES.has(rawResize) ? rawResize : "crop";
    this.runCommand(
      "awww",
      [
        "img",
        imagePath,
        "--outputs",
        monitor,
        "--resize",
        resize,
        "--filter",
        "Lanczos3",
        "--transition-type",
        transition.type,
        "--transition-duration",
        String(transition.duration),
        "--transition-fps",
        String(transition.fps),
      ],
      { timeoutMs: 10_000 },
    );
  }

  queryCurrent(): Record<string, string | null> {
    const res = this.runCommand("awww", ["query"], { timeoutMs: 5_000 });
    if (res.error || !res.stdout) {
      return {};
    }
    return parseAwwwQuery(res.stdout);
  }

  isLocked(): boolean {
    for (const locker of LOCKERS) {
      const res = this.runCommand("pgrep", ["-x", locker], { timeoutMs: 2_000 });
      if (!res.error && res.status === 0) {
        return true;
      }
    }
    return false;
  }

  notify(title: string, message: string, timeoutMs = 2000): void {
    this.runCommand(
      "notify-send",
      [
        "--app-name=wayper",
        "--icon=wayper",
        "--hint=string:desktop-entry:wayper",
        "--transient",
        "--hint=string:synchronous:wayper",
        "--expire-time",
        String(timeoutMs),
        title,
        message,
      ],
      { timeoutMs: 5_000 },
    );
  }
}
