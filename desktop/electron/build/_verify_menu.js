/**
 * 临时验证：右键菜单不盖鱼、不出屏（菜单模式扩窗方案）
 * 用法：node build/_verify_menu.js [打包输出目录名]   缺省跑开发目录
 */
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const OUT = process.argv[2] || null;
const ROOT = path.join(__dirname, "..");
const EXE = OUT
  ? path.join(ROOT, OUT, "win-unpacked", (OUT === "dist" ? "DafeiyuPet.exe" : "DafeiyuPetClean.exe"))
  : path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const ARGS = OUT ? ["--remote-debugging-port=9452"] : ["--remote-debugging-port=9452", ROOT];
const PORT = 9452;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: p, timeout: 3000 }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

function cdpEval(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error("cdp timeout")); }, 15000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== 1) return;
      clearTimeout(timer); ws.close();
      if (m.result && m.result.exceptionDetails) reject(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 300)));
      else resolve(m.result && m.result.result ? m.result.result.value : undefined);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
  });
}

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + name + (extra !== undefined ? "  → " + extra : ""));
  cond ? pass++ : fail++;
};

const rectsExpr = `(() => {
  const g = (id) => { const r = document.getElementById(id).getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  return JSON.stringify({
    win: { w: innerWidth, h: innerHeight, sx: window.screenX, sy: window.screenY },
    screen: { w: screen.width, h: screen.height },
    menu: g("menu"), sub: g("submenu"),
    pet: g("pet")
  });
})()`;

const openMenu = `(() => {
  closeMenus();
  window.dispatchEvent(new MouseEvent("contextmenu", { clientX: 170, clientY: 380, bubbles: true, cancelable: true }));
  return "ok";
})()`;

