import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface ControlActionPayload {
  protocol: "wayper-control-v2";
  download_dir: string;
  action: "next" | "prev" | "fav" | "unfav" | "ban" | "dislike";
  open_url?: boolean;
  monitor?: string | null;
}

export interface ControlActionResponse {
  matched: boolean;
  ok: boolean;
  action: string;
  monitor?: string | null;
  image?: string | null;
  status?: string | null;
  opened?: boolean;
  error?: string | null;
}

export function resolveControlEndpoint(configDir: string): string {
  if (process.platform === "win32") {
    const hash = crypto.createHash("sha1").update(configDir).digest("hex").slice(0, 12);
    const user = os.userInfo().username.replace(/[^a-zA-Z0-9_-]/g, "");
    return `\\\\.\\pipe\\wayper-${user}-${hash}`;
  }
  return path.join(configDir, "control.sock");
}

export async function startControlServer(
  endpoint: string,
  handler: (req: ControlActionPayload) => Promise<ControlActionResponse>,
): Promise<{ close: () => Promise<void> }> {
  if (process.platform !== "win32") {
    fs.mkdirSync(path.dirname(endpoint), { recursive: true });
    try {
      fs.unlinkSync(endpoint);
    } catch {
      // Ignore missing socket
    }
  }

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf-8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      const line = buffer.slice(0, newlineIndex);
      buffer = "";
      void (async () => {
        try {
          const req = JSON.parse(line) as ControlActionPayload;
          if (req?.protocol !== "wayper-control-v2") {
            socket.end(
              JSON.stringify({ matched: false, ok: false, action: "", error: "Invalid protocol" }) +
                "\n",
            );
            return;
          }
          const response = await handler(req);
          socket.end(JSON.stringify(response) + "\n");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          socket.end(
            JSON.stringify({ matched: true, ok: false, action: "unknown", error: message }) + "\n",
          );
        }
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.removeListener("error", reject);
      if (process.platform !== "win32") {
        try {
          fs.chmodSync(endpoint, 0o600);
        } catch {
          // Best-effort permission hardening
        }
      }
      resolve();
    });
  });

  return {
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") {
        try {
          fs.unlinkSync(endpoint);
        } catch {
          // Ignore
        }
      }
    },
  };
}

export async function trySendControlAction(
  endpoint: string,
  payload: ControlActionPayload,
): Promise<ControlActionResponse | null> {
  return new Promise((resolve) => {
    let connected = false;
    let settled = false;
    let responseBuffer = "";

    const finish = (result: ControlActionResponse | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const socket = net.createConnection(endpoint);
    socket.setEncoding("utf-8");
    socket.setTimeout(300);

    socket.once("connect", () => {
      connected = true;
      socket.setTimeout(30_000);
      socket.write(JSON.stringify(payload) + "\n");
    });

    socket.on("data", (chunk) => {
      responseBuffer += chunk;
      const idx = responseBuffer.indexOf("\n");
      if (idx !== -1) {
        const raw = responseBuffer.slice(0, idx);
        socket.destroy();
        try {
          const parsed = JSON.parse(raw) as ControlActionResponse;
          if (!parsed.matched) {
            finish(null);
            return;
          }
          finish(parsed);
        } catch (err) {
          finish({
            matched: true,
            ok: false,
            action: payload.action,
            error: `Invalid response from Wayper service: ${String(err)}`,
          });
        }
      }
    });

    socket.once("timeout", () => {
      socket.destroy();
      if (!connected) {
        finish(null);
      } else {
        finish({
          matched: true,
          ok: false,
          action: payload.action,
          error: `Timed out waiting for ${payload.action}. Check the current wallpaper.`,
        });
      }
    });

    socket.once("error", (err: NodeJS.ErrnoException) => {
      socket.destroy();
      if (!connected) {
        if (
          process.platform !== "win32" &&
          (err.code === "ECONNREFUSED" || err.code === "ENOENT")
        ) {
          if (err.code === "ECONNREFUSED") {
            try {
              fs.unlinkSync(endpoint);
            } catch {
              // Ignore stale socket cleanup failure
            }
          }
        }
        finish(null);
      } else {
        finish({
          matched: true,
          ok: false,
          action: payload.action,
          error: `Could not confirm ${payload.action}: ${err.message}`,
        });
      }
    });
  });
}
