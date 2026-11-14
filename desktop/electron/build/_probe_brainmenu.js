/**
 * 复现：点击「🧠 大脑」后页面消失
 * 用法：node build/_probe_brainmenu.js [打包目录名]
 * 流程：右键开菜单 → 点击「设置」→ 真实 dispatch click 到大脑行 → 观察异常/菜单/窗口状态
 */
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const OUT = process.argv[2] || null;
const ROOT = path.join(__dirname, "..");
const fs = require("fs");
function pickExe(dir) {
  const base = path.join(ROOT, dir, "win-unpacked");
  for (const name of ["DafeiyuPet.exe", "DafeiyuPetClean.exe"]) {
    if (fs.existsSync(path.join(base, name))) return path.join(base, name);
  }
  return path.join(base, "DafeiyuPet.exe");
}
const EXE = OUT ? pickExe(OUT) : path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const ARGS = OUT ? ["--remote-debugging-port=9453"] : ["--remote-debugging-port=9453", ROOT];
const PORT = 9453;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: p, timeout: 3000 }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

function cdpSend(wsUrl, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error("cdp timeout")); }, timeoutMs || 15000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === method && m.params) { /* event */ }
      if (m.id !== 1) return;
      clearTimeout(timer); ws.close();
      resolve(m);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
  });
}

async function cdpEval(wsUrl, expression) {
  const m = await cdpSend(wsUrl, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (m.result && m.result.exceptionDetails) {
    const d = m.result.exceptionDetails;
    throw new Error("EVAL异常: " + ((d.exception && d.exception.description) || d.text || "").slice(0, 400));
  }
  return m.result && m.result.result ? m.result.result.value : undefined;
}

/* 开启 Runtime 域抓 console 异常 */
function catchExceptions(wsUrl, bucket) {
  const ws = new WebSocket(wsUrl);
  ws.onopen = () => ws.send(JSON.stringify({ id: 99, method: "Runtime.enable", params: {} }));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      bucket.push(((d.exception && d.exception.description) || d.text || "").slice(0, 500));
    }
  };
  return ws;
}

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;

(async () => {
  console.log("启动：" + EXE + (OUT ? "" : " （开发目录）"));
  const child = spawn(EXE, ARGS, { env, stdio: "ignore", cwd: ROOT });

  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      targets = await getJson("/json/list");
      if (targets && targets.some((t) => t.url.includes("pet.html"))) break;
    } catch (e) {}
  }
  const pet = (targets || []).find((t) => t.url.includes("pet.html"));
  if (!pet) { console.log("❌ 找不到 pet.html 调试目标"); child.kill(); process.exit(1); }
  await sleep(1500);
  const ws = pet.webSocketDebuggerUrl;
  const errs = [];
  const catchWs = catchExceptions(ws, errs);

  await sleep(600);
  await cdpEval(ws, `S.scale = 1; savePrefs(); menuMode = null; applyScale(); "ok"`);

  /* ① 右键开菜单 */
  await cdpEval(ws, `(() => {
    closeMenus();
    window.dispatchEvent(new MouseEvent("contextmenu", { clientX: 170, clientY: 380, bubbles: true, cancelable: true }));
    return "ok";
  })()`);
  await sleep(300);

  /* ② 真实点击「设置」行（menuEl click 委托） */
  const clickSettings = await cdpEval(ws, `(() => {
    const it = menuEl.querySelector('[data-sub="settings"]');
    if (!it) return "no-settings-item";
    it.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return "clicked";
  })()`);
  await sleep(300);
  console.log("点设置 →", clickSettings);

  /* ③ 真实点击「大脑」行（submenuEl click 委托 → showSub("brain")） */
  const clickBrain = await cdpEval(ws, `(() => {
    const orig = closeMenus;
    window.__cmStack = [];
    closeMenus = function () {
      window.__cmStack.push(new Error("closeMenus 调用点").stack);
      return orig.apply(this, arguments);
    };
    const it = submenuEl.querySelector('[data-act="brain"]');
    if (!it) return "no-brain-item";
    it.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return "clicked";
  })()`);
  await sleep(400);
  console.log("点大脑 →", clickBrain);
  const cmStack = await cdpEval(ws, `(window.__cmStack || []).join("\\n=====\\n")`);
  console.log("\ncloseMenus 堆栈：\n" + cmStack);

  /* ④ 观察状态 */
  const st = await cdpEval(ws, `(() => {
    const m = document.getElementById("menu"), s = document.getElementById("submenu");
    const r = (el) => { const b = el.getBoundingClientRect();
      return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
    return JSON.stringify({
      menuShow: m.style.display, subShow: s.style.display,
      subCur: s.dataset.cur || "",
      subHTML: s.innerHTML.slice(0, 300),
      win: { w: innerWidth, h: innerHeight, sx: window.screenX, sy: window.screenY },
      screen: { w: screen.width, h: screen.height },
      menuRect: r(m), subRect: r(s),
      menuMode: menuMode ? { offX: menuMode.offX, offY: menuMode.offY } : null,
      brainListN: (typeof brainList !== "undefined") ? brainList.length : -1,
      brainNow: (typeof brainNow !== "undefined") ? brainNow : null
    });
  })()`);
  console.log("\n状态：", JSON.stringify(JSON.parse(st), null, 2));

  await sleep(800);
  console.log("\nRuntime 异常（" + errs.length + " 条）：");
  errs.forEach((e, i) => console.log("  [" + i + "] " + e.split("\n").slice(0, 4).join(" | ")));

  /* ⑤ 回归：点空白处仍要收菜单 */
  await cdpEval(ws, `document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 })); "ok"`);
  await sleep(200);
  const after = JSON.parse(await cdpEval(ws, `JSON.stringify({ m: menuEl.style.display, s: submenuEl.style.display })`));
  console.log("\n点空白收菜单 →", after.m === "none" && after.s === "none" ? "✅ 正常关闭" : "❌ " + JSON.stringify(after));

  /* ⑥ 回归：设置子菜单里点开关行（碎碎念）不再消失 */
  await cdpEval(ws, `(() => {
    closeMenus();
    window.dispatchEvent(new MouseEvent("contextmenu", { clientX: 170, clientY: 380, bubbles: true, cancelable: true }));
    return "ok";
  })()`);
  await sleep(300);
  await cdpEval(ws, `menuEl.querySelector('[data-sub="settings"]').dispatchEvent(new MouseEvent("click", { bubbles: true })); "ok"`);
  await sleep(250);
  const t1 = await cdpEval(ws, `(function(){ const e = submenuEl.querySelector('[data-act="murmur"]'); if (!e) return "no-row"; e.dispatchEvent(new MouseEvent("click", { bubbles: true })); return "clicked"; })()`);
  await sleep(250);
  const t2 = JSON.parse(await cdpEval(ws, `JSON.stringify({
    m: menuEl.style.display, s: submenuEl.style.display,
    murmur: (document.getElementById("mi-murmur") || {}).textContent || ""
  })`));
  console.log("点碎碎念开关 →", t1, t2.m === "block" && t2.s === "block" && /开|关/.test(t2.murmur)
    ? "✅ 菜单保持，文案=" + t2.murmur
    : "❌ " + JSON.stringify(t2));

  try { catchWs.close(); } catch (e) {}
  child.kill();
  await sleep(400);
  process.exit(0);
})().catch((e) => { console.log("异常：" + e.message); process.exit(1); });
