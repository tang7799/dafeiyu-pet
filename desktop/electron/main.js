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

/* ============ 大脑（对话模型）选择 ============
 * 云端模型清单由聊天窗拉取后回传缓存，桌宠菜单据此渲染。
 * 配置只存模型 id —— 具体清单可能随云端更新，所以分开存。
 */
const BRAIN_PATH = path.join(os.homedir(), ".workbuddy", "dafeiyu-brain.json");
const BRAIN_MODELS_PATH = path.join(os.homedir(), ".workbuddy", "dafeiyu-brain-models.json");

/* 离线兜底：从没开过聊天窗时菜单也能显示这几项（开过就会用云端真实清单覆盖） */
const BRAIN_FALLBACK = [
  { id: "auto", name: "Auto（自动挑）", credits: "浮动", ctx: 256 },
  { id: "glm-5.3", name: "GLM-5.3", credits: "x0.69", ctx: 1000 },
  { id: "glm-5.3-flash", name: "GLM-5.3-Flash", credits: "x0.08", ctx: 1000 },
  { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", credits: "x0.51", ctx: 1000 },
  { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", credits: "x0.11", ctx: 1000 },
  { id: "hy4free", name: "Hy4（免费）", credits: "x0.00", ctx: 960 },
  { id: "hy3", name: "Hy3（免费）", credits: "x0.00", ctx: 192 },
  { id: "deep-model", name: "极致", credits: "x1.00", ctx: 300 },
  { id: "kimi-k3.1-pro", name: "Kimi-K3.1-Pro", credits: "x0.97", ctx: 1000 },
  { id: "minimax-m3.1-flash", name: "MiniMax-M3.1-Flash", credits: "x0.08", ctx: 1000 },
  { id: "glm-4.7", name: "GLM-4.7", credits: "x0.23", ctx: 200 },
];

function loadBrain() {
  try {
    const raw = JSON.parse(fs.readFileSync(BRAIN_PATH, "utf8"));
    /* 可能带 custom 字段（自定义模型配置），原样带回 */
    if (raw && typeof raw.id === "string" && raw.id) return raw;
  } catch (e) { /* 首次运行 */ }
  return { id: "auto", name: "Auto（自动挑）" };
}
function saveBrain(b) {
  try {
    fs.mkdirSync(path.dirname(BRAIN_PATH), { recursive: true });
    fs.writeFileSync(BRAIN_PATH, JSON.stringify(b, null, 2));
  } catch (e) { log("保存大脑配置失败:", e.message); }
}
function loadBrainModels() {
  try {
    const raw = JSON.parse(fs.readFileSync(BRAIN_MODELS_PATH, "utf8"));
    if (Array.isArray(raw) && raw.length) return raw;
  } catch (e) { /* 还没缓存 */ }
  return BRAIN_FALLBACK;
}
function saveBrainModels(list) {
  try {
    fs.mkdirSync(path.dirname(BRAIN_MODELS_PATH), { recursive: true });
    fs.writeFileSync(BRAIN_MODELS_PATH, JSON.stringify(list));
  } catch (e) { log("保存模型清单失败:", e.message); }
}
function broadcastBrain(payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) { try { w.webContents.send("dafeiyu-brain-changed", payload); } catch (e) {} }
  }
}

ipcMain.handle("dafeiyu-brain-get", () => ({ brain: loadBrain(), models: loadBrainModels() }));

ipcMain.handle("dafeiyu-brain-set", (_e, id) => {
  /* 自定义大脑：不查云端清单，配置存在 brain.json 的 custom 字段里 */
  if (id === "custom") {
    const cur = loadBrain();
    if (!cur.custom || !cur.custom.baseUrl || !cur.custom.model) return { ok: false, msg: "还没配置自定义模型" };
    const b = { id: "custom", name: "自定义 · " + cur.custom.model, custom: cur.custom };
    saveBrain(b);
    log("切换大脑 ->", b.id, b.name);
    broadcastBrain({ brain: b, models: loadBrainModels() });
    return { ok: true, brain: b };
  }
  const list = loadBrainModels();
  const hit = list.find((m) => m.id === id);
  if (!hit) return { ok: false, msg: "模型清单里没有 " + id };
  const b = { id: hit.id, name: hit.name };
  saveBrain(b);
  log("切换大脑 ->", b.id, b.name);
  broadcastBrain({ brain: b, models: list });
  return { ok: true, brain: b };
});

/* 自定义模型配置（OpenAI 兼容接口：baseUrl + apiKey + model） */
ipcMain.handle("dafeiyu-brain-custom-get", () => ({ custom: loadBrain().custom || null }));

