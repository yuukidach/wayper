// Preload script — use contextBridge here to expose APIs to the renderer.
const { contextBridge, clipboard, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  copyToClipboard: (text) => clipboard.writeText(text),
  getApiPort: () => ipcRenderer.invoke('get-api-port'),
});
