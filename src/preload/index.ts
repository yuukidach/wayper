import { clipboard, contextBridge, ipcRenderer } from "electron";
import type {
  ConfigPatchPayload,
  Purity,
  WayperBridge,
  WayperPushEvent,
} from "../shared/types";

interface IpcEnvelope {
  ok: boolean;
  value?: unknown;
  error?: string;
}

async function invoke<T>(method: string, ...args: unknown[]): Promise<T> {
  const envelope = (await ipcRenderer.invoke(`wayper:${method}`, ...args)) as IpcEnvelope;
  if (!envelope || envelope.ok !== true) {
    throw new Error(envelope?.error || `Wayper request failed: ${method}`);
  }
  return envelope.value as T;
}

const bridge: WayperBridge = {
  platform: process.platform,
  copyToClipboard: (text: string) => {
    clipboard.writeText(text);
  },
  openExternal: (url: string) => invoke("openExternal", url),
  selectDownloadDir: () => invoke("selectDownloadDir"),
  openWallhavenLogin: () => invoke("openWallhavenLogin"),
  checkTrashAccess: (filename: string) => invoke("checkTrashAccess", filename),
  onEvent: (listener: (event: WayperPushEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: WayperPushEvent) => {
      listener(payload);
    };
    ipcRenderer.on("wayper:event", wrapped);
    return () => {
      ipcRenderer.removeListener("wayper:event", wrapped);
    };
  },

  getConfig: () => invoke("getConfig"),
  patchConfig: (updates: ConfigPatchPayload) => invoke("patchConfig", updates),
  setMode: (purities: Purity[]) => invoke("setMode", purities),
  getStatus: (params) => invoke("getStatus", params ?? {}),
  getDiskUsage: () => invoke("getDiskUsage"),
  getMonitors: () => invoke("getMonitors"),
  setRotation: (action) => invoke("setRotation", action),
  controlAction: (action, options) => invoke("controlAction", action, options ?? {}),
  getImagesPage: (params) => invoke("getImagesPage", params),
  getImageMetadata: (filenameOrPath) => invoke("getImageMetadata", filenameOrPath),
  setWallpaper: (monitor, imagePath) => invoke("setWallpaper", monitor, imagePath),
  setGreeter: (imagePath) => invoke("setGreeter", imagePath),
  toggleFavorite: (imagePath) => invoke("toggleFavorite", imagePath),
  banImage: (imagePath, options) => invoke("banImage", imagePath, options ?? {}),
  dislikeImage: (imagePath, options) => invoke("dislikeImage", imagePath, options ?? {}),
  restoreImage: (imagePath) => invoke("restoreImage", imagePath),
  getBlocklist: () => invoke("getBlocklist"),
  removeBlocklistEntry: (filename) => invoke("removeBlocklistEntry", filename),
  searchImages: (params) => invoke("searchImages", params),
  getTagSuggestions: (contextTags) => invoke("getTagSuggestions", contextTags),
  getUploaderSuggestions: () => invoke("getUploaderSuggestions"),
  getPreferenceSuggestions: (params) => invoke("getPreferenceSuggestions", params),
  sendPreferenceFeedback: (path, action) =>
    invoke("sendPreferenceFeedback", path, action),
  getModelReview: (params) => invoke("getModelReview", params),
  resolveModelReview: (path, action) => invoke("resolveModelReview", path, action),
  clearModelReview: (params) => invoke("clearModelReview", params),
  retrainModelNow: () => invoke("retrainModelNow"),
  checkUpdate: (force) => invoke("checkUpdate", Boolean(force)),
  reconnectWallhaven: () => invoke("reconnectWallhaven"),
};

contextBridge.exposeInMainWorld("wayper", bridge);
