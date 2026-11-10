// 大肥鱼 · 电脑操作模块（主进程）
// 能力：鼠标移动/点击/滚轮/拖拽、键盘输入与按键、打开文件或网址、读文件、列目录、抓网页、截屏
// 全部能力受「电脑操作权限」开关控制，开关状态持久化在 ~/.workbuddy/dafeiyu-pc.json
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const office = require("./office.js");
const pdfReader = require("./pdf.js");
const videoMod = require("./video.js");
const bookmarks = require("./browser.js");
const bili = require("./bili.js");
const web = require("./web.js");
const surf = require("./surf.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Office 文档是 zip 二进制，必须走专门的生成/读取，不能当文本写
const OFFICE_EXT = [".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"];
const OFFICE_READABLE = [".docx", ".xlsx", ".pptx"];

let nut = null, nutErr = null;
try {
  nut = require("@nut-tree-fork/nut-js");
  // 关闭 nut 自带日志噪音
  try { nut.logger.setLevel(nut.LogLevel.ERROR); } catch (e) { /* 版本差异忽略 */ }
} catch (e) {
  nutErr = e && e.message ? e.message : String(e);
}

const HOME = os.homedir();
const WORK_DIR = path.join(HOME, ".workbuddy");
const PERM_PATH = path.join(WORK_DIR, "dafeiyu-pc.json");
const SHOT_DIR = path.join(WORK_DIR, "dafeiyu-shots");
const TASKS_PATH = path.join(WORK_DIR, "dafeiyu-tasks.json");

let log = () => {};
let hooks = {};   // main.js 注入：{ fireTask }

/* ---------- 权限 ---------- */
let state = { enabled: true };   // 默认开启（用户明确要求放开），可右键菜单关闭
function loadPerm() {
  try {
    const raw = JSON.parse(fs.readFileSync(PERM_PATH, "utf8"));
    if (typeof raw.enabled === "boolean") state.enabled = raw.enabled;
  } catch (e) { /* 首次运行用默认值 */ }
}
function savePerm() {
  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.writeFileSync(PERM_PATH, JSON.stringify(state, null, 2));
  } catch (e) { /* ignore */ }
}
function ensurePerm() {
  if (!state.enabled) {
    const err = new Error("电脑操作权限已关闭，请在右键菜单「设置 → 🖱️ 电脑操作」里打开");
    err.code = "PERM_OFF";
    throw err;
  }
}
loadPerm();

/* ---------- 工具函数 ---------- */
const MAX_TEXT = 200 * 1024;
const DENY_PARTS = [
  `${path.sep}.ssh${path.sep}`, `${path.sep}.aws${path.sep}`, `${path.sep}.gnupg${path.sep}`,
  "id_rsa", "id_ed25519", "credentials", "Login Data", "Cookies", "keychain",
];

/* 系统标准目录：优先用 Electron 的 app.getPath（能识别 OneDrive 重定向的真实桌面） */
const SYS_CACHE = {};
function sysPath(name) {
  if (SYS_CACHE[name]) return SYS_CACHE[name];
  try {
    const { app } = require("electron");
    const p = app && app.getPath ? app.getPath(name) : null;
    if (p) return (SYS_CACHE[name] = p);
  } catch (e) { /* 非 electron 环境退化到 HOME */ }
  const fallback = { home: HOME, desktop: path.join(HOME, "Desktop"), documents: path.join(HOME, "Documents"), downloads: path.join(HOME, "Downloads"), pictures: path.join(HOME, "Pictures"), music: path.join(HOME, "Music"), videos: path.join(HOME, "Videos") };
  return fallback[name] || null;
}

/* 「桌面」「下载」这类口语写法 → 真实目录 */
const PATH_ALIAS = {
  "桌面": "desktop", desktop: "desktop",
  "下载": "downloads", "下载夹": "downloads", downloads: "downloads", download: "downloads",
  "文档": "documents", "我的文档": "documents", documents: "documents", document: "documents",
  "图片": "pictures", "我的图片": "pictures", pictures: "pictures", picture: "pictures",
  "音乐": "music", music: "music",
  "视频": "videos", videos: "videos", video: "videos",
  "用户目录": "home", "主目录": "home", home: "home",
};

/**
 * 路径归一化（关键修复）：AI 常写 "桌面\\a.txt"、"~/Desktop/a.txt"、"Desktop/a.txt" 这类路径。
 * 原来 path.resolve 会相对进程 cwd（electron 安装目录）解析，导致文件被静默写到
 * dafeiyu-pet\\desktop\\electron\\桌面\\a.txt，桌面自然什么也看不到。
 */
function resolveUserPath(input) {
  let p = String(input === undefined || input === null ? "" : input).trim();
  if (!p) throw new Error("路径不能为空");
  p = p.replace(/^["'`\s]+|["'`\s]+$/g, "");
  if (!p) throw new Error("路径不能为空");

  // %USERPROFILE% / %APPDATA% 这类环境变量
  p = p.replace(/%([^%\\/]+)%/g, (m, k) => {
    const v = process.env[k] || process.env[k.toUpperCase()];
    return v || m;
  });

  // 开头的 ~ / ~\ / ~/
  if (p === "~") p = HOME;
  else if (/^~[\\/]/.test(p)) p = HOME + p.slice(1);

  // 口语目录名（仅处理相对路径的第一段）
  const isAbsolute = /^[a-zA-Z]:/.test(p) || p.startsWith("\\\\") || p.startsWith("/");
  if (!isAbsolute) {
    const segs = p.split(/[\\/]+/).filter(Boolean);
    if (segs.length) {
      const target = PATH_ALIAS[segs[0]] || PATH_ALIAS[segs[0].toLowerCase()];
      if (target) {
        const base = sysPath(target) || path.join(HOME, segs[0]);
        p = segs.length > 1 ? path.join(base, ...segs.slice(1)) : base;
      }
    }
  }

  // 剩下的相对路径统一挂到用户目录，而不是程序自身目录
  if (!path.isAbsolute(p)) p = path.join(HOME, p);
  return path.normalize(p);
}

function checkReadable(p) {
  if (!p || typeof p !== "string") throw new Error("路径不能为空");
  const abs = resolveUserPath(p);
  const low = abs.toLowerCase();
  for (const d of DENY_PARTS) {
    if (low.includes(d.toLowerCase())) throw new Error("出于安全考虑，不允许读取敏感凭据文件：" + abs);
  }
  return abs;
}

/* 写/移动操作的保护目录（只读没关系统目录，但写入必须拦） */
const DENY_WRITE = [
  "c:\\windows", "c:\\program files", "c:\\program files (x86)", "c:\\programdata",
  "c:\\users\\all users", "c:\\system volume information", "$recycle.bin",
];
function checkWritable(p) {
  const abs = resolveUserPath(p);
  const low = abs.toLowerCase();
  for (const d of DENY_WRITE) {
    if (low.startsWith(d + path.sep) || low === d) throw new Error("出于安全考虑，不允许写系统目录：" + abs);
  }
  for (const d of DENY_PARTS) {
    if (low.includes(d.toLowerCase())) throw new Error("出于安全考虑，不允许碰敏感凭据文件：" + abs);
  }
  return abs;
}

function keyList(spec) {
  const alias = {
    enter: "Enter", return: "Enter", tab: "Tab", esc: "Escape", escape: "Escape",
    space: "Space", backspace: "Backspace", delete: "Delete", del: "Delete",
    insert: "Insert", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
    up: "Up", down: "Down", left: "Left", right: "Right",
    ctrl: "LeftControl", control: "LeftControl", alt: "LeftAlt", shift: "LeftShift",
    win: "LeftSuper", cmd: "LeftSuper", meta: "LeftSuper", super: "LeftSuper",
    capslock: "CapsLock", printscreen: "Print", menu: "Menu",
  };
  const parts = String(spec).toLowerCase().split("+").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error("按键名不能为空");
  return parts.map((p) => {
    const name = alias[p] || (p.length === 1 ? p.toUpperCase() : p.replace(/^./, (c) => c.toUpperCase()));
    const key = nut.Key[name];
    if (key === undefined) throw new Error("不认识的按键：" + p);
    return key;
  });
}

async function screenInfo() {
  const w = await nut.screen.width();
  const h = await nut.screen.height();
  const p = await nut.mouse.getPosition();
  let scaleFactor = 1;
  try {
    const { screen } = require("electron");
    scaleFactor = screen.getPrimaryDisplay().scaleFactor || 1;
  } catch (e) { /* ignore */ }
  return {
    width: w, height: h,
    scaleFactor,
    dipSize: { width: Math.round(w / scaleFactor), height: Math.round(h / scaleFactor) },
    cursor: { x: p.x, y: p.y },
    coordinateSpace: "物理像素（和屏幕截图像素一致；若界面截图按 DIP 显示，除以 scaleFactor 换算）",
  };
}

/* ---------- 窗口聚焦 ---------- */
/* ---------- 真实窗口标题 ----------
   nut 读 Windows 窗口标题会把中文读成乱码（GBK/UTF-8 转换丢了信息），
   所以 focus_window 按中文关键词找窗口永远找不着。改由 PowerShell 取标题，
   nut 只负责按句柄把窗口拉到前台。 */
let psCache = { at: 0, list: [] };
function psWindows(maxAge) {
  const ttl = maxAge === undefined ? 1200 : maxAge;
  if (psCache.list.length && Date.now() - psCache.at < ttl) return Promise.resolve(psCache.list);
  return new Promise((resolve) => {
    const cmd = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
      "Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | " +
      "ForEach-Object { '{0}|{1}|{2}' -f $_.Id, $_.MainWindowHandle, $_.MainWindowTitle }";
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd],
      { windowsHide: true, timeout: 8000, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        if (err) { resolve(psCache.list); return; }
        const out = [];
        for (const line of String(stdout || "").split(/\r?\n/)) {
          const m = /^\s*(\d+)\|(\d+)\|(.*)$/.exec(line);
          if (!m) continue;
          const title = m[3].trim();
          if (!title) continue;
          out.push({ pid: m[1], handle: m[2], title });
        }
        if (out.length) psCache = { at: Date.now(), list: out };
        resolve(out);
      });
  });
}

