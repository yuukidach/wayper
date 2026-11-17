import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import { ensureDefaultAutostart, type AutostartCommand } from "../core/autostart";
import { invalidateMonitorCache } from "../core/backend";
import { loadConfig } from "../core/config";
import { resolveControlEndpoint, startControlServer } from "../core/control-ipc";
import { setUrlOpener } from "../core/core";
import { applyGlobalProxy } from "../core/http";
import { getLogger, setupLogging } from "../core/logging";
import { getConfigDir } from "../core/paths";
import { setCliEntryPath } from "../core/preference/ledger";
import { AutoRotationService } from "../core/rotation";
import { ServiceError, WayperService } from "../core/service";
import { setTrashHandler } from "../core/trash";
import { setInteractiveLoginHandler } from "../core/wallhaven-web";
import type { WayperPushEvent } from "../shared/types";
import { createHeavyTaskHost, type HeavyTaskHost } from "./heavy-runner";
import { installWayperMediaProtocol, registerWayperSchemePrivileges } from "./protocol";
import { openInteractiveWallhavenLogin } from "./wallhaven-auth-window";

const APP_ID = "com.wayper.app";
const CAPTURE_SWITCH = "--wayper-capture";
const HIDDEN_SWITCH = "--hidden";
const WEBSITE_URL = "https://yuukidach.github.io/wayper/";
const ISSUES_URL = "https://github.com/yuukidach/wayper/issues";
const CLI_COMMANDS = new Set([
  "autostart",
  "next",
  "prev",
  "fav",
  "unfav",
  "ban",
  "dislike",
  "unban",
  "mode",
  "status",
  "metadata",
  "suggest",
  "model",
  "update-check",
  "setup",
]);
const CLI_ROOT_FLAGS = new Set(["--help", "-h", "--version", "--json", "--config"]);

const log = getLogger("main");
const isMac = process.platform === "darwin";
const isDev = Boolean(process.env.WAYPER_DEV);
const rootDir = path.resolve(__dirname, "../..");
// The CLI and the ML worker run as plain Node processes and import native
// modules, so packaged builds keep them outside the asar archive.
const unpacked = (entry: string): string =>
  path.join(__dirname, entry).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const cliEntry = unpacked("../cli/index.cjs");
const workerEntry = unpacked("../worker/ml-worker.cjs");

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let trayRefreshTimer: NodeJS.Timeout | null = null;
let captureInProgress = false;
let isQuitting = false;
let shutdownComplete = false;
let shutdownStarted = false;
let startupFinished = false;
let pendingShow = false;
let heavyHost: HeavyTaskHost | null = null;
let service: WayperService | null = null;
let rotation: AutoRotationService | null = null;
let controlServer: { close: () => Promise<void> } | null = null;

process.title = "wayper";

function userArguments(argv: readonly string[]): string[] {
  return argv.slice(process.defaultApp ? 2 : 1);
}

/** A packaged Wayper binary doubles as the CLI: `Wayper next`, `Wayper status --json`, ... */
function cliArguments(argv: readonly string[]): string[] | null {
  const args = userArguments(argv);
  for (const argument of args) {
    if (CLI_COMMANDS.has(argument) || CLI_ROOT_FLAGS.has(argument)) return args;
    if (!argument.startsWith("-")) return null;
    if (argument === CAPTURE_SWITCH) return null;
  }
  return null;
}

