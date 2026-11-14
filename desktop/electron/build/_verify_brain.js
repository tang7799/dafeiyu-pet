/**
 * 端到端验证：大脑切换（1.1.14）
 *   ① 默认配置可读、模型清单已缓存（聊天窗回传）
 *   ② brainSet 切换后落盘正确
 *   ③ 聊天窗 modelId 跟着变（不重开窗，靠广播）
 *   ④ 真实调用：切到 glm-5.3 后发一句话能拿到回复（验证通道真通）
 *   ⑤ 菜单项存在且带当前模型名
 *   ⑥ 切回 auto 后 modelId 回 auto
 * 用法：node build/_verify_brain.js [打包目录名]
 * 注意：会临时改写 ~/.workbuddy/dafeiyu-brain.json，结束时恢复原值
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const { spawn } = require("child_process");

const OUT = process.argv[2] || null;
const ROOT = path.join(__dirname, "..");
const EXE = OUT
  ? path.join(ROOT, OUT, "win-unpacked", (OUT === "dist" ? "DafeiyuPet.exe" : "DafeiyuPetClean.exe"))
  : path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const ARGS = OUT ? ["--remote-debugging-port=9474"] : ["--remote-debugging-port=9474", ROOT];
const PORT = 9474;
const BRAIN_PATH = path.join(os.homedir(), ".workbuddy", "dafeiyu-brain.json");
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
function readBrainFile() {
  try { return JSON.parse(fs.readFileSync(BRAIN_PATH, "utf8")); } catch (e) { return null; }
}

(async () => {
  /* 备份原配置，结束时恢复 */
  const backup = fs.existsSync(BRAIN_PATH) ? fs.readFileSync(BRAIN_PATH, "utf8") : null;

  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, ARGS, { env, stdio: "ignore", cwd: ROOT });
  let pet = null, chat = null;
  for (let i = 0; i < 60 && !pet; i++) {
    await sleep(500);
    try {
      const t = await getJson("/json/list");
      pet = (t || []).find((x) => x.url.includes("pet.html"));
    } catch (e) {}
  }
  if (!pet) { console.log("桌宠窗口没起来"); child.kill(); process.exit(1); }

  const petWs = pet.webSocketDebuggerUrl;
  /* 桌宠脚本就绪 */
  for (let i = 0; i < 30; i++) {
    const ok = await cdpEval(petWs, 'typeof refreshMenu === "function"').catch(() => false);
    if (ok) break;
    await sleep(400);
  }

  try {
    /* ① 初始状态 */
    console.log("\n【1】初始大脑配置");
    const init = await cdpEval(petWs, 'window.dafeiyu.brainGet().then(r=>JSON.stringify(r))');
    const initObj = JSON.parse(init);
    check("brainGet 返回当前大脑", initObj && initObj.brain && !!initObj.brain.id, JSON.stringify(initObj.brain));
    check("初始是 auto", initObj.brain.id === "auto", initObj.brain.id);
    check("模型清单已缓存（≥5 项）", Array.isArray(initObj.models) && initObj.models.length >= 5, (initObj.models || []).length + " 项");
    const hasGlm = (initObj.models || []).some((m) => m.id === "glm-5.3");
    check("清单里含 glm-5.3", hasGlm, (initObj.models || []).map((m) => m.id).slice(0, 8).join(","));

    /* ② 菜单结构 */
    console.log("\n【2】菜单项");
    const menuTxt = await cdpEval(petWs, '(function(){ const m=document.getElementById("menu"); return m ? m.textContent : ""; })()');
    check("设置子菜单能建出大脑行", await cdpEval(petWs,
      '(function(){ showSub("settings", document.querySelector(\'[data-sub="settings"]\')); const e=document.getElementById("mi-brain"); return e ? e.textContent : ""; })()'
    ).then((t) => /🧠 大脑：/.test(String(t))), "见下一项详值");
    const brainRow = await cdpEval(petWs, '(function(){ const e=document.getElementById("mi-brain"); return e ? e.textContent : "missing"; })()');
    check("大脑行显示当前模型名", /🧠 大脑：Auto/.test(String(brainRow)), brainRow);

    /* ③ 切到 glm-5.3 并落盘 */
    console.log("\n【3】切换到 GLM-5.3");
    if (!hasGlm) {
      console.log("  ⏭ 清单里没有 glm-5.3，跳过切换断言");
    } else {
      const r = await cdpEval(petWs, 'window.dafeiyu.brainSet("glm-5.3").then(r=>JSON.stringify(r))');
      const rj = JSON.parse(r);
      check("brainSet 返回成功", rj && rj.ok === true, r);
      const file = readBrainFile();
      check("配置文件已写入 glm-5.3", file && file.id === "glm-5.3", JSON.stringify(file));
      const row2 = await cdpEval(petWs, '(function(){ refreshMenu(); const e=document.getElementById("mi-brain"); return e ? e.textContent : "missing"; })()');
      check("菜单文案更新为 GLM-5.3", /GLM-5\.3/.test(String(row2)), row2);
    }

    /* ④ 打开聊天窗，看 modelId 是否跟着变 */
    console.log("\n【4】聊天窗跟随切换");
    await cdpEval(petWs, 'window.dafeiyu.openChat(); "ok"').catch(() => {});
    for (let i = 0; i < 60 && !chat; i++) {
      await sleep(500);
      try {
        const t = await getJson("/json/list");
        chat = (t || []).find((x) => x.url.includes("chat.html"));
      } catch (e) {}
    }
    if (!chat) {
      check("聊天窗打开", false, "超时");
    } else {
      const chatWs = chat.webSocketDebuggerUrl;
      /* CDN SDK + 主脚本就绪（踩过的坑：不轮询会拿到 undefined） */
      let ready = false;
      for (let i = 0; i < 60 && !ready; i++) {
        await sleep(500);
        ready = await cdpEval(chatWs, 'typeof runTurn === "function" && typeof modelId !== "undefined"').catch(() => false);
      }
      check("聊天窗脚本就绪", ready === true, String(ready));

      /* 干净版：CLOUD_CLEAN 且没填云配置时 cloud 为 null，initLLM 直接返回、modelId 一直是 null。
         这是正常的门槛行为，跳过依赖云端连接的断言（同 _verify_chatimg 的 SKIP 约定） */
      const cloudReady = await cdpEval(chatWs, 'typeof cloud !== "undefined" && !!cloud').catch(() => false);

      if (!cloudReady) {
        console.log("  ⏭ 干净版未填云配置，跳过 modelId 跟随与真实调用断言");
      } else {
        /* 等 initLLM 把 brain 配置读进来 */
        let mid = null;
        for (let i = 0; i < 30; i++) {
          mid = await cdpEval(chatWs, 'String(modelId)').catch(() => null);
          if (mid && mid !== "auto") break;
          await sleep(400);
        }
        check("modelId 读到 glm-5.3", mid === "glm-5.3", String(mid));

        /* ⑤ 真实调用一句话（验证 GLM-5.3 通道真通） */
        console.log("\n【5】真实调用 GLM-5.3");
        const before = await cdpEval(chatWs, 'document.querySelectorAll(".msg.fish, .fish").length').catch(() => 0);
        await cdpEval(chatWs, '(function(){ const i=document.getElementById("input"); i.value="只回两个字：在的"; document.getElementById("send").click(); return "sent"; })()', 20000).catch((e) => console.log("  发送异常：" + e.message));
        let reply = "", waited = 0;
        for (; waited < 120000; waited += 1500) {
          await sleep(1500);
          /* 必须等"新增"一个气泡，否则会把上一轮的残留当成这次的回复 */
          const st = await cdpEval(chatWs, '(function(){ const bs=document.querySelectorAll(".msg.fish, .fish"); let last=null; for (const b of bs) last=b.textContent; return JSON.stringify({ gen: (typeof generating!=="undefined"? generating : null), last: last, n: bs.length }); })()').catch(() => null);
          if (!st) continue;
          const o = JSON.parse(st);
          if (!o.gen && o.last && o.n > before && !/思考中/.test(o.last)) { reply = o.last; break; }
        }
        const okReply = reply && !/^\s*$/.test(reply) && !/失败|错误|错了|error/i.test(reply.slice(0, 40));
        check("GLM-5.3 真实回复成功", okReply, (reply || "无回复").slice(0, 120));
      }

      /* ⑥ 运行时切换（不重开窗） */
      console.log("\n【6】运行时切回 Auto");
      await cdpEval(petWs, 'window.dafeiyu.brainSet("auto").then(r=>JSON.stringify(r))');
      if (cloudReady) {
        let mid2 = null;
        for (let i = 0; i < 20; i++) {
          await sleep(400);
          mid2 = await cdpEval(chatWs, 'String(modelId)').catch(() => null);
          if (mid2 === "auto") break;
        }
        check("聊天窗 modelId 实时切回 auto（无需重开）", mid2 === "auto", String(mid2));
      }
      const file2 = readBrainFile();
      check("配置落盘为 auto", file2 && file2.id === "auto", JSON.stringify(file2));
    }
  } catch (e) {
    check("验证过程未抛异常", false, e.message);
  } finally {
    child.kill();
    /* 恢复原配置 */
    try {
      if (backup !== null) fs.writeFileSync(BRAIN_PATH, backup);
    } catch (e) {}
    console.log("\n" + (fail === 0 ? "全部通过" : "有失败项") + "：" + pass + " 通过 / " + fail + " 失败");
    process.exit(fail === 0 ? 0 : 1);
  }
})();
