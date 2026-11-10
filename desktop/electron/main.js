// 大肥鱼桌宠 · Electron 主进程
// 透明无边框置顶窗口 + 监听 WorkBuddy 技能写入的状态文件
const { app, BrowserWindow, ipcMain, screen, powerMonitor } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");

const STATE_PATH = path.join(os.homedir(), ".workbuddy", "dafeiyu-state.json");
const LOG_PATH = path.join(os.homedir(), ".workbuddy", "dafeiyu-pet.log");

function log(...args) {
  try {
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${args.join(" ")}\n`);
  } catch (e) { /* ignore */ }
}

/* 主进程异常兜底：记日志继续跑，不再弹 "A JavaScript error occurred" 崩溃框 */
process.on("uncaughtException", (e) => {
  log("主进程异常已兜底:", (e && e.stack) || String(e));
});

let win = null;
let chatWin = null;
let watcher = null;
let lastPayload = null;

const surf = require("./surf.js");     // 自主冲浪：记忆 / 评论权限 / 轮次与夜间策略
const pc = require("./pc.js");         // 电脑操作 + 定时任务引擎

/* ---- 版权与开发者：唯一事实来源，渲染进程通过 IPC 取用 ----
   统一文案：Copyright © 2026 Dudu Studio. All Rights Reserved. */
const APP_INFO = {
  name: "大肥鱼桌宠",
  version: app.getVersion(),
  developer: "Dudu Studio",
  copyright: "Copyright © 2026 Dudu Studio. All Rights Reserved.",
};
ipcMain.handle("dafeiyu-app-info", () => APP_INFO);

// 聊天窗口位置记忆
const CHAT_POS_PATH = path.join(os.homedir(), ".workbuddy", "dafeiyu-chat-pos.json");

function createChatWindow() {
  if (chatWin && !chatWin.isDestroyed()) { chatWin.show(); chatWin.focus(); return; }
  let pos = null;
  try { pos = JSON.parse(fs.readFileSync(CHAT_POS_PATH, "utf8")); } catch (e) { /* 首次打开 */ }
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workArea;
  chatWin = new BrowserWindow({
    width: 360,
    height: 470,
    x: pos && Number.isFinite(pos.x) ? pos.x : Math.round(sw / 2 + 120),
    y: pos && Number.isFinite(pos.y) ? pos.y : Math.round(sh - 520),
    minWidth: 300,
    minHeight: 360,
    transparent: true,
    frame: false,
    resizable: true,
    hasShadow: false,
    skipTaskbar: false,          // 任务栏可见，聊天窗口丢了能找回来
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  chatWin.setAlwaysOnTop(true, "screen-saver");
  chatWin.chatReady = false;
  chatWin.webContents.on("did-finish-load", () => { chatWin.chatReady = true; chatWin.showInactive(); });
  const savePos = () => {
    try {
      if (!chatWin || chatWin.isDestroyed()) return;
      const b = chatWin.getBounds();
      fs.writeFileSync(CHAT_POS_PATH, JSON.stringify({ x: b.x, y: b.y }));
    } catch (e) { /* ignore */ }
  };
  chatWin.on("moved", savePos);
  chatWin.on("closed", () => { chatWin = null; });
  chatWin.webContents.on("did-finish-load", () => chatWin.showInactive());
  chatWin.webContents.on("did-fail-load", (_e, code, desc, url) =>
    log("CHAT LOAD FAILED", code, desc, url));
  chatWin.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    if (level >= 2) log("chat-renderer:", level, message, sourceId + ":" + line);
  });
  chatWin.loadFile("chat.html");
  log("chat window created");
}

function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workArea;
  const x = Math.round(sw / 2 - 170);
  const y = sh - 400;
  win = new BrowserWindow({
    width: 340,                  /* 与 pet.html 的 APP_W 一致，页面加载后会按缩放再 resize */
    height: 420,
    x,
    y,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.webContents.on("did-finish-load", () => {
    log("page loaded, showing window at", JSON.stringify(win.getBounds()));
    win.show();
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) =>
    log("LOAD FAILED", code, desc, url));
  win.webContents.on("render-process-gone", (_e, details) =>
    log("RENDERER GONE", JSON.stringify(details)));
  win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    if (level >= 2) log("renderer:", level, message, sourceId + ":" + line);
  });
  win.on("closed", () => app.quit());  // 关掉鱼 = 退出整个应用（聊天窗口也一并收掉）
  win.loadFile("pet.html");
}

// 监听状态文件（技能脚本用 os.replace 原子替换，需监听目录）
function watchState() {
  const dir = path.dirname(STATE_PATH);
  const send = () => {
    try {
      const raw = fs.readFileSync(STATE_PATH, "utf-8");
      const data = JSON.parse(raw);
      const payload = {
        state: data.state || "idle",
        task: data.task || "",
        detail: data.detail || "",
        ts: data.ts || "",
      };
      const key = JSON.stringify(payload);
      if (key !== lastPayload) {
        lastPayload = key;
        if (win && !win.isDestroyed()) {
          win.webContents.send("dafeiyu-external-state", payload);
        }
      }
    } catch (e) {
      /* 文件不存在或损坏时静默跳过 */
    }
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.watch(dir, { persistent: false }, (event, filename) => {
      if (!filename || filename.includes("dafeiyu-state")) setTimeout(send, 120);
    });
    send();
  } catch (e) {
    /* 目录不可监听时降级为轮询 */
  }
  setInterval(send, 3000); // 兜底轮询
}

ipcMain.on("dafeiyu-move", (_e, x, y) => {
  if (!Number.isFinite(x) || !Number.isFinite(y)) { log("拦截非法 dafeiyu-move 坐标:", x, y); return; }
  if (win && !win.isDestroyed()) win.setPosition(Math.round(x), Math.round(y));
});

ipcMain.on("dafeiyu-ignore-mouse", (_e, ignore, opts) => {
  if (win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(ignore === true, opts && typeof opts === "object" ? opts : { forward: false });
  }
});

ipcMain.on("dafeiyu-resize", (_e, w, h) => {
  if (!Number.isFinite(w) || !Number.isFinite(h)) { log("拦截非法 dafeiyu-resize 尺寸:", w, h); return; }
  if (win && !win.isDestroyed()) {
    /* Windows 坑：resizable:false 的窗口 setSize 只放大不缩小，
       临时打开 resizable 再关掉，缩窗才能生效（菜单模式收窗依赖这个） */
    win.setResizable(true);
    win.setSize(Math.round(w), Math.round(h));
    win.setResizable(false);
  }
});

ipcMain.on("dafeiyu-topmost", (_e, v) => {
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(v === true, "screen-saver");
});

// ---- 独立聊天窗口 ----
ipcMain.on("dafeiyu-open-chat", () => createChatWindow());

// 聊天窗口 → 桌宠：AI 思考/空闲状态联动
ipcMain.on("dafeiyu-chat-state", (_e, st) => {
  if (win && !win.isDestroyed()) win.webContents.send("dafeiyu-chat-state", st);
});

// ---- 开机自启：往启动文件夹写入/删除一个启动 bat ----
const STARTUP_DIR = path.join(
  app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup"
);
const STARTUP_FILE = path.join(STARTUP_DIR, "dafeiyu_pet.bat");

function startupEnabled() {
  // 打包版走系统登录项（写的是安装后的真实 exe 路径）；开发态仍用启动文件夹里的 bat
  if (app.isPackaged) {
    try { return !!app.getLoginItemSettings().openAtLogin; } catch (e) { return false; }
  }
  try { return fs.existsSync(STARTUP_FILE); } catch (e) { return false; }
}
function writeStartup() {
  const exe = path.join(__dirname, "node_modules", "electron", "dist", "electron.exe");
  const content = "@echo off\r\nset ELECTRON_RUN_AS_NODE=\r\nstart \"\" \"" + exe + "\" \"" + __dirname + "\"\r\n";
  fs.mkdirSync(STARTUP_DIR, { recursive: true });
  fs.writeFileSync(STARTUP_FILE, content);
  log("startup enabled ->", STARTUP_FILE);
}
function removeStartup() {
  try { fs.unlinkSync(STARTUP_FILE); log("startup disabled"); } catch (e) { /* not present */ }
}

ipcMain.handle("dafeiyu-get-startup", () => startupEnabled());
ipcMain.handle("dafeiyu-toggle-startup", (_e, enable) => {
  if (app.isPackaged) {
    try {
      app.setLoginItemSettings({ openAtLogin: enable === true, path: process.execPath, args: [] });
      log("startup", enable ? "enabled" : "disabled", "(login item)");
    } catch (e) {
      log("setLoginItemSettings failed:", e && e.message);
    }
  } else if (enable) writeStartup(); else removeStartup();
  return startupEnabled();
});

// ---- 天气查询（主进程代理） ----
// 定位方式：wttr.in 不带城市参数时，按请求来源 IP 粗略定位（换网络就跟着变，不是写死的城市）。
// 两个坑：
//   1) wttr.in 按 User-Agent 决定返回内容——curl 系 UA 给文本/JSON，浏览器 UA 给 HTML 网页（甚至直接拒绝）。
//      渲染进程的 fetch 不允许自定义 UA，所以请求放在主进程。
//   2) 用文本格式时位置字段 %l 给的是原始经纬度（如 23.118100,113.253900），不好看。
//      改用 JSON 拿天气，另外用同样按 IP 定位的 ip-api 取中文城市名（失败则退回 wttr.in 的英文名）。
const WEATHER_DESC = {
  113: ["☀️", "晴"], 116: ["⛅", "多云"], 119: ["☁️", "阴"], 122: ["☁️", "阴"],
  143: ["🌫", "薄雾"], 176: ["🌦", "局部有雨"], 179: ["🌨", "局部有雪"], 182: ["🌨", "雨夹雪"],
  185: ["🌧", "冻毛毛雨"], 200: ["⛈", "雷阵雨"], 227: ["🌨", "吹雪"], 230: ["❄️", "暴风雪"],
  248: ["🌫", "雾"], 260: ["🌫", "冻雾"], 263: ["🌦", "小毛毛雨"], 266: ["🌦", "毛毛雨"],
  281: ["🌧", "冻雨"], 284: ["🌧", "强冻雨"], 293: ["🌦", "小雨"], 296: ["🌧", "小雨"],
  299: ["🌧", "中雨"], 302: ["🌧", "中雨"], 305: ["🌧", "大雨"], 308: ["🌧", "大雨"],
  311: ["🌧", "冻雨"], 314: ["🌧", "强冻雨"], 317: ["🌨", "小雨夹雪"], 320: ["🌨", "强雨夹雪"],
  323: ["🌨", "小雪"], 326: ["❄️", "小雪"], 329: ["🌨", "中雪"], 332: ["❄️", "中雪"],
  335: ["🌨", "大雪"], 338: ["❄️", "大雪"], 350: ["🌨", "冰粒"], 353: ["🌦", "阵雨"],
  356: ["🌧", "强阵雨"], 359: ["🌧", "暴雨"], 362: ["🌨", "阵雨夹雪"], 365: ["🌨", "强阵雨夹雪"],
  368: ["🌨", "阵雪"], 371: ["🌨", "强阵雪"], 374: ["🌨", "冰粒阵雨"], 377: ["🌨", "强冰粒阵雨"],
  386: ["⛈", "雷阵雨"], 389: ["⛈", "强雷阵雨"], 392: ["⛈", "雷阵雪"], 395: ["⛈", "强雷阵雪"],
};
const WIND_DIRS = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];

async function fetchJson(url, tries) {
  let last;
  for (let i = 0; i < (tries || 3); i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "curl/8.0" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const t = await res.text();
      if (/^\s*<!DOCTYPE|^\s*<html/i.test(t)) throw new Error("服务返回了网页而不是数据");
      return JSON.parse(t);
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw last || new Error("请求失败");
}

// 系统空闲秒数（番茄钟模式：判断主人是在用电脑还是摸鱼离开了）
ipcMain.handle("dafeiyu-sys-idle", () => {
  try { return powerMonitor.getSystemIdleTime(); } catch (e) { return 0; }
});

ipcMain.handle("dafeiyu-weather", async () => {
  try {
    // 中文城市名：与 wttr.in 同样按 IP 定位；失败不影响主流程
    const cityZh = fetchJson("http://ip-api.com/json/?lang=zh-CN&fields=status,city", 2)
      .then((j) => (j && j.status === "success" && j.city) || "")
      .catch(() => "");

    const j = await fetchJson("https://wttr.in/?format=j1&lang=zh", 3);
    const cc = (j.current_condition || [])[0] || {};
    const na = (j.nearest_area || [])[0] || {};
    const val = (arr) => ((arr || [])[0] || {}).value || "";

    const city = (await cityZh) || val(na.areaName) || val(na.region) || "本地";
    const known = WEATHER_DESC[String(cc.weatherCode)];
    const icon = known ? known[0] : "🌡";
    const desc = known ? known[1] : val(cc.weatherDesc);
    const temp = cc.temp_C !== undefined && cc.temp_C !== ""
      ? (Number(cc.temp_C) >= 0 ? "+" : "") + cc.temp_C + "°C" : "";
    const dir = WIND_DIRS[Math.round(Number(cc.winddirDegree || 0) / 45) % 8];
    const wind = cc.windspeedKmph ? dir + "风" + cc.windspeedKmph + "km/h" : "";
    const text = [city, icon + " " + desc, temp, cc.humidity ? "湿度" + cc.humidity + "%" : "", wind]
      .filter(Boolean).join(" ");

    log("weather", text);
    return { ok: true, text, city, desc, tempC: cc.temp_C };
  } catch (e) {
    log("weather error", e && e.message);
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// ---- 定时任务触发 ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runAgentTask(task, opts) {
  createChatWindow();                       // 没开就开，开了就聚焦
  for (let i = 0; i < 60 && chatWin && !chatWin.isDestroyed() && !chatWin.chatReady; i++) await sleep(250);
  if (!chatWin || chatWin.isDestroyed()) { log("agent task aborted: no chat window"); return; }
  const turnOpts = opts && opts.surf ? ",{surf:true}" : "";
  const js =
    'addMsg("sys", "⏰ 定时任务「' + task.name.replace(/"/g, "") + '」触发");' +
    'addMsg("user", ' + JSON.stringify(task.prompt) + ');' +
    'runTurn(' + JSON.stringify(task.prompt) + turnOpts + ');';
  await chatWin.webContents.executeJavaScript(js).catch((e) => log("agent task js error:", e && e.message));
  log("agent task dispatched:", task.name, opts && opts.surf ? "(surf)" : "");
}

function dispatchTask(task) {
  if (task.type === "surf") {
    surf.roundBegin();                      // 这一轮记成"自主冲浪"，评论风控开始生效
    return runAgentTask(task, { surf: true });
  }
  if (task.type === "agent") return runAgentTask(task);
  // remind：桌宠气泡播报
  if (win && !win.isDestroyed()) {
    win.webContents.send("dafeiyu-task-fire", { name: task.name, message: task.message });
  }
  if (chatWin && !chatWin.isDestroyed()) {
    chatWin.webContents.executeJavaScript(
      'addMsg("sys", "⏰ 提醒「' + task.name.replace(/"/g, "") + '」：' + String(task.message).replace(/"/g, "").slice(0, 60) + '")'
    ).catch(() => {});
  }
  return Promise.resolve();
}

/* ---- 自主冲浪：状态 / 开关 / 立即来一轮 / 桌宠事件通道 ---- */
function sendSurfEvent(ev) {
  if (win && !win.isDestroyed()) win.webContents.send("dafeiyu-surf-event", ev);
}
ipcMain.handle("dafeiyu-surf-state", () => surf.getState());
ipcMain.handle("dafeiyu-surf-toggle", async (_e, on) => {
  const want = on === undefined ? !surf.getState().enabled : !!on;
  if (want) {
    pc.ensureSurfTask(true, surf.getState().interval);
    surf.setEnabled(true);
  } else {
    pc.ensureSurfTask(false);
    surf.setEnabled(false);
    surf.roundEnd();
  }
  log("surf toggle:", want);
  return surf.getState();
});
ipcMain.on("dafeiyu-surf-now", () => {
  surf.roundBegin();
  sendSurfEvent("surf_start");
  runAgentTask({ name: "🐟 冲浪·手动一轮", type: "surf", prompt: pc.SURF_PROMPT }, { surf: true });
});
ipcMain.on("dafeiyu-surf-event", (_e, ev) => {
  if (typeof ev !== "string") return;
  if (ev === "round_end") surf.roundEnd();
  sendSurfEvent(ev);
});
ipcMain.handle("dafeiyu-comment-perm", (_e, on) => {
  if (on === undefined) return surf.getState();       // 只查不改
  return surf.setCommentPerm({ on: !!on });
});

app.whenReady().then(() => {
  log("=== " + APP_INFO.name + " v" + APP_INFO.version + " | 开发者 " + APP_INFO.developer + " | " + APP_INFO.copyright + " ===");
  log("app ready, electron", process.versions.electron, "node", process.versions.node);
  try {
    app.setAboutPanelOptions({
      applicationName: APP_INFO.name,
      applicationVersion: APP_INFO.version,
      version: APP_INFO.version,
      copyright: APP_INFO.copyright,
      developers: [APP_INFO.developer],
    });
  } catch (e) { /* 平台不支持时忽略 */ }
  pc.register(ipcMain, log, { fireTask: dispatchTask });   // 电脑操作能力（鼠标键盘/网络/本地内容/定时任务）
  createWindow();
  watchState();
});

app.on("window-all-closed", () => app.quit());
