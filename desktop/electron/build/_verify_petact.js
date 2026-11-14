/**
 * 临时验证：聊天指令动作（pet_act）→ 桌宠真的做动作
 * 用法：node build/_verify_petact.js [打包输出目录名]   缺省跑开发目录
 */
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const OUT = process.argv[2] || null;
const ROOT = path.join(__dirname, "..");
const EXE = OUT
  ? path.join(ROOT, OUT, "win-unpacked", (OUT === "dist" ? "DafeiyuPet.exe" : "DafeiyuPetClean.exe"))
  : path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const ARGS = OUT ? ["--remote-debugging-port=9464"] : ["--remote-debugging-port=9464", ROOT];
const PORT = 9464;
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

  /* 静音随机行为，避免干扰断言 */
  await E(`nextDecide = 1e12; S.nextIdleFun = 1e12; prefs.hover = false; savePrefs(); "ok"`);
  await sleep(300);

  /* 1) preload 桥接：onPetAct 已暴露 */
  const bridge = await E(`typeof window.dafeiyu.onPetAct`);
  check("preload 暴露 onPetAct", bridge === "function", bridge);

  /* 2) 未知动作 → 返回 false 不播 */
  const bad = await E(`(() => { const c0 = curClipName; const ok = window.__petAct("not_a_move"); return JSON.stringify({ ok, clip: curClipName, same: curClipName === c0 }); })()`);
  const bj = JSON.parse(bad);
  check("未知动作被拒绝", bj.ok === false && bj.same === true, JSON.stringify(bj));

  /* 3) 跳舞：state=special，切片切到 dance，气泡有台词 */
  await sleep(500);
  const dance = await E(`(() => { const ok = window.__petAct("dance"); return JSON.stringify({ ok, state: S.state, clip: curClipName }); })()`);
  const dj = JSON.parse(dance);
  check("dance → 播 dance 动画", dj.ok === true && dj.state === "special" && dj.clip === "dance", JSON.stringify(dj));
  await sleep(4500);                       /* 等一次性动画播完回 idle */

  /* 4) 吃冰淇淋：掉食物 → 1 秒后播 eat_icecream */
  const ice = await E(`(() => { const ok = window.__petAct("eat_icecream"); return JSON.stringify({ ok, drops: document.querySelectorAll(".food-drop").length }); })()`);
  const ij = JSON.parse(ice);
  check("eat_icecream → 掉食物", ij.ok === true && ij.drops >= 1, JSON.stringify(ij));
  let clip2 = null;
  for (let i = 0; i < 12; i++) {           /* 轮询等切片切到吃 */
    await sleep(400);
    clip2 = await E(`curClipName`);
    if (clip2 === "eat_icecream") break;
  }
  check("eat_icecream → 播吃动画", clip2 === "eat_icecream", clip2);
  const mood1 = await E(`S.mood || (prefs && 0)`);
  await sleep(4500);

  /* 5) 表演类小提琴 */
  await E(`window.__petAct("violin"); "ok"`);
  let clip3 = null;
  for (let i = 0; i < 8; i++) {
    await sleep(300);
    clip3 = await E(`curClipName`);
    if (clip3 === "violin") break;
  }
  check("violin → 播小提琴动画", clip3 === "violin", clip3);
  await sleep(4500);

  /* 6) 全部动作名都可执行（20 表演 + 6 食物） */
  const all = ["dance","spin","sing","bow","stretch","yawn","violin","flute","horse","watergun","fan","cat","snowman","swing_ride","kite","sway","bubble","look_around","work","eat_rice","eat_token","eat_snack","eat_tangyuan","eat_hotpot"];
  const acc = await E(`(() => { let ok = 0, bad = []; for (const n of ${JSON.stringify(all)}) { const r = window.__petAct(n); if (r) ok++; else bad.push(n); } return JSON.stringify({ ok, bad }); })()`);
  const aj = JSON.parse(acc);
  check("24 个动作全部接受", aj.ok === all.length && aj.bad.length === 0, JSON.stringify(aj));

  child.kill();
  console.log("结果：" + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("验证异常:", e.message); process.exit(1); });
