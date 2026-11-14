/**
 * 临时验证：自学动作（pet_teach）→ 桌宠学会新动作、能表演、重启后还记得
 * 用法：node build/_verify_teach.js [打包输出目录名]   缺省跑开发目录
 */
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const OUT = process.argv[2] || null;
const ROOT = path.join(__dirname, "..");
const EXE = OUT
  ? path.join(ROOT, OUT, "win-unpacked", (OUT === "dist" ? "DafeiyuPet.exe" : "DafeiyuPetClean.exe"))
  : path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const ARGS = OUT ? ["--remote-debugging-port=9465"] : ["--remote-debugging-port=9465", ROOT];
const PORT = 9465;
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

function cdpCall(wsUrl, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error("cdp timeout")); }, 15000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params: params || {} }));
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
const cdpEval = (wsUrl, expression) => cdpCall(wsUrl, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });

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

  /* 静音随机行为；备份既有自定义动作，测试后还原 */
  await E(`nextDecide = 1e12; S.nextIdleFun = 1e12; prefs.hover = false; savePrefs(); window.__teachBackup = localStorage.getItem("dfy_acts"); "ok"`);
  await sleep(300);

  /* 1) preload 桥接 */
  const bridge = await E(`JSON.stringify([typeof window.dafeiyu.onPetTeach, typeof window.dafeiyu.teachResult])`);
  check("preload 暴露 onPetTeach/teachResult", bridge === '["function","function"]', bridge);

  /* 2) 教一个新动作：yoga = stretch 片段 + 台词 + 特效 */
  const t1 = JSON.parse(await E(`JSON.stringify(window.__learnAct({ act: "yoga", clip: "stretch", line: "鱼式瑜伽，呼——吸——", fx: ["🧘", "✨"] }))`));
  check("learnAct 学会 yoga", t1.ok === true && t1.act === "yoga", JSON.stringify(t1));
  const p1 = JSON.parse(await E(`JSON.stringify({ inTable: !!PET_ACTS.yoga, clip: PET_ACTS.yoga && PET_ACTS.yoga.clip, saved: (localStorage.getItem("dfy_acts") || "").includes("yoga") })`));
  check("yoga 进入动作表并写入 localStorage", p1.inTable && p1.clip === "stretch" && p1.saved, JSON.stringify(p1));

  /* 3) 表演刚学的动作 */
  const act1 = await E(`(() => { const ok = window.__petAct("yoga"); return JSON.stringify({ ok, clip: curClipName }); })()`);
  const a1 = JSON.parse(act1);
  check("yoga → 播 stretch 动画", a1.ok === true && a1.clip === "stretch", act1);
  await sleep(4200);

  /* 4) 边界：片段不存在 / 内置动作不用教 / 名字不合法 */
  const t4a = JSON.parse(await E(`JSON.stringify(window.__learnAct({ act: "fly", clip: "no_such_clip" }))`));
  check("不存在的片段被拒绝并列出可选", t4a.ok === false && t4a.msg.includes("可选"), t4a.msg.slice(0, 60));
  const t4b = JSON.parse(await E(`JSON.stringify(window.__learnAct({ act: "dance", clip: "spin" }))`));
  check("内置动作不用教", t4b.ok === false && t4b.msg.includes("内置"), t4b.msg);
  const t4c = JSON.parse(await E(`JSON.stringify(window.__learnAct({ act: "做瑜伽", clip: "stretch" }))`));
  check("中文动作名被要求转英文", t4c.ok === false, t4c.msg);

  /* 5) 更新已学动作（换片段） */
  const t5 = JSON.parse(await E(`JSON.stringify(window.__learnAct({ act: "yoga", clip: "bow", line: "鱼式鞠躬" }))`));
  check("重复教 = 更新定义", t5.ok === true, JSON.stringify(t5));
  const p5 = JSON.parse(await E(`JSON.stringify({ clip: PET_ACTS.yoga.clip })`));
  check("yoga 片段已换成 bow", p5.clip === "bow", p5.clip);

  /* 6) 持久化：重载页面后动作还在（模拟重启） */
  await E(`localStorage.setItem("dfy_acts", JSON.stringify(Object.assign({}, JSON.parse(localStorage.getItem("dfy_acts") || "{}"), { yoga: { clip: "stretch", line: "鱼式瑜伽", fx: ["🧘"] } }))); "ok"`);
  await cdpCall(petT.webSocketDebuggerUrl, "Page.enable");
  await cdpCall(petT.webSocketDebuggerUrl, "Page.reload");
  await sleep(3000);
  const p6 = JSON.parse(await E(`JSON.stringify({ inTable: !!PET_ACTS.yoga, clip: PET_ACTS.yoga && PET_ACTS.yoga.clip, custom: PET_ACTS.yoga && PET_ACTS.yoga.custom })`));
  check("重载后 yoga 仍在动作表（永久记住）", p6.inTable && p6.clip === "stretch" && p6.custom === true, JSON.stringify(p6));

  /* 7) 重载后还能表演 */
  const act7 = await E(`(() => { const ok = window.__petAct("yoga"); return JSON.stringify({ ok, clip: curClipName }); })()`);
  const a7 = JSON.parse(act7);
  check("重载后 yoga 仍可表演", a7.ok === true && a7.clip === "stretch", act7);

  /* 还原测试前的动作表，避免污染用户环境 */
  await E(`window.__teachBackup === null ? localStorage.removeItem("dfy_acts") : localStorage.setItem("dfy_acts", window.__teachBackup); "ok"`);

  child.kill();
  console.log("结果：" + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("验证异常:", e.message); try { child.kill(); } catch (x) {} process.exit(1); });
