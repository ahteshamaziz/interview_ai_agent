const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appConfig', {
  backendWsUrl: 'ws://localhost:8787/ws',
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  getContentProtection: () => ipcRenderer.invoke('get-content-protection'),
  setContentProtection: (enabled) => ipcRenderer.invoke('set-content-protection', enabled),
  moveWindow: (dx, dy) => ipcRenderer.invoke('move-window', dx, dy),
});
