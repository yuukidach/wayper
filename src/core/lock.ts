import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "./paths";

export interface FileLockOptions {
  blocking?: boolean;
  timeoutMs?: number;
}

interface LockPayload {
  pid: number;
  createdAt: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 25;
const STALE_CORRUPT_GRACE_MS = 2_000;
const SYNC_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export class LockBusyError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string, message?: string) {
    super(message ?? `Lock is busy: ${lockPath}`);
    this.name = "LockBusyError";
    this.lockPath = lockPath;
  }
}

export function getDefaultLockPath(): string {
  return path.join(getConfigDir(), "state.lock");
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "EPERM";
  }
}

function isLockStale(lockPath: string): boolean {
  try {
    const raw = fs.readFileSync(lockPath, "utf8").trim();
    if (!raw) {
      const stat = fs.statSync(lockPath);
      return Date.now() - stat.mtimeMs > STALE_CORRUPT_GRACE_MS;
    }
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid)) {
      return !isPidAlive(parsed.pid);
    }
    const stat = fs.statSync(lockPath);
    return Date.now() - stat.mtimeMs > STALE_CORRUPT_GRACE_MS;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return false;
    }
    try {
      const stat = fs.statSync(lockPath);
      return Date.now() - stat.mtimeMs > STALE_CORRUPT_GRACE_MS;
    } catch {
      return false;
    }
  }
}

function tryAcquireLockOnce(lockPath: string): boolean {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    const fd = fs.openSync(lockPath, "wx");
    try {
      const payload: LockPayload = {
        pid: process.pid,
        createdAt: Date.now(),
      };
      fs.writeSync(fd, JSON.stringify(payload));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "EEXIST") {
      throw error;
    }
    if (isLockStale(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkErr) {
        if ((unlinkErr as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
          return false;
        }
      }
      // Retry immediately once stale lock is cleared
      try {
        const fd = fs.openSync(lockPath, "wx");
        try {
          const payload: LockPayload = {
            pid: process.pid,
            createdAt: Date.now(),
          };
          fs.writeSync(fd, JSON.stringify(payload));
        } finally {
          fs.closeSync(fd);
        }
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

function releaseLockFile(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Ignore already removed lock file
  }
}

export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  options?: FileLockOptions,
): Promise<T> {
  const blocking = options?.blocking ?? true;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + Math.max(0, timeoutMs);

  while (!tryAcquireLockOnce(lockPath)) {
    if (!blocking) {
      throw new LockBusyError(lockPath);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new LockBusyError(lockPath, `Timed out waiting for lock: ${lockPath}`);
    }
    const delay = Math.min(POLL_INTERVAL_MS, remaining);
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }

  try {
    return await fn();
  } finally {
    releaseLockFile(lockPath);
  }
}

export function withFileLockSync<T>(
  lockPath: string,
  fn: () => T,
  options?: FileLockOptions,
): T {
  const blocking = options?.blocking ?? true;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + Math.max(0, timeoutMs);

  while (!tryAcquireLockOnce(lockPath)) {
    if (!blocking) {
      throw new LockBusyError(lockPath);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new LockBusyError(lockPath, `Timed out waiting for lock: ${lockPath}`);
    }
    Atomics.wait(SYNC_WAIT_BUFFER, 0, 0, Math.min(POLL_INTERVAL_MS, remaining));
  }

  try {
    return fn();
  } finally {
    releaseLockFile(lockPath);
  }
}
