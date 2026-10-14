const { app, BrowserWindow, ipcMain, desktopCapturer, systemPreferences, shell, screen } = require('electron');
const path = require('path');

const isDev = !app.isPackaged;
const RENDERER_DEV_URL = 'http://localhost:5173';
const RENDERER_BUILD_PATH = path.join(__dirname, '../renderer/dist/index.html');

let mainWindow;
let overlayWindow = null;
let contentProtectionEnabled = true;
let buddyEnabled = false;
let buddyDisplayId = null;
let cursorTimer = null;
let lastCursor = null;
let lastBuddyUi = { listening: false, transcript: '' };
let mainHitRects = [];
let mainIgnoring = false;
let mainHitGraceUntil = 0;
let keysHot = false;
let keysGraceUntil = 0;

function captureSizeForDisplay(display) {
  const { width, height } = display.bounds;
  const scale = display.scaleFactor || 1;
  const physW = Math.max(1, Math.round(width * scale));
  const physH = Math.max(1, Math.round(height * scale));
  const maxW = 1600;
  if (physW <= maxW) return { width: physW, height: physH };
  return { width: maxW, height: Math.max(1, Math.round(maxW * (physH / physW))) };
}

function buddyDisplay() {
  const displays = screen.getAllDisplays();
  if (buddyDisplayId != null) {
    const locked = displays.find((d) => d.id === buddyDisplayId);
    if (locked) return locked;
  }
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || displays[0];
}

function buddyStatusPayload() {
  const display = buddyDisplay();
  return {
    enabled: buddyEnabled,
    displayId: display ? display.id : null,
    captureSize: display ? captureSizeForDisplay(display) : null,
  };
}

function pushBuddy(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (payload.type === 'listening') lastBuddyUi.listening = Boolean(payload.listening);
  if (payload.type === 'transcript') lastBuddyUi.transcript = String(payload.text || '');
  if (payload.type === 'reset') lastBuddyUi = { listening: false, transcript: '' };
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('buddy-event', payload);
  }
}

function broadcastBuddyEnabled() {
  const payload = buddyStatusPayload();
  for (const win of [mainWindow, overlayWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send('buddy-enabled', payload);
  }
}

function raiseOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.moveTop();
}

function setMainClickThrough(enabled) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (enabled) {
    // Clicks fall through except where the renderer marked a control strip.
    mainIgnoring = true;
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  } else {
    mainIgnoring = false;
    mainWindow.setIgnoreMouseEvents(false);
  }
}

function hitAt(point) {
  if (!mainWindow || mainWindow.isDestroyed() || mainHitRects.length === 0) return null;
  const bounds = mainWindow.getBounds();
  const x = point.x - bounds.x;
  const y = point.y - bounds.y;
  if (x < 0 || y < 0 || x > bounds.width || y > bounds.height) return null;
  const pad = 12;
  return mainHitRects.find((rect) =>
    x >= rect.x - pad && y >= rect.y - pad && x <= rect.x + rect.width + pad && y <= rect.y + rect.height + pad
  ) || null;
}

function syncMainClickThrough(point) {
  if (!buddyEnabled || !mainWindow || mainWindow.isDestroyed()) return;
  const hit = hitAt(point);
  if (hit) {
    mainHitGraceUntil = Date.now() + 320;
    if (mainIgnoring) {
      mainWindow.setIgnoreMouseEvents(false);
      mainIgnoring = false;
    }
  } else if (!mainIgnoring && Date.now() > mainHitGraceUntil) {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
    mainIgnoring = true;
  }

  const overKeys = hit?.id === 'keys';
  if (overKeys) {
    keysGraceUntil = Date.now() + 400;
    if (!keysHot) {
      keysHot = true;
      mainWindow.webContents.send('keys-hot', true);
    }
  } else if (keysHot && Date.now() > keysGraceUntil) {
    keysHot = false;
    mainWindow.webContents.send('keys-hot', false);
  }
}

function stopCursorFeed() {
  if (cursorTimer) clearInterval(cursorTimer);
  cursorTimer = null;
  lastCursor = null;
}

