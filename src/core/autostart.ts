import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveConfig, type WayperConfig } from "./config";
import { getConfigDir } from "./paths";

export class AutostartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutostartError";
  }
}

export interface AutostartStatus {
  enabled: boolean;
  unit: string;
}

export interface AutostartOptions {
  platform?: NodeJS.Platform;
  configPath?: string;
  unitPath?: string;
  systemctlRunner?: (args: string[]) => void;
  windowsRegistry?: {
    read: () => string | null;
    write: (command: string) => void;
    remove: () => void;
  };
}

const WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const WINDOWS_RUN_VALUE = "Wayper";
const LAUNCH_AGENT_LABEL = "io.github.yuukidach.wayper";

function systemdServicePath(): string {
  return path.join(os.homedir(), ".config", "systemd", "user", "wayper.service");
}

function launchAgentPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

function windowsStartupScriptPath(): string {
  const appData = process.env.APPDATA?.trim() || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(
    appData,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    "Wayper.cmd",
  );
}

function windowsLauncherVbsPath(): string {
  return path.join(getConfigDir(), "WayperAutostart.vbs");
}

function windowsRegistrationUnit(): string {
  return `${WINDOWS_RUN_KEY}\\${WINDOWS_RUN_VALUE}`;
}

function resolveRegistrationUnit(
  platform: NodeJS.Platform,
  unitPathOverride?: string,
): string {
  if (unitPathOverride) return unitPathOverride;
  if (platform === "linux") return systemdServicePath();
  if (platform === "darwin") return launchAgentPath();
  if (platform === "win32") return windowsRegistrationUnit();
  throw new AutostartError(`Autostart is not supported on ${platform}`);
}

