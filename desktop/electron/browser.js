/**
 * 浏览器收藏夹（书签）：直接读 Chromium 系浏览器落盘的 Bookmarks JSON。
 * 为什么要这么做：靠截屏 + 点收藏夹栏坐标去找，点偏一点就全错，
 * 而且收藏夹折叠起来的内容根本点不到。读文件既准又快，还能按名字模糊搜。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const LA = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const ROAM = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");

function exists(p) { try { return fs.existsSync(p); } catch (e) { return false; } }

/** 支持的浏览器：书签目录 + 可执行文件候选（用于"在它自己的浏览器里打开"，保住登录态） */
const BROWSERS = [
  {
    id: "edge", name: "Edge",
    userData: path.join(LA, "Microsoft", "Edge", "User Data"),
    exe: [
      path.join(LA, "Microsoft", "Edge", "Application", "msedge.exe"),
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
  },
  {
    id: "chrome", name: "Chrome",
    userData: path.join(LA, "Google", "Chrome", "User Data"),
    exe: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      path.join(LA, "Google", "Chrome\\Application", "chrome.exe"),
    ],
  },
  {
    id: "quark", name: "夸克",
    userData: path.join(LA, "Quark", "User Data"),
    exe: [path.join(LA, "Quark", "Quark.exe"), "C:\\Program Files\\Quark\\Quark.exe"],
  },
  {
    id: "360", name: "360浏览器",
    userData: path.join(LA, "360Chrome", "Chrome", "User Data"),
    exe: [path.join(LA, "360Chrome", "Chrome\\Application", "360chrome.exe")],
  },
  {
    id: "qq", name: "QQ浏览器",
    userData: path.join(LA, "Tencent", "QQBrowser", "User Data"),
    exe: ["C:\\Program Files (x86)\\Tencent\\QQBrowser\\QQBrowser.exe", "C:\\Program Files\\Tencent\\QQBrowser\\QQBrowser.exe"],
  },
  {
    id: "brave", name: "Brave",
    userData: path.join(LA, "BraveSoftware", "Brave-Browser", "User Data"),
    exe: ["C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"],
  },
  {
    id: "sogou", name: "搜狗浏览器",
    userData: path.join(ROAM, "SogouExplorer"),
    exe: ["C:\\Program Files (x86)\\SogouExplorer\\SogouExplorer.exe"],
  },
];

/** 列出某个浏览器下所有带 Bookmarks 的配置目录 */
function profilesOf(b) {
  const out = [];
  if (!exists(b.userData)) return out;
  let names = [];
  try { names = fs.readdirSync(b.userData); } catch (e) { return out; }
  for (const n of names) {
    const f = path.join(b.userData, n, "Bookmarks");
    if (exists(f)) out.push({ profile: n, file: f });
  }
  // 个别浏览器直接把 Bookmarks 放在 User Data 根下
  const rootFile = path.join(b.userData, "Bookmarks");
  if (exists(rootFile)) out.push({ profile: "", file: rootFile });
  return out;
}

function walkNode(node, out, folder, meta) {
  const kids = (node && node.children) || [];
  for (const c of kids) {
    if (!c) continue;
    if (c.type === "url" && c.url) {
      out.push({
        name: String(c.name || "").trim() || String(c.url),
        url: String(c.url),
        folder: folder || "",
        browser: meta.name,
        browserId: meta.id,
        profile: meta.profile,
      });
    } else if (c.type === "folder" || c.children) {
      const name = String(c.name || "").trim();
      walkNode(c, out, folder ? folder + "/" + name : name, meta);
    }
  }
}

function readOne(file, meta) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) { return []; }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  let data;
  try { data = JSON.parse(raw); } catch (e) { return []; }
  const roots = data.roots || {};
  const out = [];
  for (const key of Object.keys(roots)) {
    const node = roots[key];
    if (!node) continue;
    const label = node.name || ({ bookmark_bar: "收藏夹栏", other: "其他收藏夹", synced: "移动收藏夹" }[key] || key);
    walkNode(node, out, label, meta);
  }
  return out;
}

let CACHE = { at: 0, data: null };
const TTL = 20000;

