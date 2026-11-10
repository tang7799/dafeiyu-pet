/**
 * B 站 UP 主查询：搜人 → 拿 mid → 按播放量/收藏/最新排序拉视频列表。
 * 为什么不用截屏去点 UP 主页：截图认不全、坐标点不准、翻页点不动；
 * 走"真实浏览器读渲染好的页面"一步到位，播放量明明白白写在卡片上。
 * 依赖 video.js 里的 httpJson / biliCookie / UA / PART（登录态在 persist:dafeiyu-video 分区）。
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const video = require("./video.js");

const httpJson = video.httpJson;

/* ---------------- WBI 签名（B 站接口的通行证） ---------------- */
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 35, 59, 33, 42,
];
let wbiCache = { at: 0, key: "" };

function md5(s) { return crypto.createHash("md5").update(s, "utf8").digest("hex"); }

function enc(v) {
  return encodeURIComponent(String(v)).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

async function mixinKey() {
  if (wbiCache.key && Date.now() - wbiCache.at < 3600e3) return wbiCache.key;
  const nav = await httpJson("https://api.bilibili.com/x/web-interface/nav").catch(() => null);
  const img = nav && nav.data && nav.data.wbi_img && nav.data.wbi_img.img_url;
  const sub = nav && nav.data && nav.data.wbi_img && nav.data.wbi_img.sub_url;
  if (!img || !sub) return "";
  const raw = String(img).split("/").pop().split(".")[0] + String(sub).split("/").pop().split(".")[0];
  const key = MIXIN_TAB.map((i) => raw[i]).join("").slice(0, 32);
  wbiCache = { at: Date.now(), key };
  return key;
}

/** 带 wbi 签名 + 登录 cookie 的 GET */
async function wbiGet(url, params) {
  const key = await mixinKey();
  const cookie = await video.biliCookie();
  const extra = cookie ? { Cookie: cookie } : {};
  if (!key) return httpJson(url, extra);
  const p = { ...params, wts: Math.floor(Date.now() / 1000) };
  const qs = Object.keys(p)
    .sort()
    .map((k) => enc(k) + "=" + enc(p[k]))
    .join("&");
  const w_rid = md5(qs + key);
  return httpJson(url + "?" + qs + "&w_rid=" + w_rid, extra);
}

/* ---------------- 搜 UP 主 ---------------- */
/** 返回 [{mid, name, sign, fans, videos}] */
async function searchUp(keyword) {
  // 注意：搜索接口也认 wbi 签名，不签名会被风控甩回一个 HTML 挑战页
  let rs = [];
  try {
    const j = await wbiGet("https://api.bilibili.com/x/web-interface/wbi/search/type", {
      search_type: "bili_user", keyword: String(keyword), page: 1,
    });
    rs = (j && j.data && j.data.result) || [];
  } catch (e) { rs = []; }
  if (!rs.length) {
    const cookie = await video.biliCookie();
    const j2 = await httpJson(
      "https://api.bilibili.com/x/web-interface/search/type?search_type=bili_user&keyword=" +
        encodeURIComponent(keyword) + "&page=1",
      cookie ? { Cookie: cookie } : {}
    ).catch(() => null);
    rs = (j2 && j2.data && j2.data.result) || [];
  }
  return rs.slice(0, 10).map((r) => ({
    mid: r.mid,
    name: (r.uname || "").replace(/<[^>]+>/g, ""),
    fans: r.fans,
    videos: r.videos,
    sign: String(r.usign || r.sign || "").slice(0, 60),
  }));
}

/* ---------------- 拉 UP 主视频列表 ---------------- */
const ORDER = { play: "click", newest: "pubdate", fav: "stow" };

/** 页内提取：空间页视频卡（.bili-video-card）里的标题 / 播放 / 时长 */
const EXTRACT_CARDS = `(() => {
  const out = [];
  for (const c of document.querySelectorAll('.bili-video-card')) {
    const t = c.querySelector('.bili-video-card__title');
    const a = c.querySelector('a[href*="/video/BV"]');
    if (!a) continue;
    const stats = Array.from(c.querySelectorAll('.bili-cover-card__stat span')).map((s) => (s.innerText || '').trim());
    out.push({
      title: ((t && (t.getAttribute('title') || t.innerText)) || '').trim(),
      url: a.href,
      play: stats[0] || '',
      danmaku: stats[1] || '',
      duration: stats[2] || '',
    });
  }
  const upEl = document.querySelector('.up-name');
  return { up: upEl ? upEl.innerText.trim() : '', title: document.title, videos: out };
})()`;

/**
 * 内嵌真实浏览器打开 UP 空间的"排序"页，把整页视频卡读出来。
 * 为什么不走接口：x/space/wbi/arc/search 被 B 站风控盯得很紧（-352 / HTML 挑战页），
 * 而真实浏览器页面里数据都渲染好了。
 */
async function upVideosDom(mid, orderParam, limit) {
  const { BrowserWindow } = require("electron");
  const win = new BrowserWindow({
    width: 1280, height: 900, show: false, title: "大肥鱼在查 UP",
    webPreferences: {
      partition: video.PART, backgroundThrottling: false,
      contextIsolation: true, nodeIntegration: false, autoplayPolicy: "no-user-gesture-required",
    },
  });
  try {
    win.webContents.setUserAgent(video.UA);
    win.webContents.setAudioMuted(true);
    await win.loadURL("https://space.bilibili.com/" + mid + "/search/video?order=" + orderParam);
    // 等卡片渲染出来
    let n = 0, stable = 0;
    for (let i = 0; i < 26; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const c = await win.webContents
        .executeJavaScript("document.querySelectorAll('.bili-video-card').length")
        .catch(() => 0);
      if (c === n && c > 0) stable++; else stable = 0;
      n = c;
      if ((n >= Math.min(limit, 20) && stable >= 2) || (n > 0 && stable >= 4)) break;
    }
    // 不够还要更多：滚动触发懒加载
    for (let round = 0; round < 3 && n < limit; round++) {
      await win.webContents.executeJavaScript("window.scrollTo(0, document.body.scrollHeight)").catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));
      const c = await win.webContents
        .executeJavaScript("document.querySelectorAll('.bili-video-card').length")
        .catch(() => 0);
      if (c === n) break;
      n = c;
    }
    if (!n) {
      const t = await win.webContents
        .executeJavaScript("document.body ? document.body.innerText.slice(0, 200) : ''")
        .catch(() => "");
      throw new Error("空间页没读到视频卡片。页面内容开头：" + String(t).slice(0, 120));
    }
    return await win.webContents.executeJavaScript(EXTRACT_CARDS).catch(() => ({ up: "", title: "", videos: [] }));
  } finally {
    try { win.destroy(); } catch (e) { /* */ }
  }
}