async function focusWindowByTitle(keyword) {
  const kw = String(keyword || "").trim().toLowerCase();
  if (!kw) return null;

  // ① 先用 PowerShell 的准确标题匹配（中文、符号都没问题），命中就按句柄拉前台
  const ps = await psWindows();
  const hit = ps.find((w) => !isOwnHandle(w.handle) && w.title.toLowerCase().includes(kw));
  if (hit) {
    if (await focusByHandle(hit.handle)) {
      lastTargetTitle = hit.title;
      lastTargetHandle = hit.handle;
      return hit.title;
    }
  }

  // ② 退回 nut 自带的标题（纯英文标题、文件名场景够用）
  let wins = [];
  try { wins = await nut.getWindows(); } catch (e) { return null; }
  for (const w of wins) {
    const h = nutHandle(w);
    if (h && isOwnHandle(h)) continue;
    let t = "";
    try { t = await w.title; } catch (e) { continue; }
    if (t && t.toLowerCase().includes(kw)) {
      try {
        await w.focus();
        await new Promise((r) => setTimeout(r, 350));
        lastTargetTitle = t;                              // 记下来，后面打字时找不到焦点可以自动抢回来
        lastTargetHandle = h || lastTargetHandle;
        return t;
      } catch (e) { /* 试下一个 */ }
    }
  }
  return null;
}

/* ---------- 焦点守护 ----------
   桌宠窗口和聊天窗都是置顶、可聚焦的。鱼如果没先切窗口就直接打字，
   剪贴板会粘进聊天输入框（"第一次写入跑到对话框"就是这个原因）；
   鼠标点在自己窗口盖住的地方也会被自家窗口吃掉。
   ★ 不能靠窗口标题认自家窗口：nut 读到的中文标题会变成乱码，
     所以这里一律用窗口句柄（HWND）比对。 */

let lastTargetTitle = "";              // 上一次聚焦的外部窗口标题（只用来显示）
let lastTargetHandle = null;           // 上一次聚焦的外部窗口句柄（真正用来找回窗口）

function ownWindows(chatOnly) {
  try {
    const { BrowserWindow } = require("electron");
    return BrowserWindow.getAllWindows().filter((w) => {
      if (!w || w.isDestroyed()) return false;
      if (!chatOnly) return true;
      try { return /chat\.html/i.test(String(w.webContents.getURL() || "")); } catch (e) { return false; }
    });
  } catch (e) { return []; }
}

function electronHandle(win) {
  try {
    const buf = win.getNativeWindowHandle();
    if (!buf || !buf.length) return null;
    return buf.length === 8 ? buf.readBigUInt64LE().toString() : String(buf.readUInt32LE(0));
  } catch (e) { return null; }
}

function nutHandle(w) {
  try {
    const h = w.windowHandle;
    return h === undefined || h === null ? null : String(h);
  } catch (e) { return null; }
}

function ownHandleSet() {
  const s = new Set();
  for (const w of ownWindows(false)) {
    const h = electronHandle(w);
    if (h) s.add(h);
  }
  return s;
}

async function activeInfo() {
  if (!nut) return null;
  try {
    const w = await nut.getActiveWindow();
    if (!w) return null;
    let t = "";
    try { t = String((await w.title) || ""); } catch (e) { /* 标题可能读不出 */ }
    return { handle: nutHandle(w), title: t };
  } catch (e) { return null; }
}

function isOwnHandle(h) {
  return !!h && ownHandleSet().has(String(h));
}

/* 句柄 → 好看的中文标题（nut 读出来是乱码，用 PowerShell 的结果补上） */
async function prettyTitle(handle) {
  if (!handle) return "";
  const ps = await psWindows();
  const hit = ps.find((w) => String(w.handle) === String(handle));
  return hit ? hit.title : "";
}

async function focusByHandle(h) {
  if (!h || !nut) return false;
  try {
    for (const w of await nut.getWindows()) {
      if (nutHandle(w) === String(h)) {
        try { await w.focus(); await sleep(350); return true; } catch (e) { return false; }
      }
    }
  } catch (e) { /* ignore */ }
  return false;
}

/* 确认键盘到底会打到哪个窗口。返回窗口标识，判断不了返回 null（宁可不打，也不打进聊天框） */
async function ensureKeyboardTarget(hint) {
  const kw = String(hint || "").trim();
  if (kw) {
    const t = await focusWindowByTitle(kw);
    if (t) return t;
  }
  const act = await activeInfo();
  if (act && act.handle && !isOwnHandle(act.handle)) {
    lastTargetHandle = act.handle;
    const nice = (await prettyTitle(act.handle)) || act.title;
    if (nice) lastTargetTitle = nice;
    return nice || "窗口#" + act.handle;
  }

  // 焦点落在自家窗口（聊天框/桌宠）上：先 blur，再把上一次的目标窗口抢回来
  for (const w of ownWindows(false)) { try { w.blur(); } catch (e) { /* ignore */ } }
  await sleep(200);

  if (lastTargetHandle && (await focusByHandle(lastTargetHandle))) {
    return (await prettyTitle(lastTargetHandle)) || lastTargetTitle || "窗口#" + lastTargetHandle;
  }
  if (lastTargetTitle) {
    const t = await focusWindowByTitle(lastTargetTitle);
    if (t) return t;
  }
  const a3 = await activeInfo();
  if (a3 && a3.handle && !isOwnHandle(a3.handle)) {
    lastTargetHandle = a3.handle;
    const nice = (await prettyTitle(a3.handle)) || a3.title;
    if (nice) lastTargetTitle = nice;
    return nice || "窗口#" + a3.handle;
  }
  return null;
}

/* 给模型看的"当前开了哪些窗口"：自家窗口要剔掉，标题优先用 PowerShell 取（中文正常） */
async function windowTitles() {
  const own = ownHandleSet();
  const ps = await psWindows(0);
  const out = [];
  for (const w of ps) {
    if (own.has(String(w.handle))) continue;
    if (w.title && !/[\uFFFD]/.test(w.title)) out.push(w.title);
  }
  if (out.length) return out.slice(0, 20);
  if (!nut) return [];
  try {
    for (const w of await nut.getWindows()) {
      if (own.has(nutHandle(w) || "")) continue;
      let t = "";
      try { t = String((await w.title) || ""); } catch (e) { continue; }
      if (!t.trim() || /[\uFFFD]/.test(t)) continue;
      out.push(t);
    }
  } catch (e) { /* ignore */ }
  return out.slice(0, 20);
}

function chatWindowRects() {
  let sf = 1;
  try { sf = require("electron").screen.getPrimaryDisplay().scaleFactor || 1; } catch (e) { /* ignore */ }
  const rects = [];
  for (const w of ownWindows(true)) {
    try {
      const b = w.getBounds();
      rects.push({ l: b.x * sf, t: b.y * sf, r: (b.x + b.width) * sf, b: (b.y + b.height) * sf });
    } catch (e) { /* ignore */ }
  }
  return rects;
}

function inChatRect(x, y) {
  return chatWindowRects().some((r) => x >= r.l && x <= r.r && y >= r.t && y <= r.b);
}

/* 鼠标点在聊天窗盖住的地方时，临时让聊天窗穿透，让点击落到下面的真窗口上 */
async function withChatClickThrough(fn) {
  const chats = ownWindows(true);
  let changed = false;
  for (const w of chats) {
    try { w.setIgnoreMouseEvents(true, { forward: true }); changed = true; } catch (e) { /* ignore */ }
  }
  try {
    if (changed) await sleep(90);
    return await fn();
  } finally {
    if (changed) {
      await sleep(60);
      for (const w of chats) { try { w.setIgnoreMouseEvents(false); } catch (e) { /* ignore */ } }
    }
  }
}

/* ---------- 能力实现 ---------- */

/* 写入被占用时的重试 + 人话指引 */
function lockedError(abs) {
  const err = new Error(
    "写不进去：「" + path.basename(abs) + "」正被别的程序（多半是 WPS / Word / Excel）打开着，文件被锁住了。\n" +
    "两条路选一条：\n" +
    "① 让主人先把那个窗口关掉，然后重新写文件；\n" +
    "② 不要覆盖文件，直接改编辑器里的内容：open_path 打开它 → focus_window 聚焦 → key_press \"ctrl+a\" 全选 → key_type 输入新内容 → key_press \"ctrl+s\" 保存（弹「保留更改」就点它）。"
  );
  err.code = "LOCKED";
  err.locked = true;
  return err;
}

async function writeFileSafe(abs, data) {
  let lastErr = null;
  for (let i = 0; i < 4; i++) {
    try { fs.writeFileSync(abs, data); return; }
    catch (e) {
      lastErr = e;
      if (["EBUSY", "EPERM", "EACCES"].includes(e.code)) { await sleep(300); continue; }
      throw e;
    }
  }
  log("write locked:", abs, lastErr && lastErr.code);
  throw lockedError(abs);
}

