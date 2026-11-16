import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { quietSqliteWarning } from "./node-banner.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");

const externalPackages = [
  "electron",
  "@huggingface/transformers",
  "onnxruntime-node",
  "onnxruntime-common",
  "sharp",
];

const commonNodeOptions = {
  bundle: true,
  banner: { js: quietSqliteWarning },
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: false,
  external: externalPackages,
  alias: {
    "@shared": path.join(rootDir, "src/shared"),
    "@core": path.join(rootDir, "src/core"),
  },
};

async function main() {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  await Promise.all([
    esbuild({
      ...commonNodeOptions,
      entryPoints: [path.join(rootDir, "src/main/index.ts")],
      outfile: path.join(distDir, "main/index.cjs"),
    }),
    esbuild({
      ...commonNodeOptions,
      banner: {},
      entryPoints: [path.join(rootDir, "src/preload/index.ts")],
      outfile: path.join(distDir, "preload/index.cjs"),
    }),
    esbuild({
      ...commonNodeOptions,
      entryPoints: [path.join(rootDir, "src/worker/ml-worker.ts")],
      outfile: path.join(distDir, "worker/ml-worker.cjs"),
    }),
    esbuild({
      ...commonNodeOptions,
      entryPoints: [path.join(rootDir, "src/cli/index.ts")],
      outfile: path.join(distDir, "cli/index.cjs"),
    }),
    viteBuild({
      configFile: path.join(rootDir, "vite.config.ts"),
      logLevel: "info",
    }),
  ]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
