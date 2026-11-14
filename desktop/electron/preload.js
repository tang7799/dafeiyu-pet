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
  setCmdConfirm: (v) => ipcRenderer.invoke("dafeiyu-pc-cmd-confirm", v),
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
  // 聊天指令动作：模型调 pet_act 工具后转发到这里
  onPetAct: (cb) => ipcRenderer.on("dafeiyu-pet-act", (_e, name) => cb(name)),
  // 自学动作：模型调 pet_teach 工具后转发到这里，学完把结果回传主进程
  onPetTeach: (cb) => ipcRenderer.on("dafeiyu-pet-teach", (_e, spec) => cb(spec)),
  teachResult: (res) => ipcRenderer.send("dafeiyu-pet-teach-result", res),
  // 创作室：make_video 让本窗口的隐藏 canvas 录制；录完经 videoResult 回执，saveVideo 落盘
  onVideoRecord: (cb) => ipcRenderer.on("dafeiyu-video-record", (_e, spec) => cb(spec)),
  videoResult: (res) => ipcRenderer.send("dafeiyu-video-result", res),
  saveVideo: (buf, ext) => ipcRenderer.invoke("dafeiyu-video-save", buf, ext),
  // CPU 占用率（每 10 秒推送 + 主动查当前值）
  onCpu: (cb) => ipcRenderer.on("dafeiyu-cpu", (_e, pct) => cb(pct)),
  cpuNow: () => ipcRenderer.invoke("dafeiyu-cpu-now"),
  // 版本 / 开发者 / 版权
  appInfo: () => ipcRenderer.invoke("dafeiyu-app-info"),
  /* 大脑（对话模型） */
  brainGet: () => ipcRenderer.invoke("dafeiyu-brain-get"),
  brainSet: (id) => ipcRenderer.invoke("dafeiyu-brain-set", id),
  brainModels: (list) => ipcRenderer.invoke("dafeiyu-brain-models", list),
  onBrainChanged: (cb) => ipcRenderer.on("dafeiyu-brain-changed", (_e, p) => cb(p)),
  /* 自定义大脑（OpenAI 兼容接口，主进程代发请求） */
  brainCustomGet: () => ipcRenderer.invoke("dafeiyu-brain-custom-get"),
  brainCustomSet: (cfg) => ipcRenderer.invoke("dafeiyu-brain-custom-set", cfg),
  customChatStart: (p) => ipcRenderer.invoke("dafeiyu-custom-chat-start", p),
  customChatAbort: (reqId) => ipcRenderer.send("dafeiyu-custom-chat-abort", reqId),
  onCustomChunk: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on("dafeiyu-custom-chunk", h);
    return () => ipcRenderer.removeListener("dafeiyu-custom-chunk", h);
  },
});
