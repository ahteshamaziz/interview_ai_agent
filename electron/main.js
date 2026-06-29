const { app, BrowserWindow } = require('electron');
const path = require('path');

const isDev = !app.isPackaged;
const RENDERER_DEV_URL = 'http://localhost:5173';
const RENDERER_BUILD_PATH = path.join(__dirname, '../renderer/dist/index.html');

function createWindow() {
  const win = new BrowserWindow({
    width: 420,
    height: 640,
    alwaysOnTop: true,
    frame: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Excludes this window's pixels from screen capture/recording (macOS: NSWindowSharingNone, Windows: WDA_EXCLUDEFROMCAPTURE)
  win.setContentProtection(true);

  // Keep it floating above other windows, including over fullscreen apps on macOS
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  if (isDev) {
    win.loadURL(RENDERER_DEV_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(RENDERER_BUILD_PATH);
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