(async () => {
  console.log("启动：" + EXE + (OUT ? "" : " （开发目录）"));
  const child = spawn(EXE, ARGS, { env, stdio: "ignore", cwd: ROOT });

  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      targets = await getJson("/json/list");
      if (targets && targets.some((t) => t.url.includes("pet.html"))) break;
    } catch (e) { /* 还没起来 */ }
  }
  const pet = (targets || []).find((t) => t.url.includes("pet.html"));
  if (!pet) { console.log("❌ 找不到 pet.html 调试目标"); child.kill(); process.exit(1); }
  await sleep(1500);

  /* 统一缩放，保证断言可复现 */
  await cdpEval(pet.webSocketDebuggerUrl, `S.scale = 1; savePrefs(); menuMode = null; applyScale(); "ok"`);
  await sleep(400);

  /* 1) 普通位置右键：窗口扩容、菜单在鱼上方、完整在窗口内 */
  await cdpEval(pet.webSocketDebuggerUrl, openMenu);
  await sleep(250);
  let r = JSON.parse(await cdpEval(pet.webSocketDebuggerUrl, rectsExpr));
  check("菜单模式扩窗（420 → " + r.win.h + "px）", r.win.h > 500, "h=" + r.win.h);
  check("主菜单完整在窗口内", r.menu.l >= -0.5 && r.menu.t >= -0.5 && r.menu.r <= r.win.w + 0.5 && r.menu.b <= r.win.h + 0.5,
    `b=${r.menu.b.toFixed(0)} h=${r.win.h}`);
  check("菜单不盖鱼（菜单底 " + Math.round(r.menu.b) + " ≤ 鱼框顶 " + Math.round(r.pet.t) + "）", r.menu.b <= r.pet.t + 1,
    `menu.b=${r.menu.b.toFixed(0)} pet.t=${r.pet.t.toFixed(0)}`);
  check("「退出」整行可见", r.menu.b <= r.win.h + 0.5);

  /* 2) 动画子菜单：在窗口内、不盖鱼、与主菜单并排 */
  await cdpEval(pet.webSocketDebuggerUrl, `showSub("anim", document.querySelector("[data-sub=anim]")); "ok"`);
  await sleep(200);
  r = JSON.parse(await cdpEval(pet.webSocketDebuggerUrl, rectsExpr));
  const sideBySide = (r.sub.r <= r.menu.l + 1) || (r.sub.l >= r.menu.r - 1);
  check("子菜单完整在窗口内", r.sub.l >= -0.5 && r.sub.t >= -0.5 && r.sub.r <= r.win.w + 0.5 && r.sub.b <= r.win.h + 0.5,
    `b=${r.sub.b.toFixed(0)} r=${r.sub.r.toFixed(0)}`);
  check("子菜单不盖鱼", r.sub.b <= r.pet.t + 1, `sub.b=${r.sub.b.toFixed(0)} pet.t=${r.pet.t.toFixed(0)}`);
  check("子菜单与主菜单并排（不叠压）", sideBySide, `sub.l=${r.sub.l.toFixed(0)} menu.r=${r.menu.r.toFixed(0)}`);

  /* 3) 设置子菜单同样不盖鱼 */
  await cdpEval(pet.webSocketDebuggerUrl, `showSub("settings", document.querySelector("[data-sub=settings]")); "ok"`);
  await sleep(200);
  r = JSON.parse(await cdpEval(pet.webSocketDebuggerUrl, rectsExpr));
  check("设置子菜单在窗口内且不盖鱼", r.sub.b <= r.pet.t + 1 && r.sub.r <= r.win.w + 0.5, `b=${r.sub.b.toFixed(0)}`);

  /* 4) 关菜单：窗口恢复鱼自身大小 */
  await cdpEval(pet.webSocketDebuggerUrl, `closeMenus(); "ok"`);
  await sleep(250);
  r = JSON.parse(await cdpEval(pet.webSocketDebuggerUrl, rectsExpr));
  check("关菜单后窗口恢复（" + r.win.w + "×" + r.win.h + "）", r.win.w === 340 && r.win.h === 420, `${r.win.w}x${r.win.h}`);

  /* 5) 鱼贴屏幕右缘：窗口与菜单都不出屏 */
  await cdpEval(pet.webSocketDebuggerUrl, `S.x = screen.width + 120; "ok"`);   /* 循环会钳回右缘 */
  await sleep(300);
  await cdpEval(pet.webSocketDebuggerUrl, openMenu);
  await sleep(250);
  r = JSON.parse(await cdpEval(pet.webSocketDebuggerUrl, rectsExpr));
  check("右缘：窗口整体在屏幕内", r.win.sx >= -0.5 && r.win.sx + r.win.w <= r.screen.w + 0.5,
    `sx=${r.win.sx} w=${r.win.w} screen=${r.screen.w}`);
  check("右缘：菜单完整在屏幕内", r.win.sx + r.menu.r <= r.screen.w - 1 && r.win.sx + r.menu.l >= -0.5,
    `menu.r 屏幕坐标=${(r.win.sx + r.menu.r).toFixed(0)} / ${r.screen.w}`);
  check("右缘：菜单仍不盖鱼", r.menu.b <= r.pet.t + 1);

  /* 6) 鱼贴屏幕左缘 */
  await cdpEval(pet.webSocketDebuggerUrl, `closeMenus(); S.x = -120; "ok"`);
  await sleep(300);
  await cdpEval(pet.webSocketDebuggerUrl, openMenu);
  await sleep(250);
  r = JSON.parse(await cdpEval(pet.webSocketDebuggerUrl, rectsExpr));
  check("左缘：窗口整体在屏幕内", r.win.sx >= -0.5, `sx=${r.win.sx}`);
  check("左缘：菜单完整在屏幕内且不盖鱼", r.win.sx + r.menu.r <= r.screen.w - 1 && r.menu.b <= r.pet.t + 1,
    `menu.r=${(r.win.sx + r.menu.r).toFixed(0)}`);

  /* 7) 收摊还原 */
  await cdpEval(pet.webSocketDebuggerUrl, `closeMenus(); S.x = screen.width / 2; "ok"`);
  await sleep(250);

  /* 8) 关于 / 改名弹窗（非菜单模式）仍在窗口内 */
  await cdpEval(pet.webSocketDebuggerUrl, `handleAction("about"); "ok"`);
  const aboutOk = JSON.parse(await cdpEval(pet.webSocketDebuggerUrl, `(() => {
    const m = document.getElementById("about-box").getBoundingClientRect();
    return JSON.stringify({ b: m.bottom, r: m.right, w: innerWidth, h: innerHeight });
  })()`));
  check("关于弹窗完整可见", aboutOk.b <= aboutOk.h + 0.5 && aboutOk.r <= aboutOk.w + 0.5, `b=${aboutOk.b.toFixed(0)}`);
  await cdpEval(pet.webSocketDebuggerUrl, `closeMenus(); handleAction("rename"); "ok"`);
  const renOk = JSON.parse(await cdpEval(pet.webSocketDebuggerUrl, `(() => {
    const m = document.getElementById("rename-box").getBoundingClientRect();
    return JSON.stringify({ b: m.bottom, r: m.right, w: innerWidth, h: innerHeight });
  })()`));
  check("改名弹窗完整可见", renOk.b <= renOk.h + 0.5 && renOk.r <= renOk.w + 0.5, `b=${renOk.b.toFixed(0)}`);
  await cdpEval(pet.webSocketDebuggerUrl, `document.getElementById("btn-cancel").click(); "ok"`);

  console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
  child.kill();
  await sleep(400);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("异常：" + e.message); process.exit(1); });
