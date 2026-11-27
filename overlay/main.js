// Cuelensa desktop overlay follows the live call.
// It is excluded from screen capture (Windows 10 2004+: SetWindowDisplayAffinity WDA_EXCLUDEFROMCAPTURE via
// setContentProtection), so it stays on your screen but does not appear when you share your screen in
// Zoom, Google Meet or Teams, or in recordings and screenshots.
const { app, BrowserWindow, dialog, globalShortcut, screen, shell, Tray, Menu, nativeImage, ipcMain, utilityProcess } = require("electron");
const { existsSync } = require("node:fs");
const path = require("node:path");

const desktop = process.argv.includes("--desktop") || app.isPackaged;
const root = path.resolve(__dirname, "..");
let server = (process.env.MIA_SERVER_URL || "http://localhost:4000").replace(/\/$/, "");
const PROTECT = process.env.MIA_OVERLAY_PROTECT !== "0"; // set to 0 only to debug what a screen share would see
const KEYS = { toggle: "CommandOrControl+Shift+M", clickThrough: "CommandOrControl+Shift+L" };

let win = null;
let workspace = null;
let service = null;
let overlaySession = "";
let quitting = false;
let tray = null;
let clickThrough = false;

function restrictNavigation(window) {
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== new URL(server).origin) event.preventDefault();
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env, PORT: process.env.MIA_DESKTOP_PORT || "4040",
      MIA_DATA_DIR: process.env.MIA_DESKTOP_DATA_DIR || path.join(app.getPath("userData"), "workspace"),
      MIA_LISTEN_HOST: "127.0.0.1", MIA_DESKTOP: "1",
      MIA_CALLBACK_PORT: process.env.MIA_CALLBACK_PORT || "0",
    };
    service = utilityProcess.fork(path.join(root, "server.js"), [], { cwd: root, env, serviceName: "Cuelensa Local Service" });
    const timeout = setTimeout(() => reject(new Error("The local service did not start in time.")), 12000);
    service.once("message", ({ port }) => {
      clearTimeout(timeout);
      server = `http://127.0.0.1:${port}`;
      resolve();
    });
    service.once("exit", (code) => {
      clearTimeout(timeout);
      if (workspace && !quitting) {
        dialog.showErrorBox("Cuelensa service stopped", "Reopen Cuelensa to recover the saved workspace.");
        app.quit();
      } else reject(new Error(`The local service stopped with exit code ${code}. Check whether port ${env.PORT} is already in use.`));
    });
  });
}

function showWorkspace() { workspace.show(); workspace.focus(); }
function createWorkspace() {
  workspace = new BrowserWindow({
    title: "Cuelensa", width: 1280, height: 850, minWidth: 800, minHeight: 540, show: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "workspace-preload.js"), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  restrictNavigation(workspace);
  workspace.webContents.setWindowOpenHandler(({ url }) => {
    const target = new URL(url);
    if (target.origin === new URL(server).origin && target.pathname === "/overlay/") {
      showSessionOverlay(target.searchParams.get("session")).catch(() => {});
    } else if (target.protocol === "https:" && !target.username && !target.password) {
      shell.openExternal(target.href).catch(() => {});
    }
    return { action: "deny" };
  });
  workspace.once("ready-to-show", showWorkspace);
  workspace.on("close", (event) => {
    if (!quitting) { event.preventDefault(); workspace.hide(); }
  });
  workspace.loadURL(server).catch((error) => {
    dialog.showErrorBox("Could not open the workspace", error.message);
    app.quit();
  });
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 380;
  const height = Math.min(420, workArea.height - 40);
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
  restrictNavigation(win);
  win.setAlwaysOnTop(true, "screen-saver"); // above full-screen meeting windows
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (!desktop) win.once("ready-to-show", () => win.showInactive());
  // Windows only honours the capture exclusion on a window that exists on screen, so (re)apply it whenever it shows.
  win.on("show", () => win.setContentProtection(PROTECT));

  const load = () => { if (!win.isDestroyed()) win.loadURL(overlayUrl()).catch(() => {}); };
  win.webContents.on("did-fail-load", (_e, _code, _desc, _url, isMainFrame) => {
    if (!isMainFrame) return;
    win.loadFile(path.join(__dirname, "offline.html"), { query: { server } }).catch(() => {});
    setTimeout(load, 3000); // keep trying until the MIA server is up
  });
  load();
}

const overlayUrl = () => `${server}/overlay/${overlaySession ? `?session=${encodeURIComponent(overlaySession)}` : ""}`;

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
    ...(desktop ? [{ label: "Open workspace", click: showWorkspace }] : []),
    { label: win?.isVisible() ? "Hide overlay" : "Show overlay", accelerator: KEYS.toggle, click: toggleVisible },
    { label: "Click-through", type: "checkbox", checked: clickThrough, accelerator: KEYS.clickThrough, click: () => setClickThrough(!clickThrough) },
    { type: "separator" },
    { label: PROTECT ? "Screen capture protection on" : "Screen capture protection off", enabled: false },
    { label: desktop ? "Quit Cuelensa" : "Quit Cuelensa overlay", click: quit },
  ]));
}

