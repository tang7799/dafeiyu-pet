/**
 * 探测：云端原始模型对象的字段（找 限时免费/夜间折扣/订阅优先 之类的标签）
 * 用法：node build/_probe_modelraw.js
 */
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const EXE = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const ARGS = ["--remote-debugging-port=9455", ROOT];
const PORT = 9455;
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
function cdpEval(wsUrl, expression, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error("cdp timeout")); }, timeoutMs || 30000);
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

(async () => {
  const child = spawn(EXE, ARGS, { env, stdio: "ignore", cwd: ROOT });
  let pet = null;
  for (let i = 0; i < 60 && !pet; i++) {
    await sleep(500);
    try {
      const t = await getJson("/json/list");
      pet = (t || []).find((x) => x.url.includes("pet.html"));
    } catch (e) {}
  }
  if (!pet) { console.log("❌ 桌宠没起来"); child.kill(); process.exit(1); }
  await cdpEval(pet.webSocketDebuggerUrl, 'window.dafeiyu.openChat(); "ok"').catch(() => {});
  let chat = null;
  for (let i = 0; i < 90 && !chat; i++) {
    await sleep(500);
    try {
      const t = await getJson("/json/list");
      if (!t.some((x) => x.url.includes("chat.html"))) continue;
      chat = t.find((x) => x.url.includes("chat.html"));
      /* 等 CDN SDK + 主脚本 */
      const ready = await cdpEval(chat.webSocketDebuggerUrl, 'typeof cloud !== "undefined" && typeof runTurn === "function"').catch(() => false);
      if (ready) break;
      chat = null;
    } catch (e) {}
  }
  if (!chat) { console.log("❌ 聊天窗没起来"); child.kill(); process.exit(1); }
  const hasCloud = await cdpEval(chat.webSocketDebuggerUrl, '!!cloud').catch(() => false);
  if (!hasCloud) { console.log("❌ cloud 不可用（此环境连不上云服务）"); child.kill(); process.exit(1); }
  const raw = await cdpEval(chat.webSocketDebuggerUrl,
    'cloud.llm.models.list().then((ms) => JSON.stringify((ms || []).slice(0, 6)))', 20000);
  console.log("原始模型样例：");
  try {
    for (const m of JSON.parse(raw)) console.log(JSON.stringify(m));
  } catch (e) { console.log(raw); }
  child.kill();
  process.exit(0);
})().catch((e) => { console.log("异常：" + e.message); process.exit(1); });
