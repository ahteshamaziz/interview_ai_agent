const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appConfig', {
  backendWsUrl: 'ws://localhost:8787/ws',
  captureScreen: (options) => ipcRenderer.invoke('capture-screen', options),
  getContentProtection: () => ipcRenderer.invoke('get-content-protection'),
  setContentProtection: (enabled) => ipcRenderer.invoke('set-content-protection', enabled),
  moveWindow: (dx, dy) => ipcRenderer.invoke('move-window', dx, dy),
});
