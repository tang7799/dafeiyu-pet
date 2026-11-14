/* video.js —— 让大肥鱼真的"看"完一个视频
 *
 * 思路（为什么不能"一直截屏给模型看"）：
 *   1 个 20 分钟的视频，每 5 秒一帧就是 240 张图。全塞给模型 = 上下文爆掉 + 又慢又贵。
 *   所以这里的做法是：先在人看得见的播放窗口里把视频放完，边放边把"画面上的文字"
 *   用系统自带 OCR 抽成一条带时间戳的文字时间线；画面发生大变化时单独留几张关键帧。
 *   模型最后拿到的是一条几千字的文字时间线 + 几张关键画面，一次就能写出靠谱的总结。
 *
 * 三条路，按成本从低到高自动选：
 *   subtitle  官方 CC 字幕（需要这个观看分区登录过 B 站）—— 秒出，最准
 *   ocr       画面 OCR（默认）—— 靠播放器真的播，逐帧认字幕/PPT/公式
 *   frames    只留关键帧，交给模型自己看（画面为主、字很少的视频）
 */
const { BrowserWindow, session } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const https = require("https");
const { execFile } = require("child_process");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const PART = "persist:dafeiyu-video"; // 独立分区：登录过 B 站就一直是登录态
const TMP = path.join(os.tmpdir(), "dafeiyu-watch");
/* 打包后 ocr_win.ps1 在 asar 里，外部 powershell.exe 读不了 asar 虚拟路径——
   首次使用时拷到真实目录再执行（Electron 自己的 fs 能读 asar） */
const PS_SRC = path.join(__dirname, "ocr_win.ps1");
let psReal = null;
function psPath() {
  if (!psReal || !fs.existsSync(psReal)) {
    if (!PS_SRC.includes("app.asar")) { psReal = PS_SRC; return psReal; }
    psReal = path.join(TMP, "ocr_win.ps1");
    fs.mkdirSync(TMP, { recursive: true });
    fs.copyFileSync(PS_SRC, psReal);
  }
  return psReal;
}

/* ---------------- 小工具 ---------------- */