/* Office 文档：按扩展名生成真正的二进制文档 */
async function writeOfficeDoc(abs, content, isAppend, fmt) {
  let ext = path.extname(abs).toLowerCase();
  let target = abs;
  let converted = null;

  if (ext === ".doc") { target = abs.replace(/\.doc$/i, ".docx"); converted = ".doc"; ext = ".docx"; }
  if (ext === ".xls") { target = abs.replace(/\.xls$/i, ".xlsx"); converted = ".xls"; ext = ".xlsx"; }
  if (ext === ".ppt") { target = abs.replace(/\.ppt$/i, ".pptx"); converted = ".ppt"; ext = ".pptx"; }
  if (isAppend) throw new Error("Office 文档不支持追加写入（append），要改内容请给出完整的新内容整体重写");

  const f = fmt || {};
  const kind = ext === ".docx" ? "doc" : ext === ".xlsx" ? "xlsx" : "ppt";
  const buf = kind === "doc" ? office.buildDocx(content, f)
    : kind === "xlsx" ? office.buildXlsx(content, f)
      : office.buildPptx(content, f);
  if (!buf || !buf.length) throw new Error("文档生成失败（内容为空？）");

  await writeFileSafe(target, buf);

  // 写完立刻读回校验，确保不是坏文件
  let text = "";
  try { text = office.readOffice(target); } catch (e) { throw new Error("文档写出来了但读不回来，可能生成异常：" + e.message); }
  const st = fs.statSync(target);
  log("write_office", target, st.size + "B", kind, "textLen=" + text.length);

  if (kind === "ppt") {
    const pages = (text.match(/\[第\d+页\]/g) || []).length;
    return {
      path: target,
      bytes: st.size,
      format: "PowerPoint 演示文稿 (.pptx)",
      pages,
      bytesNote: "真实 pptx 格式，可以用 WPS 演示 / PowerPoint 打开继续编辑",
      textLength: text.length,
      formatting: "每页一个标题 + 要点列表；标题 " + (pages > 1 ? "首页 40pt、其余 32pt" : "32pt") + "，正文 14~18pt 自动适配",
      verified: st.size > 0 && pages > 0,
      note: converted
        ? "老式 " + converted + " 格式写不了，已保存为同名的 .pptx（WPS 能正常打开）"
        : "已生成 " + pages + " 页幻灯片。分页写法：每行 `# 标题` 开一页，`- 要点` 是项目符号，`---` 强制分页",
    };
  }

  const isDoc = kind === "doc";
  const fmtNote = isDoc
    ? "正文 " + (f.size || 12) + "pt" + (f.font ? " " + f.font : "") + "，行距 " + (f.line || 1.5) +
      (f.indent ? "，首行缩进 " + f.indent + " 字符" : "") + (f.align ? "，对齐 " + f.align : "")
    : "字号 " + (f.size || 11) + "pt，首行加粗当表头，已按内容估列宽";
  return {
    path: target,
    bytes: st.size,
    format: isDoc ? "Word 文档 (.docx)" : "Excel 表格 (.xlsx)",
    bytesNote: "真实 Office 二进制格式，可以直接用 WPS / Office 打开编辑",
    textLength: text.length,
    formatting: fmtNote,
    verified: text.length >= 0 && st.size > 0,
    note: converted
      ? "老式 " + converted + " 格式写不了，已保存为同名的 " + (isDoc ? ".docx" : ".xlsx") + "（WPS 能正常打开）"
      : "已按真正的 " + (isDoc ? "Word" : "Excel") + " 格式写入，不是纯文本",
  };
}

/* ---------------- PDF 生成：用 Chromium 排版打印 ---------------- */
/* 不用第三方库：把内容渲染成 HTML，再让 Electron 的 printToPDF 输出真 PDF。
   好处是中文、字体、分页、列表都由浏览器排版引擎保证，不会出现乱码。 */
