// 评论确认窗专用 preload：只暴露「拿信息」和「回结果」两件事
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dfyCmt", {
  info: () => ipcRenderer.invoke("dafeiyu-comment-info"),
  reply: (payload) => ipcRenderer.send("dafeiyu-comment-reply", payload || {}),
});
