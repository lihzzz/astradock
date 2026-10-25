const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("claude", {
  sessions: { historyPage: query => ipcRenderer.invoke("fixture:history", "page", query), historyChunk: query => ipcRenderer.invoke("fixture:history", "chunk", query) },
  analytics: { capture: () => {} },
});