function runCliAndExit(args: string[]): never {
  if (isMac) app.dock?.hide();
  // Block here instead of waiting on an async child: returning to the event
  // loop lets Chromium go on to open a display, which hangs and then crashes
  // where there is none (SSH, cron, a bare TTY).
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      WAYPER_AUTOSTART_COMMAND: JSON.stringify(autostartCommand()),
    },
  });
  if (result.error) {
    console.error(`Could not start the Wayper CLI: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

function capturePathFromCommandLine(commandLine: readonly string[] = []): string | null {
  for (let index = 0; index < commandLine.length; index += 1) {
    const argument = String(commandLine[index] ?? "");
    if (argument.startsWith(`${CAPTURE_SWITCH}=`)) {
      const value = argument.slice(CAPTURE_SWITCH.length + 1).trim();
      return value ? path.resolve(value) : null;
    }
    if (argument === CAPTURE_SWITCH) {
      const value = String(commandLine[index + 1] ?? "").trim();
      return value ? path.resolve(value) : null;
    }
  }
  return null;
}

function resourceCandidates(name: string): string[] {
  return [path.join(process.resourcesPath, name), path.join(rootDir, "assets", name)];
}

function getAppIconPath(): string | null {
  const iconName = process.platform === "win32" ? "icon.ico" : "icon-256.png";
  const candidates = [process.env.WAYPER_ICON_PATH, ...resourceCandidates(iconName)];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) ?? null;
}

function getTrayIcon(): string | Electron.NativeImage | null {
  if (!isMac) return getAppIconPath();
  const iconPath = resourceCandidates("trayTemplate.png").find((candidate) =>
    fs.existsSync(candidate),
  );
  if (!iconPath) return null;
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) return null;
  icon.setTemplateImage(true);
  return icon;
}

function autostartCommand(): AutostartCommand {
  const override = process.env.WAYPER_AUTOSTART_EXEC?.trim();
  if (override) return [override, HIDDEN_SWITCH];
  if (app.isPackaged) return [process.env.APPIMAGE || process.execPath, HIDDEN_SWITCH];
  return [process.execPath, app.getAppPath(), HIDDEN_SWITCH];
}

function broadcast(event: WayperPushEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send("wayper:event", event);
    }
  }
  if (event.type === "rotation" || event.type === "config") refreshTrayMenu();
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow(show: boolean): void {
  if (show && isMac) app.focus({ steal: true });
  const iconPath = getAppIconPath();
  const availableHeight = screen.getPrimaryDisplay().workAreaSize.height;
  const isWin = process.platform === "win32";
  const windowChromeOptions: Partial<Electron.BrowserWindowConstructorOptions> = isMac
    ? {
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 18, y: 20 },
      }
    : isWin
      ? {
          titleBarStyle: "hidden",
          titleBarOverlay: {
            color: "#00000000",
            symbolColor: "#f4f4f5",
            height: 60,
          },
        }
      : {
          titleBarStyle: "default",
        };
  const window = new BrowserWindow({
    width: 1200,
    height: Math.min(900, availableHeight),
    minWidth: 760,
    minHeight: 520,
    backgroundColor: "#0d0d0d",
    autoHideMenuBar: !isMac,
    ...windowChromeOptions,
    show: false,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow = window;

  window.once("ready-to-show", () => {
    if (show && !window.isDestroyed()) window.show();
  });

  window.on("close", (event) => {
    // On macOS the window is destroyed while the tray process stays alive, so
    // reopening creates a fresh window on the current workspace.
    if (!isQuitting && !isMac) {
      event.preventDefault();
      window.hide();
    }
  });

  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  const devUrl = process.env.WAYPER_RENDERER_URL;
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(path.join(__dirname, "../renderer/index.html"));

  window.webContents.on("console-message", (details) => {
    if (details.level === "error" || details.level === "warning") {
      log.warn(`[renderer] ${details.message}`);
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: "deny" };
  });

  // The renderer is a single page; never let it navigate away.
  window.webContents.on("will-navigate", (event) => event.preventDefault());
}

function revealMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(true);
    return;
  }
  // Status-item clicks do not reliably activate the owning app on macOS.
  if (isMac) app.focus({ steal: true });
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function showMainWindow(): void {
  if (!startupFinished) {
    pendingShow = true;
    return;
  }
  revealMainWindow();
}

function openExternalUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
  void shell.openExternal(parsed.toString()).catch((error: Error) => {
    log.warn(`Could not open ${parsed.origin}: ${error.message}`);
  });
}

// ---------------------------------------------------------------------------
// Tray and menus
// ---------------------------------------------------------------------------

function trayLabels(language: string): Record<string, string> {
  const isChinese =
    language === "zh" || (language !== "en" && app.getLocale().toLowerCase().startsWith("zh"));
  return isChinese
    ? {
        show: "打开 Wayper",
        next: "下一张壁纸",
        pause: "暂停自动换壁纸",
        resume: "继续自动换壁纸",
        disabled: "自动换壁纸已关闭",
        quit: "退出 Wayper",
      }
    : {
        show: "Open Wayper",
        next: "Next Wallpaper",
        pause: "Pause Auto Rotation",
        resume: "Resume Auto Rotation",
        disabled: "Auto Rotation Off",
        quit: "Quit Wayper",
      };
}

function refreshTrayMenu(): void {
  if (!tray || tray.isDestroyed() || !service) return;
  let language = "auto";
  let state = { auto_rotation: false, rotation_paused: false };
  try {
    language = service.getConfig(false).language || "auto";
    state = service.rotationSnapshot();
  } catch (error) {
    log.warn("Could not refresh tray status", error);
  }
  const labels = trayLabels(language);
  const active = state.auto_rotation;
  const paused = state.rotation_paused;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: labels.show, click: showMainWindow },
      {
        label: labels.next,
        click: () => {
          void service?.controlAction("next").catch((error: Error) => {
            log.error(`Could not change wallpaper from tray: ${error.message}`);
          });
        },
      },
      { type: "separator" },
      {
        label: active ? labels.pause : paused ? labels.resume : labels.disabled,
        enabled: active || paused,
        click: () => {
          try {
            service?.setRotation(active ? "pause" : "resume");
          } catch (error) {
            log.error("Could not toggle automatic rotation", error);
          }
          refreshTrayMenu();
        },
      },
      { type: "separator" },
      {
        label: labels.quit,
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function releaseTray(): void {
  if (trayRefreshTimer) clearInterval(trayRefreshTimer);
  trayRefreshTimer = null;
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
}

function createTray(): void {
  if (tray && !tray.isDestroyed()) return;
  const icon = getTrayIcon();
  if (!icon) {
    log.error("Could not create system tray: Wayper icon is missing");
    return;
  }
  try {
    tray = new Tray(icon);
    tray.setToolTip("Wayper");
    tray.on("click", showMainWindow);
    refreshTrayMenu();
    trayRefreshTimer = setInterval(refreshTrayMenu, 30_000);
  } catch (error) {
    tray = null;
    log.error("Could not create system tray", error);
  }
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" } as MenuItemConstructorOptions] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Wayper Website", click: () => openExternalUrl(WEBSITE_URL) },
        { label: "Report Issue", click: () => openExternalUrl(ISSUES_URL) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Internal renderer capture (used by the screenshot skill)
// ---------------------------------------------------------------------------

async function settleRendererForCapture(webContents: WebContents): Promise<void> {
  await webContents.executeJavaScript(
    `
    (async () => {
      const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
      if (document.fonts && document.fonts.ready) {
        await Promise.race([document.fonts.ready, delay(1000)]);
      }
      const visibleImages = [...document.images].filter(image => {
        const rect = image.getBoundingClientRect();
        return rect.bottom > 0 && rect.right > 0
          && rect.top < window.innerHeight && rect.left < window.innerWidth;
      });
      await Promise.all(visibleImages.map(image => Promise.race([
        image.decode ? image.decode().catch(() => undefined) : Promise.resolve(),
        new Promise(resolve => setTimeout(resolve, 1500)),
      ])));
      await Promise.race([
        new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        delay(250),
      ]);
      return true;
    })()
  `,
    true,
  );
}

const CAPTURE_TIMEOUT_MS = 8000;

function withTimeout<T>(task: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function captureCurrentWindow(outputPath: string): Promise<void> {
  if (captureInProgress || !mainWindow || mainWindow.isDestroyed()) return;
  if (path.extname(outputPath).toLowerCase() !== ".png") {
    log.error(`Capture path must end in .png: ${outputPath}`);
    return;
  }
  const parent = path.dirname(outputPath);
  try {
    if (!fs.statSync(parent).isDirectory()) throw new Error("parent is not a directory");
  } catch (error) {
    log.error(`Capture directory is unavailable: ${parent}`, error);
    return;
  }

  captureInProgress = true;
  const webContents = mainWindow.webContents;
  let insertedCss: string | null = null;
  try {
    await settleRendererForCapture(webContents);
    insertedCss = await webContents.insertCSS(`
      *, *::before, *::after {
        animation-play-state: paused !important;
        transition: none !important;
        caret-color: transparent !important;
      }
    `);
    await settleRendererForCapture(webContents);
    // A window that was never shown has no surface to present, so asking
    // Chromium to make the page visible would never produce a frame.
    const stayHidden = !mainWindow.isVisible();
    const image = await withTimeout(
      webContents.capturePage(undefined, { stayHidden }),
      CAPTURE_TIMEOUT_MS,
      "Electron did not produce a frame in time (a window that was never shown cannot be captured)",
    );
    if (image.isEmpty()) throw new Error("Electron returned an empty image");
    await fs.promises.writeFile(outputPath, image.toPNG(), { flag: "wx" });
    log.info(`Captured renderer to ${outputPath}`);
  } catch (error) {
    log.error("Could not capture renderer", error);
  } finally {
    if (insertedCss) await webContents.removeInsertedCSS(insertedCss).catch(() => undefined);
    captureInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

type IpcEnvelope = { ok: true; value: unknown } | { ok: false; error: string };

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  return (
    mainWindow !== null &&
    !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame
  );
}

function handle(method: string, handler: (...args: any[]) => unknown): void {
  ipcMain.handle(`wayper:${method}`, async (event, ...args): Promise<IpcEnvelope> => {
    if (!isTrustedSender(event)) return { ok: false, error: "Untrusted Wayper request" };
    try {
      return { ok: true, value: (await handler(...args)) ?? null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof ServiceError)) log.error(`IPC ${method} failed`, error);
      return { ok: false, error: message };
    }
  });
}

async function interactiveWallhavenLogin(credentials: {
  username: string;
  password: string;
}): Promise<Awaited<ReturnType<typeof openInteractiveWallhavenLogin>>> {
  return openInteractiveWallhavenLogin({
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : null,
    configDir: getConfigDir(),
    prefillUsername: credentials.username,
    prefillPassword: credentials.password,
  });
}

function registerIpcHandlers(api: WayperService): void {
  handle("openExternal", (url: string) => openExternalUrl(String(url)));
  handle("selectDownloadDir", async () => {
    const options: Electron.OpenDialogOptions = {
      title: "Select Wallpaper Download Folder",
      properties: ["openDirectory", "createDirectory"],
    };
    const result =
      mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });
  handle("openWallhavenLogin", async () => {
    const config = api.getConfig(false);
    const result = await interactiveWallhavenLogin({
      username: config.wallhaven_username,
      password: config.wallhaven_password,
    });
    return result.ok
      ? { ok: true, username: result.username }
      : { ok: false, error: result.error ?? "Wallhaven sign-in did not complete" };
  });
  handle("checkTrashAccess", (filename: string) => api.checkTrashAccess(filename));

  handle("getConfig", () => api.getConfigPayload());
  handle("patchConfig", async (updates) => {
    const result = await api.patchConfig(updates);
    applyGlobalProxy(api.getConfig(false).proxy);
    return result;
  });
  handle("setMode", (purities) => api.setMode(purities));
  handle("getStatus", (params) => api.getStatus(params));
  handle("getDiskUsage", () => api.getDiskUsage());
  handle("getMonitors", () => api.getMonitors());
  handle("setRotation", (action) => api.setRotation(action));
  handle("controlAction", (action, options) => api.controlAction(action, options));
  handle("getImagesPage", (params) => api.getImagesPage(params));
  handle("getImageMetadata", (target) => api.getImageMetadata(target));
  handle("setWallpaper", (monitor, image) => api.setWallpaper(monitor, image));
  handle("setGreeter", (image) => api.setGreeter(image));
  handle("toggleFavorite", (image) => api.toggleFavorite(image));
  handle("banImage", (image, options) => api.banImage(image, options));
  handle("dislikeImage", (image) => api.dislikeImage(image));
  handle("restoreImage", (image) => api.restoreImage(image));
  handle("getBlocklist", () => api.getBlocklist());
  handle("removeBlocklistEntry", (filename) => api.removeBlocklistEntry(filename));
  handle("searchImages", (params) => api.searchImages(params));
  handle("getTagSuggestions", (contextTags) => api.getTagSuggestions(contextTags));
  handle("getUploaderSuggestions", () => api.getUploaderSuggestions());
  handle("getPreferenceSuggestions", (params) => api.getPreferenceSuggestions(params));
  handle("sendPreferenceFeedback", (target, action) => api.sendPreferenceFeedback(target, action));
  handle("getModelReview", (params) => api.getModelReview(params));
  handle("resolveModelReview", (target, action) => api.resolveModelReview(target, action));
  handle("clearModelReview", (params) => api.clearModelReview(params));
  handle("retrainModelNow", () => api.retrainModelNow());
  handle("checkUpdate", (force) => api.checkUpdate(Boolean(force)));
  handle("reconnectWallhaven", () => api.reconnectWallhaven());
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function startServices(): WayperService {
  setTrashHandler((target) => shell.trashItem(target));
  setUrlOpener((url) => shell.openExternal(url));
  setCliEntryPath(cliEntry);
  setInteractiveLoginHandler((config) =>
    interactiveWallhavenLogin({
      username: config.wallhaven_username,
      password: config.wallhaven_password,
    }),
  );

  heavyHost = createHeavyTaskHost(workerEntry);
  const autoRotation = new AutoRotationService({
    onEvent: (event) => {
      if (event === "rotated") broadcast({ type: "wallpaper" });
      else if (event === "library") broadcast({ type: "library" });
      else if (service) broadcast({ type: "rotation", ...service.rotationSnapshot() });
    },
  });
  rotation = autoRotation;
  const api = new WayperService({
    rotation: autoRotation,
    emit: broadcast,
    runHeavy: heavyHost.run,
    autostartCommand,
  });
  service = api;

  try {
    const config = api.getConfig(false);
    applyGlobalProxy(config.proxy);
    // Never rewrite the login registration from development or sandboxed runs.
    if (!isDev && !process.env.WAYPER_CONFIG_DIR) {
      ensureDefaultAutostart(loadConfig(undefined, { detectDisplays: false }), autostartCommand());
    }
  } catch (error) {
    log.warn("Could not apply startup configuration", error);
  }

  installWayperMediaProtocol(() => api.getConfig(false));
  registerIpcHandlers(api);
  autoRotation.start();
  api.startWatching();

  void startControlServer(resolveControlEndpoint(getConfigDir()), (request) =>
    api.handleControlRequest(request),
  )
    .then((server) => {
      if (isQuitting) void server.close();
      else controlServer = server;
    })
    .catch((error) => log.warn("Could not start the CLI control endpoint", error));

  const notifyMonitorsChanged = (): void => {
    invalidateMonitorCache();
    broadcast({ type: "monitors" });
  };
  screen.on("display-added", notifyMonitorsChanged);
  screen.on("display-removed", notifyMonitorsChanged);
  screen.on("display-metrics-changed", notifyMonitorsChanged);
  return api;
}

async function shutdownServices(): Promise<void> {
  service?.stopWatching();
  const closing: Array<Promise<unknown>> = [];
  if (rotation) closing.push(rotation.stop());
  if (controlServer) closing.push(controlServer.close());
  controlServer = null;
  const deadline = new Promise((resolve) => setTimeout(resolve, 3000));
  await Promise.race([Promise.allSettled(closing), deadline]);
  heavyHost?.shutdown();
  heavyHost = null;
}

function main(): void {
  if (process.platform === "win32") {
    // Keep development launches grouped under Wayper instead of electron.exe.
    app.setAppUserModelId(APP_ID);
  }

  const initialCapturePath = capturePathFromCommandLine(process.argv);
  const initiallyHidden = process.argv.includes(HIDDEN_SWITCH);
  // Carry the launcher's intent through the single-instance payload: some
  // Linux launchers strip arguments and macOS can report the resident
  // process command line instead of the second launcher's.
  const gotTheLock = app.requestSingleInstanceLock({
    capturePath: initialCapturePath,
    showWindow: !initiallyHidden && !initialCapturePath,
  });

  if (!gotTheLock) {
    app.quit();
    return;
  }
  if (initialCapturePath) {
    console.error("Internal capture requires an existing Wayper app instance");
    app.quit();
    return;
  }

  registerWayperSchemePrivileges();
  setupLogging({ console: isDev ? "info" : "warn" });

  app.on("second-instance", (_event, commandLine, _workingDirectory, additionalData) => {
    const data = (additionalData ?? {}) as { capturePath?: string | null; showWindow?: boolean };
    const capturePath = data.capturePath || capturePathFromCommandLine(commandLine);
    if (capturePath) {
      void captureCurrentWindow(capturePath);
      return;
    }
    if (data.showWindow === true || !commandLine.includes(HIDDEN_SWITCH)) showMainWindow();
  });

  void app.whenReady().then(() => {
    const iconPath = getAppIconPath();
    if (isMac && app.dock && iconPath) app.dock.setIcon(iconPath);
    buildMenu();
    try {
      startServices();
    } catch (error) {
      log.error("Wayper could not start", error);
      dialog.showErrorBox(
        "Wayper could not start",
        error instanceof Error ? error.message : String(error),
      );
      isQuitting = true;
      app.quit();
      return;
    }
    createTray();
    startupFinished = true;
    // A hidden launch still loads the renderer so capture and the first
    // reveal are instant.
    createWindow(!initiallyHidden || pendingShow);
    pendingShow = false;

    app.on("activate", showMainWindow);
  });

  app.on("before-quit", (event) => {
    isQuitting = true;
    if (shutdownComplete) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    void shutdownServices()
      .catch((error) => log.error("Shutdown did not complete cleanly", error))
      .finally(() => {
        shutdownComplete = true;
        releaseTray();
        // A second app.quit() stalls once the last window closes while the
        // tray keeps the app resident, so leave explicitly after cleanup.
        app.exit(0);
      });
  });

  app.on("will-quit", releaseTray);

  app.on("window-all-closed", () => {
    // Wayper stays available from the system tray until the user chooses Quit.
  });
}

const cliArgs = cliArguments(process.argv);
if (cliArgs) runCliAndExit(cliArgs);
else main();
