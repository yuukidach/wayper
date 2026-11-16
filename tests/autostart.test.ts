import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDefaultAutostart, setAutostart } from "../src/core/autostart";
import { loadConfig } from "../src/core/config";
import { createSandbox, type Sandbox } from "./helpers/sandbox";

let sandbox: Sandbox;

beforeEach(() => {
  sandbox = createSandbox();
});

afterEach(() => {
  sandbox.cleanup();
});

// With systemd's default kill mode every Chromium helper is signalled together
// with the app; the app then aborts and stopping the service takes a minute.
describe("systemd autostart unit", () => {
  it("stops only the app, and upgrades a unit written before that was set", () => {
    const unitPath = path.join(sandbox.root, "systemd", "wayper.service");
    const configPath = path.join(sandbox.configDir, "config.toml");
    const systemctl: string[][] = [];
    const options = {
      platform: "linux" as const,
      unitPath,
      configPath,
      systemctlRunner: (args: string[]) => void systemctl.push(args),
    };
    const config = loadConfig(configPath, { detectDisplays: false });

    setAutostart(config, true, ["/opt/wayper/wayper"], options);
    const written = fs.readFileSync(unitPath, "utf8");
    expect(written).toMatch(/^KillMode=mixed$/m);
    expect(written).toMatch(/^ExecStart="\/opt\/wayper\/wayper" --hidden$/m);

    const older = written.replace("KillMode=mixed\n", "");
    fs.writeFileSync(unitPath, older);
    systemctl.length = 0;
    ensureDefaultAutostart(config, ["/somewhere/else/wayper"], options);
    const upgraded = fs.readFileSync(unitPath, "utf8");
    expect(upgraded).toMatch(/^KillMode=mixed$/m);
    // Only the missing line is added; the registered command is left as it was.
    expect(upgraded).toMatch(/^ExecStart="\/opt\/wayper\/wayper" --hidden$/m);
    expect(systemctl).toEqual([["daemon-reload"]]);

    const custom = older.replace("Type=simple\n", "Type=simple\nKillMode=process\n");
    fs.writeFileSync(unitPath, custom);
    systemctl.length = 0;
    ensureDefaultAutostart(config, ["/opt/wayper/wayper"], options);
    expect(fs.readFileSync(unitPath, "utf8")).toBe(custom);
    expect(systemctl).toEqual([]);
  });
});
