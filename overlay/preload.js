// Bridge between the overlay page (served by the MIA server) and the Electron window controls.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("miaOverlay", {
  hide: () => ipcRenderer.send("overlay:hide"),
  setClickThrough: (on) => ipcRenderer.send("overlay:click-through", on),
  setOpacity: (v) => ipcRenderer.send("overlay:opacity", v),
  info: () => ipcRenderer.invoke("overlay:info"),
  openCue: (sessionId, cueId) => ipcRenderer.invoke("overlay:open-cue", sessionId, cueId),
  onClickThrough: (fn) => ipcRenderer.on("click-through", (_e, on) => fn(on)),
});
