# AGENTS.md

## Project Overview

wayper is a wallpaper manager with Wallhaven integration, written in TypeScript and shipped as
one Electron application. The same code provides the desktop app, the `wayper` CLI, and local
training and scoring of the preference model. There is no separate backend process or HTTP API.

## Agent Guidance Layout

- This `AGENTS.md` is the canonical shared agent guidance file.
- Claude Code imports this file from `.claude/CLAUDE.md`; keep durable project guidance here.
- Shared repo skills live in `.claude/skills` for Claude Code compatibility.
- `.agents/skills` contains symlinks to `.claude/skills` so Codex can discover the same skills.

## Setup

- Node.js 24 or newer and npm. Install dependencies with `npm ci` at the repository root.
- Set `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` before `npm ci` to avoid downloading the unused GPU
  provider (several hundred MB on Linux x64).
- Build with `npm run build`. Bundles go to `dist/` and are required before `npm start`,
  `node bin/wayper.cjs`, the screenshot skill, or packaging.

## Common Commands

- `npm run dev` runs the app against the Vite dev server (extra Electron switches go after
  `--`, e.g. `npm run dev -- --hidden`); `npm start` builds and launches it.
- Run CLI commands from a checkout with `node bin/wayper.cjs ...` after `npm run build`.
- `npm run typecheck` runs `tsc --noEmit` over `src/`, `tests/`, and the build configs.
- `npm test` runs the vitest suite on system Node. `npm run test:electron` runs the same suite
  on the Node runtime embedded in Electron, which is where the app, the ML worker, and the
  packaged CLI execute. Run both: the runtimes differ (for example, Electron's BoringSSL has no
  BLAKE2 or SHA-3 digests).
- `npm run dist` builds installers with electron-builder into `release/`. `npx electron-builder
  --linux --dir` is a quick packaging check.
- To try the app without touching real state, point `WAYPER_CONFIG_DIR` at a scratch directory
  whose `config.toml` sets its own `download_dir`, and pass `--user-data-dir=...` to Electron.

## Architecture

- `src/core/` is platform-neutral Node code with no Electron imports. `src/core/core.ts` owns
  state-modifying operations and `src/core/service.ts` (`WayperService`) is the single API over
  them. The CLI and the IPC layer stay thin wrappers around these.
- Platform-specific wallpaper behavior belongs in `src/core/backend/`; keep shared logic in
  top-level `src/core` modules.
- `src/main/` is the Electron main process: window, tray, single-instance handling, the
  `wayper://media/...` protocol, and one IPC handler per `WayperBridge` method.
- `src/preload/` exposes the typed `window.wayper` bridge declared in `src/shared/types.ts`.
  Calls go over `wayper:<method>` and return `{ ok, value }` or `{ ok, error }`; push events
  arrive on `wayper:event`. Add a method in all three places: types, preload, main.
- `src/renderer/` is the React, Tailwind, and Motion frontend built by Vite. It only talks to
  the bridge and has a strict Content-Security-Policy in production builds.
- `src/cli/` is the CLI. `bin/wayper.cjs` runs it on system Node from a checkout. In packaged
  builds the app executable recognises CLI arguments and synchronously re-executes itself as
  Node before any display is opened, so CLI commands work over SSH and from timers.
- A running app owns state changes: the CLI forwards hotkey actions to it over the control
  socket (`control.sock` in the config directory, a named pipe on Windows) and only acts
  locally when no app is running.
- `src/core/rotation.ts` owns automatic rotation inside the main process.
- Heavy preference-model work (training, suggestion ranking) runs through
  `src/core/heavy-tasks.ts`. The app runs it in an Electron utility process
  (`src/worker/ml-worker.ts`); the CLI runs it in-process.
- `src/core/preference/` holds the model. Its numerical behavior is pinned by parity fixtures
  generated from the original Python implementation; treat changes to scores as behavior
  changes and keep `tests/preference-parity.test.ts` and `tests/suggestions-parity.test.ts`
  green. Text embeddings come from `@huggingface/transformers` and are cached in
  `~/.cache/wayper/semantic`.
- File-based state is intentional: TOML config, plain-text blacklist/undo files, JSON history,
  and per-download-dir state files.
- File locks prevent concurrent state modifications. The state lock is not re-entrant.

## Packaging

- `package.json` `dependencies` lists only what must exist on disk at runtime
  (`@huggingface/transformers` and its native dependencies). Everything that esbuild or Vite
  bundles belongs in `devDependencies`.
- Packaged builds keep `dist/cli`, `dist/worker`, and `node_modules` outside the asar archive
  because they run as plain Node and load native modules.
- macOS `.dmg` and Windows installer builds come from `.github/workflows/release-macos.yml`.
- The AUR package runs on the system Electron. `packaging/aur/PKGBUILD` is the source of truth
  and `.github/workflows/release-aur.yml` publishes it; `packaging/aur/wayper.sh` is the
  `/usr/bin/wayper` launcher. Its GUI/CLI dispatch rule must match `bin/wayper.cjs`.

## Code Conventions

- TypeScript is `strict`. Prefer explicit types at module boundaries, `node:`-prefixed built-in
  imports, and async/await for I/O.
- Keep imports ordered as Node built-ins, third-party, then local.
- Use camelCase for functions and variables and PascalCase for types, classes, and React
  components. Keys in files on disk and in `--json` output stay snake_case for compatibility
  with existing libraries and scripts.
- Keep `src/core` free of Electron imports so the CLI and tests can load it on plain Node.
  Electron-only behavior is injected through seams such as `setTrashHandler`, `setUrlOpener`,
  and `setInteractiveLoginHandler`.

## Change Guidelines

- All changes to `main`, including version bumps, must be merged through a pull request.
  Do not push commits directly to `main` or bypass its repository rules. Create release
  tags only from the corresponding merged commit on `main` after its checks pass.
- Keep behavior cross-platform for Windows, macOS, and Linux. Do not assume X11 on Linux;
  support Wayland-oriented Hyprland/Sway paths.
- Disliked images go to system trash. Do not introduce a project-managed `.trash/` directory.
- Actions on "the current wallpaper" must only touch files inside the library; the compositor
  may be showing an image another tool set.
- All CLI commands should preserve `--json` machine-readable output behavior.
- When changing user-facing docs, keep `README.md` and `docs/README.zh-CN.md` in sync. Update
  `docs/index.html` when the public site content changes.
- For version bumps, keep `package.json`, `package-lock.json`, and `src/shared/version.ts` in
  sync. The release workflow fills in `pkgver` in the published PKGBUILD.
- Do not modify local user config, wallpaper state, `.claude/settings.local.json`, or generated
  build artifacts unless the task explicitly requires it.
