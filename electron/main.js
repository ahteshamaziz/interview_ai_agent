const { app, BrowserWindow, ipcMain, desktopCapturer, systemPreferences, shell } = require('electron');
const path = require('path');

const isDev = !app.isPackaged;
const RENDERER_DEV_URL = 'http://localhost:5173';
const RENDERER_BUILD_PATH = path.join(__dirname, '../renderer/dist/index.html');

let mainWindow;
let contentProtectionEnabled = true;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 640,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Excludes this window's pixels from screen capture/recording (macOS: NSWindowSharingNone, Windows: WDA_EXCLUDEFROMCAPTURE)
  contentProtectionEnabled = true;
  mainWindow.setContentProtection(true);

  // Keep it floating above other windows, including over fullscreen apps on macOS
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  if (isDev) {
    mainWindow.loadURL(RENDERER_DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(RENDERER_BUILD_PATH);
  }
}

ipcMain.handle('get-content-protection', () => contentProtectionEnabled);

ipcMain.handle('set-content-protection', (_event, enabled) => {
  if (!mainWindow) return contentProtectionEnabled;
  contentProtectionEnabled = Boolean(enabled);
  mainWindow.setContentProtection(contentProtectionEnabled);
  return contentProtectionEnabled;
});

ipcMain.handle('move-window', (_event, deltaX, deltaY) => {
  if (!mainWindow) return null;
  const dx = Number(deltaX) || 0;
  const dy = Number(deltaY) || 0;
  const [x, y] = mainWindow.getPosition();
  mainWindow.setPosition(x + dx, y + dy, false);
  return mainWindow.getPosition();
});

ipcMain.handle('capture-screen', async (_event, options = {}) => {
  // On macOS, check screen recording permission before attempting capture
  if (process.platform === 'darwin') {
    const status = systemPreferences.getMediaAccessStatus('screen');
    if (status !== 'granted') {
      // Opening System Preferences prompts the user to grant access
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      throw new Error(`Screen recording permission is "${status}". Please grant access in System Preferences → Privacy & Security → Screen Recording, then restart the app.`);
    }
  }

  const width = Number(options?.width) || 1920;
  const height = Number(options?.height) || 1080;

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height },
  });
  const primary = sources[0];
  if (!primary) throw new Error('No screen source found');
  return primary.thumbnail.toPNG().toString('base64');
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
