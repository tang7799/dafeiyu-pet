/**
 * 临时验证：社区功能批次（陪工 / CPU 状态鱼 / 喝水提醒 / 时段问候+节日 / 连点生气）
 * 用法：node build/_verify_batch.js [打包输出目录名]   缺省跑开发目录
 */
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const OUT = process.argv[2] || null;
const ROOT = path.join(__dirname, "..");
const EXE = OUT
  ? path.join(ROOT, OUT, "win-unpacked", (OUT === "dist" ? "DafeiyuPet.exe" : "DafeiyuPetClean.exe"))
  : path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const ARGS = OUT ? ["--remote-debugging-port=9466"] : ["--remote-debugging-port=9466", ROOT];
const PORT = 9466;
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

  /* 静音随机行为 + 备份 prefs */
  await E(`nextDecide = 1e12; S.nextIdleFun = 1e12; prefs.hover = false; savePrefs();
    window.__b1 = localStorage.getItem("dfy_water_n"); window.__b2 = localStorage.getItem("dfy_greet");
    prefs.workmate = true; prefs.water = true; prefs.cpu = true; savePrefs();
    setState("idle"); S.nextDecide = 1e12; workmateActive = 0; workmateOn = false; "ok"`);
  await sleep(300);

  /* 1) preload CPU 桥接 */
  const bridge = await E(`JSON.stringify([typeof window.dafeiyu.onCpu, typeof window.dafeiyu.cpuNow])`);
  check("preload 暴露 onCpu/cpuNow", bridge === '["function","function"]', bridge);

  /* 2) 陪工模式：活跃 8 分钟触发 work 循环，离开 2 分钟收工 */
  for (let i = 0; i < 8; i++) await E(`companionTick(0); "ok"`);
  const c1 = JSON.parse(await E(`JSON.stringify({ on: workmateOn, state: S.state })`));
  check("陪工触发：连续活跃 8 分钟 → work", c1.on === true && c1.state === "work", JSON.stringify(c1));
  const c2 = JSON.parse(await E(`companionTick(200); JSON.stringify({ on: workmateOn, state: S.state })`));
  check("离开 2 分钟 → 收工回 idle", c2.on === false && c2.state === "idle", JSON.stringify(c2));
  await E(`workmateActive = 0; "ok"`);

  /* 3) CPU 状态鱼：连续两次 ≥85% 触发吐槽动画 */
  await E(`cpuForTest = 90; cpuPush(90); "ok"`);
  await sleep(200);
  await E(`cpuPush(90); "ok"`);
  const c3 = JSON.parse(await E(`JSON.stringify({ clip: curClipName, panicAt: lastCpuPanic > 0 })`));
  check("CPU ≥85% ×2 → 播 fan 吐槽", c3.clip === "fan" && c3.panicAt, JSON.stringify(c3));
  await sleep(4000);
  await E(`cpuForTest = 95; lastCpuPanic = -1e6; setState("idle"); cpuPush(95); "ok"`);
  await sleep(200);
  await E(`cpuPush(95); "ok"`);
  const c4 = await E(`curClipName`);
  check("CPU ≥92% → 播 startle 惊醒", c4 === "startle", c4);
  await E(`cpuForTest = null; cpuPush(30); "ok"`);
  const c5 = JSON.parse(await E(`JSON.stringify({ hot: cpuHot, pct: cpuPct })`));
  check("CPU 回落后计数清零", c5.hot === 0 && c5.pct === 30, JSON.stringify(c5));
  await sleep(4200);

  /* 4) 喝水提醒 + 摸头记杯（先清零并包计数器，排除跨运行残留） */
  await E(`localStorage.removeItem("dfy_water_n"); window.__wa = 0; const _wa = waterAdd; waterAdd = function(){ __wa++; return _wa(); }; "ok"`);
  await E(`lastWaterAt = Date.now() - 46 * 60 * 1000; waterCheck(); "ok"`);
  const w1 = JSON.parse(await E(`JSON.stringify({ pending: pendingWater, clip: curClipName })`));
  check("到点催喝水", w1.pending === true && w1.clip === "bubble", JSON.stringify(w1));
  const tap = await E(`(() => {
    const r = pet.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    pet.dispatchEvent(new MouseEvent("dblclick", { clientX: cx, clientY: cy, bubbles: true }));
    return JSON.stringify({ pending: pendingWater, calls: __wa, n: waterStats() });
  })()`);
  const w2 = JSON.parse(tap);
  check("摸头确认 → 恰好记一杯", w2.pending === false && w2.calls === 1 && w2.n === 1, tap);

  /* 5) 连点 3 次生气 */
  await sleep(4200);
  const m0 = await E(`mood`);
  const taps = await E(`(async () => {
    const r = pet.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    for (let i = 0; i < 3; i++) {
      pet.dispatchEvent(new PointerEvent("pointerdown", { clientX: cx, clientY: cy, button: 0, bubbles: true }));
      pet.dispatchEvent(new PointerEvent("pointerup", { clientX: cx, clientY: cy, button: 0, bubbles: true }));
      await new Promise((r2) => setTimeout(r2, 120));
    }
    return JSON.stringify({ clip: curClipName, dragging: S.dragging });
  })()`);
  const a1 = JSON.parse(taps);
  const m1 = await E(`mood`);
  check("连点 3 次 → 生气播 error", a1.clip === "error" && a1.dragging === false, taps);
  check("生气心情 -3", Math.round(m1) === Math.round(m0) - 3, m0 + "→" + m1);
  await sleep(4200);

  /* 6) 时段问候 + 节日（用 testHour 钩子模拟时间） */
  const f1 = await E(`festivalToday()`);
  check("festivalToday 今天无节日返回 null", f1 === null, JSON.stringify(f1));
  await E(`greetTick(12); "ok"`);            /* 模拟中午 12 点 → 午饭问候 */
  const g1 = JSON.parse(await E(`JSON.stringify({ saved: !!localStorage.getItem("dfy_greet"), lunch: JSON.parse(localStorage.getItem("dfy_greet") || "{}").ids || [] })`));
  check("正午问候触发并记录", g1.saved && g1.lunch.includes("lunch"), JSON.stringify(g1));
  const g2 = JSON.parse(await E(`(() => { greetTick(12); return JSON.stringify(JSON.parse(localStorage.getItem("dfy_greet")).ids.length); })()`));
  check("同一条问候一天只说一次", g2 === 1, g2);
  const fest = await E(`(() => { const r = FEST_LINES["春节"]; return JSON.stringify({ hasSpring: r.includes("拜年") }); })()`);
  check("节日台词表就绪", JSON.parse(fest).hasSpring, fest);

  /* 7) 菜单三件套 */
  const menu = await E(`(() => {
    showSub("settings", { getBoundingClientRect: () => ({ left: 10, right: 30, top: 10 }) });
    const g = (id) => { const e = document.getElementById(id); return e ? e.textContent : null; };
    const out = JSON.stringify({ workmate: g("mi-workmate"), water: g("mi-water"), cpu: g("mi-cpu") });
    closeMenus();
    return out;
  })()`);
  const mi = JSON.parse(menu);
  check("菜单：陪工模式项", /陪工模式：开/.test(mi.workmate || ""), mi.workmate);
  check("菜单：喝水提醒项（今日计数）", /喝水提醒：开/.test(mi.water || "") && /今日 \d+ 杯/.test(mi.water || ""), mi.water);  check("菜单：CPU 状态项（百分比随采样实时变）", /CPU：\d+%/.test(mi.cpu || "") && /反应开/.test(mi.cpu || ""), mi.cpu);

  /* 8) 陪工开关关闭后强制收工 */
  await E(`prefs.workmate = true; workmateActive = 0; companionTick(0); companionTick(0); "ok"`);
  await E(`companionTick(0); JSON.stringify(workmateOn)`);
  await E(`prefs.workmate = false; companionTick(0); "ok"`);
  const c8 = JSON.parse(await E(`JSON.stringify({ on: workmateOn, state: S.state })`));
  check("关掉陪工开关 → 立即收工", c8.on === false, JSON.stringify(c8));

  /* 还原 */
  await E(`window.__b1 === null ? localStorage.removeItem("dfy_water_n") : localStorage.setItem("dfy_water_n", window.__b1);
    window.__b2 === null ? localStorage.removeItem("dfy_greet") : localStorage.setItem("dfy_greet", window.__b2);
    prefs.workmate = true; prefs.water = true; savePrefs(); "ok"`);

  child.kill();
  console.log("结果：" + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("验证异常:", e.message); try { child.kill(); } catch (x) {} process.exit(1); });
