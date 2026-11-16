import { loadConfig } from "../core/config";
import { heavyTasks, type HeavyTaskName } from "../core/heavy-tasks";
import { applyGlobalProxy } from "../core/http";
import { getLogger, setupLogging } from "../core/logging";

interface WorkerRequest {
  id: number;
  name: HeavyTaskName;
  args: unknown;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

interface ParentPortLike {
  on(event: "message", listener: (event: { data: WorkerRequest }) => void): void;
  postMessage(message: WorkerResponse): void;
}

setupLogging({ console: null });
const log = getLogger("worker");

try {
  applyGlobalProxy(loadConfig(undefined, { detectDisplays: false }).proxy);
} catch {
  // The worker still runs local scoring when the configuration is unreadable.
}

async function handle(request: WorkerRequest): Promise<WorkerResponse> {
  const task = heavyTasks[request.name] as ((args: unknown) => Promise<unknown>) | undefined;
  if (typeof task !== "function") {
    return { id: request.id, ok: false, error: `Unknown task: ${String(request.name)}` };
  }
  try {
    return { id: request.id, ok: true, value: await task(request.args) };
  } catch (error) {
    log.warn(`Task ${request.name} failed`, error);
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPortLike }).parentPort;
if (parentPort) {
  parentPort.on("message", (event) => {
    void handle(event.data).then((response) => parentPort.postMessage(response));
  });
} else if (typeof process.send === "function") {
  process.on("message", (message) => {
    void handle(message as WorkerRequest).then((response) => process.send?.(response));
  });
}