function startCursorFeed() {
  if (cursorTimer) return;
  cursorTimer = setInterval(() => {
    if (!buddyEnabled) return;
    const point = screen.getCursorScreenPoint();
    syncMainClickThrough(point);
    if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()) return;
    const bounds = overlayWindow.getBounds();
    const x = point.x - bounds.x;
    const y = point.y - bounds.y;
    const inside = x >= 0 && y >= 0 && x <= bounds.width && y <= bounds.height;
    if (lastCursor && lastCursor.x === x && lastCursor.y === y && lastCursor.inside === inside) return;
    lastCursor = { x, y, inside };
    overlayWindow.webContents.send('buddy-cursor', { x, y, inside });
  }, 16);
}

function createOverlay() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  buddyDisplayId = display.id;
  const { x, y, width, height } = display.bounds;

  overlayWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: true,
    skipTaskbar: true,
    show: false,
    roundedCorners: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Keep the guide itself out of screen capture so the model does not highlight the buddy.
  overlayWindow.setContentProtection(true);
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.webContents.setBackgroundThrottling(false);

  overlayWindow.once('ready-to-show', () => {
    if (!buddyEnabled || !overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.showInactive();
    raiseOverlay();
    startCursorFeed();
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
    stopCursorFeed();
  });

  if (isDev) {
    overlayWindow.loadURL(`${RENDERER_DEV_URL}?overlay=1`);
  } else {
    overlayWindow.loadFile(RENDERER_BUILD_PATH, { query: { overlay: '1' } });
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 440,
    height: 720,
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

  // The guide overlay must stay above this panel. Clicks still pass through it.
  const keepOverlayAbove = () => {
    if (buddyEnabled) raiseOverlay();
  };
  mainWindow.on('focus', keepOverlayAbove);
  mainWindow.on('move', keepOverlayAbove);

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
  let primary = sources[0];
  if (options.displayId != null) {
    const match = sources.find((source) => String(source.display_id) === String(options.displayId));
    if (match) primary = match;
  }
  if (!primary) throw new Error('No screen source found');
  return primary.thumbnail.toPNG().toString('base64');
});

ipcMain.handle('set-buddy-enabled', (_event, enabled) => {
  buddyEnabled = Boolean(enabled);
  setMainClickThrough(buddyEnabled);
  if (buddyEnabled) {
    startCursorFeed();
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    buddyDisplayId = display.id;
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      createOverlay();
    } else {
      overlayWindow.setBounds(display.bounds);
      overlayWindow.setIgnoreMouseEvents(true, { forward: true });
      if (!overlayWindow.isVisible()) overlayWindow.showInactive();
      raiseOverlay();
      startCursorFeed();
      pushBuddy({ type: 'reset' });
    }
  } else if (overlayWindow && !overlayWindow.isDestroyed()) {
    stopCursorFeed();
    pushBuddy({ type: 'reset' });
    overlayWindow.hide();
  }
  const payload = buddyStatusPayload();
  broadcastBuddyEnabled();
  return payload;
});

ipcMain.handle('set-overlay-ignore-mouse', (event, ignore) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return false;
  if (event.sender !== overlayWindow.webContents) return false;
  if (ignore) overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  else overlayWindow.setIgnoreMouseEvents(false);
  return true;
});

ipcMain.handle('buddy-push', (_event, payload) => {
  pushBuddy(payload);
  return true;
});

ipcMain.handle('buddy-hello', () => ({ ...lastBuddyUi }));

ipcMain.handle('set-main-hit-rects', (event, rects) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  mainHitRects = Array.isArray(rects)
    ? rects
        .map((rect) => ({
          id: String(rect?.id || ''),
          x: Number(rect?.x) || 0,
          y: Number(rect?.y) || 0,
          width: Number(rect?.width) || 0,
          height: Number(rect?.height) || 0,
        }))
        .filter((rect) => rect.width > 0 && rect.height > 0)
    : [];
  return true;
});

ipcMain.handle('window-minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});

ipcMain.handle('window-toggle-fullscreen', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const next = !mainWindow.isFullScreen();
  mainWindow.setFullScreen(next);
  return next;
});

ipcMain.handle('window-close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});

app.whenReady().then(() => {
  createWindow();
  screen.on('display-metrics-changed', () => {
    if (!buddyEnabled || !overlayWindow || overlayWindow.isDestroyed() || buddyDisplayId == null) return;
    const display = screen.getAllDisplays().find((d) => d.id === buddyDisplayId);
    if (display) overlayWindow.setBounds(display.bounds);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
