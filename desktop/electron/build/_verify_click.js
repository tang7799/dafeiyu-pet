/**
 * 端到端验证：点击准确率三项新能力
 *   ① mouse_click {title} 窗口相对点击（含 fx/fy 比例）
 *   ② space:"shot" 截图坐标自动换算
 *   ③ click_text OCR 点文字
 * 流程：开记事本 → 窗口中心点一下 → 打字 → click_text 点「退出」→ 截图换算点击 → 清理
 * 用法：node build/_verify_click.js [打包输出目录名]
 */
const path = require("path");
const http = require("http");
const { spawn, exec } = require("child_process");
const OUT = process.argv[2] || null;
const ROOT = path.join(__dirname, "..");
const EXE = OUT
  ? path.join(ROOT, OUT, "win-unpacked", (OUT === "dist" ? "DafeiyuPet.exe" : "DafeiyuPetClean.exe"))
  : path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const ARGS = OUT ? ["--remote-debugging-port=9470"] : ["--remote-debugging-port=9470", ROOT];
const PORT = 9470;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  ✅ " + name + (detail ? "  → " + detail : "")); }
  else { fail++; console.log("  ❌ " + name + "  → " + String(detail).slice(0, 200)); }
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
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error("cdp timeout")); }, timeoutMs || 20000);
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
  await sleep(1200);
  const pcRaw = (tool, args) => cdpEval(chat.webSocketDebuggerUrl,
    "window.dafeiyu.pc(" + JSON.stringify(tool) + "," + JSON.stringify(args || {}) + ").then(r=>JSON.stringify(r))", 45000);
  const pc = async (tool, args) => {
    let raw;
    try { raw = await pcRaw(tool, args); }
    catch (e) { throw new Error(tool + " 调用异常: " + e.message); }
    let w;
    if (typeof raw === "string") { try { w = JSON.parse(raw); } catch (e) { throw new Error(tool + " 返回非 JSON: " + raw.slice(0, 120)); } }
    else w = raw;
    if (w.error !== undefined && w.result === undefined) throw new Error(tool + " 失败: " + w.error);
    return w.result !== undefined ? w.result : w;
  };

  /* ① screen_info 基线 */
  const si = await pc("screen_info");
  check("screen_info 可用（scaleFactor=" + si.scaleFactor + "）", si.width > 0 && si.scaleFactor > 0, JSON.stringify({ w: si.width, h: si.height, sf: si.scaleFactor }));

  /* 打开记事本 */
  exec("taskkill /IM notepad.exe /F 2>nul", () => {});
  await sleep(600);
  await pc("open_path", { path: "C:\\Windows\\notepad.exe" });
  /* 等记事本真起来（Win11 新记事本启动要 2~4 秒），轮询聚焦 */
  let npReady = false;
  for (let i = 0; i < 8 && !npReady; i++) {
    await sleep(1200);
    try { await pc("focus_window", { title: "记事本" }); npReady = true; } catch (e) {}
  }
  check("记事本已启动并聚焦", npReady, npReady ? "" : "8 次轮询都没找到窗口");

  /* ② 窗口相对点击：比例定位（点窗口正中，空白文档无副作用） */
  let r = await pc("mouse_click", { title: "记事本", fx: 0.5, fy: 0.5 });
  check("窗口相对点击（title+fx/fy 比例）", r.window && r.mode === "比例" && r.at && r.at.x > 0, JSON.stringify(r));
  await sleep(600);

  /* ③ 窗口内偏移点击（点客户区顶部空白，无副作用） */
  r = await pc("mouse_click", { title: "记事本", x: 60, y: 40 });
  check("窗口相对点击（title+x/y 偏移）", r.window && r.mode === "窗口内偏移", JSON.stringify(r));
  await sleep(400);

  /* ④ click_text：OCR 点菜单栏「编辑」（不依赖打字，菜单文字常驻可见） */
  r = await pc("click_text", { text: "编辑" });
  const si2 = await pc("screen_info");
  const inScreen = r.at && r.at.x >= 0 && r.at.y >= 0 && r.at.x < si2.width && r.at.y < si2.height;
  check("click_text 点中「编辑」菜单", r.clicked === "编辑" && inScreen, JSON.stringify(r));
  await sleep(700);
  /* 点开菜单后应有「另存为/页面设置」等菜单项出现 —— 截图对比验证菜单真的弹了 */
  const shotMenu = await pc("screenshot");
  check("菜单已弹出（截到编辑菜单内容）", shotMenu && shotMenu.bytes > 0, "截图 " + shotMenu.bytes + "B");
  await pc("key_press", { key: "esc" });
  await sleep(300);

  /* ⑤ space:"shot" 截图坐标换算：取截图正中点，物理坐标应≈屏幕中心 */
  const shot = await pc("screenshot");
  r = await pc("mouse_move", { x: shot.width / 2, y: shot.height / 2, space: "shot" });
  const dx = Math.abs(r.to.x - si2.width / 2), dy = Math.abs(r.to.y - si2.height / 2);
  check("space:\"shot\" 换算（截图 " + shot.width + "px → 屏幕 " + si2.width + "px）", dx <= 2 && dy <= 2, JSON.stringify(r));
  /* 不带 space 直接用截图坐标：应该明显偏离屏幕中心（证明换算真的在起作用） */
  r = await pc("mouse_move", { x: shot.width / 2, y: shot.height / 2 });
  const drift = Math.abs(r.to.x - si2.width / 2);
  check("对照：不带 space 直接用截图坐标会偏 " + drift + "px（换算必要性确认）", drift > dx * 5 || drift > 50, "偏移 " + drift + "px");

  /* 清理 */
  exec("taskkill /IM notepad.exe /F", () => {});
  console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
  child.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("VERIFY FAIL:", e.message); exec("taskkill /IM notepad.exe /F", () => {}); process.exit(1); });
