// Built to build/preload-popover.cjs. Exposes the minimal IPC surface the
// popover UI needs — no Node access in the renderer.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('librepool', {
  snapshot: () => ipcRenderer.invoke('librepool:snapshot'),
  openDashboard: () => ipcRenderer.invoke('librepool:open-dashboard'),
  copyBaseUrl: () => ipcRenderer.invoke('librepool:copy-base-url'),
  copyApiKey: () => ipcRenderer.invoke('librepool:copy-api-key'),
  setLoginItem: (open: boolean) => ipcRenderer.invoke('librepool:set-login-item', open),
  quit: () => ipcRenderer.invoke('librepool:quit'),
  onRefresh: (cb: () => void) => ipcRenderer.on('librepool:refresh', cb),
});
