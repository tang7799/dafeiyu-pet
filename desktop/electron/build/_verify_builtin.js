/**
 * 内置版（非干净版）功能验证（CDP）
 *
 * 启动 dist/win-unpacked/DafeiyuPet.exe，打开聊天窗口，断言：
 * 内置云配置还在（CLOUD_CLEAN=false / CLOUD_DEFAULT 有公钥 / cloud 客户端已创建 / 徽章不是「未配置」），
 * 且首屏不会强制要求填配置。
 *
 * 用法：node build/_verify_builtin.js [输出目录，默认 dist]
 */
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const OUT = process.argv[2] || "dist";
const EXE = path.join(__dirname, "..", OUT, "win-unpacked", "DafeiyuPet.exe");
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: urlPath, timeout: 3000 }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
  });
}

function cdpEval(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error("cdp timeout")); }, 15000);
    ws.onopen = () => ws.send(JSON.stringify({
      id: 1, method: "Runtime.evaluate",
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.result && msg.result.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails).slice(0, 400)));
      else resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
  });
}

(async () => {
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  console.log("启动内置版：" + EXE);
  const child = spawn(EXE, ["--remote-debugging-port=" + PORT], { env, stdio: "ignore" });
  let failed = 0;
  const check = (name, cond, extra) => {
    console.log((cond ? "  ✅ " : "  ❌ ") + name + (extra !== undefined ? "  → " + extra : ""));
    if (!cond) failed++;
  };
  try {
    await sleep(5000);
    const targets = await getJson("/json");
    const pet = targets.find((t) => (t.url || "").includes("pet.html"));
    if (!pet) throw new Error("找不到 pet 页面，targets=" + JSON.stringify(targets.map((t) => t.url)));
    await cdpEval(pet.webSocketDebuggerUrl, "window.dafeiyu.openChat(); 'opened'");
    await sleep(3500);

    const t2 = await getJson("/json");
    const chat = t2.find((t) => (t.url || "").includes("chat.html"));
    if (!chat) throw new Error("聊天窗口没打开，targets=" + JSON.stringify(t2.map((t) => t.url)));

    let ready = false;
    for (let i = 0; i < 30; i++) {
      const t = await cdpEval(chat.webSocketDebuggerUrl, "typeof CLOUD_CLEAN");
      if (t === "boolean") { ready = true; break; }
      await sleep(500);
    }
    if (!ready) throw new Error("聊天页脚本 15 秒内没执行完（SDK 可能没加载上）");

    const raw = await cdpEval(chat.webSocketDebuggerUrl, `(() => {
      const out = {};
      out.cleanFlag = CLOUD_CLEAN;
      out.hasKey = !!(CLOUD_DEFAULT && /^wbpk_/.test(CLOUD_DEFAULT.publishableKey || ""));
      out.endpoint = (CLOUD_DEFAULT && CLOUD_DEFAULT.baseUrl) || (CLOUD_DEFAULT && CLOUD_DEFAULT.url) || "";
      out.cloudState = (typeof cloud !== "undefined") ? (cloud === null ? "null" : typeof cloud) : "undefined";
      out.badge = (document.getElementById("acc") || {}).textContent;
      const fb = document.getElementById("first-box");
      out.firstShown = !!(fb && fb.classList.contains("show"));
      /* 内置版首屏是"欢迎卡片"：带「先用内置的」按钮，标题也不是"必须自己填" */
      out.borrowDisplay = getComputedStyle(document.getElementById("first-borrow")).display;
      out.firstTitle = (fb.querySelector("h3") || {}).textContent;
      return JSON.stringify(out);
    })()`);

    const r = JSON.parse(raw);
    console.log("\n内置版验证结果：");
    check("打包进页面的 CLOUD_CLEAN 为 false", r.cleanFlag === false, r.cleanFlag);
    check("CLOUD_DEFAULT 带内置公钥", r.hasKey === true, r.endpoint || "(无 endpoint 字段)");
    check("已创建云端客户端（cloud 不是 null）", r.cloudState !== "null" && r.cloudState !== "undefined", r.cloudState);
    check("徽章不是「未配置」", r.badge !== "未配置", r.badge);
    /* 内置版首屏是「用内置额度 / 填自己配置」二选一的欢迎卡（首次运行才弹），
       干净版才会改成"必须自己填"并隐藏「先用内置的」按钮 */
    check("首屏保留「先用内置的」这条路", r.borrowDisplay !== "none", r.borrowDisplay);
    check("首屏标题不是「必须自己填」", !/填上你自己的云配置/.test(r.firstTitle || ""), r.firstTitle);
  } catch (e) {
    console.error("\n验证出错：" + e.message);
    failed++;
  } finally {
    try { child.kill(); } catch (e) {}
    await sleep(800);
    console.log(failed ? "\n结果：有 " + failed + " 项未通过" : "\n结果：全部通过");
    process.exit(failed ? 1 : 0);
  }
})();
