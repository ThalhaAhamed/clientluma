// ClientLuma desktop overlay follows the live call.
// It is excluded from screen capture (Windows 10 2004+: SetWindowDisplayAffinity WDA_EXCLUDEFROMCAPTURE via
// setContentProtection), so it stays on your screen but does not appear when you share your screen in
// Zoom, Google Meet or Teams, or in recordings and screenshots.
const { app, BrowserWindow, globalShortcut, screen, Tray, Menu, nativeImage, ipcMain } = require("electron");
const path = require("node:path");

const SERVER = (process.env.MIA_SERVER_URL || "http://localhost:4000").replace(/\/$/, "");
const PROTECT = process.env.MIA_OVERLAY_PROTECT !== "0"; // set to 0 only to debug what a screen share would see
const KEYS = { toggle: "CommandOrControl+Shift+M", clickThrough: "CommandOrControl+Shift+L" };

let win = null;
let tray = null;
let clickThrough = false;

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 380;
  const height = Math.min(640, workArea.height - 40);
  win = new BrowserWindow({
    width, height,
    x: workArea.x + workArea.width - width - 20,
    y: workArea.y + 20,
    minWidth: 300, minHeight: 240,
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: true, // stays out of the taskbar (which would show in a full-screen share); use the tray icon
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setContentProtection(PROTECT);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== new URL(SERVER).origin) event.preventDefault();
  });
  win.setAlwaysOnTop(true, "screen-saver"); // above full-screen meeting windows
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.once("ready-to-show", () => win.showInactive()); // don't steal focus from the meeting
  // Windows only honours the capture exclusion on a window that exists on screen, so (re)apply it whenever it shows.
  win.on("show", () => win.setContentProtection(PROTECT));

  const load = () => win.loadURL(`${SERVER}/overlay/`).catch(() => {});
  win.webContents.on("did-fail-load", (_e, _code, _desc, _url, isMainFrame) => {
    if (!isMainFrame) return;
    win.loadFile(path.join(__dirname, "offline.html"), { query: { server: SERVER } });
    setTimeout(load, 3000); // keep trying until the MIA server is up
  });
  load();
}

function setClickThrough(on) {
  clickThrough = on;
  win.setIgnoreMouseEvents(on, { forward: true });
  win.webContents.send("click-through", on);
  rebuildTray();
}

function toggleVisible() {
  if (win.isVisible()) win.hide();
  else win.showInactive();
  rebuildTray();
}

function rebuildTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: win?.isVisible() ? "Hide overlay" : "Show overlay", accelerator: KEYS.toggle, click: toggleVisible },
    { label: "Click-through", type: "checkbox", checked: clickThrough, accelerator: KEYS.clickThrough, click: () => setClickThrough(!clickThrough) },
    { type: "separator" },
    { label: PROTECT ? "Hidden from screen sharing" : "VISIBLE to screen sharing (debug)", enabled: false },
    { label: "Quit ClientLuma overlay", click: () => app.quit() },
  ]));
}

function createTray() {
  // 16x16 teal dot, drawn in code so the overlay ships with no image files.
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - 7.5, y - 7.5);
    const i = (y * size + x) * 4;
    if (d < 7) { buf[i] = 0x6e; buf[i + 1] = 0x76; buf[i + 2] = 0x0f; buf[i + 3] = 255; } // BGRA
  }
  tray = new Tray(nativeImage.createFromBitmap(buf, { width: size, height: size }));
  tray.setToolTip("ClientLuma overlay");
  tray.on("click", toggleVisible);
  rebuildTray();
}

ipcMain.on("overlay:hide", () => { win.hide(); rebuildTray(); });
ipcMain.on("overlay:click-through", (_e, on) => setClickThrough(Boolean(on)));
ipcMain.on("overlay:opacity", (_e, v) => win.setOpacity(Math.min(1, Math.max(0.35, Number(v) || 1))));
ipcMain.handle("overlay:info", () => ({ protected: PROTECT, keys: KEYS, server: SERVER }));

app.whenReady().then(() => {
  createWindow();
  createTray();
  globalShortcut.register(KEYS.toggle, toggleVisible);
  globalShortcut.register(KEYS.clickThrough, () => setClickThrough(!clickThrough));
});
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
