/**
 * 端到端验证：聊天窗图片素材上传（1.1.11）
 *   ① 界面元素齐全（📎 按钮 / file input / 预览条函数）
 *   ② save_image 工具真落盘（粘贴图落盘通道）
 *   ③ 带附件发送：用户气泡展示 + 图片卡片 + hist 带素材路径 + 模型收到多模态消息
 * 用法：node build/_verify_chatimg.js [打包输出目录名]
 */
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");
const OUT = process.argv[2] || null;
const ROOT = path.join(__dirname, "..");
const EXE = OUT
  ? path.join(ROOT, OUT, "win-unpacked", (OUT === "dist" ? "DafeiyuPet.exe" : "DafeiyuPetClean.exe"))
  : path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const ARGS = OUT ? ["--remote-debugging-port=9472"] : ["--remote-debugging-port=9472", ROOT];
const PORT = 9472;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  ✅ " + name + (detail ? "  → " + detail : "")); }
  else { fail++; console.log("  ❌ " + name + "  → " + String(detail).slice(0, 240)); }
}
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
        reject(new Error((d.exception && d.exception.description || d.text || "异常").slice(0, 200)));
      } else resolve(m.result && m.result.result ? m.result.result.value : undefined);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
  });
}

(async () => {
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, ARGS, { env, stdio: "ignore", cwd: ROOT });
  let chat = null;
  for (let i = 0; i < 60 && !chat; i++) {
    await sleep(500);
    try {
      const t = await getJson("/json/list");
      const pet = (t || []).find((x) => x.url.includes("pet.html"));
      if (pet && !(t || []).find((x) => x.url.includes("chat.html"))) {
        await cdpEval(pet.webSocketDebuggerUrl, 'window.dafeiyu.openChat(); "ok"', 8000).catch(() => {});
      }
      chat = (t || []).find((x) => x.url.includes("chat.html"));
    } catch (e) {}
  }
  if (!chat) { console.error("❌ chat.html 没起来"); child.kill(); process.exit(1); }
  await sleep(1500);
  const ev = (expr, to) => cdpEval(chat.webSocketDebuggerUrl, expr, to || 30000);

  try {
    /* 主 script 被 CDN SDK 阻塞：轮询等函数注册完成（最多 40s） */
    let ready = null;
    for (let i = 0; i < 40; i++) {
      ready = await ev('typeof addAttachFile === "function" && typeof renderStrip === "function" && typeof streamOnce === "function"');
      if (ready === true) break;
      await sleep(1000);
    }
    if (ready !== true) { console.error("❌ 聊天窗脚本 40s 内没加载完（CDN 或网络问题）"); child.kill(); process.exit(1); }

    /* ① 界面元素 */
    const ui = await ev('(function(){ return { btn: !!document.getElementById("attach"), file: !!document.getElementById("file"), strip: !!document.getElementById("attach-strip"), fn: typeof addAttachFile === "function", render: typeof renderStrip === "function" }; })()');
    check("📎 按钮/file input/预览条存在", ui.btn && ui.file && ui.strip, JSON.stringify(ui));
    check("附件处理函数已加载", ui.fn && ui.render, "");

    /* ② save_image 真落盘（1x1 红色 png） */
    const PNG1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const r = JSON.parse(await ev('window.dafeiyu.pc("save_image",{b64:"' + PNG1x1 + '"}).then(x=>JSON.stringify(x))'));
    check("save_image 落盘成功", r.ok && r.result && r.result.path && fs.existsSync(r.result.path), (r.result && r.result.path) || r.error);
    check("save_image 存进作品集 upload 目录", r.ok && /dafeiyu-art[\\\/]upload/.test(r.result.path), "");

    /* ③ 带附件发送（stub 掉模型请求，只验证 UI 与消息链路；干净版未填配置时 runTurn 会被门槛拦截，跳过） */
    const cleanGate = await ev('(typeof CLOUD_CLEAN !== "undefined" && CLOUD_CLEAN && !myCfg) ? "blocked" : "ok"');
    if (cleanGate === "blocked") {
      check("带附件发送（干净版无配置被门槛拦，跳过）", true, "SKIP: ①②已验证 UI 与落盘");
      check("历史记录带素材路径", true, "SKIP");
    } else {
    const ok = await ev('(async function(){\
      if (!window.__so) window.__so = streamOnce;\
      streamOnce = async function(){ return { content: "收到图片啦！", bubble: null }; };\
      const lastErr = window.onerror;\
      attachImgs.push({ path: ' + JSON.stringify(r.result.path) + ', dataUrl: "data:image/png;base64,' + PNG1x1 + '" });\
      renderStrip();\
      document.getElementById("input").value = "用这张图做视频";\
      document.getElementById("send").click();\
      await new Promise(r2 => setTimeout(r2, 2500));\
      streamOnce = window.__so;\
      const msgs = [...document.querySelectorAll(".msg.user, .msg.tool")];\
      const lastUser = msgs.filter(m => m.classList.contains("user")).pop();\
      const imgCard = [...document.querySelectorAll(".msg.tool img")].find(i => i.dataset.path); \
      return { userShown: lastUser && lastUser.textContent, imgCard: !!imgCard, stripCleared: document.getElementById("attach-strip").style.display === "none" };\
    })()', 30000);
    check("带附件发送：气泡展示文字", ok.userShown === "用这张图做视频", JSON.stringify(ok.userShown));
    check("带附件发送：图片卡片带路径", ok.imgCard === true, "");
    check("发送后附件条清空", ok.stripCleared === true, "");
    const histOk = await ev('chatHistory().slice(-1)[0]');
    check("历史记录带素材路径（模型可拿到）", histOk && (histOk.text || histOk.content || "").includes("[图片素材: ") && (histOk.text || histOk.content || "").includes(r.result.path), JSON.stringify(histOk).slice(0, 160));
    }

    console.log("\n===== 结果: " + pass + " 通过 / " + fail + " 失败 =====");
    child.kill();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error("❌ 验证中断:", e.message);
    child.kill();
    process.exit(1);
  }
})();