/** "217.8万" → 2178000 */
function playNum(x) {
  if (typeof x === "number") return x;
  const m = String(x || "").replace(/,/g, "").match(/^([\d.]+)(万|亿)?/);
  if (!m) return 0;
  const base = parseFloat(m[1]);
  return m[2] === "亿" ? base * 1e8 : m[2] === "万" ? base * 1e4 : base;
}

/**
 * 拉某个 UP 的视频，按播放量等排序。
 * up: 关键词或 mid；order: play/newest/fav；limit: 返回几条
 */
async function upVideos(opts) {
  opts = opts || {};
  let mid = Number(opts.mid) || 0;
  let upInfo = null;
  if (!mid) {
    const kw = String(opts.up || opts.keyword || opts.name || "").trim();
    if (!kw) throw new Error('bili_up 需要 up（名字或关键词）或 mid。例：{"up":"李永乐"}');
    const ups = await searchUp(kw);
    if (!ups.length) throw new Error("B 站上没搜到叫「" + kw + "」的 UP 主（换个更准的名字试试）");
    upInfo = ups[0];
    mid = ups[0].mid;
  }

  const order = ORDER[opts.order] ? opts.order : "play";
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || 10));

  // 主路：真实浏览器读空间页（order=click 就是"最多播放"）
  let videos = [];
  let source = "page";
  try {
    const r = await upVideosDom(mid, ORDER[order], limit);
    videos = (r.videos || []).map((v) => ({
      title: v.title,
      url: String(v.url || "").replace(/\?spm_id_from=[^&]*/, ""),
      bvid: (String(v.url).match(/BV[\w]+/) || [""])[0],
      play: v.play,
      playNum: playNum(v.play),
      danmaku: v.danmaku,
      length: v.duration,
    }));
    if (!videos.length) throw new Error("页面读到了但没解析出视频");
  } catch (e) {
    // 兜底：试试 wbi 接口（多多少被风控，但留着无妨）
    source = "api";
    try {
      const j = await wbiGet("https://api.bilibili.com/x/space/wbi/arc/search", {
        mid, ps: Math.min(50, Math.max(20, limit)), pn: 1, order: ORDER[order], platform: "web", keyword: "",
      });
      if (j.code !== 0 || !j.data || !j.data.list) throw new Error("code " + j.code);
      videos = (j.data.list.videos || []).map((v) => ({
        title: String(v.title || "").replace(/<[^>]+>/g, ""),
        url: "https://www.bilibili.com/video/" + v.bvid,
        bvid: v.bvid,
        play: v.play,
        playNum: playNum(v.play),
        length: v.length,
      }));
    } catch (e2) {
      throw new Error("这个 UP 的视频列表拉不到：" + (e && e.message) +
        "。可以稍后再试，或让主人打开 https://space.bilibili.com/" + mid + " 看一眼。");
    }
  }

  if (order === "play") videos.sort((a, b) => b.playNum - a.playNum);

  return {
    mid,
    up: (upInfo && upInfo.name) || opts.up || String(mid),
    upUrl: "https://space.bilibili.com/" + mid,
    fans: upInfo && upInfo.fans,
    order,
    source,
    total: videos.length,
    videos: videos.slice(0, limit).map((v, i) => ({
      rank: i + 1,
      title: v.title,
      play: v.play,
      duration: v.length,
      bvid: v.bvid,
      url: v.url,
    })),
    hint: '播放量最多的就是 rank:1。要"看这个视频讲什么"就直接 watch_video {"url":…}，鱼会自己看完再总结。',
  };
}