ipcMain.handle("dafeiyu-brain-custom-set", (_e, cfg) => {
  cfg = cfg || {};
  const baseUrl = String(cfg.baseUrl || "").trim();
  const model = String(cfg.model || "").trim();
  if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, msg: "接口地址要以 http(s):// 开头" };
  if (!model) return { ok: false, msg: "模型 ID 不能为空" };
  const c = { name: String(cfg.name || "").trim(), baseUrl, model, apiKey: String(cfg.apiKey || "").trim() };
  const b = { id: "custom", name: "自定义 · " + model, custom: c };
  saveBrain(b);
  log("自定义大脑 ->", c.baseUrl, c.model);
  broadcastBrain({ brain: b, models: loadBrainModels() });
  return { ok: true, brain: b };
});

/* 自定义模型的对话流：主进程代发（渲染层 fetch 会被 CORS 拦，厂商接口基本不放行）。
   按 reqId 回发 dafeiyu-custom-chunk：{delta:{content,reasoning_content}} / {done,usage,error} */
const customRuns = new Map();   /* reqId -> AbortController */

ipcMain.handle("dafeiyu-custom-chat-start", (e, payload) => {
  const { reqId, messages, cfg } = payload || {};
  if (!reqId || !cfg || !cfg.baseUrl || !cfg.model) return { ok: false, msg: "自定义模型参数不完整" };
  const win = BrowserWindow.fromWebContents(e.sender);
  const send = (d) => {
    try { if (win && !win.isDestroyed()) win.webContents.send("dafeiyu-custom-chunk", Object.assign({ reqId }, d)); } catch (err) {}
  };
  const ctrl = new AbortController();
  customRuns.set(reqId, ctrl);
  (async () => {
    try {
      let url = String(cfg.baseUrl).trim().replace(/\/+$/, "");
      if (!/\/chat\/completions$/.test(url)) url += "/chat/completions";
      const headers = { "Content-Type": "application/json" };
      if (cfg.apiKey) headers.Authorization = "Bearer " + cfg.apiKey;
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: cfg.model, messages, stream: true, temperature: 0.7 }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error("HTTP " + res.status + (t ? "：" + t.slice(0, 220) : ""));
      }
      const ctype = String(res.headers.get("content-type") || "");
      if (ctype.indexOf("event-stream") === -1) {
        /* 有的中转不回 SSE：整包 JSON 也接住 */
        const j = await res.json().catch(() => null);
        const d = j && j.choices && j.choices[0] && (j.choices[0].message || j.choices[0].delta);
        if (d && d.content) send({ delta: { content: d.content } });
        send({ done: true, usage: j && j.usage });
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "", usage = null;
      for (;;) {
        const r2 = await reader.read();
        if (r2.done) break;
        buf += dec.decode(r2.value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line.indexOf("data:") !== 0) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const j = JSON.parse(data);
            if (j.usage) usage = j.usage;
            const ch = j.choices && j.choices[0];
            const d = ch && (ch.delta || ch.message);
            if (d && (d.content || d.reasoning_content)) {
              send({ delta: { content: d.content || "", reasoning_content: d.reasoning_content || "" } });
            }
          } catch (err) { /* 半截行/心跳，忽略 */ }
        }
      }
      send({ done: true, usage });
    } catch (err) {
      if (String(err && err.name) === "AbortError") send({ done: true });
      else send({ done: true, error: String(err && err.message || err).slice(0, 300) });
    } finally { customRuns.delete(reqId); }
  })();
  return { ok: true };
});

ipcMain.on("dafeiyu-custom-chat-abort", (_e, reqId) => {
  const c = customRuns.get(reqId);
  if (c) { try { c.abort(); } catch (err) {} }
});

/* 聊天窗拉到云端清单后回传（带真实倍率/上下文），菜单立刻跟着更新 */
ipcMain.handle("dafeiyu-brain-models", (_e, list) => {
  if (!Array.isArray(list) || !list.length) return { ok: false };
  const slim = list
    .filter((m) => m && m.id && m.enabled !== false && m.maxInputTokens)   /* 视频/图像模型不进大脑菜单 */
    .map((m) => ({
      id: String(m.id),
      name: String(m.name || m.id),
      credits: String(m.credits || (m.id === "auto" ? "浮动" : "免费")).replace(" credits", ""),
      ctx: Math.round((m.maxInputTokens || 0) / 1000),
      img: !!m.supportsImages,
      icon: String(m.iconUrl || ""),
      desc: String(m.descriptionZh || m.descriptionEn || "").slice(0, 90),
    }));
  if (!slim.length) return { ok: false };
  saveBrainModels(slim);
  const b = loadBrain();
  /* 选中的模型如果已下架，回退 auto，避免一直请求不存在的模型（自定义大脑不在此列） */
  if (b.id !== "custom" && !slim.find((m) => m.id === b.id)) {
    b.id = "auto"; b.name = (slim.find((m) => m.id === "auto") || {}).name || "Auto";
    saveBrain(b);
    broadcastBrain({ brain: b, models: slim });
  }
  return { ok: true, count: slim.length, brain: loadBrain() };
});

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

