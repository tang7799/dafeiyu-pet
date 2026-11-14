/**
 * 端到端验证：大脑菜单改版（WorkBuddy 风格）+ 自定义模型（1.1.14 热修加项）
 *   ① brainCustomSet 保存 / 落盘 / 校验
 *   ② 菜单渲染：快捷档 + 全部模型 + 限时免费标签 + 自定义行 + 配置入口，当前项打勾
 *   ③ 自定义弹窗：打开预填、保存生效
 *   ④ 聊天真走自定义通道：本地 mock SSE 服务器收到的 model / Authorization / system 提示词，
 *      气泡里出现 mock 回复（流式）
 *   ⑤ 菜单点空白关闭、点子菜单不再误收（回归 _dafMenuClick）
 * 用法：node build/_verify_brainui.js
 * 注意：会临时改写 ~/.workbuddy/dafeiyu-brain.json，结束时恢复原值
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const OUT = process.argv[2] || null;
function pickExe(dir) {
  const base = path.join(ROOT, dir, "win-unpacked");
  for (const name of ["DafeiyuPet.exe", "DafeiyuPetClean.exe"]) {
    if (fs.existsSync(path.join(base, name))) return path.join(base, name);
  }
  return path.join(base, "DafeiyuPet.exe");
}
const EXE = OUT ? pickExe(OUT) : path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const ARGS = OUT ? ["--remote-debugging-port=9476"] : ["--remote-debugging-port=9476", ROOT];
const PORT = 9476;
const BRAIN_PATH = path.join(os.homedir(), ".workbuddy", "dafeiyu-brain.json");
const MOCK_PORT = 9482;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  ✅ " + name + (detail ? "  → " + detail : "")); }
  else { fail++; console.log("  ❌ " + name + "  → " + String(detail).slice(0, 300)); }
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
        reject(new Error((d.exception && d.exception.description || d.text || "异常").slice(0, 300)));
      } else resolve(m.result && m.result.result ? m.result.result.value : undefined);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
  });
}

/* ---- mock SSE 服务器：记录请求，回固定流式回复 ---- */
const mockHits = [];
const mockServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let j = null;
    try { j = JSON.parse(body); } catch (e) {}
    mockHits.push({
      url: req.url,
      auth: req.headers.authorization || "",
      model: j && j.model,
      stream: j && j.stream,
      sys: (j && j.messages || []).some((m) => m.role === "system"),
      nMsgs: j && j.messages ? j.messages.length : 0,
    });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const parts = ["你好", "呀，", "本鱼在的"];
    let i = 0;
    const t = setInterval(() => {
      if (i < parts.length) {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: parts[i] } }] }) + "\n\n");
        i++;
      } else {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 6 } }) + "\n\n");
        res.write("data: [DONE]\n\n");
        res.end();
        clearInterval(t);
      }
    }, 60);
  });
});

function readBrainFile() {
  try { return JSON.parse(fs.readFileSync(BRAIN_PATH, "utf8")); } catch (e) { return null; }
}

