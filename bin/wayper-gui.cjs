#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const rootDir = path.resolve(__dirname, "..");
const rawArgs = process.argv.slice(2);

function resolveElectronBinary() {
  const isWin = process.platform === "win32";
  const localBin = isWin
    ? path.join(rootDir, "node_modules", "electron", "dist", "electron.exe")
    : path.join(rootDir, "node_modules", ".bin", "electron");
  if (fs.existsSync(localBin)) return localBin;
  return isWin ? "electron.exe" : "electron";
}

process.title = "wayper-gui";
const electronBin = resolveElectronBinary();
const child = spawn(electronBin, [rootDir, ...rawArgs], {
  stdio: "inherit",
  windowsHide: true,
  env: { ...process.env },
});
process.on("SIGINT", () => {
  if (!child.killed) child.kill("SIGINT");
});
process.on("SIGTERM", () => {
  if (!child.killed) child.kill("SIGTERM");
});
child.on("exit", (code) => {
  process.exit(code ?? 0);
});
