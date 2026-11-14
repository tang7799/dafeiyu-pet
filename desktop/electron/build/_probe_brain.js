/**
 * 探测：鱼现在用的到底是什么大脑
 *   ① modelId（实际请求的模型 ID）
 *   ② cloud.llm.models.list() 完整可用模型列表
 *   ③ 云端 endpoint 与额度模式
 * 用法：node build/_probe_brain.js
 */
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const ROOT = path.join(__dirname, "..");
const EXE = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const PORT = 9473;
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
      if (m.result && m.result.exceptionDetails) {
        const d = m.result.exceptionDetails;
        reject(new Error((d.exception && d.exception.description || d.text || "异常").slice(0, 300)));
      } else resolve(m.result && m.result.result ? m.result.result.value : undefined);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
  });
}

(async () => {
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, ["--remote-debugging-port=" + PORT, ROOT], { env, stdio: "ignore", cwd: ROOT });
  let chat = null;
  for (let i = 0; i < 60 && !chat; i++) {
    await sleep(500);
    try {
      const t = await getJson("/json/list");
      const pet = (t || []).find((x) => x.url.includes("pet.html"));
      if (pet && !(t || []).find((x) => x.url.includes("chat.html"))) {
        await cdpEval(pet.webSocketDebuggerUrl, 'window.dafeiyu.openChat(); "ok"').catch(() => {});
      }
      chat = (t || []).find((x) => x.url.includes("chat.html"));
    } catch (e) {}
  }
  if (!chat) { console.log("聊天窗没打开"); child.kill(); process.exit(1); }

  /* 等 CDN SDK 与主脚本就绪（踩过的坑：不轮询会拿到 undefined） */
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    await sleep(500);
    try { ready = (await cdpEval(chat.webSocketDebuggerUrl, 'typeof runTurn === "function" && typeof modelId !== "undefined"')) === true; } catch (e) {}
  }
  const ws = chat.webSocketDebuggerUrl;

  console.log("=== ① 实际使用的模型 ===");
  console.log("modelId =", await cdpEval(ws, 'String(modelId)').catch((e) => "读取失败：" + e.message));

  console.log("\n=== ② 云端可用模型列表 ===");
  try {
    const list = await cdpEval(ws, '(async function(){ const ms = await cloud.llm.models.list(); return JSON.stringify(ms); })()', 30000);
    const ms = JSON.parse(list);
    console.log("共 " + ms.length + " 个");
    console.log("id".padEnd(28) + "名称".padEnd(26) + "上下文".padEnd(10) + "倍率");
    for (const m of ms) {
      if (m.enabled === false) continue;
      const ctx = m.maxInputTokens >= 1000 ? Math.round(m.maxInputTokens / 1000) + "K" : (m.maxInputTokens || "-");
      console.log(String(m.id).padEnd(28) + String(m.name || "").padEnd(26) + String(ctx).padEnd(10) + String(m.credits || (m.id === "auto" ? "浮动" : "免费")));
    }
  } catch (e) { console.log("拉取失败：" + e.message); }

  console.log("\n=== ③ 云端接入信息 ===");
  try {
    console.log(await cdpEval(ws, 'JSON.stringify({ endpoint: (myCfg||{}).endpoint || CLOUD_DEFAULT.endpoint, ownKey: !!myCfg, clean: CLOUD_CLEAN, hasCloud: !!cloud }, null, 1)'));
  } catch (e) { console.log("读取失败：" + e.message); }

  console.log("\n=== ④ 计费口径 ===");
  try {
    console.log("今日账单节点：", await cdpEval(ws, '(document.getElementById("usage")||{}).textContent || "无"'));
  } catch (e) {}

  child.kill();
  process.exit(0);
})();
