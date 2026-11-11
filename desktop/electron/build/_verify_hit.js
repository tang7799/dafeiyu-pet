/**
 * 临时验证：小手/抓取/右键只在鱼身上或附近生效（v1.1.7 体验修正，不改版本号）
 * 用法：node build/_verify_hit.js [打包输出目录名]   缺省跑开发目录
 */
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const OUT = process.argv[2] || null;
const ROOT = path.join(__dirname, "..");
const EXE = OUT
  ? path.join(ROOT, OUT, "win-unpacked", (OUT === "dist" ? "DafeiyuPet.exe" : "DafeiyuPetClean.exe"))
  : path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const ARGS = OUT ? ["--remote-debugging-port=9463"] : ["--remote-debugging-port=9463", ROOT];
const PORT = 9463;
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
  const petT = (targets || []).find((t) => t.url.includes("pet.html"));
  if (!petT) { console.log("❌ 找不到 pet.html 调试目标"); child.kill(); process.exit(1); }
  await sleep(1500);
  const E = (expr) => cdpEval(petT.webSocketDebuggerUrl, expr);

  /* 统一缩放，关随机行为 */
  await E(`S.scale = 1; savePrefs(); menuMode = null; applyScale(); prefs.hover = false; savePrefs(); nextDecide = 1e12; S.nextIdleFun = 1e12; "ok"`);
  await sleep(400);

  /* 鱼身中心（窗口内 + 屏幕两套坐标）与远离点 */
  const fc = JSON.parse(await E(`(() => {
    const r = fishRect();
    return JSON.stringify({ cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2,
      scx: (r.left + r.right) / 2 + window.screenX, scy: (r.top + r.bottom) / 2 + window.screenY,
      l: r.left, r: r.right, t: r.top, b: r.bottom, winW: innerWidth, winH: innerHeight });
  })()`));
  const far = { x: Math.round(fc.winW / 2), y: 12 };      /* 窗口顶部：鱼上方远处透明区 */
  const farS = { x: far.x + (await E("window.screenX")), y: far.y + (await E("window.screenY")) };
  console.log("鱼身矩形:", JSON.stringify({ l: Math.round(fc.l), t: Math.round(fc.t), r: Math.round(fc.r), b: Math.round(fc.b) }),
    "窗口:", fc.winW + "x" + fc.winH);
  const mvNear = `window.dispatchEvent(new PointerEvent("pointermove", { clientX: ${fc.cx}, clientY: ${fc.cy}, screenX: ${fc.scx}, screenY: ${fc.scy}, bubbles: true })); "ok"`;
  const mvFar = `window.dispatchEvent(new PointerEvent("pointermove", { clientX: ${far.x}, clientY: ${far.y}, screenX: ${farS.x}, screenY: ${farS.y}, bubbles: true })); "ok"`;
  const bodyCls = `JSON.stringify({ near: document.body.classList.contains("near-fish"), drag: document.body.classList.contains("dragging") })`;

  /* 1) 初始：没动过鼠标，不应有小手 */
  let st = JSON.parse(await E(bodyCls));
  check("初始无小手（没碰过鱼）", !st.near && !st.drag);

  /* 2) 鼠标挪到鱼身上 → 小手出现；挪远 → 消失 */
  await E(mvNear);
  st = JSON.parse(await E(bodyCls));
  check("鼠标在鱼身上 → near-fish 出现", st.near === true);

  await E(mvFar);
  st = JSON.parse(await E(bodyCls));
  check(`鼠标挪远(${far.x},${far.y}) → near-fish 消失`, st.near === false);

  /* 2b) 像素级：动画框内、但压在鱼身上方透明区 → 不应出现小手 */
  const fr = JSON.parse(await E(`(() => {
    const p = pet.getBoundingClientRect(), r = fishRect();
    return JSON.stringify({ ft: p.top, bt: r.top, bl: r.left, br: r.right });
  })()`));
  const gap = { x: Math.round((fr.bl + fr.br) / 2), y: Math.round(fr.ft + 5) };
  await E(`window.dispatchEvent(new PointerEvent("pointermove", { clientX: ${gap.x}, clientY: ${gap.y}, screenX: ${gap.x} + window.screenX, screenY: ${gap.y} + window.screenY, bubbles: true })); "ok"`);
  st = JSON.parse(await E(bodyCls));
  check(`框内透明区(${gap.x},${gap.y}) → 仍无小手（像素级判定）`, st.near === false);

  /* 3) 鱼拖着窗口游走，静止鼠标原地失去小手（每帧按屏幕坐标校正） */
  await E(`document.body.classList.add("near-fish");
    lastMouse.sx = ${fc.scx}; lastMouse.sy = ${fc.scy};
    S.x += 260; clampX();                    /* 鱼挪走：窗口跟着跑，屏幕上鼠标点不再压着鱼 */
    "ok"`);
  await sleep(500);                          /* 等主循环跑几帧 refreshCursor */
  st = JSON.parse(await E(bodyCls));
  check("鱼游走后原地鼠标失去小手（屏幕坐标校正）", st.near === false);

  /* 4) 远处右键：菜单不弹 */
  await E(`closeMenus(); "ok"`);
  await E(`window.dispatchEvent(new MouseEvent("contextmenu", { clientX: ${far.x}, clientY: ${far.y}, bubbles: true, cancelable: true })); "ok"`);
  st = JSON.parse(await E(`JSON.stringify({ open: document.getElementById("menu").style.display === "block" })`));
  check("远处右键 → 菜单不弹", st.open === false);

  /* 5) 鱼身上右键：菜单弹出 */
  await E(`window.dispatchEvent(new MouseEvent("contextmenu", { clientX: ${fc.cx}, clientY: ${fc.cy}, bubbles: true, cancelable: true })); "ok"`);
  st = JSON.parse(await E(`JSON.stringify({ open: document.getElementById("menu").style.display === "block" })`));
  check("鱼身上右键 → 菜单弹出", st.open === true);
  await E(`closeMenus(); "ok"`);

  /* 6) 远处按下：不进入拖拽 */
  await E(`S.dragging = false; "ok"`);
  await E(`pet.dispatchEvent(new PointerEvent("pointerdown", { clientX: ${far.x}, clientY: ${far.y}, screenX: ${farS.x}, screenY: ${farS.y}, button: 0, bubbles: true, cancelable: true })); "ok"`);
  st = JSON.parse(await E(`JSON.stringify({ drag: S.dragging, cls: document.body.classList.contains("dragging") })`));
  check("远处按下 → 不抓取", st.drag === false && st.cls === false);

  /* 7) 鱼身上按下：进入拖拽 + 抓取光标；松手后恢复 */
  await E(mvNear);
  await E(`pet.dispatchEvent(new PointerEvent("pointerdown", { clientX: ${fc.cx}, clientY: ${fc.cy}, screenX: ${fc.scx}, screenY: ${fc.scy}, button: 0, bubbles: true, cancelable: true })); "ok"`);
  st = JSON.parse(await E(`JSON.stringify({ drag: S.dragging, cls: document.body.classList.contains("dragging") })`));
  check("鱼身上按下 → 拖拽 + dragging 光标类", st.drag === true && st.cls === true);

  await E(`pet.dispatchEvent(new PointerEvent("pointerup", { clientX: ${fc.cx}, clientY: ${fc.cy}, screenX: ${fc.scx}, screenY: ${fc.scy}, button: 0, bubbles: true, cancelable: true })); "ok"`);
  st = JSON.parse(await E(`JSON.stringify({ drag: S.dragging, cls: document.body.classList.contains("dragging") })`));
  check("松手 → dragging 类清除", st.drag === false && st.cls === false);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  child.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("验证脚本异常:", e.message); process.exit(2); });