function whichExecutable(name: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const extensions =
    process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, `${name}${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) {
          return path.resolve(candidate);
        }
      } catch {
        // Ignore
      }
    }
  }
  return null;
}

export type AutostartCommand = string | readonly string[];

function resolveExecArgs(
  execCommand?: AutostartCommand,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (execCommand !== undefined && typeof execCommand !== "string") {
    const args = execCommand.map((arg) => arg.trim()).filter((arg) => arg.length > 0);
    if (args.length === 0) {
      throw new AutostartError("Cannot enable autostart with an empty executable command");
    }
    return args.includes("--hidden") ? args : [...args, "--hidden"];
  }
  if (execCommand !== undefined) {
    const trimmed = execCommand.trim();
    if (!trimmed) {
      throw new AutostartError("Cannot enable autostart with an empty executable command");
    }
    const quotedHiddenMatch = trimmed.match(/^"([^"]+)"\s+--hidden$/);
    if (quotedHiddenMatch) {
      return [quotedHiddenMatch[1], "--hidden"];
    }
    if (trimmed.endsWith(" --hidden")) {
      return [trimmed.slice(0, -" --hidden".length).trim(), "--hidden"];
    }
    return [trimmed, "--hidden"];
  }

  const execDir = path.dirname(process.execPath);
  const binName = platform === "win32" ? "wayper.exe" : "wayper";
  const candidates = [path.join(execDir, binName)];
  if (process.argv[1]) {
    const invoked = path.resolve(process.argv[1]);
    const baseLower = path.basename(invoked).toLowerCase();
    if (baseLower === "wayper" || baseLower === "wayper.exe" || baseLower === "wayper.cjs") {
      candidates.unshift(invoked);
    }
  }
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        if (candidate.endsWith(".cjs")) {
          return [process.execPath, candidate, "--hidden"];
        }
        return [candidate, "--hidden"];
      }
    } catch {
      // Ignore
    }
  }

  const fromPath = whichExecutable("wayper");
  if (fromPath) {
    return [fromPath, "--hidden"];
  }

  // Electron packaged binary fallback
  if (process.versions.electron) {
    return [process.execPath, "--hidden"];
  }

  throw new AutostartError("Cannot find wayper; install Wayper before enabling autostart");
}

function systemdQuote(arg: string): string {
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildSystemdService(args: readonly string[]): string {
  const execLine = args
    .map((arg, index) => (index < args.length - 1 || arg.includes(" ") ? systemdQuote(arg) : arg))
    .join(" ");
  return (
    "[Unit]\n" +
    "Description=Wayper wallpaper manager\n" +
    "PartOf=graphical-session.target\n" +
    "After=graphical-session.target\n\n" +
    "[Service]\n" +
    "Type=simple\n" +
    `ExecStart=${execLine}\n` +
    "Restart=on-failure\n" +
    "RestartSec=3\n\n" +
    "[Install]\n" +
    "WantedBy=graphical-session.target\n"
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildLaunchAgentPlist(args: readonly string[]): string {
  const items = args.map((arg) => `\t\t<string>${escapeXml(arg)}</string>`).join("\n");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n' +
    "<dict>\n" +
    "\t<key>Label</key>\n" +
    `\t<string>${LAUNCH_AGENT_LABEL}</string>\n` +
    "\t<key>ProgramArguments</key>\n" +
    "\t<array>\n" +
    `${items}\n` +
    "\t</array>\n" +
    "\t<key>RunAtLoad</key>\n" +
    "\t<true/>\n" +
    "</dict>\n" +
    "</plist>\n"
  );
}

function formatWindowsRunCommand(args: readonly string[]): string {
  return args
    .map((arg, idx) => (idx === 0 || arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg))
    .join(" ");
}

function defaultWindowsReadRegistration(): string | null {
  const res = spawnSync("reg.exe", ["query", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE], {
    encoding: "utf8",
    timeout: 8_000,
    windowsHide: true,
  });
  if (res.error || res.status !== 0) {
    return null;
  }
  const match = (res.stdout ?? "").match(/REG_SZ\s+(.+)$/m);
  return match ? match[1].trim() : "";
}

function defaultWindowsWriteRegistration(command: string): void {
  const res = spawnSync(
    "reg.exe",
    ["add", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE, "/t", "REG_SZ", "/d", command, "/f"],
    {
      encoding: "utf8",
      timeout: 8_000,
      windowsHide: true,
    },
  );
  if (res.error || res.status !== 0) {
    const detail = (res.stderr ?? "").trim() || (res.stdout ?? "").trim() || "reg.exe add failed";
    throw new AutostartError(detail);
  }
}

function defaultWindowsDeleteRegistration(): void {
  const existing = defaultWindowsReadRegistration();
  if (existing === null) {
    return;
  }
  const res = spawnSync("reg.exe", ["delete", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE, "/f"], {
    encoding: "utf8",
    timeout: 8_000,
    windowsHide: true,
  });
  if (res.error || res.status !== 0) {
    const detail = (res.stderr ?? "").trim() || (res.stdout ?? "").trim() || "reg.exe delete failed";
    throw new AutostartError(detail);
  }
}

function defaultSystemctlRunner(args: string[]): void {
  if (!whichExecutable("systemctl")) {
    throw new AutostartError("systemctl is required to manage Wayper autostart");
  }
  const res = spawnSync("systemctl", ["--user", ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (res.error) {
    throw new AutostartError(res.error.message);
  }
  if (res.status !== 0) {
    const detail = (res.stderr ?? "").trim() || (res.stdout ?? "").trim() || "systemctl failed";
    throw new AutostartError(detail);
  }
}

export function getAutostartStatus(options?: AutostartOptions): AutostartStatus {
  const platform = options?.platform ?? process.platform;
  const unit = resolveRegistrationUnit(platform, options?.unitPath);
  if (platform === "win32") {
    const readReg = options?.windowsRegistry?.read ?? defaultWindowsReadRegistration;
    return { enabled: readReg() !== null, unit };
  }
  return { enabled: fs.existsSync(unit), unit };
}

export function setAutostart(
  config: WayperConfig,
  enabled: boolean,
  execCommand?: AutostartCommand,
  options?: AutostartOptions,
): AutostartStatus {
  const platform = options?.platform ?? process.platform;
  const unit = resolveRegistrationUnit(platform, options?.unitPath);

  if (platform === "win32") {
    const readReg = options?.windowsRegistry?.read ?? defaultWindowsReadRegistration;
    const writeReg = options?.windowsRegistry?.write ?? defaultWindowsWriteRegistration;
    const removeReg = options?.windowsRegistry?.remove ?? defaultWindowsDeleteRegistration;
    const legacyStartup = windowsStartupScriptPath();
    const legacyVbs = windowsLauncherVbsPath();
    const previous = readReg();

    if (enabled) {
      try {
        const args = resolveExecArgs(execCommand, platform);
        const command = formatWindowsRunCommand(args);
        writeReg(command);
        fs.rmSync(legacyStartup, { force: true });
        fs.rmSync(legacyVbs, { force: true });
      } catch (error) {
        try {
          if (previous === null) {
            removeReg();
          } else {
            writeReg(previous);
          }
        } catch {
          // Best-effort rollback
        }
        if (error instanceof AutostartError) throw error;
        throw new AutostartError(error instanceof Error ? error.message : String(error));
      }
    } else {
      try {
        removeReg();
        fs.rmSync(legacyStartup, { force: true });
        fs.rmSync(legacyVbs, { force: true });
      } catch (error) {
        if (error instanceof AutostartError) throw error;
        throw new AutostartError(error instanceof Error ? error.message : String(error));
      }
    }

    config.autostart = enabled;
    saveConfig(config, options?.configPath);
    return { enabled, unit };
  }

  const runSystemctl = options?.systemctlRunner ?? defaultSystemctlRunner;
  const previousBytes = fs.existsSync(unit) ? fs.readFileSync(unit) : null;

  if (enabled) {
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    try {
      const args = resolveExecArgs(execCommand, platform);
      if (platform === "linux") {
        fs.writeFileSync(unit, buildSystemdService(args), "utf8");
        runSystemctl(["daemon-reload"]);
        runSystemctl(["enable", path.basename(unit)]);
      } else {
        fs.writeFileSync(unit, buildLaunchAgentPlist(args), "utf8");
      }
    } catch (error) {
      try {
        if (previousBytes === null) {
          fs.rmSync(unit, { force: true });
        } else {
          fs.writeFileSync(unit, previousBytes);
        }
      } catch {
        // Best-effort rollback
      }
      if (error instanceof AutostartError) throw error;
      throw new AutostartError(error instanceof Error ? error.message : String(error));
    }
  } else {
    try {
      if (platform === "linux" && fs.existsSync(unit)) {
        runSystemctl(["disable", path.basename(unit)]);
      }
      fs.rmSync(unit, { force: true });
      if (platform === "linux") {
        runSystemctl(["daemon-reload"]);
      }
    } catch (error) {
      if (error instanceof AutostartError) throw error;
      throw new AutostartError(error instanceof Error ? error.message : String(error));
    }
  }

  config.autostart = enabled;
  saveConfig(config, options?.configPath);
  return { enabled, unit };
}

export function ensureDefaultAutostart(
  config: WayperConfig,
  execCommand?: AutostartCommand,
  options?: AutostartOptions,
): void {
  if (config.autostart && !getAutostartStatus(options).enabled) {
    setAutostart(config, true, execCommand, options);
  }
}
