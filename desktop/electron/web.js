/**
 * 通用网页阅读/操作：内嵌一个（可复用的）BrowserWindow 当"鱼的手指和眼睛"。
 * 动机：靠 screenshot 猜坐标去点网页，准确率很低——文字认不全、按钮位置漂移、
 * 弹层挡住。直接在页面 DOM 里读文字、按文字找元素点，是确定性的，不靠猜。
 * 分区沿用 persist:dafeiyu-video，B 站等登录态共享。
 */
const { BrowserWindow } = require("electron");
const video = require("./video.js");

const UA = video.UA;
const PART = video.PART;

let win = null;
let idleTimer = null;

function ensureWin(show) {
  if (win && !win.isDestroyed()) {
    if (show) { try { win.show(); win.moveTop(); } catch (e) { /* */ } }
    return win;
  }
  win = new BrowserWindow({
    width: 1280, height: 900, show: false, title: "大肥鱼的网页",
    autoHideMenuBar: true,
    webPreferences: {
      partition: PART, backgroundThrottling: false,
      contextIsolation: true, nodeIntegration: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  win.webContents.setUserAgent(UA);
  try { win.setMenuBarVisibility(false); } catch (e) { /* */ }
  // target=_blank 的链接就地打开，别弹新窗口（否则点的结果就"丢了"）
  win.webContents.setWindowOpenHandler(({ url }) => {
    try { win.webContents.loadURL(url); } catch (e) { /* */ }
    return { action: "deny" };
  });
  win.on("closed", () => { win = null; });
  return win;
}

/** 8 分钟没人用就自己关掉，别一直挂着占内存 */
function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) { /* */ }
    win = null;
  }, 8 * 60 * 1000);
}

/** 打开一个页面并等它稳定（SPA 要等渲染） */
async function load(url, opts) {
  opts = opts || {};
  const w = ensureWin(opts.show);
  try { w.setAudioMuted(true); } catch (e) { /* */ }
  await w.loadURL(url, { extraHeaders: "Accept-Language: zh-CN,zh;q=0.9\r\n" });
  // 等正文稳定：两轮采样长度不再变 + readyState complete，最多 15 秒
  let lastLen = -1, stable = 0;
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 600));
    const st = await w.webContents
      .executeJavaScript("(() => ({ ready: document.readyState, len: (document.body ? document.body.innerText : '').length, n: document.body ? document.body.querySelectorAll('*').length : 0 }))()")
      .catch(() => null);
    if (!st) continue;
    if (st.ready === "complete" && st.len === lastLen && st.len > 50) {
      stable++;
      if (stable >= 2) break;
    } else stable = 0;
    lastLen = st.len;
  }
  touch();
  return w;
}

/** 读当前页面：标题、正文、链接清单、可点按钮 */
function extract(maxText) {
  return win.webContents.executeJavaScript(`(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none';
    };
    const title = document.title || '';
    let text = (document.body ? document.body.innerText : '') || '';
    text = text.replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n');
    const links = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      if (!vis(a)) continue;
      const t = (a.innerText || a.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
      if (!t || t.length > 60) continue;
      const href = a.href;
      if (!/^https?:/.test(href)) continue;
      const k = t + '|' + href;
      if (seen.has(k)) continue;
      seen.add(k);
      links.push({ text: t, href: href.replace(/([?&])spm_id_from=[^&]*/g, '') });
      if (links.length >= 60) break;
    }
    const buttons = [];
    for (const b of document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')) {
      if (!vis(b)) continue;
      const t = (b.innerText || b.value || b.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
      if (!t || t.length > 30) continue;
      if (!buttons.includes(t)) buttons.push(t);
      if (buttons.length >= 30) break;
    }
    const inputs = [];
    for (const i of document.querySelectorAll('input[type="text"], input[type="search"], input:not([type]), textarea')) {
      if (!vis(i)) continue;
      const t = (i.placeholder || i.name || i.getAttribute('aria-label') || '').trim();
      inputs.push({ placeholder: t || '(无名输入框)', value: i.value || '' });
      if (inputs.length >= 10) break;
    }
    return { title, url: location.href, text: text.slice(0, ${maxText || 9000}), links, buttons, inputs };
  })()`).catch((e) => null);
}