function httpText(url, extra) {
  return new Promise((resolve, reject) => {
    const opt = {
      headers: Object.assign(
        { "User-Agent": UA, Referer: "https://www.bilibili.com", "Accept-Language": "zh-CN,zh;q=0.9" },
        extra || {}
      ),
      timeout: 15000,
    };
    const req = https.get(url, opt, (res) => {
      // 短链跳转
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return httpText(next, extra).then(resolve, reject);
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => { req.destroy(new Error("网络超时")); });
    req.on("error", reject);
  });
}

async function httpJson(url, extra) {
  const r = await httpText(url, extra);
  try { return JSON.parse(r.text); } catch (e) { throw new Error("接口返回的不是 JSON：" + r.text.slice(0, 120)); }
}

/** 表单 POST（B 站写操作全是这个格式：application/x-www-form-urlencoded） */
function httpPost(url, body, extra) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(body || {}).toString();
    const u = new URL(url);
    const opt = {
      method: "POST",
      headers: Object.assign(
        {
          "User-Agent": UA,
          Referer: "https://www.bilibili.com",
          "Accept-Language": "zh-CN,zh;q=0.9",
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(data),
          Origin: "https://www.bilibili.com",
        },
        extra || {}
      ),
      timeout: 15000,
    };
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "POST",
        headers: opt.headers,
        timeout: opt.timeout,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("timeout", () => { req.destroy(new Error("网络超时")); });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function httpPostJson(url, body, extra) {
  const r = await httpPost(url, body, extra);
  try { return JSON.parse(r.text); } catch (e) { throw new Error("接口返回的不是 JSON：" + r.text.slice(0, 160)); }
}

/* ---------------- 解析"主人说的那个视频" ---------------- */

function extractBvid(s) {
  const str = String(s || "");
  let m = str.match(/BV[0-9A-Za-z]{10}/);
  if (m) return { bvid: m[0] };
  m = str.match(/av(\d{1,12})/i);
  if (m) return { aid: m[1] };
  m = str.match(/b23\.tv\/([A-Za-z0-9]+)/);
  if (m) return { short: "https://b23.tv/" + m[1] };
  return null;
}

async function resolveVideo(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("没说要看哪个视频");
  const hit = extractBvid(raw);
  if (hit && hit.bvid) return { bvid: hit.bvid };
  if (hit && hit.aid) {
    const j = await httpJson(`https://api.bilibili.com/x/web-interface/view?aid=${hit.aid}`);
    if (j.code === 0) return { bvid: j.data.bvid };
  }
  if (hit && hit.short) {
    const r = await httpText(hit.short);
    const m = String(r.text).match(/BV[0-9A-Za-z]{10}/) || (r.text || "").match(/BV[0-9A-Za-z]{10}/);
    if (m) return { bvid: m[0] };
    throw new Error("短链没跳到一个视频页");
  }
  // 不是链接 → 当搜索词
  const kw = raw.replace(/^(帮我|给我|去|看|看看|总结一下|总结|视频)/g, "").trim() || raw;
  const j = await httpJson(
    "https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=video&page=1&keyword=" + encodeURIComponent(kw)
  );
  const list = (j.data && j.data.result) || [];
  const ok = list.filter((x) => x && x.bvid);
  if (!ok.length) throw new Error("B站没搜到「" + kw + "」，换个说法或者直接把视频链接给我");
  const top = ok[0];
  return {
    bvid: top.bvid,
    searched: kw,
    candidates: ok.slice(0, 5).map((x) => ({
      bvid: x.bvid, title: String(x.title || "").replace(/<[^>]+>/g, ""), up: x.author, duration: x.duration,
    })),
  };
}

async function videoMeta(bvid) {
  const j = await httpJson("https://api.bilibili.com/x/web-interface/view?bvid=" + bvid);
  if (j.code !== 0) throw new Error("拿不到视频信息：" + (j.message || j.code));
  const d = j.data;
  return {
    bvid: d.bvid,
    aid: d.aid,
    cid: d.cid,
    title: d.title,
    up: d.owner && d.owner.name,
    duration: d.duration,
    desc: (d.desc || "").slice(0, 600),
    cover: d.pic,
    pages: (d.pages || []).map((p, i) => ({ i: i + 1, cid: p.cid, title: p.part, duration: p.duration })),
    url: "https://www.bilibili.com/video/" + d.bvid,
  };
}

async function biliCookie() {
  try {
    const ses = session.fromPartition(PART);
    const list = await ses.cookies.get({ domain: ".bilibili.com" });
    return list.map((c) => c.name + "=" + c.value).join("; ");
  } catch (e) { return ""; }
}

async function biliLoggedIn() {
  return /SESSDATA=\S{4,}/.test(await biliCookie());
}

/** 不登录也能查：这个视频到底有没有官方字幕可拿（或必须登录才能拿） */
async function subtitleAvailable(bvid, cid) {
  try {
    const j = await httpJson(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`);
    const d = j.data || {};
    const subs = (d.subtitle && d.subtitle.subtitles) || [];
    return {
      needLogin: !!d.need_login_subtitle,
      count: subs.length,
      vipOnly: /大会员|vip|付费/i.test(JSON.stringify(d.permission || {})),
    };
  } catch (e) { return null; }
}

/** 官方字幕合理性校验。CC 字幕是 UP 主自己挂的文件，真有挂错视频的
 *  （110 秒数学视频挂着 365 条美食探店字幕）。返回问题描述，没问题返回 null。 */
function subtitleSuspicious(lines, duration) {
  if (!Array.isArray(lines) || !lines.length || !(duration > 10)) return null;
  const lastT = lines[lines.length - 1].t || 0;
  if (lastT > duration * 1.35 + 8) {
    return "字幕时间轴都到 " + mmss(lastT) + " 了，视频只有 " + mmss(duration);
  }
  if (lines.length > Math.max(40, duration * 1.2)) {
    return "字幕密度异常（" + lines.length + " 条 / " + duration + " 秒）";
  }
  return null;
}

/** 弹登录窗，等主人扫码。返回 { loggedIn, fresh, cancelled, timeout } */
async function ensureBiliLogin(ctx, opts) {
  if (await biliLoggedIn()) return { loggedIn: true, fresh: false };
  const prog = (ctx && ctx.onProgress) || (() => {});
  const log = (ctx && ctx.log) || (() => {});
  prog({ phase: "need-login" });
  log("waiting for login scan");
  const win = new BrowserWindow({
    width: 860, height: 720, show: true,
    title: "大肥鱼 · 请用手机 B站 App 扫码登录",
    autoHideMenuBar: true,
    webPreferences: { partition: PART, backgroundThrottling: false },
  });
  win.webContents.setUserAgent(UA);
  try { win.setMenuBarVisibility(false); } catch (e) { /* */ }
  await win.loadURL("https://passport.bilibili.com/login").catch(() => {});
  const end = Date.now() + ((opts && opts.waitMs) || 240000);
  while (Date.now() < end) {
    if (await biliLoggedIn()) {
      try { win.destroy(); } catch (e) { /* */ }
      prog({ phase: "login-ok" });
      log("login ok");
      return { loggedIn: true, fresh: true };
    }
    if (win.isDestroyed()) { prog({ phase: "login-cancel" }); return { loggedIn: false, cancelled: true }; }
    await new Promise((r) => setTimeout(r, 1200));
  }
  try { win.destroy(); } catch (e) { /* */ }
  prog({ phase: "login-timeout" });
  return { loggedIn: false, timeout: true };
}

/** 播放中：页面是不是在提示"登录后才能看"（试看结束/会员专属/要付费） */
async function pageNeedsLogin(win) {
  try {
    return await win.webContents.executeJavaScript(
      `(() => {
        const t = (document.body.innerText || "").slice(0, 5000);
        const m = t.match(/试看结束|登录后(免费)?(观看|可(以)?看)|开通大会员|仅大会员(可看|可见)|本片需要会员|成为会员后可(以)?观看|试看\\s*30\\s*秒/);
        return m ? m[0] : null;
      })()`
    );
  } catch (e) { return null; }
}

/** 官方字幕：登录过才有。有的话最省事，秒出。 */
async function officialSubtitle(bvid, cid) {
  const cookie = await biliCookie();
  if (!/SESSDATA=/.test(cookie)) return null;
  try {
    const j = await httpJson(
      `https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`,
      { Cookie: cookie }
    );
    const subs = (j.data && j.data.subtitle && j.data.subtitle.subtitles) || [];
    if (!subs.length) return null;
    // 中文优先
    const pick = subs.find((s) => /zh|ai-zh/i.test(s.lan)) || subs[0];
    let u = pick.subtitle_url || "";
    if (u.startsWith("//")) u = "https:" + u;
    if (!u) return null;
    const body = await httpJson(u);
    const items = (body.body || []).map((x) => ({ t: Number(x.from) || 0, text: String(x.content || "").trim() }));
    return items.filter((x) => x.text);
  } catch (e) {
    return null;
  }
}

/* ---------------- OCR（系统自带 Windows.Media.Ocr） ---------------- */

let ocrBusy = null;
function ocrFile(file, scale, region) {
  // 串行：避免同时开一堆 powershell
  const run = () =>
    new Promise((resolve) => {
      const a = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psPath(), "-Path", file, "-Scale", String(scale || 200)];
      if (region) a.push("-Left", region[0], "-Top", region[1], "-Width", region[2], "-Height", region[3]);
      execFile("powershell.exe", a, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (err, out) => {
        if (err) return resolve({ ok: false, error: err.message });
        try { resolve(JSON.parse(String(out).trim())); } catch (e) { resolve({ ok: false, error: "OCR 输出解析失败" }); }
      });
    });
  const p = ocrBusy ? ocrBusy.then(run, run) : run();
  ocrBusy = p.catch(() => {});
  return p;
}

/** Windows OCR 会把中文每个字之间塞空格，删掉中文与中文之间的空格 */
function cleanOcr(t) {
  return String(t || "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/([\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef])[ ]+(?=[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef])/g, "$1")
    .replace(/[|｜]/g, " ")
    .trim();
}

const JUNK = /bilibili|哔哩哔哩|www\.|\.com|未经作者授权|禁止转载|弹幕|关注|点赞|投币|收藏|分享|发送|高清|倍速|自动|选集|登录|注册/i;

/** 从一帧 OCR 里挑出"字幕那一行"：贴底、居中、有字数、不是水印按钮 */
function pickSubtitleLine(lines, rawW, rawH, scalePct) {
  const k = 100 / (scalePct || 100);
  const cand = [];
  for (const l of lines || []) {
    const t = cleanOcr(l.text);
    if (!t) continue;
    const x = (l.x || 0) * k, y = (l.y || 0) * k, w = (l.w || 0) * k, h = (l.h || 0) * k;
    if (h <= 0) continue;
    if (y + h < rawH * 0.6) continue;               // 只看画面下 40%
    if (y > rawH * 0.985) continue;                 // 压在最底边的控件残影
    if (JUNK.test(t)) continue;
    const len = t.replace(/\s/g, "").length;
    if (len < 4) continue;
    const cx = x + w / 2;
    const off = Math.abs(cx - rawW / 2) / rawW;
    if (off > 0.3) continue;                        // 字幕基本居中
    cand.push({ t, bottom: y + h, off, len });
  }
  if (!cand.length) return null;
  cand.sort((a, b) => b.bottom - a.bottom || a.off - b.off);
  return cand[0].t;
}

/** 像不像 UP 主水印 / B站 logo 的 OCR 误读 */
function looksLikeWatermark(t, upName) {
  const s = norm(t);
  if (!s) return true;
  // 纯字母串（bilibili 常被认成 LiliLili / ViVi 之类）
  if (/^[A-Za-z\s]{4,14}$/.test(String(t).trim())) return true;
  if (!upName) return false;
  const u = norm(upName);
  if (!u) return false;
  if (s.includes(u) || u.includes(s)) return true;
  // OCR 常错一两个字：命中率过半就当水印
  let hit = 0;
  for (const ch of s) if (u.includes(ch)) hit++;
  return s.length >= 3 && hit / s.length > 0.6;
}

/**
 * 整帧的"画面文字"（PPT / 公式 / 图表标注），用于弥补字幕讲不到的信息。
 * 会剔掉顶部/角落的水印、UP 主名、B站 logo 误读。
 */
function frameTopics(lines, rawW, rawH, scalePct, upName) {
  const k = 100 / (scalePct || 100);
  const out = [];
  for (const l of lines || []) {
    const t = cleanOcr(l.text);
    if (!t || JUNK.test(t)) continue;
    if (looksLikeWatermark(t, upName)) continue;
    const x = (l.x || 0) * k, y = (l.y || 0) * k, w = (l.w || 0) * k, h = (l.h || 0) * k;
    if (y + h > rawH * 0.62) continue;              // 只要画面主体的字
    if (y < rawH * 0.055) continue;                 // 贴顶的那条一般就是水印带
    // 角落里的短字（右上角 bilibili / 右下角台标）
    const cx = x + w / 2;
    const corner = cx > rawW * 0.72 || cx < rawW * 0.28;
    if (corner && y < rawH * 0.2) continue;
    const len = t.replace(/\s/g, "").length;
    if (len < 2 || len > 60) continue;
    out.push(t);
  }
  return out.slice(0, 6);
}

/* ---------------- 相似度去重 ---------------- */

function norm(s) { return String(s || "").replace(/[\s，。、！？,.!?""'']/g, ""); }

function similar(a, b) {
  const A = norm(a), B = norm(b);
  if (!A || !B) return false;
  if (A === B) return true;
  if (A.length > 3 && B.length > 3) {
    if (A.includes(B) || B.includes(A)) return true;
    // 前半句相同（OCR 可能多认/少认半句）
    const n = Math.min(A.length, B.length, 8);
    if (A.slice(0, n) === B.slice(0, n)) return true;
  }
  return false;
}

function mmss(s) {
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60), x = s % 60;
  return String(m).padStart(2, "0") + ":" + String(x).padStart(2, "0");
}

/* ---------------- 观看窗口 ---------------- */

const HIDE_DM_CSS = `
  /* 弹幕 + B站往视频上盖的互动浮层（投票/问答/互动弹窗），这些会直接污染 OCR */
  .bpx-player-row-dm-wrap, .bilibili-player-video-danmaku, .bpx-player-dm-wrap,
  .bpx-player-dm-mask-wrap, .bpx-player-new-dialogue-area, .bpx-player-dm-btn-panel,
  .bpx-player-video-interaction, .bpx-player-interaction-wrap, .bilibili-player-video-popup,
  .bpx-player-toast, .bpx-player-ending, .bpx-player-follow, .bpx-player-paytip,
  [class*="dm-mask"], [class*="interaction-wrap"], [class*="video-interaction"],
  [class*="player-paytip"], [class*="login-tip"], [class*="player-ad"] { display: none !important; }
  .bilibili-player-video-btn-danmaku, .bpx-player-control-bottom { display: none !important; }
  * { cursor: none !important; }
`;

async function openWatchWindow(url, opts) {
  // 16:9 最贴合视频，画面四周不会留太多黑边
  const sw = opts.width || 1440;
  const sh = opts.height || Math.round((sw * 9) / 16);
  const win = new BrowserWindow({
    width: sw,
    height: sh,
    show: opts.show !== false,
    title: "大肥鱼在看视频",
    alwaysOnTop: false,
    autoHideMenuBar: true,
    webPreferences: {
      partition: PART,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  win.webContents.setUserAgent(UA);
  win.webContents.setAudioMuted(opts.mute !== false);
  try { win.setMenuBarVisibility(false); } catch (e) { /* */ }
  win.webContents.on("did-finish-load", () => {
    win.webContents.insertCSS(HIDE_DM_CSS).catch(() => {});
  });
  await win.loadURL(url, { extraHeaders: "Accept-Language: zh-CN,zh;q=0.9\r\n" });
  return win;
}

/**
 * 把 <video> 直接搬到全屏容器里。
 * 好处：弹幕、登录浮层、控制条、右侧推荐栏、缓冲提示…全部看不见了，截图就是干净的画面本身，
 *       而且视频铺满窗口，字幕字号比嵌在页面里大一倍（OCR 准确率和模型读图都受益）。
 */
async function isolateVideo(win) {
  return win.webContents
    .executeJavaScript(
      `(() => {
        const v = document.querySelector('video');
        if (!v) return { err: 'no-video' };
        let host = document.getElementById('dfy-stage');
        if (!host) {
          host = document.createElement('div');
          host.id = 'dfy-stage';
          host.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;background:#000;z-index:2147483647;overflow:hidden';
          document.documentElement.appendChild(host);
        }
        if (v.parentElement !== host) host.appendChild(v);
        v.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;display:block';
        v.controls = false;
        v.disablePictureInPicture = true;
        v.setAttribute('playsinline', '');
        // 关掉循环/自动连播：播完就停住最后一帧，不要自己从头再放一遍
        v.loop = false;
        try { v.autoplay = false; } catch (e) {}
        if (!v.__dfyGuard) {
          v.__dfyGuard = true;
          v.addEventListener('ended', () => { try { v.pause(); } catch (e) {} });
          // 有些播放器在结束时会直接改 src 播下一个/重播当前，盯住 src 变化
          v.addEventListener('loadedmetadata', () => {
            if (v.__dfySeen && v.__dfySeen !== v.currentSrc) v.__dfySwitched = true;
            v.__dfySeen = v.currentSrc;
          });
        }
        return { ok: true, w: host.clientWidth, h: host.clientHeight, dur: v.duration || 0 };
      })()`
    )
    .catch((e) => ({ err: e.message }));
}

/** 等播放器就绪，返回视频状态 */
async function waitVideo(win, timeoutMs) {
  const end = Date.now() + (timeoutMs || 25000);
  while (Date.now() < end) {
    const st = await win.webContents
      .executeJavaScript(
        `(() => { const v = document.querySelector('video');
          return v ? { ready: v.readyState, dur: v.duration || 0, cur: v.currentTime || 0, paused: v.paused } : null; })()`
      )
      .catch(() => null);
    if (st && st.ready >= 2 && st.dur > 1) return st;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function startPlay(win, from, rate) {
  return win.webContents
    .executeJavaScript(
      `(() => {
        const v = document.querySelector('video');
        if (!v) return { err: 'no-video' };
        v.muted = true;
        // v.ended 时直接 play() 会从 0 重播，所以结束状态必须强制回到 from
        try { if (v.ended || Math.abs(v.currentTime - ${Number(from) || 0}) > 0.5) v.currentTime = ${Number(from) || 0}; } catch (e) {}
        try { v.playbackRate = ${Number(rate) || 1.5}; } catch (e) {}
        v.play().catch(() => {});
        return { ok: true, dur: v.duration, cur: v.currentTime, rate: v.playbackRate };
      })()`
    )
    .catch((e) => ({ err: e.message }));
}

async function setRate(win, rate) {
  return win.webContents
    .executeJavaScript(
      `(() => { const v = document.querySelector('video'); if (!v) return null;
        try { v.playbackRate = ${Number(rate) || 1}; } catch (e) {}
        return { rate: v.playbackRate, cur: v.currentTime, dur: v.duration, paused: v.paused }; })()`
    )
    .catch(() => null);
}

async function videoState(win) {
  return win.webContents
    .executeJavaScript(
      `(() => { const v = document.querySelector('video'); if (!v) return null;
        return {
          cur: v.currentTime || 0, dur: v.duration || 0, paused: v.paused,
          rate: v.playbackRate, ended: !!v.ended, ready: v.readyState,
          src: String(v.currentSrc || v.src || "").slice(-40)
        }; })()`
    )
    .catch(() => null);
}

/** 收尾时立刻把画面停住：后面还要编码十几张图，不能让它在窗口里继续播甚至重播 */
async function stopPlay(win) {
  return win.webContents
    .executeJavaScript(
      `(() => { const v = document.querySelector('video'); if (!v) return null;
        try { v.pause(); v.loop = false; } catch (e) {}
        return { cur: v.currentTime, dur: v.duration, paused: v.paused }; })()`
    )
    .catch(() => null);
}

/** 缩略灰度指纹，用来判断"画面是不是换了" */
function thumbKey(img) {
  try {
    const small = img.resize({ width: 40, height: 23, quality: "good" });
    const buf = small.toBitmap(); // BGRA
    const out = [];
    for (let i = 0; i < buf.length; i += 4) out.push((buf[i] + buf[i + 1] + buf[i + 2]) / 3);
    return out;
  } catch (e) { return null; }
}

function diffOf(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length / 255;
}

/* ---------------- 主流程 ---------------- */

/**
 * opts: { url|keyword, maxMinutes=20, startAt=0, interval=5, rate=2, show=true, mute=true,
 *         ocr=true, keyframes=8, width, height }
 * ctx:  { log(fn), onProgress(obj) }
 */
async function watchVideo(opts, ctx) {
  opts = opts || {};
  ctx = ctx || {};
  const log = (m) => ctx.log && ctx.log("[watch] " + m);
  const prog = (o) => { try { ctx.onProgress && ctx.onProgress(o); } catch (e) { /* */ } };
  fs.mkdirSync(TMP, { recursive: true });

  const target = opts.url || opts.keyword || opts.q || opts.title;
  const rv = await resolveVideo(target);
  const meta = await videoMeta(rv.bvid);
  log(`video ${meta.bvid} ${meta.title} ${meta.duration}s`);
  prog({ phase: "meta", title: meta.title, duration: meta.duration, up: meta.up, bvid: meta.bvid });

  const interval = Math.min(20, Math.max(2, Number(opts.interval) || 5));
  const rate = Math.min(3, Math.max(0.5, Number(opts.rate) || 1.5));
  const maxSec = Math.min(90 * 60, Math.max(30, (Number(opts.maxMinutes) || 20) * 60));
  const startAt = Math.max(0, Math.min(Number(opts.startAt) || 0, Math.max(0, meta.duration - 5)));
  const wantOcr = opts.ocr !== false;
  const maxKeys = Math.min(14, Math.max(2, opts.keyframes === undefined ? 8 : Number(opts.keyframes)));

  const result = {
    bvid: meta.bvid,
    title: meta.title,
    up: meta.up,
    url: meta.url,
    duration: meta.duration,
    durationText: mmss(meta.duration),
    desc: meta.desc,
    searched: rv.searched,
    candidates: rv.candidates,
    mode: "ocr",
    timeline: [],
    text: "",
    keyframes: [],
    stats: {},
    note: "",
  };

  // ---- 路线 1：官方字幕 ----
  if (opts.mode !== "ocr") {
    let subs = await officialSubtitle(meta.bvid, meta.cid);
    // 没拿到：查一下是不是"这视频明明有字幕、只是没登录"，是的话请主人扫个码
    if ((!subs || !subs.length) && opts.login !== false) {
      const avail = await subtitleAvailable(meta.bvid, meta.cid);
      if (avail && (avail.count > 0 || avail.needLogin) && !(await biliLoggedIn())) {
        log("subtitle needs login, asking");
        const lr = await ensureBiliLogin(ctx, {});
        if (lr.loggedIn) subs = await officialSubtitle(meta.bvid, meta.cid);
      }
    }
    // 官方字幕是 UP 主自己挂的文件，真有挂错视频的（110 秒数学视频挂着 365 条美食探店字幕）。
    // 命中异常就弃用，改走画面识别。
    if (subs && subs.length) {
      const bad = subtitleSuspicious(subs, meta.duration);
      if (bad) {
        log("subtitle suspicious: " + subs.length + " lines / " + meta.duration + "s -> discard, fall back to OCR (" + bad + ")");
        result.note = "这个视频挂的官方字幕和画面对不上（" + bad + "，八成是 UP 主挂错了字幕文件），已经自动改用画面识别看完了。";
        subs = null;
      }
    }
    if (subs && subs.length) {
      log("official subtitle " + subs.length + " lines");
      result.mode = "subtitle";
      result.timeline = compressTimeline(subs.map((x) => ({ t: x.t, text: x.text })));
      result.text = renderTimeline(result.timeline);
      result.stats = { lines: result.timeline.length, source: "bilibili-cc" };
      result.note = "用的是 B 站官方字幕，没有开播放器";
      prog({ phase: "done", mode: "subtitle" });
      return result;
    }
  }

  // ---- 路线 2/3：开窗口真看 ----
  const win = await openWatchWindow(meta.url, opts);
  let winClosed = false;      // 主人手动关的
  let autoClosed = false;     // 鱼自己关的（收工），不算"中途被关掉"
  win.on("closed", () => { if (!autoClosed) winClosed = true; });
  const cleanup = () => {
    autoClosed = true;
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) { /* */ }
  };

  try {
    const st0 = await waitVideo(win, 30000);
    if (!st0) throw new Error("播放器一直没准备好（可能页面卡住或需要登录/验证）");
    prog({ phase: "ready", duration: st0.dur });
    // 把视频抠出来铺满窗口：弹幕/登录浮层/控制条/推荐栏全部消失，画面变大，字幕字号翻倍
    const iso = await isolateVideo(win);
    log("isolate: " + JSON.stringify(iso));
    await startPlay(win, startAt, rate);

    const endAt = Math.min(meta.duration, startAt + maxSec);
    const timeline = [];
    const keys = [];
    let lastKey = null;
    let lastOcrT = -999;
    let frames = 0, ocrCalls = 0, ocrMs = 0, dup = 0;
    let lastAccepted = "";
    let noSubRun = 0;                                  // 连续几帧没读到字幕
    let lastCur = -1, stall = 0, slowed = false;
    // 关键帧：均匀铺开 + 画面突变补拍。先按上限多留，最后再按需要挑
    const keyCap = Math.min(24, Math.max(8, maxKeys + 12));
    const keyGap = Math.max(5, (endAt - startAt) / Math.max(1, keyCap));
    let nextKeyT = startAt + 1;
    let frameW = 0, frameH = 0;
    let peakCur = startAt;                             // 见过的最大进度，用来发现"播完又从头开始"
    let endReason = "";
    // 兜底：墙上时间远超应播时长，说明在空转（重播/连播/卡住），必须收工
    const wallDeadline = Date.now() + ((endAt - startAt) / rate) * 1000 + 90 * 1000;

    while (true) {
      if (winClosed) { endReason = "窗口被关掉了"; break; }
      const s = await videoState(win);
      if (!s) break;
      const cur = s.cur || 0;
      const vdur = s.dur > 1 ? s.dur : meta.duration;

      /* ---- 结束判据（关键）：以前只判 cur>=endAt-0.3，
         700ms 采样一次、1.5 倍速下一跳就 1 秒多，很容易正好跨过这 0.3 秒，
         于是永远等不到"播完"→ 播放器重播/连播下一个 → 无限看下去，只能手动关窗。 ---- */
      if (s.ended) { endReason = "播放器 ended"; break; }                    // 最可靠：原生结束标记
      if (vdur > 1 && cur >= vdur - 1.0) { endReason = "到片尾"; break; }   // 到了视频真实结尾
      if (cur >= endAt - 1.0) { endReason = "到时间上限"; break; }
      if (cur < peakCur - 2) {                                              // 进度倒退 = 自动重播/连播下一个
        // 已经贴近片尾的倒退，其实就是"播完回卷"，按正常看完处理
        endReason = peakCur >= Math.min(vdur, endAt) - 5 ? "到片尾" : "播放器重播了（停在 " + mmss(peakCur) + "）";
        break;
      }
      if (cur > peakCur) peakCur = cur;
      if (Date.now() > wallDeadline) { endReason = "超时收工"; break; }

      // 进度不动（缓冲/暂停/被限速）：先自己救，连续不动太久才放弃
      if (lastCur >= 0 && Math.abs(cur - lastCur) < 0.08) {
        // 停住的位置已经在片尾附近 = 其实播完了，只是播放器还挂着"结束"状态。
        // 这里如果再去 play()，HTML5 会从头开始放 —— 以前就是这样变成"看完又重播"的。
        if (vdur > 1 && cur >= vdur - 2.5) { endReason = "到片尾"; break; }
        stall++;
        // 卡了一小会儿了：看看是不是页面在要登录（试看结束/会员专属）
        if (stall === 4 && opts.login !== false) {
          const why = await pageNeedsLogin(win);
          if (why) {
            log("page asks login: " + why);
            const lr = await ensureBiliLogin(ctx, {});
            if (lr.loggedIn) {
              // 登录成功：刷新页面、重新抠出视频、从断点接着看
              try { await win.loadURL(meta.url); } catch (e) { /* */ }
              await waitVideo(win, 25000);
              await isolateVideo(win);
              await startPlay(win, cur, rate);
              stall = 0;
              lastCur = -1;
              continue;
            }
          }
        }
        if (stall >= 12) {
          result.note = "视频在第 " + mmss(cur) + " 秒卡住不播了（网络缓冲不够，或者需要登录才能继续看）";
          break;
        }
        if (stall === 3 && !slowed) {
          slowed = true;
          await setRate(win, 1);                        // 网速跟不上就降到 1 倍速
          log("stalled -> rate 1x");
        }
        if (s.paused) await startPlay(win, cur, slowed ? 1 : rate);
        await new Promise((r) => setTimeout(r, 900));
        continue;
      }
      stall = 0;
      lastCur = cur;

      let img;
      try {
        img = await win.webContents.capturePage();
      } catch (e) {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      if (!img || img.isEmpty()) { await new Promise((r) => setTimeout(r, 800)); continue; }
      frames++;
      const sz = img.getSize();
      frameW = sz.width; frameH = sz.height;

      // 画面变化 → 可能是一页新 PPT/新图表，留一张关键帧
      const key = thumbKey(img);
      const d = diffOf(key, lastKey);
      const dueByTime = cur >= nextKeyT;
      if (keys.length < keyCap && (dueByTime || (lastKey !== null && d > 0.03))) {
        const kb = img.resize({ width: Math.min(1100, sz.width), quality: "best" }).toJPEG(86);
        keys.push({ t: cur, dataUrl: "data:image/jpeg;base64," + kb.toString("base64"), diff: +d.toFixed(3) });
        if (dueByTime) nextKeyT = cur + keyGap;
      }
      if (key) lastKey = key;

      // OCR：按视频时间节流，不按墙钟（OCR 慢也不会漏）
      if (wantOcr && cur - lastOcrT >= interval) {
        lastOcrT = cur;
        const f = path.join(TMP, "f.jpg");
        try { fs.writeFileSync(f, img.toJPEG(95)); } catch (e) { /* */ }
        const r = await ocrFile(f, 200);
        ocrCalls++;
        if (r.ok) {
          ocrMs += r.ms || 0;
          const sub = pickSubtitleLine(r.lines, sz.width, sz.height, r.scale);
          const topics = frameTopics(r.lines, sz.width, sz.height, r.scale, meta.up);
          if (sub) {
            noSubRun = 0;
            if (similar(sub, lastAccepted)) dup++;
            else {
              timeline.push({ t: cur, text: sub });
              lastAccepted = sub;
            }
          } else {
            // 没字幕（纯画面演示）才拿画面文字顶上；只在连着几帧都没字幕时用，
            // 免得水印/标题闪一下就把字幕流打断
            noSubRun++;
            if (topics.length && noSubRun >= 3) {
              const joined = topics.slice(0, 3).join(" / ");
              if (!similar(joined, lastAccepted)) {
                timeline.push({ t: cur, text: "（画面）" + joined });
                lastAccepted = joined;
              } else dup++;
            } else dup++;
          }
        }
      }

      prog({
        phase: "watching", cur: Math.round(cur), end: Math.round(endAt), dur: meta.duration,
        lines: timeline.length, keys: keys.length, pct: Math.round((cur / endAt) * 100),
      });

      // 快到片尾时把采样间隔收细：不然 1.5 倍速下一跳就跨过结尾，只会看到"回卷到 0"
      const tail = Math.min(vdur, endAt) - cur;
      await new Promise((r) => setTimeout(r, tail < 8 ? 260 : 700));
    }

    log("watch loop end: " + (endReason || "状态丢失"));
    // 先把画面停住，再立刻关掉观看窗口 —— 让主人一眼看出"看完了"，
    // 而不是窗口还停在那儿、以为鱼卡住了要手动关。
    if (!winClosed) {
      await stopPlay(win);
      cleanup();
    }

    result.timeline = compressTimeline(timeline);
    result.text = renderTimeline(result.timeline);
    const watchedTo = Math.min(Math.max(peakCur, startAt), meta.duration);   // 实际看到哪一秒
    if (/重播/.test(endReason)) {
      result.note = "视频播到 " + mmss(watchedTo) + " 就自动重播了，我在这里停下，前面的内容都在。";
    }
    if (/ended|片尾/.test(endReason) && watchedTo < endAt - 8) {
      result.note = (result.note ? result.note + "；" : "") +
        "视频在 " + mmss(watchedTo) + " 就结束了（比总时长短，可能是试看片段或分段视频），后面的内容拿不到。";
    }
    if (winClosed) {
      result.note = (result.note ? result.note + "；" : "") +
        "播放窗口被你中途关掉了，我看到 " + mmss(watchedTo) + " 为止。";
    }

    // OCR 准不准，决定给模型多少张画面：机器认字靠不住，画面多给一点让它自己看
    const q = judgeQuality(result.timeline, Math.max(30, watchedTo - startAt));
    const wantKeys = q.level === "empty" ? 18 : 13;
    const picked = pickEvenly(keys, Math.min(wantKeys, keys.length || wantKeys));
    result.keyframes = picked.map((k) => k.dataUrl);
    result.keyframeInfo = picked.map((k) => ({ at: mmss(k.t) }));
    result.quality = q;
    result.stats = {
      frames,
      ocrCalls,
      ocrSeconds: +(ocrMs / 1000).toFixed(1),
      kept: result.timeline.length,
      duplicates: dup,
      playedTo: mmss(watchedTo),
      rate,
      frameSize: frameW + "x" + frameH,
    };
    result.mode = wantOcr ? "ocr" : "frames";
    if (!result.timeline.length && !keys.length) result.note = "整段没读出任何文字，画面可能太暗/太快，或者一直在放音乐";
    if (q.level === "poor") {
      result.note = (result.note ? result.note + "；" : "") +
        "画面里的字认得不太准（这个视频的字幕是描边花字/手写体），文字只能当线索，具体内容以附上的画面截图为准";
    }
    prog({ phase: "done", mode: result.mode, lines: result.timeline.length });
    return result;
  } finally {
    cleanup();
  }
}

/** 大致判断这次读到的文本可不可信（乱码最明显的特征：日常用字几乎不出现） */
function judgeQuality(tl, watchedSec) {
  const all = tl.map((x) => String(x.text || "")).join("");
  const flat = all.replace(/\s/g, "");
  if (!tl.length || flat.length < 8) {
    return { level: "empty", score: 0, note: "几乎没读到文字" };
  }
  const expect = Math.max(4, Math.round((watchedSec || 60) / 4.5)); // 正常语速约 4~5 秒一句
  const cover = Math.min(1, tl.length / expect);
  const lens = tl.map((x) => String(x.text || "").replace(/\s/g, "").length);
  const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
  const shortRatio = lens.filter((l) => l <= 4).length / lens.length;
  const cjk = (flat.match(/[\u4e00-\u9fa5]/g) || []).length;
  const cjkRatio = cjk / Math.max(1, flat.length);
  // 正常中文里"的了是不我们这那就…"这类高频字占 15%~25%；认成乱码时会趋近 0
  const common = (flat.match(/[的了是不我们你他她它这那就的有和会说要个上来到时为以也都很对能还好么怎什吗呢着把被给让对再又做看说讲]|过|后|前/g) || []).length;
  const commonRatio = common / Math.max(1, flat.length);
  const score = Math.round(
    (cover * 0.3 +
      Math.min(1, avg / 12) * 0.2 +
      (1 - shortRatio) * 0.12 +
      Math.min(1, commonRatio / 0.13) * 0.3 +
      Math.min(1, cjkRatio / 0.9) * 0.08) * 100
  );
  const level = score >= 64 ? "good" : score >= 40 ? "ok" : "poor";
  return {
    level, score,
    cover: +cover.toFixed(2), avgLen: +avg.toFixed(1),
    commonRatio: +commonRatio.toFixed(2), cjkRatio: +cjkRatio.toFixed(2),
  };
}

/** 从关键帧里均匀挑 n 张（首尾都保留） */
function pickEvenly(list, n) {
  if (!list.length) return [];
  if (list.length <= n) return list.slice();
  const out = [];
  for (let i = 0; i < n; i++) out.push(list[Math.round((i * (list.length - 1)) / (n - 1))]);
  return out.filter((x, i, a) => a.indexOf(x) === i);
}

/** 相邻重复合并，太短的碎片并到下一句 */
function compressTimeline(items) {
  const out = [];
  for (const it of items) {
    const t = String(it.text || "").trim();
    if (!t) continue;
    const prev = out[out.length - 1];
    if (prev && similar(prev.text, t)) continue;
    out.push({ t: Math.round(it.t), text: t, screen: it.screen });
  }
  // 连续"（画面）"类的合并
  const merged = [];
  for (const it of out) {
    const p = merged[merged.length - 1];
    if (p && p.text.startsWith("（画面）") && it.text.startsWith("（画面）") && it.t - p.t <= 12) {
      const add = it.text.replace("（画面）", "");
      if (!p.text.includes(add)) p.text = p.text + "；" + add;
      continue;
    }
    merged.push(it);
  }
  return merged;
}

function renderTimeline(list) {
  return list.map((x) => "[" + mmss(x.t) + "] " + x.text).join("\n");
}

/* ---------------- 辅助：只截当前屏幕 OCR（给非 B 站视频用） ---------------- */

async function ocrScreen(region) {
  const { desktopCapturer, screen } = require("electron");
  const disp = screen.getPrimaryDisplay();
  const w = Math.round(disp.size.width * disp.scaleFactor);
  const h = Math.round(disp.size.height * disp.scaleFactor);
  const src = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: w, height: h } });
  if (!src.length) throw new Error("没拿到屏幕画面");
  fs.mkdirSync(TMP, { recursive: true });
  const f = path.join(TMP, "screen.png");
  fs.writeFileSync(f, src[0].thumbnail.toPNG());
  const r = await ocrFile(f, 200);
  if (!r.ok) throw new Error("OCR 失败：" + r.error);
  return {
    text: cleanOcr(r.text),
    lines: (r.lines || []).map((l) => cleanOcr(l.text)),
    ms: r.ms,
    screen: { w, h },
    note: "这是整屏文字。要读视频，优先用 watch_video。",
  };
}

module.exports = {
  watchVideo, ocrScreen, ocrFile, resolveVideo, videoMeta, cleanOcr, mmss,
  ensureBiliLogin, biliLoggedIn, biliCookie, httpJson, httpText, httpPost, httpPostJson, PART, UA,
  subtitleSuspicious,
};
