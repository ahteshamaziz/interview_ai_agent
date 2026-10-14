const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appConfig', {
  backendWsUrl: 'ws://localhost:8787/ws',
  captureScreen: (options) => ipcRenderer.invoke('capture-screen', options),
  getContentProtection: () => ipcRenderer.invoke('get-content-protection'),
  setContentProtection: (enabled) => ipcRenderer.invoke('set-content-protection', enabled),
  moveWindow: (dx, dy) => ipcRenderer.invoke('move-window', dx, dy),
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowToggleFullscreen: () => ipcRenderer.invoke('window-toggle-fullscreen'),
  windowClose: () => ipcRenderer.invoke('window-close'),
  setMainHitRects: (rects) => ipcRenderer.invoke('set-main-hit-rects', rects),
  setBuddyEnabled: (enabled) => ipcRenderer.invoke('set-buddy-enabled', enabled),
  setOverlayIgnoreMouse: (ignore) => ipcRenderer.invoke('set-overlay-ignore-mouse', ignore),
  pushBuddyEvent: (payload) => ipcRenderer.invoke('buddy-push', payload),
  buddyHello: () => ipcRenderer.invoke('buddy-hello'),
  onBuddyCursor: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('buddy-cursor', listener);
    return () => ipcRenderer.removeListener('buddy-cursor', listener);
  },
  onBuddyEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('buddy-event', listener);
    return () => ipcRenderer.removeListener('buddy-event', listener);
  },
  onBuddyEnabled: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('buddy-enabled', listener);
    return () => ipcRenderer.removeListener('buddy-enabled', listener);
  },
  onKeysHot: (callback) => {
    const listener = (_event, hot) => callback(hot);
    ipcRenderer.on('keys-hot', listener);
    return () => ipcRenderer.removeListener('keys-hot', listener);
  },
});
