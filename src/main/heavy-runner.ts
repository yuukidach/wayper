import { utilityProcess, type UtilityProcess } from "electron";
import type { HeavyTaskName, HeavyTaskRunner } from "../core/heavy-tasks";

const IDLE_SHUTDOWN_MS = 45_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface Worker {
  process: UtilityProcess;
  pending: Map<number, Pending>;
}

export interface HeavyTaskHost {
  run: HeavyTaskRunner;
  shutdown: () => void;
}

/**
 * Runs model scoring and training in an Electron utility process so the main
 * process (tray, rotation, IPC) never blocks on CPU-heavy work.  The worker is
 * started on demand and released after a few idle minutes.
 */
export function createHeavyTaskHost(workerPath: string): HeavyTaskHost {
  let worker: Worker | null = null;
  let nextId = 1;
  let idleTimer: NodeJS.Timeout | null = null;
  let closed = false;

  const failAll = (target: Worker, message: string): void => {
    for (const entry of target.pending.values()) entry.reject(new Error(message));
    target.pending.clear();
  };

  const clearIdleTimer = (): void => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const stop = (message: string): void => {
    clearIdleTimer();
    const active = worker;
    worker = null;
    if (!active) return;
    failAll(active, message);
    active.process.kill();
  };

  const scheduleIdleShutdown = (): void => {
    clearIdleTimer();
    if (worker === null || worker.pending.size > 0) return;
    idleTimer = setTimeout(() => stop("Model worker was released while idle"), IDLE_SHUTDOWN_MS);
    idleTimer.unref?.();
  };

  const ensureWorker = (): Worker => {
    if (worker) return worker;
    const spawned: Worker = {
      process: utilityProcess.fork(workerPath, [], {
        serviceName: "Wayper Model Worker",
        stdio: "ignore",
      }),
      pending: new Map(),
    };
    spawned.process.on(
      "message",
      (message: { id: number; ok: boolean; value?: unknown; error?: string }) => {
        const entry = spawned.pending.get(message.id);
        if (!entry) return;
        spawned.pending.delete(message.id);
        if (message.ok) entry.resolve(message.value);
        else entry.reject(new Error(message.error ?? "Model worker task failed"));
        if (worker === spawned) scheduleIdleShutdown();
      },
    );
    spawned.process.on("exit", () => {
      // Only requests owned by this process fail; a replacement keeps its own.
      if (worker === spawned) {
        worker = null;
        clearIdleTimer();
      }
      failAll(spawned, "Model worker stopped unexpectedly");
    });
    worker = spawned;
    return spawned;
  };

  const run = ((name: HeavyTaskName, args: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      if (closed) {
        reject(new Error("Wayper is shutting down"));
        return;
      }
      const id = nextId;
      nextId += 1;
      clearIdleTimer();
      let target: Worker;
      try {
        target = ensureWorker();
        target.pending.set(id, { resolve, reject });
        target.process.postMessage({ id, name, args });
      } catch (error) {
        worker?.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    })) as HeavyTaskRunner;

  return {
    run,
    shutdown: () => {
      closed = true;
      stop("Wayper is shutting down");
    },
  };
}
