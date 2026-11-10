/**
 * 干净版功能验证（CDP）
 *
 * 启动 dist-clean/win-unpacked/DafeiyuPetClean.exe，通过调试端口打开聊天窗口，
 * 断言：没有内置配置 / cloud 未创建 / 首屏强制填配置 / 无"借用"入口 / 发送被拦截。
 *
 * 用法：node build/verify-clean.js
 */
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const OUT = process.env.DFY_OUT_DIR || "dist-clean";
const EXE = path.join(__dirname, "..", OUT, "win-unpacked", "DafeiyuPetClean.exe");
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: urlPath, timeout: 3000 }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
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
      if (msg.result && msg.result.exceptionDetails) {
        reject(new Error(JSON.stringify(msg.result.exceptionDetails).slice(0, 400)));
      } else {
        resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
      }
    };
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error("ws error")); };
  });
}

(async () => {
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;   // 否则 exe 会以纯 Node 模式静默退出
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
    await sleep(3000);

    const t2 = await getJson("/json");
    const chat = t2.find((t) => (t.url || "").includes("chat.html"));
    if (!chat) throw new Error("聊天窗口没打开，targets=" + JSON.stringify(t2.map((t) => t.url)));

    /* 页面里的 SDK 是从 CDN 加载的阻塞脚本，冷启动可能要几秒：
       等到页面的内联脚本真正执行完（CLOUD_CLEAN 已定义）再做断言 */
    let ready = false;
    for (let i = 0; i < 30; i++) {
      const t = await cdpEval(chat.webSocketDebuggerUrl, "typeof CLOUD_CLEAN");
      if (t === "boolean") { ready = true; break; }
      await sleep(500);
    }
    if (!ready) throw new Error("聊天页脚本 15 秒内没执行完（SDK 可能没加载上）");

    const raw = await cdpEval(chat.webSocketDebuggerUrl, `(() => {
      const out = {};
      out.cleanFlag = (typeof CLOUD_CLEAN !== "undefined") ? CLOUD_CLEAN : "undefined";
      out.defaultCfg = (typeof CLOUD_DEFAULT !== "undefined") ? String(CLOUD_DEFAULT) : "undefined";
      out.cloudState = (typeof cloud !== "undefined") ? (cloud === null ? "null" : typeof cloud) : "undefined";
      out.badge = document.getElementById("acc").textContent;
      const fb = document.getElementById("first-box");
      out.firstShown = fb.classList.contains("show");
      out.firstTitle = (fb.querySelector("h3") || {}).textContent;
      out.borrowBtn = getComputedStyle(document.getElementById("first-borrow")).display;
      out.resetBtnText = document.getElementById("cfg-reset").textContent;
      out.pageHasOwnerKey = document.documentElement.outerHTML.indexOf("wbpk_GTO0") >= 0;
      // 关掉首屏，模拟发消息
      document.getElementById("first-own").click();
      document.getElementById("input").value = "你好呀";
      document.getElementById("send").click();
      out.cfgBoxShown = document.getElementById("cfg-box").classList.contains("show");
      const sys = Array.from(document.querySelectorAll("#msgs .msg.sys")).map(e => e.textContent);
      out.lastSys = sys.length ? sys[sys.length - 1] : "";
      out.userMsgCount = document.querySelectorAll("#msgs .msg.user").length;
      return JSON.stringify(out);
    })()`);

    const r = JSON.parse(raw);
    console.log("\n干净版验证结果：");
    check("打包进页面的 CLOUD_CLEAN 为 true", r.cleanFlag === true, r.cleanFlag);
    check("CLOUD_DEFAULT 已置空", r.defaultCfg === "null", r.defaultCfg);
    check("没有创建云端客户端（cloud === null）", r.cloudState === "null", r.cloudState);
    check("页面源码中不含作者公钥", r.pageHasOwnerKey === false);
    check("徽章显示「未配置」", r.badge === "未配置", r.badge);
    check("启动即弹出填配置窗口", r.firstShown === true, r.firstShown);
    check("首屏标题已改为自己填", /填上你自己的云配置/.test(r.firstTitle || ""), r.firstTitle);
    check("没有「先用内置的」按钮", r.borrowBtn === "none", r.borrowBtn);
    check("「恢复默认」已改成「清空配置」", r.resetBtnText === "清空配置", r.resetBtnText);
    check("未配置时发送被拦截（没有任何消息发出）", r.userMsgCount === 0, "user 消息数=" + r.userMsgCount);
    check("发送被拦截后自动打开配置面板", r.cfgBoxShown === true, r.cfgBoxShown);
    check("给出了明确提示", /先填上自己的云配置/.test(r.lastSys || ""), r.lastSys);
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