/* ================= 评论区：读 + 留言 =================
 * 为什么不用鼠标点评论框：点偏一次就白搭，而且发出去之前主人根本看不见内容。
 * 这里的做法是：接口直接写（登录态复用看视频那个分区），但**发之前弹一个确认窗**，
 * 主人能看到要发到哪、能改内容，点「发布」才真的发。公开发言不能替主人拍板。
 */

/** 从链接 / BV 号 / av 号里认出视频 */function pickBvid(input) {
  const s = String(input || "").trim();
  let m = s.match(/BV[0-9A-Za-z]{10}/);
  if (m) return m[0];
  m = s.match(/(?:^|\/|av)(\d{1,12})(?:$|[/?#&])/i);
  if (m && !/BV/i.test(s)) return "av" + m[1];
  m = s.match(/^av(\d{1,12})$/i);
  if (m) return "av" + m[1];
  if (/^\d{1,12}$/.test(s)) return "av" + s;
  return "";
}

/** 视频基本信息（aid 是评论接口的钥匙） */
async function videoBrief(a) {
  const raw = String((a && (a.url || a.bvid || a.video || a.path || a.id)) || "").trim();
  if (!raw) throw new Error('需要视频链接或 BV 号。例：{"bvid":"BV1xx411c7mD","message":"说得太好了"}');
  const key = pickBvid(raw);
  if (!key) throw new Error("没从「" + raw + "」里认出视频号（要有 BV 号，或者直接粘完整链接）");
  const api = /^av/i.test(key)
    ? "https://api.bilibili.com/x/web-interface/view?aid=" + key.slice(2)
    : "https://api.bilibili.com/x/web-interface/view?bvid=" + key;
  const j = await httpJson(api);
  if (j.code !== 0 || !j.data) throw new Error("找不到这个视频：" + (j.message || j.code));
  const d = j.data;
  return {
    bvid: d.bvid,
    aid: d.aid,
    title: d.title,
    up: (d.owner && d.owner.name) || "",
    upMid: (d.owner && d.owner.mid) || 0,
    desc: String(d.desc || "").slice(0, 200),
    replyCount: (d.stat && d.stat.reply) || 0,
    url: "https://www.bilibili.com/video/" + d.bvid,
  };
}

const REPLY_ERR = {
  "-101": "账号没登录（或者登录态过期了）",
  "-102": "这个账号被封禁了",
  "-111": "csrf 校验失败，登录态可能坏了，重新扫码登录一次",
  "-400": "请求参数有问题",
  "-403": "没有权限（可能是这个视频的评论区有限制）",
  "-404": "视频不存在或已被删除",
  "-412": "被风控拦了（同一个号短时间发太多，或者网络太像机器人）",
  "-509": "请求太频繁被限流了",
  12002: "这个视频的评论区已关闭",
  12009: "评论里有敏感词，被 B 站挡下来了",
  12015: "评论内容不合格（空白、只有表情、或者太长）",
  12035: "UP 主关闭了评论区",
  12051: "发得太频繁了，等一会儿再发",
};

function explain(code, msg) {
  const t = REPLY_ERR[String(code)];
  return t ? t + "（" + msg + "，code " + code + "）" : msg + "（code " + code + "）";
}

/** 读评论区。sort: hot 按热度 / new 按时间 */
async function listComments(a) {
  a = a || {};
  const v = await videoBrief(a);
  const limit = Math.max(1, Math.min(30, Number(a.limit) || 10));
  const wantNew = String(a.sort || a.order || "").toLowerCase() === "new" || a.sort === "time";
  const cookie = await video.biliCookie();

  // 两个接口各有分工：旧 reply/ 能带出置顶评论，main 才能按"最新"排（旧接口 sort=0 未登录返回空）
  const api = wantNew
    ? "https://api.bilibili.com/x/v2/reply/main?type=1&oid=" + v.aid + "&mode=2&ps=" + limit
    : "https://api.bilibili.com/x/v2/reply?type=1&oid=" + v.aid + "&sort=2&ps=" + limit + "&pn=1";
  const j = await httpJson(api, cookie ? { Cookie: cookie } : {});
  if (j.code !== 0) throw new Error("读评论区失败：" + explain(j.code, j.message));

  const d = j.data || {};
  const fmt = (r) => ({
    rpid: String(r.rpid),
    user: (r.member && r.member.uname) || "已注销",
    text: String((r.content && r.content.message) || "").replace(/\s+/g, " ").trim(),
    like: r.like || 0,
    replies: r.rcount || 0,
    isUp: !!(r.member && v.upMid && String(r.member.mid) === String(v.upMid)),
    time: r.ctime ? new Date(r.ctime * 1000).toISOString().slice(0, 16).replace("T", " ") : undefined,
  });

  // 置顶评论单独放，主人经常要回复的其实是它
  const pinned = (d.top_replies || []).filter(Boolean).map(fmt);
  const list = (d.replies || []).filter(Boolean).map((r) => {
    const o = fmt(r);
    const kids = (r.replies || []).filter(Boolean).slice(0, 2).map(fmt);
    if (kids.length) o.topReplies = kids;
    return o;
  });

  return {
    bvid: v.bvid,
    title: v.title,
    up: v.up,
    url: v.url,
    total: v.replyCount,
    sort: wantNew ? "new" : "hot",
    pinned: pinned.length ? pinned : undefined,
    comments: list,
    hint:
      "要回复某一条就用 bili_comment 带上 replyTo:<那条的 rpid>。" +
      (list.length ? "" : "（这个视频还没人评论，你可以留第一条）"),
  };
}

/* ---------- 确认窗（发之前让主人看一眼、改一改） ---------- */
let cmtPending = null;
let cmtIpcReady = false;

function initCommentIpc() {
  if (cmtIpcReady) return;
  cmtIpcReady = true;
  const { ipcMain } = require("electron");
  // 注意：handle 同名只能注册一次，否则第二次会抛错
  ipcMain.handle("dafeiyu-comment-info", (e) => {
    if (cmtPending && !cmtPending.win.isDestroyed() && e.sender === cmtPending.win.webContents) {
      return cmtPending.payload;
    }
    return {};
  });
  ipcMain.on("dafeiyu-comment-reply", (e, p) => {
    if (!cmtPending || cmtPending.win.isDestroyed()) return;
    if (e.sender !== cmtPending.win.webContents) return;
    const finish = cmtPending.finish;
    finish({
      action: p && p.action === "send" ? "send" : "cancel",
      text: String((p && p.text) || ""),
    });
  });
}

function askConfirm(payload, opts) {
  initCommentIpc();
  const { BrowserWindow } = require("electron");
  if (cmtPending) return Promise.resolve({ action: "busy" });
  return new Promise((resolve) => {
    let settled = false;
    const win = new BrowserWindow({
      width: 520,
      height: 512,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      title: "大肥鱼想留个言",
      alwaysOnTop: true,
      autoHideMenuBar: true,
      backgroundColor: "#ffffff",
      webPreferences: {
        preload: path.join(__dirname, "comment_preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    try { win.setMenuBarVisibility(false); } catch (e) { /* */ }

    const finish = (r) => {
      if (settled) return;
      settled = true;
      cmtPending = null;
      try { if (!win.isDestroyed()) win.destroy(); } catch (e) { /* */ }
      resolve(r);
    };

    cmtPending = { win, payload, finish };
    win.once("ready-to-show", () => {
      try { win.show(); win.focus(); } catch (e) { /* */ }
    });
    win.on("closed", () => finish({ action: "cancel", text: "" }));
    win.loadFile(path.join(__dirname, "comment.html")).catch(() => finish({ action: "cancel", text: "" }));
    setTimeout(() => finish({ action: "timeout", text: "" }), (opts && opts.waitMs) || 300000);
  });
}

/* ---------- 发评论 ---------- */
async function postComment(a, ctx) {
  a = a || {};
  const log = (ctx && ctx.log) || (() => {});
  const want = String(a.message || a.content || a.text || a.comment || "").trim();
  if (!want) throw new Error('bili_comment 需要 message（评论内容）。例：{"bvid":"BV1xx411c7mD","message":"讲得真清楚"}');

  const v = await videoBrief(a);
  if (want.length > 1000) throw new Error("B 站一条评论最多 1000 字，现在 " + want.length + " 字，删减一下再发");

  // 1) 登录（没登录就弹扫码窗，和看视频共用同一个登录态）
  if (!(await video.biliLoggedIn())) {
    log("comment: need login");
    const lr = await video.ensureBiliLogin(ctx, {});
    if (!lr.loggedIn) {
      throw new Error(
        lr.timeout
          ? "发评论得先登录 B 站，刚才等了两分钟没扫上码。跟主人说一声，扫码登录后再发。"
          : "主人关掉了登录窗，所以这条评论没发出去。"
      );
    }
  }

  const cookie = await video.biliCookie();
  const jctM = /bili_jct=([^;]+)/.exec(cookie);
  if (!jctM) throw new Error("登录信息里缺 csrf 令牌（bili_jct），请重新扫码登录一次 B 站");
  const csrf = jctM[1];

  // 2) 要回复某条评论的话，先把那条查出来给主人看
  let root = "", parent = "", replyTo = null;
  const target = a.replyTo || a.rpid || a.reply_rpid || "";
  if (target) {
    const t = String(target).trim();
    // 允许直接给楼中楼里的 rpid，也允许给"第3条"这种序号
    let rpid = t;
    if (!/^\d{6,}$/.test(t)) {
      const idx = parseInt(t, 10);
      const cl = await listComments({ bvid: v.bvid, limit: 20 }).catch(() => null);
      if (cl && cl.comments && cl.comments[idx - 1]) rpid = cl.comments[idx - 1].rpid;
    }
    if (/^\d{6,}$/.test(rpid)) {
      root = rpid;
      parent = rpid;
      const one = await httpJson(
        "https://api.bilibili.com/x/v2/reply/reply?type=1&oid=" + v.aid + "&root=" + rpid + "&ps=1&pn=1",
        cookie ? { Cookie: cookie } : {}
      ).catch(() => null);
      const rootInfo = one && one.data && one.data.root ? one.data.root : null;
      if (rootInfo) {
        replyTo = {
          rpid,
          uname: (rootInfo.member && rootInfo.member.uname) || "",
          text: String((rootInfo.content && rootInfo.content.message) || "").slice(0, 120),
        };
      } else {
        replyTo = { rpid, uname: "", text: "" };
      }
    }
  }

  // 3) 主人过目（可改内容）
  const c = await askConfirm({ title: v.title, up: v.up, url: v.url, message: want, replyTo });
  if (c.action === "busy") throw new Error("已经有一个评论确认窗开着了，先把那个处理掉再说");
  if (c.action === "timeout") throw new Error("等了 5 分钟，主人没在确认窗里点「发布」，这条评论没有发出去");
  if (c.action !== "send") throw new Error("主人在确认窗里点了取消，这条评论没有发");

  const finalText = String(c.text || want).trim();
  if (!finalText) throw new Error("评论内容被清空了，没有发");
  if (finalText.length > 1000) throw new Error("主人改完变成 " + finalText.length + " 字，超过 B 站 1000 字上限，没有发");

  // 4) 真发
  const body = { oid: v.aid, type: 1, message: finalText, plat: 1, csrf, ...(root ? { root, parent } : {}) };
  let j = await video.httpPostJson("https://api.bilibili.com/x/v2/reply/add", body, { Cookie: cookie });
  // 偶尔会被风控要签名：带 wbi 再试一次（参数进 body，别重复放 query）
  if (j.code === -412 || j.code === -352) {
    const key = await mixinKey();
    if (key) {
      const p = { ...body, wts: Math.floor(Date.now() / 1000) };
      const qs = Object.keys(p).sort().map((k) => enc(k) + "=" + enc(p[k])).join("&");
      p.w_rid = md5(qs + key);
      j = await video.httpPostJson("https://api.bilibili.com/x/v2/reply/add", p, { Cookie: cookie });
    }
  }
  if (j.code !== 0) throw new Error("评论没发出去：" + explain(j.code, j.message));

  const rpid = j.data && (j.data.rpid_str || j.data.rpid);
  log("comment posted rpid=" + rpid);
  return {
    ok: true,
    posted: true,
    text: finalText,
    edited: finalText !== want,
    bvid: v.bvid,
    title: v.title,
    up: v.up,
    url: v.url,
    replyTo: replyTo ? { user: replyTo.uname, rpid: replyTo.rpid } : undefined,
    rpid: rpid ? String(rpid) : undefined,
    note: "已经用主人的账号发出去了，在视频评论区能看到。跟主人说一声发好了就行，别再把内容重复贴一遍。",
  };
}

module.exports = { searchUp, upVideos, mixinKey, listComments, postComment, videoBrief, askConfirm };