/** 读出所有浏览器收藏（带 20 秒缓存，避免反复读盘） */
function loadAll(force) {
  if (!force && CACHE.data && Date.now() - CACHE.at < TTL) return CACHE.data;
  const items = [];
  const sources = [];
  for (const b of BROWSERS) {
    for (const p of profilesOf(b)) {
      const got = readOne(p.file, { id: b.id, name: b.name, profile: p.profile });
      if (got.length) {
        items.push(...got);
        sources.push({ browser: b.name, profile: p.profile || "(根)", count: got.length, file: p.file });
      } else {
        sources.push({ browser: b.name, profile: p.profile || "(根)", count: 0, file: p.file });
      }
    }
  }
  // 去重（同一个网址在多个浏览器/配置里重复收藏）
  const seen = new Set();
  const uniq = [];
  for (const it of items) {
    const k = it.url.replace(/#.*$/, "").replace(/\/$/, "").toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(it);
  }
  const data = { items: uniq, sources, at: Date.now() };
  CACHE = { at: Date.now(), data };
  return data;
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\s\u3000]/g, "")
    .replace(/[，。、！？,.!?"""''（）()【】\[\]《》<>:：;；]/g, "");
}

/** 模糊搜索收藏：名字命中 > 网址命中；支持"百度的网址"这种带废话的说法 */
function search(keyword, opts) {
  opts = opts || {};
  const all = (opts.all || loadAll()).items;
  const kwRaw = String(keyword || "").trim();
  if (!kwRaw) {
    return all.slice(0, Math.max(1, Math.min(200, Number(opts.limit) || 40)));
  }
  const kw = norm(kwRaw);
  const parts = kwRaw.split(/[\s,，]+/).map(norm).filter(Boolean);
  const scored = [];
  for (const it of all) {
    const n = norm(it.name);
    const u = norm(it.url);
    const host = norm((it.url.match(/^[a-z]+:\/\/([^/?#]+)/i) || [])[1] || "");
    let score = 0;
    if (n === kw) score = 100;
    else if (n.startsWith(kw)) score = 88;
    else if (n.includes(kw)) score = 76;
    else if (kw.includes(n) && n.length >= 2) score = 70;      // "百度的网址" → 名字"百度"
    else if (host.includes(kw)) score = 62;
    else if (u.includes(kw)) score = 52;
    if (!score && parts.length > 1 && parts.every((p) => n.includes(p) || u.includes(p))) score = 48;
    if (!score && parts.length === 1) {
      const p = parts[0];
      if (p.length >= 2 && (n.includes(p) || u.includes(p))) score = 40;
    }
    if (score) scored.push({ ...it, score, _len: n.length });
  }
  scored.sort((a, b) => b.score - a.score || a._len - b._len || a.name.localeCompare(b.name));
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || 12));
  return scored.slice(0, limit).map(({ _len, ...rest }) => rest);
}

function exeOf(browserId) {
  const b = BROWSERS.find((x) => x.id === browserId);
  if (!b) return null;
  for (const e of b.exe) if (e && exists(e)) return e;
  return null;
}

/** 在收藏所属的那个浏览器里打开（保住登录态）；不行就退回默认浏览器 */
function launch(item) {
  const exe = exeOf(item.browserId);
  if (exe) {
    const args = ["--new-tab", item.url];
    if (item.profile && item.profile !== "(根)") args.push("--profile-directory=" + item.profile);
    try {
      const child = spawn(exe, args, { detached: true, stdio: "ignore" });
      child.unref();
      return { via: item.browser + "（新标签页）", exe };
    } catch (e) { /* 落到下面 */ }
  }
  const { shell } = require("electron");
  shell.openExternal(item.url);
  return { via: "系统默认浏览器" };
}

/** 打开一个收藏：name 可以是收藏名/域名/关键词 */
function openBookmark(name, opts) {
  opts = opts || {};
  const all = loadAll(true);
  if (!all.items.length) {
    return {
      found: false,
      message: "一个收藏都没读到。可能这台电脑用的是 Firefox/IE，或者浏览器版本把书签存在数据库里。",
      sources: all.sources,
    };
  }
  const hits = search(name, { all, limit: 12 });
  if (!hits.length) {
    return {
      found: false,
      message: "收藏夹里没有名字/网址含「" + String(name || "") + "」的收藏。",
      total: all.items.length,
      samples: all.items.slice(0, 12).map((x) => x.name + " → " + x.url),
    };
  }
  const best = hits[0];
  let how;
  try { how = launch(best); } catch (e) { how = { via: "打开失败：" + (e && e.message) }; }
  return {
    found: true,
    opened: { name: best.name, url: best.url, browser: best.browser, folder: best.folder },
    via: how.via,
    alternatives: hits.slice(1, 6).map((x) => ({ name: x.name, url: x.url, browser: x.browser })),
    note: hits.length > 1 ? "另有 " + (hits.length - 1) + " 个相近的收藏，要换一个就直接说名字。" : undefined,
  };
}

/** 给工具用的清单 */
function listBookmarks(opts) {
  opts = opts || {};
  const all = loadAll();
  const kw = opts.keyword || opts.q || opts.name || "";
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || (kw ? 12 : 60)));
  const items = kw ? search(kw, { all, limit }) : all.items.slice(0, limit);
  return {
    keyword: kw || undefined,
    total: all.items.length,
    browsers: all.sources.filter((s) => s.count > 0).map((s) => s.browser + "(" + s.profile + "): " + s.count),
    count: items.length,
    items: items.map((x) => ({ name: x.name, url: x.url, folder: x.folder, browser: x.browser })),
    hint: kw
      ? "要打开哪一个就直接用 open_bookmark，name 填收藏名即可，不用点界面。"
      : "这是全部收藏（最多 " + limit + " 条）。找具体的用 keyword 过滤。",
  };
}

module.exports = { loadAll, search, openBookmark, listBookmarks, BROWSERS, exeOf };
