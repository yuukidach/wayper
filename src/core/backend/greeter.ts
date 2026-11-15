import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { GreeterConfig, WayperConfig } from "../config";
import { validateImageFile } from "../image-probe";

export class GreeterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GreeterError";
  }
}

export interface InstallGreeterOptions {
  platform?: NodeJS.Platform;
  copyFileFn?: (src: string, dst: string) => void;
  chmodFn?: (dst: string, mode: number) => void;
  sudoRunner?: (
    args: string[],
    input: Buffer,
    timeoutMs: number,
  ) => Pick<SpawnSyncReturns<Buffer>, "status" | "error">;
}

function extractGreeterConfig(config: GreeterConfig | WayperConfig): GreeterConfig {
  return "greeter" in config ? config.greeter : config;
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM";
}

export function installGreeterImage(
  config: GreeterConfig | WayperConfig,
  imagePath: string,
  options?: InstallGreeterOptions,
): void {
  const platform = options?.platform ?? process.platform;
  if (platform !== "linux") {
    throw new GreeterError("Login backgrounds are only supported on Linux");
  }

  const greeter = extractGreeterConfig(config);
  if (!greeter.image) {
    throw new GreeterError("Configure [greeter].image in config.toml first");
  }

  if (!validateImageFile(imagePath)) {
    throw new GreeterError("The selected file is not a readable image");
  }

  const resolvedSrc = path.resolve(imagePath);
  const resolvedDst = path.resolve(greeter.image);
  if (resolvedSrc === resolvedDst) {
    return;
  }

  try {
    if (fs.existsSync(greeter.image) && fs.statSync(greeter.image).isDirectory()) {
      throw new GreeterError("The greeter target must be a file, not a directory");
    }
  } catch (error) {
    if (error instanceof GreeterError) {
      throw error;
    }
  }

  const copyFn = options?.copyFileFn ?? fs.copyFileSync;
  const chmodFn = options?.chmodFn ?? fs.chmodSync;

  try {
    copyFn(imagePath, greeter.image);
    chmodFn(greeter.image, 0o644);
    return;
  } catch (error) {
    if (!isPermissionError(error)) {
      throw new GreeterError(
        "Could not copy the login background; check the greeter target and sudo permissions",
      );
    }
  }

  const password = greeter.sudo_password;
  const sudoArgs = password ? ["-S", "-p", ""] : ["-n"];
  sudoArgs.push("--", "install", "-m", "644", "-T", "--", imagePath, greeter.image);
  const inputBuf = password ? Buffer.from(password, "utf8") : Buffer.alloc(0);

  const runSudo =
    options?.sudoRunner ??
    ((args: string[], input: Buffer, timeoutMs: number) =>
      spawnSync("sudo", args, {
        input,
        stdio: ["pipe", "ignore", "ignore"],
        timeout: timeoutMs,
      }));

  const result = runSudo(sudoArgs, inputBuf, 15_000);
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") {
      throw new GreeterError("Timed out updating the login background");
    }
    throw new GreeterError(
      "Could not copy the login background; check the greeter target and sudo permissions",
    );
  }
  if (result.status !== 0) {
    throw new GreeterError(
      "Could not copy the login background; check the greeter target and sudo permissions",
    );
  }
}