function createTray() {
  // 16x16 mint dot, drawn in code so the overlay ships with no image files.
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - 7.5, y - 7.5);
    const i = (y * size + x) * 4;
    if (d < 7) { buf[i] = 0xd0; buf[i + 1] = 0xef; buf[i + 2] = 0xa9; buf[i + 3] = 255; } // BGRA
  }
  tray = new Tray(nativeImage.createFromBitmap(buf, { width: size, height: size }));
  tray.setToolTip("Cuelensa overlay");
  tray.on("click", desktop ? showWorkspace : toggleVisible);
  rebuildTray();
}

const validSession = id => typeof id === "string" && /^mtg_[a-f0-9]{10}$/.test(id);
const trusted = (event, window) => event.sender === window?.webContents && event.senderFrame?.url &&
  new URL(event.senderFrame.url).origin === new URL(server).origin;
ipcMain.on("overlay:hide", event => { if (trusted(event, win)) { win.hide(); rebuildTray(); } });
ipcMain.on("overlay:click-through", (event, on) => { if (trusted(event, win)) setClickThrough(Boolean(on)); });
ipcMain.on("overlay:opacity", (event, v) => {
  if (trusted(event, win)) win.setOpacity(Math.min(1, Math.max(0.35, Number(v) || 1)));
});
ipcMain.handle("overlay:info", event => trusted(event, win) ? { protected: PROTECT, keys: KEYS } : null);
ipcMain.handle("overlay:open-cue", async (event, sessionId, cueId) => {
  if (!trusted(event, win) || !validSession(sessionId) || typeof cueId !== "string" || !/^sug_[a-f0-9]{10}$/.test(cueId)) return;
  const target = new URL("/", server);
  target.search = new URLSearchParams({ session: sessionId, cue: cueId });
  if (workspace) {
    await workspace.loadURL(target.href);
    showWorkspace();
  } else await shell.openExternal(target.href);
});
async function showSessionOverlay(sessionId) {
  if (!validSession(sessionId)) return;
  if (sessionId !== overlaySession) {
    overlaySession = sessionId;
    await win.loadURL(overlayUrl());
  }
  if (!win.isVisible()) toggleVisible();
}
ipcMain.handle("workspace:show-overlay", (event, sessionId) => {
  if (trusted(event, workspace)) return showSessionOverlay(sessionId);
});
async function quit() {
  if (desktop) {
    const active = await fetch(`${server}/api/workspace`).then((r) => r.json()).then((data) => data.active.length).catch(() => 0);
    if (active) {
      showWorkspace();
      await dialog.showMessageBox(workspace, { message: "End your calls before quitting", detail: "Open Workspace to resume a call and save its report." });
      return;
    }
  }
  app.quit();
}

if (desktop) {
  const legacyProfile = path.join(app.getPath("appData"), "ClientLuma");
  app.setName("Cuelensa");
  if (!process.env.MIA_DESKTOP_DATA_DIR && existsSync(path.join(legacyProfile, "workspace")) && !existsSync(path.join(app.getPath("userData"), "workspace"))) {
    app.setPath("userData", legacyProfile);
  }
  if (!app.requestSingleInstanceLock()) app.exit(0);
  app.on("second-instance", () => { if (workspace) showWorkspace(); });
}
app.whenReady().then(async () => {
  if (desktop) await startServer();
  createWindow();
  if (desktop) createWorkspace();
  createTray();
  globalShortcut.register(KEYS.toggle, toggleVisible);
  globalShortcut.register(KEYS.clickThrough, () => setClickThrough(!clickThrough));
}).catch((error) => {
  dialog.showErrorBox("Could not start Cuelensa", error.message);
  app.quit();
});
app.on("before-quit", () => { quitting = true; });
app.on("will-quit", () => { globalShortcut.unregisterAll(); service?.kill(); });
app.on("window-all-closed", () => app.quit());
