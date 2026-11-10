/**
 * 临时验证：天气功能返回纯文本而非 HTML 网页
 * 用法：node build/_verify_weather.js
 */
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const EXE = path.join(__dirname, "..", "node_modules", "electron", "dist", "electron.exe");
const APP_DIR = path.join(__dirname, "..");
const PORT = 9445;
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
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error("cdp timeout")); }, 25000);
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
  console.log((cond ? "  ✅ " : "  ❌ ") + name + (extra !== undefined ? "  → " + String(extra).slice(0, 90) : ""));
  cond ? pass++ : fail++;
};

(async () => {
  console.log("启动开发态桌宠：" + EXE);
  const child = spawn(EXE, ["--remote-debugging-port=" + PORT, APP_DIR], { env, stdio: "ignore", cwd: APP_DIR });

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

  // 1) 天气接口直调
  const r = await cdpEval(pet.webSocketDebuggerUrl, "window.dafeiyu.weather()");
  check("weather() 返回 ok=true", !!r && r.ok === true, r && r.error);
  check("返回文本不含 <!DOCTYPE", !!r && !/<!DOCTYPE|<html/i.test(r.text || ""), r && (r.text || "").slice(0, 60));
  check("文本含温度 °C", !!r && /°C/.test(r.text || ""), r && r.text);
  check("文本含湿度", !!r && /湿度/.test(r.text || ""));

  // 2) 菜单动作端到端：handleAction('weather') 触发气泡
  await cdpEval(pet.webSocketDebuggerUrl, "handleAction('weather'); 'ok'");
  await sleep(3500);
  const bubble = await cdpEval(pet.webSocketDebuggerUrl, `(() => {
    // 气泡元素：找页面上由 say() 控制的元素（class 含 say/bubble 的可见文本）
    const els = [...document.querySelectorAll("body *")].filter(e =>
      e.children.length === 0 && /☁|°C|湿度|天气/.test(e.textContent || ""));
    return els.map(e => e.textContent.trim()).join(" || ");
  })()`);
  check("点击「查看天气」后气泡显示天气文本", /°C/.test(bubble || "") && !/<!DOCTYPE/.test(bubble || ""), bubble);

  console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
  child.kill();
  await sleep(400);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("异常：" + e.message); process.exit(1); });
