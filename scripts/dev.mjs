import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { context as esbuildContext } from "esbuild";
import { createServer } from "vite";
import { quietSqliteWarning } from "./node-banner.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const electronArgs = process.argv.slice(2);

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
  sourcemap: true,
  external: externalPackages,
  alias: {
    "@shared": path.join(rootDir, "src/shared"),
    "@core": path.join(rootDir, "src/core"),
  },
};

async function main() {
  const server = await createServer({
    configFile: path.join(rootDir, "vite.config.ts"),
    server: { port: 5173, strictPort: false },
  });
  await server.listen();
  const devUrl = server.resolvedUrls?.local?.[0] ?? "http://localhost:5173";

  const contexts = await Promise.all([
    esbuildContext({
      ...commonNodeOptions,
      entryPoints: [path.join(rootDir, "src/main/index.ts")],
      outfile: path.join(distDir, "main/index.cjs"),
    }),
    esbuildContext({
      ...commonNodeOptions,
      banner: {},
      entryPoints: [path.join(rootDir, "src/preload/index.ts")],
      outfile: path.join(distDir, "preload/index.cjs"),
    }),
    esbuildContext({
      ...commonNodeOptions,
      entryPoints: [path.join(rootDir, "src/worker/ml-worker.ts")],
      outfile: path.join(distDir, "worker/ml-worker.cjs"),
    }),
    esbuildContext({
      ...commonNodeOptions,
      entryPoints: [path.join(rootDir, "src/cli/index.ts")],
      outfile: path.join(distDir, "cli/index.cjs"),
    }),
  ]);

  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.watch()));

  const electronBin = createRequire(import.meta.url)("electron");
  const child = spawn(electronBin, [rootDir, ...electronArgs], {
    stdio: "inherit",
    env: { ...process.env, WAYPER_RENDERER_URL: devUrl, WAYPER_DEV: "1" },
  });
  child.on("exit", async (code) => {
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
    await server.close();
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