function mdToHtml(text) {
  const lines = String(text === undefined || text === null ? "" : text).replace(/\r\n/g, "\n").split("\n");
  const st = { size: 12, font: "宋体", line: 1.7, indent: 2, align: "left" };
  const out = [];
  let list = [];
  const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const inline = (s) => escHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<i>$1</i>")
    .replace(/__([^_]+)__/g, "<u>$1</u>");
  const flushList = () => {
    if (!list.length) return;
    out.push("<ul>" + list.map((t) => "<li>" + inline(t) + "</li>").join("") + "</ul>");
    list = [];
  };
  for (const raw of lines) {
    let line = raw.replace(/\s+$/, "");
    if (!line.trim()) { flushList(); continue; }
    // 排版指令：!字号 12 / !字体 宋体 / !行距 1.5 / !首行缩进 2 / !对齐 居中
    const dir = /^!\s*(字号|字体|行距|首行缩进|对齐)\s+(.+)$/.exec(line.trim());
    if (dir) {
      const v = dir[2].trim();
      if (dir[1] === "字号") st.size = parseFloat(v) || st.size;
      else if (dir[1] === "字体") st.font = v;
      else if (dir[1] === "行距") st.line = parseFloat(v) || st.line;
      else if (dir[1] === "首行缩进") st.indent = parseFloat(v) || 0;
      else if (dir[1] === "对齐") st.align = /居中|中/.test(v) ? "center" : /右/.test(v) ? "right" : /两端/.test(v) ? "justify" : "left";
      continue;
    }
    let ov = {};
    const bm = /^\s*\{([^{}]{1,120})\}\s*/.exec(line);
    if (bm) {
      for (const tok of bm[1].split("|")) {
        const t = tok.trim();
        if (/^\d+(\.\d+)?$/.test(t)) ov.size = parseFloat(t);
        else if (/居中|中/.test(t)) ov.align = "center";
        else if (/右/.test(t)) ov.align = "right";
        else if (/左/.test(t)) ov.align = "left";
        else if (/加粗|粗/.test(t)) ov.bold = true;
      }
      line = line.slice(bm[0].length);
    }
    const li = /^[-*+•]\s+(.*)$/.exec(line);
    if (li) { list.push(li[1]); continue; }
    flushList();
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const size = ov.size || st.size, align = ov.align || st.align;
    const style = 'text-align:' + align + ';';
    if (h) {
      const lv = h[1].length;
      const hs = lv === 1 ? 22 : lv === 2 ? 16 : lv === 3 ? 14 : 12.5;
      out.push('<h' + Math.min(lv, 3) + ' style="font-size:' + hs + 'pt;' + (lv === 1 ? "text-align:center;" : "") + '">' + inline(h[2]) + "</h" + Math.min(lv, 3) + ">");
      continue;
    }
    const w = ov.bold ? "font-weight:bold;" : "";
    out.push('<p style="font-size:' + size + "pt;" + style + w + '">' + inline(line) + "</p>");
  }
  flushList();
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 22mm 20mm; }
  body { font-family: "${st.font}", "Microsoft YaHei", "SimSun", sans-serif; font-size: ${st.size}pt; line-height: ${st.line}; color: #000; margin: 0; }
  p { margin: 0 0 6pt; text-indent: ${st.indent}em; }
  h1, h2, h3 { font-family: "黑体", "Microsoft YaHei", sans-serif; margin: 12pt 0 6pt; text-indent: 0; }
  ul { margin: 4pt 0 8pt; padding-left: 2em; }
  li { margin: 3pt 0; }
  b, strong { font-weight: 700; }
  </style></head><body>${out.join("\n")}</body></html>`;
}

async function writePdfDoc(abs, content) {
  const { BrowserWindow } = require("electron");
  const tmp = path.join(os.tmpdir(), "dfy-pdf-" + Date.now() + ".html");
  fs.writeFileSync(tmp, mdToHtml(content), "utf8");
  const win = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { offscreen: true, javascript: false } });
  try {
    await win.loadFile(tmp);
    await sleep(150);
    const buf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: "A4",
      margins: { marginType: "custom", top: 0.87, bottom: 0.87, left: 0.79, right: 0.79 },
    });
    if (!buf || !buf.length) throw new Error("PDF 渲染失败（内容为空？）");
    await writeFileSafe(abs, buf);
    let pages = 0, textLen = 0;
    try {
      const r = require("./pdf.js").readPdf(abs);
      pages = r.pages; textLen = r.text.length;
    } catch (e) { /* 校验失败不影响文件本身 */ }
    const st = fs.statSync(abs);
    log("write_pdf", abs, st.size + "B", "pages=" + pages);
    return {
      path: abs,
      bytes: st.size,
      format: "PDF 文档 (.pdf)",
      pages,
      textLength: textLen,
      formatting: "A4 纸张，20mm 左右边距，浏览器排版引擎生成，中文正常",
      verified: st.size > 1024,
      note: "真 PDF，可以直接打印或用阅读器打开。支持 # 标题、- 列表、**加粗**、!字号/!字体/!行距/!首行缩进/!对齐",
    };
  } finally {
    try { win.destroy(); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  }
}

/* ---------- 看视频：进度广播（让聊天窗能显示"看到第几分钟了"） ---------- */
let watchBusy = false;
function broadcastWatch(payload) {
  try {
    const { BrowserWindow } = require("electron");
    BrowserWindow.getAllWindows().forEach((w) => {
      if (w.isDestroyed()) return;
      try {
        if (String(w.webContents.getURL() || "").includes("chat.html")) {
          w.webContents.send("dafeiyu-watch-progress", payload);
        }
      } catch (e) { /* ignore */ }
    });
  } catch (e) { /* ignore */ }
}

/* ---------- 按名字打开软件 ----------
 * 主人说"打开微信"，靠截屏认图标坐标命中率太低。这里直接扫数据源：
 * ① 开始菜单/桌面的快捷方式（.lnk）  ② Get-StartApps（商店应用 + 系统应用，带 AUMID 可直接拉起）
 * 中文名、英文名、说一半、带"软件/应用"后缀都做模糊匹配。 */
const APP_ALIAS = {
  记事本: ["notepad"], 计算器: ["calculator"], 画图: ["paint", "mspaint"], 画板: ["paint", "mspaint"],
  写字板: ["wordpad"], 命令提示符: ["cmd"], 终端: ["terminal", "windows terminal", "cmd"],
  资源管理器: ["explorer", "文件资源管理器"], 文件管理器: ["explorer", "文件资源管理器"],
  我的电脑: ["explorer", "此电脑"], 此电脑: ["explorer"], 设置: ["settings"], 控制面板: ["control panel"],
  任务管理器: ["task manager"], 截图工具: ["snipping tool"], 便签: ["sticky notes"],
  微信: ["wechat", "weixin"], 网易云: ["网易云音乐", "netease cloudmusic", "cloudmusic"],
  网易云音乐: ["netease cloudmusic", "cloudmusic"], QQ音乐: ["qqmusic"], 腾讯会议: ["wemeet"],
  钉钉: ["dingtalk"], 飞书: ["feishu", "lark"], 优酷: ["youku"], 爱奇艺: ["iqiyi"],
  火绒: ["huorong"], 压缩: ["bandizip", "7-zip", "7zip", "winrar", "360压缩"],
  vscode: ["visual studio code", "vs code"], 代码编辑器: ["visual studio code", "vscode"],
  git: ["git bash"],
};

function normalizeApp(s) {
  return String(s || "").toLowerCase()
    .replace(/[\s·•・_\-—－–/\\（）()\[\]【】{}'"'“”‘’.,，。:：;；!！?？+]/g, "")
    .replace(/(软件|应用|程序|客户端|电脑版|pc版|forpc)$/g, "");
}

function expandAppName(q) {
  const out = [String(q).trim()];
  for (const k of Object.keys(APP_ALIAS)) {
    if (normalizeApp(k) === normalizeApp(q) || String(q).includes(k)) out.push(...APP_ALIAS[k]);
  }
  return [...new Set(out)];
}

function scoreAppMatch(query, name) {
  const q = normalizeApp(query), n = normalizeApp(name);
  if (!q || !n) return 0;
  let score = 0;
  if (q === n) score = 100;
  else if (n.startsWith(q)) score = 90;
  else if (q.length >= 2 && n.includes(q)) score = 80;
  else if (n.length >= 2 && q.includes(n)) score = 60;
  // 辅助入口惩罚：主人要开的是软件本体，不是它的卸载器/帮助文档/设置向导/诊断工具
  if (score && /(卸载|帮助|手册|向导|更新|快速启动|uninstall|uninst|help|readme|releasenotes|whatsnew|最新版本|faqs|下载程序|性能测试|distiller|options|languages|plugins|changes|visualize|inspection|routing|treehouse|composer|boost|licens|queuemanager|taskscheduler|networkmonitor|\brx\b|\btool\b|toolbox)/i.test(String(name))) {
    score = Math.max(0, score - 40);
  }
  return score;
}

function listShortcutDirs() {
  const dirs = [
    path.join(HOME, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs"),
    "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
  ];
  try { const d = sysPath("desktop"); if (d && !dirs.includes(d)) dirs.push(d); } catch (e) { /* ignore */ }
  dirs.push("C:\\Users\\Public\\Desktop");
  return dirs;
}

function walkShortcuts(dir, depth, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (depth < 4) walkShortcuts(full, depth + 1, out); continue; }
    if (/\.lnk$/i.test(ent.name)) {
      out.push({ name: ent.name.replace(/\.lnk$/i, ""), file: full, from: path.basename(dir) });
    }
  }
}

function listShortcuts() {
  const out = [];
  for (const d of listShortcutDirs()) walkShortcuts(d, 0, out);
  return out;
}

async function getStartApps() {
  const r = await new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-Command",
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-StartApps | ConvertTo-Json -Compress"],
      { timeout: 20000, windowsHide: true, encoding: "utf8" }, (err, stdout) => resolve(err ? null : String(stdout || "").trim()));
  });
  if (!r) return [];
  const s = r.replace(/^\uFEFF/, "");
  try {
    const j = JSON.parse(s);
    const arr = Array.isArray(j) ? j : [j];
    return arr.filter((x) => x && x.Name && x.AppID).map((x) => ({ name: String(x.Name), appId: String(x.AppID) }));
  } catch (e) { return []; }
}

/* ---------- 局部截图/局部 OCR 的 region 换算 ----------
 * 模型看到的屏幕是压缩后的截图，它给的 region 坐标天然是"上一眼那张图"里的像素，
 * 按比例换算回物理像素；换算后越界而原始值没越界，就当它直接给的是物理像素。 */
let lastShot = null;   // 最近一次返回给模型的截图 { w,h 压缩尺寸, physW,physH 物理尺寸 }
function resolveRegion(region, full) {
  if (!region) return null;
  const x = Number(region.x), y = Number(region.y);
  const w = Number(region.w !== undefined ? region.w : region.width);
  const h = Number(region.h !== undefined ? region.h : region.height);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  const fw = full ? full.width : (lastShot && lastShot.physW) || 0;
  const fh = full ? full.height : (lastShot && lastShot.physH) || 0;
  if (!fw || !fh) return null;
  const fits = (rx, ry, rw, rh) => rx >= 0 && ry >= 0 && rw > 0 && rh > 0 && rx + rw <= fw && ry + rh <= fh;
  let k = 1;
  if (lastShot && lastShot.w > 0) k = Math.min(fw / lastShot.w, fh / lastShot.h);
  let box = null;
  if (k !== 1 && fits(Math.round(x * k), Math.round(y * k), Math.round(w * k), Math.round(h * k))) {
    box = { x: Math.round(x * k), y: Math.round(y * k), w: Math.round(w * k), h: Math.round(h * k) };
  } else if (fits(Math.round(x), Math.round(y), Math.round(w), Math.round(h))) {
    box = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  } else {
    // 部分越界：按比例裁到屏幕内（至少留 16px，别让 crop 报错）
    const sx = Math.max(0, Math.round(x * k)), sy = Math.max(0, Math.round(y * k));
    const sw = Math.max(16, Math.min(Math.round(w * k), fw - sx));
    const sh = Math.max(16, Math.min(Math.round(h * k), fh - sy));
    box = { x: sx, y: sy, w: sw, h: sh };
  }
  return { used: box, rect: { x: box.x, y: box.y, width: box.w, height: box.h } };
}

const TOOLS = {
  async screen_info() {
    return await screenInfo();
  },

  async sys_paths() {
    return {
      home: HOME,
      username: os.userInfo().username,
      desktop: sysPath("desktop"),
      documents: sysPath("documents"),
      downloads: sysPath("downloads"),
      pictures: sysPath("pictures"),
      note: "这就是主人电脑上的真实目录。写文件请直接用这些绝对路径；也支持「桌面\\a.txt」这种写法，会自动换算到桌面。",
    };
  },

  async mouse_pos() {
    const p = await nut.mouse.getPosition();
    return { x: p.x, y: p.y };
  },

  async mouse_move(a) {
    const x = Math.round(Number(a.x)), y = Math.round(Number(a.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("mouse_move 需要数字 x / y");
    const before = await nut.mouse.getPosition();
    await nut.mouse.setPosition(new nut.Point(x, y));
    const after = await nut.mouse.getPosition();
    return { from: { x: before.x, y: before.y }, to: { x: after.x, y: after.y } };
  },

  async mouse_click(a) {
    if (a.x !== undefined && a.y !== undefined) await TOOLS.mouse_move(a);
    const btn = String(a.button || "left").toLowerCase();
    const b = btn === "right" ? nut.Button.RIGHT : btn === "middle" ? nut.Button.MIDDLE : nut.Button.LEFT;
    const clicks = Math.max(1, Math.min(3, Number(a.clicks) || 1));
    const doClick = async () => {
      if (clicks >= 2) await nut.mouse.doubleClick(b);
      else await nut.mouse.click(b);
    };
    const p0 = await nut.mouse.getPosition();
    // 点在聊天窗盖住的位置：让聊天窗临时穿透，否则点击会被自家窗口吃掉
    if (inChatRect(p0.x, p0.y)) await withChatClickThrough(doClick);
    else await doClick();
    const p = await nut.mouse.getPosition();
    return { clicked: btn, clicks, at: { x: p.x, y: p.y }, throughChat: inChatRect(p0.x, p0.y) || undefined };
  },

  async mouse_scroll(a) {
    if (a.x !== undefined && a.y !== undefined) await TOOLS.mouse_move(a);
    const dy = Number(a.dy || 0);
    if (!Number.isFinite(dy) || dy === 0) throw new Error("mouse_scroll 需要非零 dy（正数向下滚）");
    const n = Math.max(1, Math.min(20, Math.abs(Math.round(dy))));
    if (dy > 0) await nut.mouse.scrollDown(n); else await nut.mouse.scrollUp(n);
    return { scrolled: n * (dy > 0 ? 1 : -1) };
  },

  async mouse_drag(a) {
    const x1 = Math.round(Number(a.x1)), y1 = Math.round(Number(a.y1));
    const x2 = Math.round(Number(a.x2)), y2 = Math.round(Number(a.y2));
    if (![x1, y1, x2, y2].every(Number.isFinite)) throw new Error("mouse_drag 需要 x1/y1/x2/y2");
    await nut.mouse.setPosition(new nut.Point(x1, y1));
    await nut.mouse.pressButton(nut.Button.LEFT);
    await new Promise((r) => setTimeout(r, 120));
    await nut.mouse.setPosition(new nut.Point(x2, y2));
    await new Promise((r) => setTimeout(r, 120));
    await nut.mouse.releaseButton(nut.Button.LEFT);
    return { from: { x: x1, y: y1 }, to: { x: x2, y: y2 } };
  },

  async key_type(a) {
    const text = String(a.text || "");
    if (!text) throw new Error("key_type 需要 text");
    // 关键一步：先确认焦点不在大肥鱼自己的聊天窗上，否则内容会粘进聊天输入框
    const target = await ensureKeyboardTarget(a.target || a.window || a.title);
    if (!target) {
      const titles = await windowTitles();
      throw new Error(
        "还没定位到要写入的窗口：现在焦点还在大肥鱼自己这边，直接打字会打进聊天框，所以我没打。\n" +
        "先 open_path 打开目标文件，或者 key_type 时带上 target 指定窗口标题（例如 {\"text\":\"...\",\"target\":\"文档名\"}）。\n" +
        "当前打开着的窗口有：" + (titles.length ? titles.join(" | ") : "（没有）")
      );
    }
    const { clipboard } = require("electron");
    // mode:"type" 强制逐字敲键（纯英文且输入法为英文时才可靠）
    if (a.mode === "type") {
      await nut.keyboard.type(text.slice(0, 2000));
      return { typed: Math.min(text.length, 2000), via: "逐字敲键", target };
    }
    // 默认走剪贴板粘贴：绕过中文输入法（模拟按键会被 IME 当拼音拦截）
    const { clipboard: cb2 } = require("electron");
    // 部分环境下 readText() 会返回非字符串，做健壮性归一
    const r = cb2.readText();
    const prev = typeof r === "string" ? r : "";
    cb2.writeText(text.slice(0, 2000));
    try {
      await nut.keyboard.pressKey(nut.Key.LeftControl, nut.Key.V);
      await new Promise((rr) => setTimeout(rr, 80));
      await nut.keyboard.releaseKey(nut.Key.LeftControl, nut.Key.V);
    } finally {
      await new Promise((rr) => setTimeout(rr, 500));
      try {
        if (prev) cb2.writeText(prev);
        else cb2.clear();
      } catch (e2) { /* 还原失败不影响输入结果 */ }
    }
    return { typed: Math.min(text.length, 2000), via: "剪贴板粘贴（已绕过输入法）", target };
  },

  async key_press(a) {
    const raw = String(a.key || "").trim();
    // win / alt+tab / printscreen 这类是全局键，不需要目标窗口
    const global = /^(win|alt\+tab|printscreen|prtsc|音量.*)$/i.test(raw);
    let target = "";
    if (!global) {
      target = await ensureKeyboardTarget(a.target || a.window || a.title);
      if (!target) {
        const titles = await windowTitles();
        throw new Error(
          "还没定位到窗口：焦点还在大肥鱼自己这边，按键会按到聊天框上，所以没按。\n" +
          "先 open_path 或 focus_window 把目标窗口拉到前台，或给 key_press 带 target。\n" +
          "当前打开着的窗口有：" + (titles.length ? titles.join(" | ") : "（没有）")
        );
      }
    }
    const keys = keyList(a.key);
    await nut.keyboard.pressKey(...keys);
    await new Promise((r) => setTimeout(r, 60));
    await nut.keyboard.releaseKey(...keys);
    return { pressed: String(a.key), target: target || "全局" };
  },

  /** 列出 / 搜索浏览器收藏夹（直接读书签文件，准、快、不靠点界面） */
  async bookmarks(a) {
    return bookmarks.listBookmarks(a || {});
  },

  /** 打开收藏夹里的某个网站：按名字模糊匹配，在收藏所属的浏览器里新开标签 */
  async open_bookmark(a) {
    a = a || {};
    const name = String(a.name || a.title || a.keyword || a.q || a.url || "").trim();
    if (!name) {
      throw new Error('open_bookmark 需要 name，例如 {"name":"百度"}。不知道有哪些收藏就先调 bookmarks 看一眼。');
    }
    const r = bookmarks.openBookmark(name, a);
    if (!r.found) {
      throw new Error(
        String(r.message || "").replace(/。+$/, "") +
          (r.samples && r.samples.length ? "。收藏夹里有：" + r.samples.slice(0, 8).join(" ｜ ") : "") +
          (r.total ? "" : "。也可以用 bookmarks 工具列出全部收藏。")
      );
    }
    // 浏览器可能起得比我们想得慢，轮询把窗口拉到前台
    let focused = null;
    for (let i = 0; i < 8 && !focused; i++) {
      await sleep(400);
      focused = (await focusWindowByTitle(r.opened.name)) || (await focusWindowByTitle(r.opened.browser));
    }
    return { ...r, focused: focused || "已经打开了，但浏览器窗口可能还在后台（可以 focus_window 再拉一次）" };
  },

  /** 读网页：直接读渲染好的文字和链接清单（不靠截图猜坐标） */
  async read_page(a) {
    a = a || {};
    const url = String(a.url || a.link || "").trim();
    if (url) return await web.readPage(url, a);
    return await web.readCurrent(a);
  },

  /** 在当前打开的网页里，按文字精确点链接/按钮 */
  async click_page(a) {
    a = a || {};
    const text = String(a.text || a.label || a.button || a.link || "").trim();
    return await web.clickPage(text, a);
  },

  /** 往网页输入框打字（enter:true 顺便回车） */
  async page_type(a) {
    a = a || {};
    const text = String(a.text || a.value || "").trim();
    if (!text) throw new Error('page_type 需要 text。例：{"text":"梯度下降","into":"搜索","enter":true}');
    return await web.typePage(text, a);
  },

  /** 滚动当前网页 */
  async page_scroll(a) {
    return await web.scrollPage((a && a.dy) !== undefined ? a.dy : 600);
  },

  /** 关掉鱼自己开的网页窗口 */
  async close_page() {
    return web.closePage();
  },

  /** 查 B 站 UP 主的视频排行（播放量最多的直接排第一） */
  async bili_up(a) {
    return await bili.upVideos(a || {});
  },

  /** 读视频评论区（按热度或最新） */
  async bili_comments(a) {
    return await bili.listComments(a || {});
  },

  /** 在视频评论区留言：没登录先弹扫码，发之前弹确认窗让主人过目/改内容 */
  async bili_comment(a) {
    /* 自主冲浪时额外过一道风控：默认禁评、单日≤3、间隔≥15分钟、同视频1条。
       主人手动聊天不受这条限制（确认窗就是人工把关）。 */
    const brief = await bili.videoBrief(a || {});
    surf.assertCommentAllowed(brief.bvid);
    const r = await bili.postComment(a || {}, { log });
    surf.noteComment(r.bvid || brief.bvid, r.text);
    return r;
  },

  /** 按名字打开软件：先扫快捷方式，找不到再问 Get-StartApps（商店/系统应用） */
  async open_app(a) {
    const query = String(a.name || a.app || a.keyword || a.title || "").trim();
    if (!query) throw new Error('open_app 需要 name，例如 {"name":"微信"}');
    const names = expandAppName(query);
    const { shell } = require("electron");

    // ① 开始菜单 / 桌面快捷方式
    const shortcuts = listShortcuts();
    const scored = [];
    const seen = new Set();
    for (const s of shortcuts) {
      let best = 0, cov = 0;
      for (const q of names) {
        const sc = scoreAppMatch(q, s.name);
        if (sc > best) { best = sc; cov = normalizeApp(q).length / Math.max(1, normalizeApp(s.name).length); }
      }
      if (best >= 55) {
        const key = normalizeApp(s.name) + "|" + s.file;
        if (!seen.has(key)) { seen.add(key); scored.push({ ...s, score: best, cov }); }
      }
    }
    scored.sort((x, y) => y.score - x.score || y.cov - x.cov || x.name.length - y.name.length);
    if (scored.length) {
      const top = scored[0];
      const err = await shell.openPath(top.file);
      if (!err) {
        let focused = null;
        for (let i = 0; i < 14 && !focused; i++) {
          await sleep(400);
          focused = await focusWindowByTitle(top.name.split(/\s+/)[0]);
        }
        log("open_app", query, "→", top.name, top.file);
        return {
          opened: top.name, via: "开始菜单/桌面快捷方式", matched: top.score >= 80 ? "名字对上了" : "模糊匹配（主人确认开的是不是想要的）",
          score: top.score, source: top.from,
          focused: focused || "窗口还没起来（有的软件要几秒），稍后可以 focus_window 再试",
          alternatives: scored.slice(1, 5).map((s) => s.name),
        };
      }
      // 快捷方式坏了（目标被移走）→ 落到 ② 再试
    }

    // ② 商店/系统应用（Get-StartApps）
    const apps = await getStartApps();
    const appScored = [];
    for (const ap of apps) {
      let best = 0, cov = 0;
      for (const q of names) {
        const sc = scoreAppMatch(q, ap.name);
        if (sc > best) { best = sc; cov = normalizeApp(q).length / Math.max(1, normalizeApp(ap.name).length); }
      }
      if (best >= 55) appScored.push({ ...ap, score: best, cov });
    }
    appScored.sort((x, y) => y.score - x.score || y.cov - x.cov || x.name.length - y.name.length);
    if (appScored.length) {
      const top = appScored[0];
      await new Promise((resolve) => {
        execFile("explorer.exe", ["shell:appsFolder\\" + top.appId], { windowsHide: true }, () => resolve());
      });
      let focused = null;
      for (let i = 0; i < 14 && !focused; i++) {
        await sleep(400);
        focused = await focusWindowByTitle(top.name.split(/\s+/)[0]);
      }
      log("open_app", query, "→", top.name, "shell:appsFolder/" + top.appId);
      return {
        opened: top.name, via: "系统应用列表（商店/系统应用）", matched: top.score >= 80 ? "名字对上了" : "模糊匹配（主人确认开的是不是想要的）",
        score: top.score, appId: top.appId,
        focused: focused || "窗口还没起来，稍后可以 focus_window 再试",
        alternatives: appScored.slice(1, 5).map((s) => s.name),
      };
    }

    // ③ 都没找到：给出最接近的候选 + 下一步建议
    const near = [];
    for (const s of shortcuts.concat(apps.map((x) => ({ name: x.name })))) {
      let best = 0;
      for (const q of names) best = Math.max(best, scoreAppMatch(q, s.name));
      if (best >= 30) near.push({ name: s.name, score: best });
    }
    near.sort((x, y) => y.score - x.score);
    const uniq = [...new Set(near.map((x) => x.name))].slice(0, 8);
    throw new Error(
      "没找到叫「" + query + "」的应用。" +
      (uniq.length ? "名字相近的有：" + uniq.join("、") + "。挑个对的用准确名字再调一次 open_app。" : "") +
      "（如果主人要开的是文件不是软件，用 open_path 给路径；实在没有就用开始菜单搜索：key_press win → key_type 名字 → screenshot 看结果 → 对准应用那行双击）"
    );
  },

  async open_path(a) {
    const target = String(a.path || a.url || "").trim();
    if (!target) throw new Error("open_path 需要 path 或 url");
    const { shell } = require("electron");
    if (/^https?:\/\//i.test(target)) {
      await shell.openExternal(target);
      return { opened: target, via: "浏览器" };
    }
    const resolved = resolveUserPath(target);
    if (!fs.existsSync(resolved)) {
      // 直接说个域名（baidu.com / www.qq.com）也当网址开，别逼主人补 https://
      const looksDomain = /^[\w-]+(\.[\w-]+)+(\/[\w\-./?%&=#]*)?$/i.test(target);
      const looksFile = /\.(txt|md|docx?|xlsx?|pptx?|pdf|js|json|csv|png|jpe?g|gif|zip|rar|7z|exe|lnk|bat|ps1|html?)$/i.test(target);
      if (looksDomain && !looksFile) {
        await shell.openExternal("https://" + target);
        return { opened: "https://" + target, via: "浏览器（自动补了 https://）" };
      }
      // 兜底：主人说的其实是收藏夹里的网站名字（"打开百度"）→ 直接去收藏夹找
      if (!looksFile && !/[\\/]/.test(target)) {
        const hits = bookmarks.search(target, { limit: 3 });
        if (hits.length && hits[0].score >= 70) {
          const r = bookmarks.openBookmark(target, {});
          if (r.found) return { ...r, via: r.via + "（从收藏夹匹配的）", matchedBookmark: true };
        }
      }
      throw new Error(
        "这个路径不存在：" + resolved +
        "（要新建文件请用 write_file，新建文件夹用 make_dir；如果这是收藏夹里的网站名字，请用 open_bookmark）"
      );
    }
    const err = await shell.openPath(resolved);
    if (err) throw new Error("打不开：" + err);
    // 轮询等窗口起来再拉前台（WPS/Office 启动慢，固定等 1.5 秒经常抓空）
    const base = path.basename(resolved);
    const noExt = base.replace(/\.[^.]+$/, "");
    let focused = null;
    for (let i = 0; i < 16 && !focused; i++) {
      await sleep(400);
      focused = (await focusWindowByTitle(base)) || (noExt !== base ? await focusWindowByTitle(noExt) : null);
    }
    return { opened: resolved, via: "默认程序", focused: focused || "窗口还没起来（WPS 有时要几秒），稍后可以用 focus_window 再试" };
  },

  async focus_window(a) {
    const kw = String(a.title || a.keyword || "").trim();
    if (!kw) throw new Error('focus_window 需要 title，例如 {"title":"文档名"}');
    for (let i = 0; i < 9; i++) {
      const t = await focusWindowByTitle(kw);
      if (t) return { focused: t };
      await sleep(350);
    }
    // 还是没找到：把现有窗口标题报出来，让鱼自己挑关键词，别干瞪眼
    let titles = [];
    try {
      const wins = await nut.getWindows();
      for (const w of wins.slice(0, 80)) {
        try { const t = await w.title; if (t && String(t).trim()) titles.push(String(t).trim()); } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
    const keys = ["wps", "word", "excel", "powerpoint", "notepad", "记事本", "写字板", "浏览器", "chrome", "edge", "资源管理器"];
    let hint = titles.filter((t) => keys.some((k) => t.toLowerCase().includes(k)));
    if (!hint.length) hint = titles;
    throw new Error("没找到标题含「" + kw + "」的窗口（等了 3 秒）。当前开着的窗口有：" +
      (hint.length ? hint.slice(0, 8).join(" ｜ ") : "（没枚举到窗口）") +
      "。可以从里面挑关键词再试，或者先 open_path 打开文件。");
  },

  async read_file(a) {
    const abs = checkReadable(a.path);
    const st = fs.statSync(abs);
    if (st.isDirectory()) throw new Error("这是目录，请用 list_dir");
    const ext = path.extname(abs).toLowerCase();
    if (/\.(png|jpe?g|gif|bmp|webp|ico|svg)$/i.test(abs)) throw new Error("这是图片文件，读文本读不出内容。要看屏幕请用 screenshot（自动压缩并直接看图）；要看本地图片可以用 open_path 打开给主人看");
    if (OFFICE_READABLE.includes(ext)) {
      // docx/xlsx/pptx 是 zip 包，直接按 utf8 读只会得到乱码——这里提取真正的文字
      const text = office.readOffice(abs);
      log("read_office", abs, text.length + "chars");
      return {
        path: abs, size: st.size,
        content: text.slice(0, 20000),
        truncated: text.length > 20000,
        note: "已从 " + ext + " 里提取出文字内容（原文件是二进制，直接读会乱码）",
      };
    }
    if ([".doc", ".xls", ".ppt"].includes(ext)) {
      throw new Error("这是老式 Office 格式（97-2003 的 .doc/.xls/.ppt），内容读不出来。可以让主人另存为 .docx/.xlsx，或者鱼用 open_path 打开后 screenshot 看。");
    }
    if (ext === ".pdf") {
      // PDF 是二进制，必须走文本提取；页数多时只读前面一部分，避免撑爆上下文
      const r = pdfReader.readPdf(abs, 40);
      log("read_pdf", abs, r.pages + "pages", r.text.length + "chars");
      if (!r.text.trim()) {
        throw new Error("这份 PDF 没能提取出文字（" + r.pages + " 页，可能是扫描件/纯图片）。可以告诉主人这是图片型 PDF，或者鱼用 open_path 打开它、再 screenshot 看图读内容。");
      }
      const truncated = r.text.length > 20000;
      return {
        path: abs,
        size: st.size,
        pages: r.pages,
        readPages: r.readPages,
        content: r.text.slice(0, 20000),
        truncated,
        note: "已从 PDF 提取文字（共 " + r.pages + " 页，读了前 " + r.readPages + " 页）" +
          (r.emptyPages ? "；其中 " + r.emptyPages + " 页没有文字层（可能是图片）" : "") +
          (r.pages > r.readPages ? "；要看后面的页可以让我再读，或者直接问某一页的内容" : ""),
      };
    }
    if (st.size > MAX_TEXT) throw new Error(`文件太大（${Math.round(st.size / 1024)}KB），上限 200KB`);
    const text = fs.readFileSync(abs, "utf8");
    log("read_file", abs, st.size + "B");
    return { path: abs, size: st.size, content: text.slice(0, 20000), truncated: text.length > 20000 };
  },

  async list_dir(a) {
    const abs = checkReadable(a.path || HOME);
    const items = fs.readdirSync(abs, { withFileTypes: true }).slice(0, 200).map((d) => ({
      name: d.name,
      type: d.isDirectory() ? "dir" : "file",
    }));
    log("list_dir", abs, items.length + "项");
    return { path: abs, count: items.length, items };
  },

  async fetch_url(a) {
    const url = String(a.url || "").trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("fetch_url 需要 http(s) 网址");
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; DafeiyuPet/1.0)" },
      signal: AbortSignal.timeout(15000),
    });
    const raw = await res.text();
    log("fetch_url", url, res.status, raw.length + "B");
    return { url, status: res.status, contentType: res.headers.get("content-type") || "", text: raw.slice(0, 12000), truncated: raw.length > 12000 };
  },

  async screenshot(a) {
    const { desktopCapturer, screen } = require("electron");
    const disp = screen.getPrimaryDisplay();
    const w = Math.round(disp.size.width * disp.scaleFactor);
    const h = Math.round(disp.size.height * disp.scaleFactor);
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: w, height: h } });
    if (!sources.length) throw new Error("没拿到屏幕画面");
    let img = sources[0].thumbnail;
    const phys = img.getSize();
    // 模型看的永远是压缩后的小图，region 坐标按"上一张截图的坐标系"换算回物理像素
    const region = resolveRegion(a && (a.region || a.rect), phys);
    // 压缩：长边压到 1280 以内 + JPEG 质量逐级下降，直到 200KB 以内（AI 和历史记录都装得下）
    const MAX_DIM = 1280, LIMIT = 200 * 1024;
    let zoomed = false;
    if (region) {
      img = img.crop(region.rect);
      const d = img.getSize();
      // 小区域放大 2 倍，字才看得清（这就是"局部认字准"的关键）
      if (Math.max(d.width, d.height) < 800) {
        img = img.resize({ width: d.width * 2, height: d.height * 2 });
        zoomed = true;
      }
    } else {
      const dims = img.getSize();
      if (Math.max(dims.width, dims.height) > MAX_DIM) {
        img = img.resize({ width: dims.width >= dims.height ? MAX_DIM : undefined, height: dims.height > dims.width ? MAX_DIM : undefined });
      }
    }
    let jpeg = null, quality = 82;
    for (; quality >= 45; quality -= 12) {
      jpeg = img.toJPEG(quality);
      if (jpeg.length <= LIMIT) break;
    }
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const file = path.join(SHOT_DIR, "shot-" + Date.now() + ".jpg");
    fs.writeFileSync(file, jpeg);
    const size = img.getSize();
    lastShot = { w: size.width, h: size.height, physW: phys.width, physH: phys.height };
    log("screenshot", file, jpeg.length + "B", "q" + quality, region ? "region" : "full");
    return {
      path: file, width: size.width, height: size.height, bytes: jpeg.length,
      format: "jpeg",
      region: region ? { x: region.used.x, y: region.used.y, w: region.used.w, h: region.used.h, zoomed } : undefined,
      note: region
        ? (zoomed ? "局部放大截图（已放大 2 倍），小字应该能看清了" : "局部截图") + "，图片直接附在本条结果里"
        : "已压缩，图片直接附在本条结果里，可以直接看",
      imageDataUrl: "data:image/jpeg;base64," + jpeg.toString("base64"),
    };
  },

  /** 局部 OCR：region 裁剪 + 放大识别，并把放大原图附给模型逐字对照 */
  async ocr_screen(a) {
    const regionArg = a && (a.region || a.rect);
    if (!regionArg) {
      const r = await videoMod.ocrScreen();
      r.note = "这是整屏 OCR 文字。★整屏小字容易认错（人名/群名/数字尤甚），关键文字请用带 region 的局部识别，或对照截图确认。要读视频优先 watch_video。";
      return r;
    }
    const { desktopCapturer, screen } = require("electron");
    const disp = screen.getPrimaryDisplay();
    const w = Math.round(disp.size.width * disp.scaleFactor);
    const h = Math.round(disp.size.height * disp.scaleFactor);
    const src = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: w, height: h } });
    if (!src.length) throw new Error("没拿到屏幕画面");
    let img = src[0].thumbnail;
    const full = img.getSize();
    const region = resolveRegion(regionArg, full);
    if (!region) throw new Error('region 格式：{"x":数字,"y":数字,"w":数字,"h":数字}（按你上一眼看到的截图里的坐标）');
    img = img.crop(region.rect);
    const d0 = img.getSize();
    if (Math.max(d0.width, d0.height) < 800) img = img.resize({ width: d0.width * 2, height: d0.height * 2 });
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = path.join(SHOT_DIR, "ocr-" + Date.now() + ".png");
    const png = img.toPNG();
    fs.writeFileSync(f, png);
    const r = await videoMod.ocrFile(f, 150);
    if (!r.ok) throw new Error("OCR 失败：" + r.error);
    const size = img.getSize();
    lastShot = { w: size.width, h: size.height, physW: full.width, physH: full.height };
    log("ocr_screen", "region", JSON.stringify(region.used), (r.ms || 0) + "ms");
    return {
      text: videoMod.cleanOcr(r.text),
      lines: (r.lines || []).map((l) => videoMod.cleanOcr(l.text)),
      region: { x: region.used.x, y: region.used.y, w: region.used.w, h: region.used.h },
      ms: r.ms, bytes: png.length, width: size.width, height: size.height,
      imageDataUrl: "data:image/png;base64," + png.toString("base64"),
      note: "局部放大 OCR 完成（已自动反色/增强对比度，深色气泡也能认）。★OCR 可能认错字——结果里附了放大原图，关键字（人名/群名/数字/金额）必须逐字对照图片，以图为准。",
    };
  },

  /** 主动登录 B站（弹窗等扫码；看会员视频/拿官方字幕前会需要） */
  async bili_login() {
    if (await videoMod.biliLoggedIn()) {
      return { loggedIn: true, fresh: false, note: "早就登录着了，不用再扫" };
    }
    const r = await videoMod.ensureBiliLogin({ log, onProgress: (p) => broadcastWatch(p) }, {});
    return Object.assign(
      {
        note: r.loggedIn
          ? "扫码成功，之后看视频就能用官方字幕和高清了"
          : "没等到扫码（窗口被关或超时），那这次就只能靠画面识别了",
      },
      r
    );
  },

  /**
   * 看视频：真的把视频从头播到尾，边播边把画面里的字幕/文字认成一条带时间戳的时间线。
   * 一个调用就把整件事干完（内部自己等待、自己采样），不占用模型的工具步数。
   */
  async watch_video(a) {
    if (!a || (!a.url && !a.keyword && !a.q && !a.title)) {
      throw new Error(
        'watch_video 需要一个视频地址或关键词。例：{"tool":"watch_video","args":{"url":"https://www.bilibili.com/video/BV1xx411c7mD","maxMinutes":15}}\n' +
        '也可以直接给关键词：{"tool":"watch_video","args":{"keyword":"梯度下降 讲解","maxMinutes":10}}'
      );
    }
    if (watchBusy) throw new Error("已经在看一个视频了，等这条看完再说（同时看两个画面会串）");
    watchBusy = true;
    const t0 = Date.now();
    try {
      const r = await videoMod.watchVideo(a, {
        log,
        onProgress: (p) => broadcastWatch(p),
      });
      const images = (r.keyframes || []).slice(0, 20);
      delete r.keyframes;

      // 太长就按时间均匀抽样，保住整体脉络（模型一次读太多反而抓不住重点）
      const full = r.text || "";
      if (full.length > 14000) {
        const lines = full.split("\n");
        const step = Math.ceil(lines.length / 200);
        const keep = [];
        for (let i = 0; i < lines.length; i += step) keep.push(lines[i]);
        r.text = keep.join("\n") + "\n…（共 " + lines.length + " 条，已按时间抽样；要细看某一段可以带 startAt 再调一次）";
        r.sampled = true;
      }

      r.imageCount = images.length;
      r.images = images;
      r.elapsed = Math.round((Date.now() - t0) / 100) / 10;
      const q = r.quality || {};
      r.hint =
        (r.mode === "subtitle"
          ? "这段用的是 B 站官方字幕，最准，直接按时间线写总结。"
          : "这条时间线是机器「边播边认画面文字」得来的，**错别字不少，只当线索**。请对照附上的 " +
            images.length +
            " 张关键画面（按时间顺序）还原每段到底讲了什么，别把错字原样写进总结；认不准的地方宁可少说，别编。") +
        "不要说看不了视频，你刚刚已经把它看完了。";
      if (r.mode !== "subtitle" && (q.level === "empty" || q.level === "poor")) {
        r.hint += "（另外：这视频如果重新看一次前先 bili_login 扫码登录，能用上 B 站官方字幕，会准得多。）";
      }
      return r;
    } finally {
      watchBusy = false;
    }
  },

  async write_file(a) {
    if (!a || a.path === undefined || String(a.path).trim() === "") {
      throw new Error('write_file 缺少 path 参数。正确格式：{"tool":"write_file","args":{"path":"桌面\\\\文件名.docx","content":"要写的内容"}}');
    }
    const abs = checkWritable(a.path);
    const content = String(a.content === undefined ? "" : a.content);
    if (content.length > 2 * 1024 * 1024) throw new Error("内容超过 2MB，写不了");
    if (!a.append && fs.existsSync(abs)) {
      const st = fs.statSync(abs);
      if (st.isFile() && st.size > 1024 * 1024) throw new Error("目标文件已有 " + Math.round(st.size / 1024) + "KB 内容，覆盖太危险，请先让鱼确认");
    }

    // Office 格式：走真正的 OOXML 生成，不能再当文本写（那是乱码的根源）
    const ext = path.extname(abs).toLowerCase();
    if (OFFICE_EXT.includes(ext)) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      // 排版参数：可以直接给 write_file 传 font/size/line/indent/align
      const fmt = {
        font: a.font || a.fontFamily || undefined,
        size: a.size || a.fontSize || a.fontsize || undefined,
        line: a.line || a.lineSpacing || a.line_spacing || undefined,
        indent: a.indent === undefined ? undefined : a.indent,
        align: a.align || a.alignment || undefined,
        border: a.border,
        headerBold: a.headerBold,
      };
      return await writeOfficeDoc(abs, content, !!a.append, fmt);
    }

    // PDF：用 Chromium 排版打印，绝不能当纯文本写（会生成打不开的假 PDF）
    if (ext === ".pdf") {
      if (a.append) throw new Error("PDF 不支持追加写入，要改内容请给出完整的新内容整体重写");
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      return await writePdfDoc(abs, content);
    }
    // 其它二进制格式：直接拒绝，别写出坏文件骗自己
    if ([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".zip", ".rar", ".7z",
      ".mp3", ".mp4", ".wav", ".avi", ".mov", ".exe", ".dll", ".msi", ".psd", ".ai", ".iso"].includes(ext)) {
      throw new Error("这个格式（" + ext + "）不是文本，write_file 写不出合法文件。要生成文件请用 .txt/.md/.docx/.xlsx/.pptx/.pdf；其它格式可以让主人用对应软件建好，鱼再用 open_path + key_type 往里填内容");
    }

    const dir = path.dirname(abs);
    const dirExisted = fs.existsSync(dir);
    const prevSize = fs.existsSync(abs) && fs.statSync(abs).isFile() ? fs.statSync(abs).size : 0;
    fs.mkdirSync(dir, { recursive: true });
    if (a.append) {
      try { fs.appendFileSync(abs, content); }
      catch (e) {
        if (e && ["EBUSY", "EPERM", "EACCES"].includes(e.code)) throw lockedError(abs);
        throw e;
      }
    } else {
      await writeFileSafe(abs, Buffer.from(content, "utf8"));
    }
    const st2 = fs.statSync(abs);
    const expected = Buffer.byteLength(content) + (a.append ? prevSize : 0);
    log("write_file", abs, content.length + "chars", a.append ? "append" : "write", "->", st2.size + "B");
    return {
      path: abs,
      bytes: st2.size,
      mode: a.append ? "append" : "write",
      verified: st2.isFile() && st2.size === expected,
      note: dirExisted ? undefined : "目标文件夹原本不存在，已自动创建：" + dir,
    };
  },

  async move_file(a) {
    const from = checkWritable(a.from || a.path);
    const to = checkWritable(a.to || a.target);
    if (!fs.existsSync(from)) throw new Error("源文件不存在：" + from);
    const st = fs.statSync(from);
    if (!st.isFile()) throw new Error("只能移动文件（不支持整个文件夹）：", from);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.existsSync(to) && fs.statSync(to).isFile() && path.resolve(from) !== path.resolve(to)) {
      throw new Error("目标已存在同名文件：" + to + "，请换一个名字");
    }
    try {
      fs.renameSync(from, to);
    } catch (e) {
      if (e.code === "EXDEV") {           // 跨盘：复制后删源
        fs.copyFileSync(from, to);
        fs.unlinkSync(from);
      } else throw e;
    }
    log("move_file", from, "->", to);
    return { from, to };
  },

  async make_dir(a) {
    if (!a || a.path === undefined || String(a.path).trim() === "") {
      throw new Error('make_dir 缺少 path 参数。正确格式：{"tool":"make_dir","args":{"path":"桌面\\\\新文件夹"}}');
    }
    const abs = checkWritable(a.path);
    fs.mkdirSync(abs, { recursive: true });
    log("make_dir", abs);
    return { path: abs };
  },

  /* ---------- 自主冲浪：记忆 / 评论权限 / 间隔 ---------- */
  async memory_search(a) {
    return surf.memorySearch(a || {});
  },

  async memory_write(a) {
    return surf.memoryWrite(a || {});
  },

  async comment_perm(a) {
    return surf.setCommentPerm(a || {});
  },

  async surf_interval(a) {
    const r = surf.setIntervalMinutes(a || {});
    const t = tasks.find((x) => x.type === "surf");
    if (t) { t.everyMinutes = r.minutes; saveTasks(); armTask(t); }
    return Object.assign({ applied: !!t }, r);
  },

  /* ---------- 定时任务 ---------- */
  async schedule_add(a) {
    const name = String(a.name || "").trim();
    if (!name) throw new Error("任务需要名字 name");
    const type = a.type === "agent" ? "agent" : a.type === "surf" ? "surf" : "remind";
    const text = String(a.prompt || a.message || "").trim();
    if (!text) throw new Error("需要 message（提醒内容）或 prompt（AI 任务指令）");
    if (type === "agent" && !a.prompt) throw new Error("agent 型任务需要 prompt");
    const specCount = ["at", "everyMinutes", "once"].filter((k) => a[k] !== undefined).length;
    if (specCount !== 1) throw new Error("时间三选一：at=\"HH:MM\"（每天） / everyMinutes=N（每隔N分钟） / once=\"YYYY-MM-DD HH:MM\"（单次）");
    const task = { name, type, message: text, prompt: text, created: Date.now(), lastRun: 0 };
    if (a.everyMinutes !== undefined) {
      const m = Number(a.everyMinutes);
      if (!Number.isFinite(m) || m < 1) throw new Error("everyMinutes 需要正整数分钟");
      task.everyMinutes = Math.round(m);
    } else if (a.once !== undefined) {
      const t = new Date(String(a.once).replace("T", " ")).getTime();
      if (!Number.isFinite(t)) throw new Error("once 格式应为 \"YYYY-MM-DD HH:MM\"");
      if (t <= Date.now()) throw new Error("once 的时间已经过去了");
      task.onceAt = t;
    } else {
      const mm = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(a.at).trim());
      if (!mm) throw new Error("at 格式应为 \"HH:MM\"");
      task.at = String(a.at).trim();
    }
    if (tasks.some((t) => t.name === name)) throw new Error("已有同名任务「" + name + "」，请先删除或换个名字");
    tasks.push(task);
    saveTasks(); armTask(task);
    log("schedule_add", name, type);
    return { name, type, spec: describeSpec(task), nextRun: task.nextRun || null };
  },

  async schedule_list() {
    return { count: tasks.length, tasks: tasks.map((t) => ({ name: t.name, type: t.type, spec: describeSpec(t), message: t.message, nextRun: t.nextRun || null, lastRun: t.lastRun || 0 })) };
  },

  async schedule_remove(a) {
    const name = String(a.name || "").trim();
    const idx = tasks.findIndex((t) => t.name === name);
    if (idx < 0) throw new Error("没有叫「" + name + "」的任务");
    const [gone] = tasks.splice(idx, 1);
    clearTimeout(gone._timer);
    saveTasks();
    log("schedule_remove", name);
    return { removed: name };
  },

  async schedule_run(a) {
    const name = String(a.name || "").trim();
    const t = tasks.find((x) => x.name === name);
    if (!t) throw new Error("没有叫「" + name + "」的任务");
    return await runTaskNow(t);
  },
};

/* ---------- 定时任务引擎 ---------- */
let tasks = [];
function loadTasks() {
  try { tasks = JSON.parse(fs.readFileSync(TASKS_PATH, "utf8")) || []; } catch (e) { tasks = []; }
  if (!Array.isArray(tasks)) tasks = [];
}
function saveTasks() {
  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.writeFileSync(TASKS_PATH, JSON.stringify(tasks.map(({ _timer, ...t }) => t), null, 2));
  } catch (e) { /* ignore */ }
}
function describeSpec(t) {
  if (t.everyMinutes) return "每 " + t.everyMinutes + " 分钟";
  if (t.at) return "每天 " + t.at;
  if (t.onceAt) return "单次 " + new Date(t.onceAt).toLocaleString("zh-CN");
  return "?";
}
function nextFire(t, from) {
  from = from || Date.now();
  if (t.everyMinutes) {
    const base = t.lastRun || from;
    return Math.max(from, base + t.everyMinutes * 60000);
  }
  if (t.at) {
    const [h, m] = t.at.split(":").map(Number);
    const d = new Date(from);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  if (t.onceAt) return t.onceAt > from ? t.onceAt : null;
  return null;
}
function armTask(t) {
  clearTimeout(t._timer);
  const at = nextFire(t);
  if (at === null) {
    if (t.onceAt && t.onceAt <= Date.now() && !t.lastRun) t.done = true;
    return;
  }
  t.nextRun = at;
  const delay = Math.min(Math.max(at - Date.now(), 200), 2147483647);
  t._timer = setTimeout(() => fireTask(t), delay);
}
async function fireTask(t) {
  /* 自主冲浪的两条硬护栏（写死在代码里，不靠模型自觉）：
     ① 23:00~07:00 不冲浪，间隔自动拉到 60 分钟以上；
     ② 每日轮次上限，超了就等明天。 */
  if (t.type === "surf") {
    if (surf.nightHours()) {
      t.everyMinutes = Math.max(Number(t.everyMinutes) || 30, 60);
      t.lastRun = Date.now();                 // 从"现在"重新计时，否则 nextFire 会立刻再触发形成死循环
      log("surf skipped (night), next every", t.everyMinutes, "min");
      armTask(t); saveTasks();
      return;
    }
    if (!surf.takeRound()) {
      t.lastRun = Date.now();
      log("surf skipped (daily cap reached)");
      armTask(t); saveTasks();
      return;
    }
  }
  t.lastRun = Date.now();
  t.nextRun = null;
  saveTasks();
  log("task fire:", t.name, t.type);
  try { await hooks.fireTask({ name: t.name, type: t.type, message: t.message, prompt: t.prompt }); }
  catch (e) { log("task fire error:", e && e.message); }
  if (!t.done && (t.everyMinutes || t.at)) armTask(t);
  else if (t.onceAt) {           // 单次任务触发完就移除
    tasks = tasks.filter((x) => x !== t);
    saveTasks();
  }
}
async function runTaskNow(t) {
  await hooks.fireTask({ name: t.name, type: t.type, message: t.message, prompt: t.prompt });
  t.lastRun = Date.now();
  if (t.everyMinutes || t.at) armTask(t);
  saveTasks();
  return { ran: t.name, type: t.type };
}
function armAll() {
  tasks = tasks.filter((t) => !t.done);
  tasks.forEach(armTask);
  saveTasks();
}

/* 自主冲浪总开关：开了就有（或更新）一个 type=surf 的定时任务，关了就把任务摘掉 */
const SURF_TASK_NAME = "🐟 自主冲浪";
const SURF_PROMPT = "开始一轮自主冲浪。先读记忆，再优先处理B站消息通知，没通知就刷推荐；一轮最多看 2 个视频；按规则输出 EVENT 行，最后用一两句话跟主人说说这轮看到啥。";
function ensureSurfTask(on, minutes) {
  const t = tasks.find((x) => x.type === "surf");
  if (on) {
    if (t) {
      if (minutes) { t.everyMinutes = Math.max(10, Math.min(180, Math.round(Number(minutes) || 30))); armTask(t); saveTasks(); }
      return { task: t.name, spec: describeSpec(t), created: false };
    }
    const task = {
      name: SURF_TASK_NAME, type: "surf", message: "自主冲浪", prompt: SURF_PROMPT,
      created: Date.now(), lastRun: 0,
      everyMinutes: Math.max(10, Math.min(180, Math.round(Number(minutes) || 30))),
    };
    tasks.push(task);
    saveTasks(); armTask(task);
    log("surf task created, every", task.everyMinutes, "min");
    return { task: task.name, spec: describeSpec(task), created: true };
  }
  if (!t) return { removed: null };
  clearTimeout(t._timer);
  tasks = tasks.filter((x) => x !== t);
  saveTasks();
  log("surf task removed");
  return { removed: t.name };
}

/* ---------- IPC 注册 ---------- */
function register(ipcMain, logger, hookObj) {
  log = logger || (() => {});
  hooks = hookObj || {};
  loadTasks();
  armAll();
  log("pc module ready, nut-js:", nut ? "ok" : "FAILED " + nutErr, "| tasks:", tasks.length);

  ipcMain.handle("dafeiyu-pc-status", () => ({
    enabled: state.enabled,
    mouseReady: !!nut,
    nutError: nutErr,
    home: HOME,
    username: os.userInfo().username,
    paths: {
      home: HOME,
      desktop: sysPath("desktop"),
      documents: sysPath("documents"),
      downloads: sysPath("downloads"),
      pictures: sysPath("pictures"),
    },
  }));

  ipcMain.handle("dafeiyu-pc-perm", (_e, v) => {
    state.enabled = !!v;
    savePerm();
    log("pc perm ->", state.enabled);
    try {
      const { BrowserWindow } = require("electron");
      BrowserWindow.getAllWindows().forEach((w) => {
        if (!w.isDestroyed()) w.webContents.send("dafeiyu-pc-changed", state.enabled);
      });
    } catch (e) { /* ignore */ }
    return { enabled: state.enabled };
  });

  ipcMain.handle("dafeiyu-pc", async (_e, name, args) => {
    const fn = TOOLS[name];
    if (!fn) return { ok: false, error: "没有这个工具：" + name };
    try {
      ensurePerm();
      const needNut = ["mouse_move", "mouse_click", "mouse_scroll", "mouse_drag", "mouse_pos", "key_type", "key_press", "focus_window", "screen_info"];
      if (!nut && needNut.includes(name)) {
        return { ok: false, error: "鼠标键盘模块没加载成功：" + nutErr };
      }
      const t0 = Date.now();
      const result = await fn(args || {});
      log("tool", name, JSON.stringify(args || {}).slice(0, 120), (Date.now() - t0) + "ms");
      return { ok: true, result };
    } catch (e) {
      log("tool error", name, e && e.message);
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });
}

module.exports = { register, TOOLS, resolveUserPath, sysPath, ensureSurfTask, SURF_TASK_NAME, SURF_PROMPT };
