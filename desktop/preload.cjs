const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fluxsave", {
  analyze: (url) => ipcRenderer.invoke("analyze", url),
  chooseFolder: () => ipcRenderer.invoke("choose-folder"),
  download: (job) => ipcRenderer.invoke("download", job),
  showFile: (filePath) => ipcRenderer.invoke("show-file", filePath),
  cancel: (jobId) => ipcRenderer.send("cancel-download", jobId),
  onProgress: (callback) => ipcRenderer.on("download-progress", (_event, value) => callback(value)),
  onEngineStatus: (callback) => ipcRenderer.on("engine-status", (_event, value) => callback(value))
});
