import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSandbox, type Sandbox } from "./helpers/sandbox";

const rootDir = path.resolve(__dirname, "..");
const cliBundle = path.join(rootDir, "node_modules", ".cache", "wayper-test", "cli.cjs");

let sandbox: Sandbox;

function wayper(...args: string[]): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliBundle, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      WAYPER_CONFIG_DIR: sandbox.configDir,
      XDG_DATA_HOME: path.join(sandbox.root, "xdg-data"),
      // Keep the child away from any live compositor session.
      HYPRLAND_INSTANCE_SIGNATURE: "",
      SWAYSOCK: "",
      WAYLAND_DISPLAY: "",
      DISPLAY: "",
    },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(async () => {
  await build({
    entryPoints: [path.join(rootDir, "src/cli/index.ts")],
    outfile: cliBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    logLevel: "silent",
    external: ["electron", "@huggingface/transformers", "onnxruntime-node", "onnxruntime-common"],
  });
});

beforeEach(() => {
  sandbox = createSandbox();
});

afterEach(() => {
  sandbox.cleanup();
});

describe("wayper CLI", () => {
  it("keeps --json output machine readable", () => {
    sandbox.addImage("sfw", "landscape", "wallhaven-cli001.png");

    const status = wayper("--json", "status");
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ mode: ["sfw"], quota_mb: 4000 });

    const mode = wayper("--json", "mode", "sfw,sketchy");
    expect(JSON.parse(mode.stdout)).toEqual({ action: "mode", mode: ["sfw", "sketchy"] });
    expect(fs.readFileSync(path.join(sandbox.downloadDir, ".mode"), "utf8")).toBe("sfw,sketchy");
    expect(JSON.parse(wayper("--json", "mode").stdout)).toEqual({
      action: "mode",
      mode: ["nsfw", "sketchy"],
    });

    expect(JSON.parse(wayper("--json", "autostart").stdout)).toEqual({ autostart: false });
    expect(JSON.parse(wayper("--json", "unban").stdout)).toEqual({
      action: "unban",
      status: "nothing_to_undo",
    });
    expect(JSON.parse(wayper("--json", "model", "status").stdout)).toMatchObject({
      status: "untrained",
    });
    expect(JSON.parse(wayper("--json", "suggest").stdout)).toEqual({ suggestions: [] });
    expect(JSON.parse(wayper("--json", "metadata", "status").stdout)).toMatchObject({
      records: 1,
      missing_records: 1,
      complete_records: 0,
    });
  });

  it("reports failures as JSON errors with a non-zero exit code", () => {
    const next = wayper("--json", "next");
    expect(next.code).toBe(1);
    expect(JSON.parse(next.stdout)).toEqual({ error: "No monitor config found" });

    const score = wayper("--json", "model", "score", "--tags", "anime");
    expect(score.code).toBe(1);
    expect(JSON.parse(score.stdout).error).toMatch(/No preference model trained yet/);

    const usage = wayper("--json", "status", "--hidden");
    expect(usage.code).toBe(2);
    expect(JSON.parse(usage.stdout).error).toMatch(/--hidden/);

    const unknown = wayper("frobnicate");
    expect(unknown.code).toBe(2);
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr).toMatch(/No such command 'frobnicate'/);

    const missingConfig = wayper("--config", path.join(sandbox.root, "missing.toml"), "status");
    expect(missingConfig.code).toBe(2);
  });

  it("honours an explicit --config file", () => {
    const alternate = path.join(sandbox.root, "alternate");
    fs.mkdirSync(path.join(alternate, "sfw", "portrait"), { recursive: true });
    const configPath = path.join(sandbox.root, "alternate.toml");
    fs.writeFileSync(configPath, `download_dir = ${JSON.stringify(alternate)}\nquota_mb = 77\n`);

    const status = wayper("--json", "--config", configPath, "status");
    expect(JSON.parse(status.stdout)).toMatchObject({ quota_mb: 77 });
    wayper("--config", configPath, "mode", "nsfw");
    expect(fs.readFileSync(path.join(alternate, ".mode"), "utf8")).toBe("nsfw");
    expect(fs.existsSync(path.join(sandbox.downloadDir, ".mode"))).toBe(false);
  });
});