/** 打开网页直接读内容（不靠截图） */
async function readPage(url, opts) {
  opts = opts || {};
  if (!/^https?:\/\//i.test(String(url || ""))) throw new Error("read_page 需要 http(s) 网址");
  const t0 = Date.now();
  const w = await load(url, opts);
  const r = await extract(Number(opts.maxText) || 9000);
  if (!r) throw new Error("页面读不出来（可能加载失败或被站点拒绝）");
  r.elapsed = Math.round((Date.now() - t0) / 100) / 10;
  r.hint = "要看哪个链接/按钮，用 click_page {\"text\":\"…\"} 按 DOM 精确点，不要 screenshot 猜坐标。";
  // 顺手留一张小截图（默认带上，模型眼见为实，但文字为准）
  try {
    const img = await w.webContents.capturePage();
    if (img && !img.isEmpty()) {
      const small = img.resize({ width: Math.min(1100, img.getSize().width), quality: "good" });
      r.shot = "data:image/jpeg;base64," + small.toJPEG(80).toString("base64");
    }
  } catch (e) { /* */ }
  return r;
}

/** 在当前页面里按文字点元素（链接/按钮），点完回报页面变化 */
async function clickPage(text, opts) {
  opts = opts || {};
  if (!win || win.isDestroyed()) throw new Error("现在没有打开的网页，先用 read_page 打开一个");
  const kw = String(text || "").trim();
  if (!kw) throw new Error('click_page 需要 text，例如 {"text":"登录"}');
  const before = await win.webContents
    .executeJavaScript("(() => ({ url: location.href, title: document.title }))()")
    .catch(() => null);
  const hit = await win.webContents
    .executeJavaScript(`(() => {
      const want = ${JSON.stringify(kw)}.toLowerCase().replace(/\\s+/g, '');
      if (!want) return { found: false };
      const sel = 'a[href], button, [role="button"], summary, [onclick], input[type="button"], input[type="submit"]';
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const s = getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none';
      };
      let best = null, bestScore = -1, matched = 0;
      for (const el of document.querySelectorAll(sel)) {
        if (!vis(el)) continue;
        const raw = (el.innerText || el.value || el.getAttribute('title') || el.getAttribute('aria-label') || '').trim();
        if (!raw || raw.length > 80) continue;
        const t = raw.replace(/\\s+/g, '').toLowerCase();
        let sc = 0;
        if (t === want) sc = 100;
        else if (t.startsWith(want)) sc = 82;
        else if (t.includes(want)) sc = 64;
        else if (want.includes(t) && t.length >= 2) sc = 45;
        if (!sc) continue;
        matched++;
        sc -= Math.min(20, raw.length / 6);          // 短而准的优先
        if (sc > bestScore) { bestScore = sc; best = el; }
      }
      if (!best) return { found: false };
      try { best.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
      best.click();                                   // 用页面自己的 click，等价于真点
      return { found: true, matched, tag: best.tagName, text: (best.innerText || best.value || '').replace(/\\s+/g, ' ').trim().slice(0, 40), href: best.href || null };
    })()`)
    .catch(() => null);
  if (!hit || !hit.found) {
    // 没匹配上：把可点的文字报出来，让模型挑
    const r = await extract(0);
    const cand = ((r && r.buttons) || []).slice(0, 15)
      .concat(((r && r.links) || []).slice(0, 15).map((l) => l.text));
    throw new Error("页面上没有文字含「" + kw + "」的可点元素。当前能点的有：" +
      (cand.length ? cand.join(" ｜ ") : "（没读到，可能页面还没加载完）"));
  }
  // 真点（上面的查找已经点过一次；这里确保触发），然后等页面反应
  await new Promise((r) => setTimeout(r, Number(opts.wait) || 1200));
  const after = await win.webContents
    .executeJavaScript("(() => ({ url: location.href, title: document.title }))()")
    .catch(() => null);
  touch();
  return {
    clicked: kw,
    matched: hit.matched,
    element: hit.tag + (hit.href ? " → " + hit.href : ""),
    from: before, to: after,
    changed: !before || !after || before.url !== after.url || before.title !== after.title,
    note: after && after.url !== (before && before.url)
      ? "页面跳转了。要读新页面内容再调一次 read_page（不带 url 就读当前页）。"
      : "页面没跳转（可能是页内切换/弹层）。可以再 read_page 看看内容变了没。",
  };
}

/** 不带 url 时：把当前页面再读一遍 */
async function readCurrent(opts) {
  opts = opts || {};
  if (!win || win.isDestroyed()) throw new Error("现在没有打开的网页，先用 read_page 打开一个");
  const r = await extract(Number(opts.maxText) || 9000);
  if (!r) throw new Error("页面读不出来");
  r.hint = '要看哪个链接/按钮，用 click_page {"text":"…"}。';
  return r;
}

/** 往网页输入框打字（按 placeholder 提示找输入框），enter:true 顺手回车 */
async function typePage(text, opts) {
  opts = opts || {};
  if (!win || win.isDestroyed()) throw new Error("现在没有打开的网页，先用 read_page 打开一个");
  const into = String(opts.into || opts.placeholder || "").trim();
  const r = await win.webContents
    .executeJavaScript(`(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none'; };
      const fields = [...document.querySelectorAll('input[type="text"], input[type="search"], input:not([type]), textarea')].filter(vis);
      const want = ${JSON.stringify(into)}.toLowerCase().replace(/\\s+/g, '');
      let el = null;
      if (want) el = fields.find((f) => ((f.placeholder || '') + (f.name || '') + (f.getAttribute('aria-label') || '')).toLowerCase().replace(/\\s+/g, '').includes(want));
      if (!el) el = fields.find((f) => !f.value);
      if (!el) el = fields[0];
      if (!el) return { found: false, fields: fields.map((f) => f.placeholder || f.name || '(无名)').slice(0, 6) };
      el.focus();
      return { found: true, placeholder: el.placeholder || el.name || '(无名)' };
    })()`)
    .catch(() => null);
  if (!r || !r.found) {
    throw new Error("页面上没找到能打字的输入框" +
      (r && r.fields && r.fields.length ? "（有这些输入框：" + r.fields.join(" ｜ ") + "）" : ""));
  }
  const typed = await win.webContents
    .executeJavaScript(`(() => new Promise((resolve) => {
      const el = document.activeElement;
      if (!el || el.value === undefined) { resolve({ ok: false }); return; }
      el.focus();
      const set = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set;
      set.call(el, ${JSON.stringify(String(text || ""))});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (!${opts.enter ? "true" : "false"}) { resolve({ ok: true, value: el.value, via: 'typed' }); return; }
      // 回车三级兜底：键盘事件 → 表单提交 → 附近的搜索按钮
      const before = location.href;
      try {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      } catch (e) {}
      let via = 'enter';
      setTimeout(() => {
        if (location.href === before) {
          let done = false;
          if (el.form) {
            try { el.form.requestSubmit(); done = true; via = 'form'; } catch (e) { try { el.form.submit(); done = true; via = 'form-submit'; } catch (e2) {} }
          }
          if (!done) {
            const scope = el.closest('form, .nav-search, [class*="search"], header') || document;
            const btn = scope.querySelector('button[type="submit"], [class*="search"][role="button"], [class*="search-btn"], button');
            if (btn) { btn.click(); via = 'button'; }
          }
        }
        setTimeout(() => resolve({ ok: true, value: el.value, url: location.href, via }), 700);
      }, 450);
    }))()`)
    .catch((e) => ({ ok: false, err: String(e) }));
  await new Promise((r2) => setTimeout(r2, opts.enter ? 2000 : 300));
  const st = await win.webContents
    .executeJavaScript("(() => ({ url: location.href, title: document.title }))()")
    .catch(() => null);
  touch();
  return { typed: String(text || ""), into: r.placeholder, ok: !!typed.ok, via: typed.via, page: st, enter: !!opts.enter };
}

function scrollPage(dy) {
  if (!win || win.isDestroyed()) throw new Error("现在没有打开的网页，先用 read_page 打开一个");
  return win.webContents
    .executeJavaScript(`window.scrollBy(0, ${Math.round(Number(dy) || 600)}); ({ y: Math.round(window.scrollY), h: document.body.scrollHeight })`)
    .catch(() => null);
}

function closePage() {
  try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) { /* */ }
  win = null;
  return { closed: true };
}

function isOpen() { return !!(win && !win.isDestroyed()); }

module.exports = { readPage, readCurrent, clickPage, typePage, scrollPage, closePage, isOpen };
