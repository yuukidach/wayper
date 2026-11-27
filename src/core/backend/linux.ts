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

function sleepAsync(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export type AsyncCommandRunner = (
  cmd: string,
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<CommandRunnerResult>;

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

function defaultCommandRunnerAsync(
  cmd: string,
  args: string[],
  options?: { timeoutMs?: number },
): Promise<CommandRunnerResult> {
  const timeoutMs = options?.timeoutMs ?? 5_000;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (result: CommandRunnerResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      finish({
        status: null,
        stdout: "",
        stderr: "",
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      finish({ status: null, stdout, stderr, error });
    });

    child.on("close", (code) => {
      finish({
        status: timedOut ? null : code,
        stdout,
        stderr,
        ...(timedOut ? { error: new Error(`Command timed out after ${timeoutMs}ms: ${cmd}`) } : {}),
      });
    });
  });
}

function buildAwwwImgArgs(monitor: string, imagePath: string, transition: TransitionConfig): string[] {
  const rawResize = String(transition.resize ?? "crop").trim().toLowerCase();
  const resize = VALID_RESIZE_MODES.has(rawResize) ? rawResize : "crop";
  return [
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
  ];
}

function buildNotifySendArgs(title: string, message: string, timeoutMs: number): string[] {
  return [
    "--app-name=wayper",
    "--icon=wayper",
    "--hint=string:desktop-entry:wayper",
    "--transient",
    "--hint=string:synchronous:wayper",
    "--expire-time",
    String(timeoutMs),
    title,
    message,
  ];
}

export class LinuxBackend implements WallpaperBackend {
  private readonly runCommand: CommandRunner;
  private readonly runCommandAsync: AsyncCommandRunner;
  private readonly usesDefaultRunner: boolean;
  private queryInflight: Promise<Record<string, string | null>> | null = null;

  constructor(
    runCommand: CommandRunner = defaultCommandRunner,
    runCommandAsync?: AsyncCommandRunner,
  ) {
    this.runCommand = runCommand;
    this.usesDefaultRunner = runCommand === defaultCommandRunner && !runCommandAsync;
    this.runCommandAsync =
      runCommandAsync ??
      (runCommand === defaultCommandRunner
        ? defaultCommandRunnerAsync
        : async (cmd, args, opts) => this.runCommand(cmd, args, opts));
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

  private async jsonCommandAsync(cmd: string, args: string[]): Promise<unknown> {
    const res = await this.runCommandAsync(cmd, args, { timeoutMs: 5_000 });
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

  async detectMonitorsAsync(): Promise<MonitorConfig[]> {
    for (const session of this.sessionOrder()) {
      if (session === "hyprland") {
        const parsed = parseLinuxMonitors(await this.jsonCommandAsync("hyprctl", ["monitors", "-j"]));
        if (parsed.length > 0) return parsed;
      } else {
        const parsed = parseLinuxMonitors(
          await this.jsonCommandAsync("swaymsg", ["-t", "get_outputs", "-r"]),
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

  async getFocusedMonitorAsync(): Promise<string | null> {
    for (const session of this.sessionOrder()) {
      if (session === "hyprland") {
        const focused = parseFocusedOutput(
          await this.jsonCommandAsync("hyprctl", ["activeworkspace", "-j"]),
        );
        if (focused) return focused;
      } else {
        const focused = parseFocusedOutput(
          await this.jsonCommandAsync("swaymsg", ["-t", "get_workspaces", "-r"]),
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

  private async isDaemonRunningAsync(): Promise<boolean> {
    const res = await this.runCommandAsync("awww", ["query"], { timeoutMs: 3_000 });
    return !res.error && res.status === 0;
  }

  private spawnDaemonDetached(): boolean {
    try {
      const child = spawn("awww-daemon", [], {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => {
        // Ignore missing daemon binary
      });
      child.unref();
      return true;
    } catch {
      return false;
    }
  }

  ensureReady(): void {
    if (this.isDaemonRunning()) {
      return;
    }
    if (!this.spawnDaemonDetached()) {
      return;
    }
    for (let i = 0; i < 10; i += 1) {
      sleepSync(500);
      if (this.isDaemonRunning()) {
        return;
      }
    }
  }

  async ensureReadyAsync(): Promise<void> {
    if (await this.isDaemonRunningAsync()) {
      return;
    }
    if (!this.spawnDaemonDetached()) {
      return;
    }
    for (let i = 0; i < 10; i += 1) {
      await sleepAsync(500);
      if (await this.isDaemonRunningAsync()) {
        return;
      }
    }
  }

  setWallpaper(monitor: string, imagePath: string, transition: TransitionConfig): void {
    this.runCommand("awww", buildAwwwImgArgs(monitor, imagePath, transition), {
      timeoutMs: 10_000,
    });
  }

  async setWallpaperAsync(
    monitor: string,
    imagePath: string,
    transition: TransitionConfig,
  ): Promise<void> {
    await this.runCommandAsync("awww", buildAwwwImgArgs(monitor, imagePath, transition), {
      timeoutMs: 10_000,
    });
  }

  queryCurrent(): Record<string, string | null> {
    const res = this.runCommand("awww", ["query"], { timeoutMs: 5_000 });
    if (res.error || !res.stdout) {
      return {};
    }
    return parseAwwwQuery(res.stdout);
  }

  async queryCurrentAsync(): Promise<Record<string, string | null>> {
    if (this.queryInflight !== null) {
      return { ...(await this.queryInflight) };
    }
    const task = this.runCommandAsync("awww", ["query"], { timeoutMs: 5_000 }).then((res) => {
      if (res.error || !res.stdout) {
        return {};
      }
      return parseAwwwQuery(res.stdout);
    });
    this.queryInflight = task;
    try {
      return { ...(await task) };
    } finally {
      if (this.queryInflight === task) {
        this.queryInflight = null;
      }
    }
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

  async isLockedAsync(): Promise<boolean> {
    for (const locker of LOCKERS) {
      const res = await this.runCommandAsync("pgrep", ["-x", locker], { timeoutMs: 2_000 });
      if (!res.error && res.status === 0) {
        return true;
      }
    }
    return false;
  }

  notify(title: string, message: string, timeoutMs = 2000): void {
    const args = buildNotifySendArgs(title, message, timeoutMs);
    if (!this.usesDefaultRunner) {
      this.runCommand("notify-send", args, { timeoutMs: 5_000 });
      return;
    }
    try {
      const child = spawn("notify-send", args, {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => {
        // Ignore missing notify-send binary
      });
      child.unref();
    } catch {
      // Ignore notification spawn failure
    }
  }
}
