/**
 * 探针：启动聊天窗并抓取启动阶段 JS 异常 + 按钮接线状态
 * 用法：node build/_probe_chat.js [打包输出目录名]
 */
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const OUT = process.argv[2] || null;
const ROOT = path.join(__dirname, "..");
const EXE = OUT
  ? path.join(ROOT, OUT, "win-unpacked", (OUT === "dist" ? "DafeiyuPet.exe" : "DafeiyuPetClean.exe"))
  : path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const ARGS = OUT ? ["--remote-debugging-port=9468"] : ["--remote-debugging-port=9468", ROOT];
const PORT = 9468;
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

async function waitChat() {
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const t = await getJson("/json/list");
      const chat = (t || []).find((x) => x.url.includes("chat.html"));
      if (chat) return chat;
    } catch (e) {}
  }
  throw new Error("chat.html target 未出现");
}

function cdp(wsUrl, onEvent) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error("cdp timeout")); }, 20000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 0, method: "Runtime.enable", params: {} }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        const txt = d.exception && (d.exception.description || d.exception.value) || d.text;
        onEvent("EXCEPTION[" + (d.scriptId || "?") + " line " + (d.lineNumber + 1) + "]: " + String(txt).slice(0, 300));
      }
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        onEvent("console.error: " + m.params.args.map((a) => a.value || a.description || "").join(" ").slice(0, 200));
      }
      if (m.id === 1) { clearTimeout(timer); resolve(m.result && m.result.result ? m.result.result.value : undefined); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
  });
}

(async () => {
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, ARGS, { env, stdio: "ignore", cwd: ROOT });
  const chat = await (async () => {
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try {
        const t = await getJson("/json/list");
        const pet = (t || []).find((x) => x.url.includes("pet.html"));
        if (pet && !((t || []).find((x) => x.url.includes("chat.html")))) {
          await new Promise((res, rej) => {
            const ws = new WebSocket(pet.webSocketDebuggerUrl);
            ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: 'window.dafeiyu.openChat(); "ok"', returnByValue: true } }));
            ws.onmessage = (ev) => { ws.close(); res(); };
            ws.onerror = () => res();
          });
        }
        const chat = (t || []).find((x) => x.url.includes("chat.html"));
        if (chat) return chat;
      } catch (e) {}
    }
    throw new Error("chat.html target 未出现");
  })();
  console.log("chat target:", chat.url);
  const events = [];
  const result = await cdp(chat.webSocketDebuggerUrl, (e) => events.push(e)).then(() => null).catch((e) => "CDP_FAIL: " + e.message);
  // 在异常监听窗口结束后，检查按钮接线状态
  const state = await new Promise((resolve, reject) => {
    const ws = new WebSocket(chat.webSocketDebuggerUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error("cdp timeout 2")); }, 15000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {
      expression: `(() => {
        const send = document.getElementById("send");
        const input = document.getElementById("input");
        return JSON.stringify({
          readyState: document.readyState,
          hasDafeiyu: !!(window.dafeiyu && window.dafeiyu.appInfo),
          sendBtn: !!send,
          sendDisabled: send ? send.disabled : null,
          inputPh: input ? input.placeholder : null,
          inputVal: input ? input.value : null,
          verNo: (document.getElementById("ver-no")||{}).textContent
        });
      })()`,
      returnByValue: true } }));
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id !== 1) return; clearTimeout(timer); ws.close(); resolve(m.result.result.value); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("ws2 error")); };
  });
  console.log("页面状态:", state);
  if (events.length) { console.log("--- 捕获的异常/错误 ---"); events.forEach((e) => console.log(e)); }
  else console.log("启动阶段没有捕获到 JS 异常");
  child.kill();
  process.exit(0);
})().catch((e) => { console.error("PROBE FAIL:", e.message); process.exit(1); });
