/**
 * 验证 v1.1.5：菜单迁移（看看屏幕/鼠标绕圈演示 → 主菜单）+ 悬浮模式开关
 * 用法：node build/_verify_v115.js [打包输出目录名]   缺省跑开发目录
 */
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const OUT = process.argv[2] || null;
const ROOT = path.join(__dirname, "..");
const EXE = OUT
  ? path.join(ROOT, OUT, "win-unpacked", (OUT === "dist" ? "DafeiyuPet.exe" : "DafeiyuPetClean.exe"))
  : path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const ARGS = OUT ? ["--remote-debugging-port=9459"] : ["--remote-debugging-port=9459", ROOT];
const PORT = 9459;
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
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error("cdp timeout")); }, 20000);
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

/* 在 #pet 上合成一次完整的左键拖拽：按下（鱼身处 170,380）→ 移动到 (cx,cy) → 原地悬停消速度 → 松手 */
const dragExpr = (cx, cy) => `(() => {
  const p = document.getElementById("pet");
  p.dispatchEvent(new PointerEvent("pointerdown", { clientX: 170, clientY: 380, button: 0, bubbles: true, cancelable: true }));
  for (let i = 1; i <= 4; i++) {
    const t = i / 4;
    p.dispatchEvent(new PointerEvent("pointermove", { clientX: Math.round(170 + (${cx} - 170) * t), clientY: Math.round(380 + (${cy} - 380) * t), button: 0, bubbles: true }));
  }
  for (let i = 0; i < 8; i++) {   /* 原地再“停”一会：hist 全是同一点，松手速度归零，模拟人手松前停顿 */
    p.dispatchEvent(new PointerEvent("pointermove", { clientX: ${cx}, clientY: ${cy}, button: 0, bubbles: true }));
  }
  p.dispatchEvent(new PointerEvent("pointerup", { clientX: ${cx}, clientY: ${cy}, button: 0, bubbles: true, cancelable: true }));
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
    } catch (e) {}
  }
  const pet = (targets || []).find((t) => t.url.includes("pet.html"));
  if (!pet) { console.log("❌ 找不到 pet.html 调试目标"); child.kill(); process.exit(1); }
  await sleep(1500);
  const U = pet.webSocketDebuggerUrl;
  const ev = (expr) => cdpEval(U, expr);

  /* 静音随机行为 + 统一缩放 + 等开机问候说完 */
  await ev(`S.nextIdleFun = 1e12; S.nextDecide = 1e12; S.scale = 1; savePrefs(); "ok"`);
  await sleep(7500);
  const G = Number(await ev(`groundY`)) || 0;       /* 页面里的地面线 */

  console.log("\n—— 菜单迁移 ——");
  await ev(`closeMenus(); window.dispatchEvent(new MouseEvent("contextmenu", { clientX: 170, clientY: 380, bubbles: true })); "ok"`);
  await sleep(300);
  let m1 = JSON.parse(await ev(`(() => {
    const g = (s) => { const e = document.querySelector(s); return e ? e.textContent.trim() : null; };
    return JSON.stringify({ shot: g("#menu [data-act=shot]"), demo: g("#menu [data-act=mousedemo]") });
  })()`));
  check("主菜单有「👀 看看屏幕」", /看看屏幕/.test(m1.shot), m1.shot);
  check("主菜单有「🖱️ 鼠标绕圈演示」", /鼠标绕圈/.test(m1.demo), m1.demo);
  await ev(`showSub("settings", document.querySelector("[data-sub=settings]")); "ok"`);
  await sleep(200);
  let m2 = await ev(`(() => {
    const sub = document.getElementById("submenu");
    return JSON.stringify({ shot: !!sub.querySelector("[data-act=shot]"), demo: !!sub.querySelector("[data-act=mousedemo]"),
      hover: (sub.querySelector("#mi-hover") || {}).textContent || null });
  })()`);
  const m2p = JSON.parse(m2);
  check("设置子菜单已移除这两项", !m2p.shot && !m2p.demo, JSON.stringify(m2p));
  check("设置子菜单出现「🪁 悬浮模式：关」", /悬浮模式：关/.test(m2p.hover), m2p.hover);
  await ev(`closeMenus(); "ok"`);

  console.log("\n—— 悬浮模式 ——");
  /* 默认关：中高度拖拽松手 = 掉落（轮询等它落地，掉落+反弹最多约 3 秒） */
  const waitGround = async () => {
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      const f = Number(await ev(`Math.round(S.y - footPadCur)`));
      if (Math.abs(f - G) <= 4) return f;
    }
    return Number(await ev(`Math.round(S.y - footPadCur)`));
  };
  await ev(`S.throwLock = 0; sysIdleForTest = null; "ok"`);
  await ev(dragExpr(170, 130));                     /* 拖到半空松手 */
  const h0b = await waitGround();
  check("默认（关）：松手后鱼会掉回地面", Math.abs(h0b - G) <= 4, "foot=" + h0b + " ground=" + G);

  /* 开启 */
  await ev(`handleAction("hover"); "ok"`);
  let h1 = JSON.parse(await ev(`JSON.stringify({ on: prefs.hover, ls: localStorage.getItem("dfy_hover") })`));
  check("开关可开（localStorage on）", h1.on === true && h1.ls === "on", JSON.stringify(h1));

  /* 拖到半空松手：原地悬浮，不掉落 */
  await ev(`S.throwLock = 0; "ok"`);
  await ev(dragExpr(170, 130));
  await sleep(200);
  let h2 = JSON.parse(await ev(`JSON.stringify({ state: S.state, y: Math.round(S.y), foot: Math.round(S.y - footPadCur), ground: groundY })`));
  check("拖到半空松手：状态 idle 且悬在空中", h2.state === "idle" && h2.foot < G - 60,
    JSON.stringify(h2));
  await sleep(1300);
  let h3 = await ev(`Math.round(S.y)`);
  check("1.3 秒后位置不变（不掉落）", Math.abs(h3 - h2.y) <= 2, "y=" + h2.y + " → " + h3);

  /* 悬浮中蹦跶：瞬时动画照常落地。
     注意：落地后产品逻辑会把 nextDecide 重置为 1 秒后，鱼随即恢复随机待机行为
     （可能播一段一次性动画 → state 变 special），所以这里只断言"落回地面且蹦跶结束"，
     不苛求 state 一定是 idle。轮询等待，最多 4 秒。 */
  await ev(`S.nextDecide = 1e12; S.nextIdleFun = 1e12; S.hopCount = 1; setState("hop"); startHop(); "ok"`);
  let h4ok = false, h4 = null;
  for (let i = 0; i < 14; i++) {
    await sleep(300);
    h4 = JSON.parse(await ev(`JSON.stringify({ state: S.state, foot: Math.round(S.y - footPadCur) })`));
    if (Math.abs(h4.foot - G) <= 3 && h4.state !== "hop" && h4.state !== "fly") { h4ok = true; break; }
  }
  check("蹦跶后仍会落地", h4ok, JSON.stringify(h4));

  /* 再悬浮一次，然后关掉 → 掉回地面 */
  await ev(`S.throwLock = 0; "ok"`);
  await ev(dragExpr(170, 150));
  await sleep(200);
  let yBefore = await ev(`Math.round(S.y)`);
  await ev(`handleAction("hover"); "ok"`);
  const h5foot = await waitGround();
  let h5 = await ev(`JSON.stringify({ on: prefs.hover, foot: Math.round(S.y - footPadCur) })`);
  const h5p = JSON.parse(h5);
  check("关掉开关：悬浮的鱼掉回地面", h5p.on === false && Math.abs(h5foot - G) <= 4,
    h5 + " (松手时 y=" + yBefore + ")");
  let h6 = JSON.parse(await ev(`JSON.stringify({ menu: (function(){ showSub("settings", document.querySelector("[data-sub=settings]")); closeMenus(); return (document.getElementById("mi-hover")||{}).textContent || ""; })() })`));
  check("菜单行恢复「关」", /悬浮模式：关/.test(h6.menu), h6.menu);
  await ev(`closeMenus(); S.x = screen.width / 2; "ok"`);

  console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
  child.kill();
  await sleep(400);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("异常：" + e.message); process.exit(1); });
