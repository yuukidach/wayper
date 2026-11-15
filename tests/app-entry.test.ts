import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { build, type BuildOptions } from "esbuild";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSandbox, type Sandbox } from "./helpers/sandbox";

const rootDir = path.resolve(__dirname, "..");
const appDir = path.join(rootDir, "node_modules", ".cache", "wayper-test", "app");

function resolveElectronBinary(): string | null {
  try {
    const binary: unknown = createRequire(__filename)("electron");
    return typeof binary === "string" && fs.existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

const electronBinary = resolveElectronBinary();
let sandbox: Sandbox;

/** Runs the app entry point the way a packaged `Wayper <command>` does, with no display. */
function wayperApp(...args: string[]): { code: number | null; stdout: string; signal: string | null } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WAYPER_CONFIG_DIR: sandbox.configDir,
    XDG_DATA_HOME: path.join(sandbox.root, "xdg-data"),
  };
  for (const name of [
    "ELECTRON_RUN_AS_NODE",
    "WAYLAND_DISPLAY",
    "DISPLAY",
    "HYPRLAND_INSTANCE_SIGNATURE",
    "SWAYSOCK",
  ]) {
    delete env[name];
  }
  const result = spawnSync(electronBinary as string, [appDir, ...args], {
    encoding: "utf8",
    timeout: 45_000,
    env,
  });
  return { code: result.status, stdout: result.stdout, signal: result.signal };
}

beforeAll(async () => {
  const options: BuildOptions = {
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    logLevel: "silent",
    external: ["electron", "@huggingface/transformers", "onnxruntime-node", "onnxruntime-common"],
  };
  await Promise.all([
    build({
      ...options,
      entryPoints: [path.join(rootDir, "src/main/index.ts")],
      outfile: path.join(appDir, "dist/main/index.cjs"),
    }),
    build({
      ...options,
      entryPoints: [path.join(rootDir, "src/cli/index.ts")],
      outfile: path.join(appDir, "dist/cli/index.cjs"),
    }),
  ]);
  fs.writeFileSync(
    path.join(appDir, "package.json"),
    JSON.stringify({ name: "wayper", version: "0.0.0", main: "dist/main/index.cjs" }),
  );
});

beforeEach(() => {
  sandbox = createSandbox();
});

afterEach(() => {
  sandbox.cleanup();
});

// Without a display the desktop runtime used to hang for a minute and crash
// instead of answering, which broke the CLI over SSH and from timers.
describe.skipIf(electronBinary === null)("app binary used as the CLI", () => {
  it("answers CLI commands without a display", () => {
    const version = wayperApp("--version");
    expect(version.signal).toBeNull();
    expect(version.code).toBe(0);
    // On Windows the desktop runtime writes a blank line before the CLI starts.
    expect(version.stdout.trimStart()).toMatch(/^wayper, version \d+\.\d+\.\d+/);

    const autostart = wayperApp("--json", "autostart");
    expect(autostart.code).toBe(0);
    expect(JSON.parse(autostart.stdout)).toEqual({ autostart: false });
  }, 120_000);

  it("propagates CLI exit codes", () => {
    const unknown = wayperApp("--json", "model", "nope");
    expect(unknown.code).toBe(2);
    expect(JSON.parse(unknown.stdout)).toHaveProperty("error");
  }, 60_000);
});