(async () => {
  const backup = fs.existsSync(BRAIN_PATH) ? fs.readFileSync(BRAIN_PATH, "utf8") : null;
  await new Promise((r) => mockServer.listen(MOCK_PORT, r));

  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, ARGS, { env, stdio: "ignore", cwd: ROOT });
  let pet = null;
  for (let i = 0; i < 60 && !pet; i++) {
    await sleep(500);
    try {
      const t = await getJson("/json/list");
      pet = (t || []).find((x) => x.url.includes("pet.html"));
    } catch (e) {}
  }
  if (!pet) { console.log("桌宠窗口没起来"); child.kill(); process.exit(1); }
  const petWs = pet.webSocketDebuggerUrl;
  for (let i = 0; i < 30; i++) {
    const ok = await cdpEval(petWs, 'typeof refreshMenu === "function"').catch(() => false);
    if (ok) break;
    await sleep(400);
  }

  try {
    /* ① 自定义配置保存 */
    console.log("\n【1】自定义模型配置");
    const bad = await cdpEval(petWs, 'window.dafeiyu.brainCustomSet({baseUrl:"ftp://x",model:"m"}).then(r=>JSON.stringify(r))');
    check("非法地址被拦", JSON.parse(bad).ok === false, bad);
    const ok1 = await cdpEval(petWs,
      'window.dafeiyu.brainCustomSet({name:"测试模型",baseUrl:"http://127.0.0.1:' + MOCK_PORT + '/v1",apiKey:"sk-test",model:"mock-5"}).then(r=>JSON.stringify(r))');
    const o1 = JSON.parse(ok1);
    check("brainCustomSet 保存成功", o1.ok === true, ok1);
    check("自动切到自定义大脑", o1.brain && o1.brain.id === "custom" && o1.brain.custom && o1.brain.custom.model === "mock-5", ok1);
    const file = readBrainFile();
    check("落盘 id=custom 且带配置", file && file.id === "custom" && file.custom && file.custom.apiKey === "sk-test", JSON.stringify(file));

    /* ② 菜单渲染 */
    console.log("\n【2】大脑菜单渲染");
    await cdpEval(petWs, 'closeMenus(); showSub("brain", document.querySelector(\'[data-sub="settings"]\')); "ok"');
    const ui = JSON.parse(await cdpEval(petWs, `(function(){
      const rows = [...submenuEl.querySelectorAll(".item.mrow")];
      return JSON.stringify({
        n: rows.length,
        heads: [...submenuEl.querySelectorAll(".mhead")].map((h) => h.textContent),
        free: rows.filter((r) => r.querySelector(".mtag-free")).length,
        ticks: rows.filter((r) => r.querySelector(".mtick") && r.querySelector(".mtick").textContent === "✓").map((r) => r.dataset.brain),
        custom: rows.some((r) => r.dataset.brain === "custom"),
        cfgRow: !!submenuEl.querySelector('[data-act="cusconfig"]'),
        backRow: !!submenuEl.querySelector('[data-act="backsettings"]'),
        metaSample: (rows.find((r) => r.dataset.brain === "glm-5.3") || {textContent:""}).textContent
      });
    })()`));
    check("模型行数量 = 清单" + (ui.n - (ui.custom ? 1 : 0)) + " + 自定义", ui.n >= 10, String(ui.n));
    check("分组头：快捷档 + 全部模型", ui.heads.join(",") === "快捷档,全部模型", ui.heads.join(","));
    check("限时免费标签存在", ui.free >= 1, ui.free + " 个");
    check("当前项打勾（自定义）", ui.ticks.join(",") === "custom", ui.ticks.join(","));
    check("自定义行 + 配置入口 + 返回都在", ui.custom && ui.cfgRow && ui.backRow, "");
    check("倍率显示 0.69x 风格", /0\.69x/.test(ui.metaSample), ui.metaSample);

    /* ③ 自定义弹窗 */
    console.log("\n【3】自定义模型弹窗");
    await cdpEval(petWs, 'openCustomCfg(); "ok"');
    const dlg = JSON.parse(await cdpEval(petWs, `JSON.stringify({
      show: customBox.style.display,
      url: cuUrl.value, key: cuKey.value, model: cuModel.value
    })`));
    check("弹窗打开且预填当前配置", dlg.show === "block" && dlg.url.indexOf(":" + MOCK_PORT) > 0 && dlg.model === "mock-5" && dlg.key === "sk-test", JSON.stringify(dlg));
    await cdpEval(petWs, 'document.getElementById("cu-cancel").click(); "ok"');

    /* ④ 聊天真走自定义通道 */
    console.log("\n【4】聊天走自定义通道");
    await cdpEval(petWs, 'window.dafeiyu.openChat(); "ok"').catch(() => {});
    let chat = null;
    for (let i = 0; i < 60 && !chat; i++) {
      await sleep(500);
      try {
        const t = await getJson("/json/list");
        chat = (t || []).find((x) => x.url.includes("chat.html"));
      } catch (e) {}
    }
    check("聊天窗打开", !!chat, chat ? "" : "超时");
    if (chat) {
      const chatWs = chat.webSocketDebuggerUrl;
      let ready = false;
      for (let i = 0; i < 60 && !ready; i++) {
        await sleep(500);
        ready = await cdpEval(chatWs, 'typeof runTurn === "function" && typeof modelId !== "undefined"').catch(() => false);
      }
      check("聊天窗脚本就绪", ready === true, String(ready));
      let mid = null;
      for (let i = 0; i < 30; i++) {
        mid = await cdpEval(chatWs, 'String(modelId)').catch(() => null);
        if (mid === "custom") break;
        await sleep(400);
      }
      check("modelId = custom", mid === "custom", String(mid));
      const before = await cdpEval(chatWs, 'document.querySelectorAll(".msg.fish, .fish").length').catch(() => 0);
      await cdpEval(chatWs, '(function(){ const i=document.getElementById("input"); i.value="在吗"; document.getElementById("send").click(); return "sent"; })()', 20000).catch((e) => console.log("  发送异常：" + e.message));
      let reply = "";
      for (let w = 0; w < 30000; w += 1000) {
        await sleep(1000);
        const st = await cdpEval(chatWs, '(function(){ const bs=document.querySelectorAll(".msg.fish, .fish"); let last=null; for (const b of bs) last=b.textContent; return JSON.stringify({ gen: (typeof generating!=="undefined"? generating : null), last: last, n: bs.length }); })()').catch(() => null);
        if (!st) continue;
        const o = JSON.parse(st);
        if (!o.gen && o.n > before) { reply = o.last; break; }
      }
      check("mock 流式回复完整送达", /你好呀，本鱼在的/.test(reply), (reply || "无回复").slice(0, 120));
      check("mock 收到请求（model/stream/system）", mockHits.length >= 1 && mockHits[0].model === "mock-5" && mockHits[0].stream === true && mockHits[0].sys === true,
        JSON.stringify(mockHits[0] || null));
      check("API Key 以 Bearer 透传", mockHits.length >= 1 && mockHits[0].auth === "Bearer sk-test", mockHits[0] && mockHits[0].auth);

      /* ⑤ 菜单回归：点子菜单行不再误收（_dafMenuClick） */
      console.log("\n【5】菜单回归");
      await cdpEval(petWs, `(() => {
        closeMenus();
        window.dispatchEvent(new MouseEvent("contextmenu", { clientX: 170, clientY: 380, bubbles: true, cancelable: true }));
        menuEl.querySelector('[data-sub="settings"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
        submenuEl.querySelector('[data-act="brain"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return "ok";
      })()`);
      await sleep(400);
      const menuState = JSON.parse(await cdpEval(petWs, 'JSON.stringify({ m: menuEl.style.display, s: submenuEl.style.display })'));
      check("点大脑菜单保持打开", menuState.m === "block" && menuState.s === "block", JSON.stringify(menuState));
    }
  } catch (e) {
    check("验证过程未抛异常", false, e.message);
  } finally {
    child.kill();
    mockServer.close();
    try {
      if (backup !== null) fs.writeFileSync(BRAIN_PATH, backup);
      else fs.unlinkSync(BRAIN_PATH);
    } catch (e) {}
    console.log("\n" + (fail === 0 ? "全部通过" : "有失败项") + "：" + pass + " 通过 / " + fail + " 失败");
    process.exit(fail === 0 ? 0 : 1);
  }
})();