/* ---- 聊天指令 → 桌宠动作（pet_act 工具的转发通道）---- */
function forwardPetAct(name) {
  if (win && !win.isDestroyed()) {
    win.webContents.send("dafeiyu-pet-act", String(name || ""));
    return true;
  }
  return false;
}
ipcMain.handle("dafeiyu-pet-act", (_e, name) => forwardPetAct(name));

/* ---- 教学：模型把新动作教给桌宠（pet_teach 工具的转发通道，等桌宠回执） ---- */
let teachWait = null;
ipcMain.on("dafeiyu-pet-teach-result", (_e, res) => {
  if (teachWait) { const r = teachWait; teachWait = null; r(res || { ok: false, msg: "学习结果为空" }); }
});
function forwardPetTeach(spec) {
  if (!win || win.isDestroyed()) return Promise.resolve({ ok: false, msg: "桌宠不在线，学不了" });
  return new Promise((resolve) => {
    teachWait = resolve;
    win.webContents.send("dafeiyu-pet-teach", spec || {});
    setTimeout(() => {
      if (teachWait === resolve) { teachWait = null; resolve({ ok: false, msg: "桌宠没响应学习请求" }); }
    }, 3000);
  });
}

/* ---- 视频：make_video 工具让桌宠窗口的隐藏 canvas 录制（等回执），另配保存通道 ---- */
let videoWait = null;
ipcMain.on("dafeiyu-video-result", (_e, res) => {
  if (videoWait) { const r = videoWait; videoWait = null; r(res || { ok: false, msg: "录制结果为空" }); }
});
ipcMain.handle("dafeiyu-video-save", (_e, buf, ext) => {
  try {
    const artDir = path.join(os.homedir(), ".workbuddy", "dafeiyu-art");
    fs.mkdirSync(artDir, { recursive: true });
    const f = path.join(artDir, "vid-" + Date.now() + "-" + Math.floor(Math.random() * 9000 + 1000) + "." + (ext === "mp4" ? "mp4" : "webm"));
    fs.writeFileSync(f, Buffer.from(buf));
    log("video saved", f, buf.length + "B");
    return { ok: true, path: f, size: buf.length };
  } catch (e) { return { ok: false, msg: "保存视频失败：" + e.message }; }
});
function forwardVideoRecord(spec) {
  if (!win || win.isDestroyed()) return Promise.resolve({ ok: false, msg: "桌宠不在线，录不了视频" });
  return new Promise((resolve) => {
    videoWait = resolve;
    win.webContents.send("dafeiyu-video-record", spec || {});
    setTimeout(() => {
      if (videoWait === resolve) { videoWait = null; resolve({ ok: false, msg: "录制超时（5 分钟）" }); }
    }, 300000);
  });
}

/* ---- CPU 占用率采样：每 10 秒推给桌宠（CPU 状态鱼） ---- */
let cpuLast = os.cpus();
let cpuPctMain = 0;
setInterval(() => {
  try {
    const cur = os.cpus();
    let idleT = 0, total = 0;
    for (let i = 0; i < cur.length && i < cpuLast.length; i++) {
      const a = cur[i].times, b = cpuLast[i].times;
      idleT += a.idle - b.idle;
      total += (a.user - b.user) + (a.nice - b.nice) + (a.sys - b.sys) + (a.idle - b.idle) + (a.irq - b.irq);
    }
    cpuLast = cur;
    cpuPctMain = total > 0 ? Math.round(100 * (1 - idleT / total)) : 0;
    if (win && !win.isDestroyed()) win.webContents.send("dafeiyu-cpu", cpuPctMain);
  } catch (e) {}
}, 10000);
ipcMain.handle("dafeiyu-cpu-now", () => cpuPctMain);

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
  pc.register(ipcMain, log, { fireTask: dispatchTask, petAct: forwardPetAct, petTeach: forwardPetTeach, videoRecord: forwardVideoRecord });   // 电脑操作能力（鼠标键盘/网络/本地内容/定时任务/创作室）
  createWindow();
  watchState();
});

app.on("window-all-closed", () => app.quit());
