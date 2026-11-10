const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dafeiyu", {
  move: (x, y) => ipcRenderer.send("dafeiyu-move", x, y),
  resize: (w, h) => ipcRenderer.send("dafeiyu-resize", w, h),
  ignoreMouse: (ignore, opts) => ipcRenderer.send("dafeiyu-ignore-mouse", ignore, opts),
  setTopmost: (v) => ipcRenderer.send("dafeiyu-topmost", v),
  getStartup: () => ipcRenderer.invoke("dafeiyu-get-startup"),
  toggleStartup: (enable) => ipcRenderer.invoke("dafeiyu-toggle-startup", enable),
  onExternalState: (cb) => ipcRenderer.on("dafeiyu-external-state", (_e, payload) => cb(payload)),
  // 独立聊天窗口
  openChat: () => ipcRenderer.send("dafeiyu-open-chat"),
  chatState: (st) => ipcRenderer.send("dafeiyu-chat-state", st),
  onChatState: (cb) => ipcRenderer.on("dafeiyu-chat-state", (_e, st) => cb(st)),
  // 电脑操作能力
  pcStatus: () => ipcRenderer.invoke("dafeiyu-pc-status"),
  setPcPerm: (v) => ipcRenderer.invoke("dafeiyu-pc-perm", v),
  pc: (name, args) => ipcRenderer.invoke("dafeiyu-pc", name, args),
  weather: () => ipcRenderer.invoke("dafeiyu-weather"),
  // 系统空闲秒数（番茄钟用）
  sysIdle: () => ipcRenderer.invoke("dafeiyu-sys-idle"),
  onPcChanged: (cb) => ipcRenderer.on("dafeiyu-pc-changed", (_e, v) => cb(v)),
  // 看视频的实时进度
  onWatchProgress: (cb) => ipcRenderer.on("dafeiyu-watch-progress", (_e, p) => cb(p)),
  // 定时任务提醒
  onTaskFire: (cb) => ipcRenderer.on("dafeiyu-task-fire", (_e, task) => cb(task)),
  // 自主冲浪：开关状态、立即来一轮、桌宠事件（EVENT:xxx）
  surfState: () => ipcRenderer.invoke("dafeiyu-surf-state"),
  surfToggle: (on) => ipcRenderer.invoke("dafeiyu-surf-toggle", on),
  surfNow: () => ipcRenderer.send("dafeiyu-surf-now"),
  surfEvent: (ev) => ipcRenderer.send("dafeiyu-surf-event", ev),
  onSurfEvent: (cb) => ipcRenderer.on("dafeiyu-surf-event", (_e, ev) => cb(ev)),
  commentPerm: (on) => ipcRenderer.invoke("dafeiyu-comment-perm", on),
  // 版本 / 开发者 / 版权
  appInfo: () => ipcRenderer.invoke("dafeiyu-app-info"),
});
