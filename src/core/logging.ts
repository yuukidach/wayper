import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "./paths";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: "DEBUG",
  info: "INFO",
  warn: "WARNING",
  error: "ERROR",
};
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const LOG_BACKUPS = 3;

let fileEnabled = false;
let consoleLevel: LogLevel | null = null;
let fileLevel: LogLevel = "info";
let logFilePath: string | null = null;
let bytesSinceCheck = 0;

export function logFile(): string {
  return path.join(getConfigDir(), "wayper.log");
}

export function setupLogging(options?: {
  file?: boolean;
  console?: LogLevel | null;
  verbose?: boolean;
}): void {
  fileEnabled = options?.file ?? true;
  consoleLevel = options?.console === undefined ? null : options.console;
  fileLevel = options?.verbose ? "debug" : "info";
  logFilePath = logFile();
  if (fileEnabled) {
    try {
      fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    } catch {
      fileEnabled = false;
    }
  }
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function timestamp(now: Date): string {
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

function rotateIfNeeded(target: string): void {
  try {
    if (fs.statSync(target).size < MAX_LOG_BYTES) return;
  } catch {
    return;
  }
  try {
    for (let index = LOG_BACKUPS - 1; index >= 1; index -= 1) {
      const from = `${target}.${index}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${target}.${index + 1}`);
    }
    fs.renameSync(target, `${target}.1`);
  } catch {
    // Another process may have rotated the file first.
  }
}

function formatDetail(detail: unknown): string {
  if (detail === undefined || detail === null) return "";
  if (detail instanceof Error) return `: ${detail.stack ?? detail.message}`;
  if (typeof detail === "string") return `: ${detail}`;
  try {
    return `: ${JSON.stringify(detail)}`;
  } catch {
    return `: ${String(detail)}`;
  }
}

function write(level: LogLevel, name: string, message: string, detail?: unknown): void {
  const now = new Date();
  const suffix = formatDetail(detail);
  if (fileEnabled && logFilePath && LEVEL_ORDER[level] >= LEVEL_ORDER[fileLevel]) {
    const line = `${timestamp(now)} [${LEVEL_LABEL[level]}] wayper.${name}: ${message}${suffix}\n`;
    try {
      bytesSinceCheck += line.length;
      if (bytesSinceCheck > 64 * 1024) {
        bytesSinceCheck = 0;
        rotateIfNeeded(logFilePath);
      }
      fs.appendFileSync(logFilePath, line, "utf8");
    } catch {
      // Logging must never break a wallpaper action.
    }
  }
  if (consoleLevel !== null && LEVEL_ORDER[level] >= LEVEL_ORDER[consoleLevel]) {
    const clock = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    process.stderr.write(`${clock} [${LEVEL_LABEL[level]}] ${message}${suffix}\n`);
  }
}

export interface Logger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

export function getLogger(name: string): Logger {
  return {
    debug: (message, detail) => write("debug", name, message, detail),
    info: (message, detail) => write("info", name, message, detail),
    warn: (message, detail) => write("warn", name, message, detail),
    error: (message, detail) => write("error", name, message, detail),
  };
}
