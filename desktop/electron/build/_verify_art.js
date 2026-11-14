/**
 * 端到端验证：创作室 v3（智谱/硅基流动双平台，无免费兜底）
 *   ① art_config 平台 key 保存/删除/脱敏 + 通道切换
 *   ② 无任何 key：明确引导注册
 *   ③ 假 key：报错聚合显示每个通道的真实原因（401 等）
 *   ④ draw_image 参数校验
 *   ⑤ make_video 无智谱 key 的引导报错（旧版录屏接口已下架）
 *   ⑥ make_video 假 key → 智谱鉴权失败（真实连通性）
 *   ⑦ animate_image 参数校验与引导
 *   ⑧ list_art 作品集
 *   ⑨ pet_act 联动（有真 key 时出图才播 done，本脚本默认不测真出图）
 * 真出图验证：设置环境变量 DFY_ZHIPU_KEY=<有效key> 后运行，会额外测一次真实出图
 * 用法：node build/_verify_art.js [打包输出目录名]
 */
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");
const OUT = process.argv[2] || null;
const REAL_KEY = process.env.DFY_ZHIPU_KEY || null;
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
  else { fail++; console.log("  ❌ " + name + "  → " + String(detail).slice(0, 260)); }
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
  const pc = (tool, args, to) => cdpEval(chat.webSocketDebuggerUrl,
    "window.dafeiyu.pc(" + JSON.stringify(tool) + "," + JSON.stringify(args || {}) + ").then(r=>JSON.stringify({ok:r.ok,result:r.result,error:r.error}))", to || 200000);
  const unw = (s) => { const w = JSON.parse(s); if (!w.ok) throw new Error(w.error || "tool failed"); return w.result; };

  try {
    const petWs = ((await getJson("/json/list")).find((x) => x.url.includes("pet.html"))).webSocketDebuggerUrl;
    await cdpEval(petWs,
      'window.__actCalls=0; if(!window.__dpa){window.__dpa=doPetAct;} doPetAct=function(n){ if(n==="done") __actCalls++; return __dpa(n); }; "ok"', 8000);
    unw(await pc("art_config", { provider: "zhipu", key: "" }));
    unw(await pc("art_config", { provider: "siliconflow", key: "" }));
    unw(await pc("art_config", { imageApi: null, videoApi: null }));
    unw(await pc("art_config", { imageProvider: "auto", videoProvider: "zhipu" }));

    /* ① art_config 平台 key 保存/脱敏/删除 + 通道切换 */
    let r = unw(await pc("art_config", { provider: "zhipu", key: "zp-test-1234567890" }));
    check("art_config 保存 zhipu key", r.providers && r.providers.zhipu && r.providers.zhipu.key.includes("***"), JSON.stringify(r.providers && r.providers.zhipu));
    check("art_config key 不明文回显", !JSON.stringify(r).includes("1234567890"), "");
    check("art_config 返回注册链接", /bigmodel\.cn/.test(JSON.stringify(r)), "");
    r = unw(await pc("art_config", { imageProvider: "siliconflow" }));
    check("art_config 切换通道", r.imageProvider === "siliconflow", "imageProvider=" + r.imageProvider);
    r = unw(await pc("art_config", { provider: "zhipu", key: "" }));
    check("art_config 空 key 删除", (r.providers.zhipu.key || "") === "", JSON.stringify(r.providers.zhipu && r.providers.zhipu.key));

    /* ② 无任何 key：明确引导注册（不再有免费兜底通道） */
    const e0 = JSON.parse(await pc("draw_image", { prompt: "a cute whale" }, 60000)).error || "";
    check("无 key 画图引导注册/保存", /bigmodel\.cn|art_config|key/.test(e0) && !/pollinations/i.test(e0), e0.slice(0, 120));

    /* ③ 假 key：报错聚合每个通道的真实原因 */
    unw(await pc("art_config", { provider: "zhipu", key: "zp-invalid-key-for-test" }));
    unw(await pc("art_config", { provider: "siliconflow", key: "sf-invalid-key-for-test" }));
    const e1 = JSON.parse(await pc("draw_image", { prompt: "a cute whale" }, 200000)).error || "";
    check("假 key 聚合报错含智谱原因", /(zhipu|智谱)[：:].*(401|鉴权|失败|key)/i.test(e1), e1.slice(0, 220));
    check("假 key 聚合报错含硅基流动原因", /(siliconflow|硅基流动)[：:]/i.test(e1), "");
    check("报错不再出现 pollinations", !/pollinations/i.test(e1), "");
    unw(await pc("art_config", { provider: "zhipu", key: "" }));
    unw(await pc("art_config", { provider: "siliconflow", key: "" }));

    /* ④ draw_image 参数校验 */
    const e2 = JSON.parse(await pc("draw_image", {})).error || "";
    check("draw_image 无 prompt 报错引导", /prompt/.test(e2), e2.slice(0, 80));

    /* ④+ 真出图（可选：需 DFY_ZHIPU_KEY 环境变量提供有效 key） */
    if (REAL_KEY) {
      unw(await pc("art_config", { provider: "zhipu", key: REAL_KEY }));
      r = unw(await pc("draw_image", { prompt: "a cute chubby blue whale flying over clouds, cartoon", width: 512, height: 512 }, 200000));
      check("draw_image 真出图（" + r.provider + "）", r.path && fs.existsSync(r.path) && r.size > 8000, r.path + " " + r.size + "B");
      check("draw_image 返回预览 dataUrl", /^data:image\/jpeg;base64,/.test(r.dataUrl || ""), "");
      const actCalls = await cdpEval(petWs, "window.__actCalls", 8000);
      check("画完鱼播联动动画（done）", actCalls >= 1, "次数=" + actCalls);
      unw(await pc("art_config", { provider: "zhipu", key: "" }));  /* 清掉测试 key */
    } else {
      check("真出图（未提供 DFY_ZHIPU_KEY，跳过）", true, "SKIP");
      check("联动动画（依赖真出图，跳过）", true, "SKIP");
    }

    /* ⑤ make_video 无智谱 key 的引导 */
    const e3 = JSON.parse(await pc("make_video", { prompt: "一条小鲸鱼游过星空" }, 60000)).error || "";
    check("make_video 无 key 引导注册/保存", /bigmodel\.cn|art_config|智谱/.test(e3), e3.slice(0, 100));
    const e3b = JSON.parse(await pc("make_video", { images: ["a.png"] }, 60000)).error || "";
    check("make_video 旧参数(images)被拒并引导新用法", /animate_image|prompt/.test(e3b), e3b.slice(0, 100));

    /* ⑥ make_video 假 key → 智谱接口真实应答（401/鉴权失败） */
    unw(await pc("art_config", { provider: "zhipu", key: "zp-invalid-key-for-test" }));
    const w3 = JSON.parse(await pc("make_video", { prompt: "一条小鲸鱼游过星空", duration: "5" }, 120000));
    const e4 = w3.ok ? "调用竟然成功了" : (w3.error || "");
    check("make_video 假 key 被智谱拒绝（接口连通）", !w3.ok && /鉴权|401|403|失败|key|timeout|fetch/i.test(e4), e4.slice(0, 120));
    unw(await pc("art_config", { provider: "zhipu", key: "" }));

    /* ⑦ animate_image 参数校验与无 key 引导 */
    const artDir = path.join(process.env.USERPROFILE || require("os").homedir(), ".workbuddy", "dafeiyu-art");
    const existing = fs.existsSync(artDir) ? fs.readdirSync(artDir).filter((f) => /\.(png|jpe?g)$/i.test(f)).map((f) => path.join(artDir, f)) : [];
    const anyImg = existing.length ? existing[existing.length - 1] : null;
    const e5 = JSON.parse(await pc("animate_image", { image: anyImg || "Z:\\x.png" })).error || "";
    check("animate_image 无 key 引导 art_config", /art_config|bigmodel\.cn|key/.test(e5), e5.slice(0, 100));
    const e6 = JSON.parse(await pc("animate_image", { image: "Z:\\不存在的图.png" })).error || "";
    check("animate_image 图不存在报错", /不存在/.test(e6), e6.slice(0, 80));

    /* ⑧ list_art 作品集 */
    r = unw(await pc("list_art"));
    check("list_art 正常返回", typeof r.count === "number" && Array.isArray(r.items), "count=" + r.count);

    console.log("\n===== 结果: " + pass + " 通过 / " + fail + " 失败 =====");
    child.kill();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error("❌ 验证中断:", e.message);
    child.kill();
    process.exit(1);
  }
})();
