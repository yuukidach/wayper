#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const rawArgs = process.argv.slice(2);

const CLI_FLAGS = new Set(["-h", "--help", "--version", "--json", "--config"]);

// Only switches (--hidden, Chromium flags) start the desktop app; a command
// word or a CLI-level flag selects the CLI. Keep in sync with
// packaging/aur/wayper.sh.
function shouldLaunchGui(args) {
  if (args.some((arg) => arg.startsWith("--wayper-capture"))) return true;
  return args.every(
    (arg) => arg.startsWith("-") && !CLI_FLAGS.has(arg) && !arg.startsWith("--config="),
  );
}

function resolveElectronBinary() {
  const isWin = process.platform === "win32";
  const localBin = isWin
    ? path.join(rootDir, "node_modules", "electron", "dist", "electron.exe")
    : path.join(rootDir, "node_modules", ".bin", "electron");
  if (fs.existsSync(localBin)) return localBin;
  return isWin ? "electron.exe" : "electron";
}

if (shouldLaunchGui(rawArgs)) {
  process.title = "wayper";
  const electronBin = resolveElectronBinary();
  const child = spawn(electronBin, [rootDir, ...rawArgs], {
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env },
  });
  const forwardSignal = (sig) => {
    if (!child.killed) {
      child.kill(sig);
    }
  };
  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));
  child.on("error", (err) => {
    console.error(`Failed to launch Wayper desktop runtime (${electronBin}): ${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
} else {
  const cliEntry = path.join(rootDir, "dist", "cli", "index.cjs");
  if (!fs.existsSync(cliEntry)) {
    console.error("Wayper CLI bundle not found at dist/cli/index.cjs. Run `npm run build` first.");
    process.exit(1);
  }
  require(cliEntry);
}
