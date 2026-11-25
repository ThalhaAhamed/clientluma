const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clientLuma", {
  showOverlay: (sessionId) => ipcRenderer.invoke("workspace:show-overlay", sessionId),
  chooseReplay: () => ipcRenderer.invoke("workspace:choose-replay"),
});
