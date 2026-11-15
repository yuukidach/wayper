// Runs the vitest suite on the Node runtime embedded in Electron. The app,
// the ML worker and the packaged CLI all execute there, and it differs from
// system Node (BoringSSL instead of OpenSSL, an older V8).
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const electronBinary = require("electron");
const vitestEntry = path.join(rootDir, "node_modules/vitest/vitest.mjs");

const result = spawnSync(
  electronBinary,
  [vitestEntry, "run", "--pool=forks", ...process.argv.slice(2)],
  {
    cwd: rootDir,
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
