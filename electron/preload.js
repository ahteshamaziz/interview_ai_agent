const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('appConfig', {
  backendWsUrl: 'ws://localhost:8787/ws',
});
