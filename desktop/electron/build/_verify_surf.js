/**
 * 验证自主冲浪 v1.1.7：状态/开关、定时任务落盘、记忆工具、EVENT 剥离、桌宠动作、冲浪提示词注入
 * 用法：node build/_verify_surf.js [打包输出目录名]   缺省跑开发目录
 */
const path = require("path");
const http = require("http");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");

const OUT = process.argv[2] || null;
const ROOT = path.join(__dirname, "..");
const EXE = OUT
  ? path.join(ROOT, OUT, "win-unpacked", (OUT === "dist" ? "DafeiyuPet.exe" : "DafeiyuPetClean.exe"))
  : path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const PORT = 9461;
const ARGS = OUT ? ["--remote-debugging-port=" + PORT] : ["--remote-debugging-port=" + PORT, ROOT];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TASKS = path.join(os.homedir(), ".workbuddy", "dafeiyu-tasks.json");
const MEM_DIR = path.join(os.homedir(), ".workbuddy", "dafeiyu-memory");
const MARK = "验证脚本记录-" + Date.now();

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
  console.log((cond ? "  ✅ " : "  ❌ ") + name + (extra !== undefined ? "  → " + extra : ""));
  cond ? pass++ : fail++;
};
const readTasks = () => {
  try { return JSON.parse(fs.readFileSync(TASKS, "utf8")) || []; } catch (e) { return []; }
};

(async () => {
  console.log("启动：" + EXE + (OUT ? "" : " （开发目录）"));
  const child = spawn(EXE, ARGS, { env, stdio: "ignore", cwd: ROOT });
  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      targets = await getJson("/json/list");
      if (targets && targets.some((t) => t.url.includes("pet.html"))) break;
    } catch (e) {}
  }
  const pet = (targets || []).find((t) => t.url.includes("pet.html"));
  if (!pet) { console.log("❌ 找不到 pet.html 调试目标"); child.kill(); process.exit(1); }
  await sleep(1800);
  const ev = (expr) => cdpEval(pet.webSocketDebuggerUrl, expr);
  await ev(`S.nextIdleFun = 1e12; S.nextDecide = 1e12; "ok"`);

  try {
    console.log("\n—— 状态与菜单 ——");
    const st0 = await ev(`window.dafeiyu.surfState()`);
    check("surfState 返回状态对象", st0 && typeof st0 === "object" && "enabled" in st0 && "commentOn" in st0, JSON.stringify(st0));
    check("评论默认关闭", st0.commentOn === false);
    check("主菜单有「让鱼去冲浪」", await ev(`!!document.querySelector('#menu [data-act="surf"]')`));
    const hasMiSurf = await ev(`showSub("settings", document.querySelector('#menu [data-sub="settings"]')); !!document.getElementById("mi-surf")`);
    check("设置里有「自主冲浪」开关行", hasMiSurf);
    await ev(`closeMenus(); "ok"`);

    console.log("\n—— 开关 → 定时任务落盘 ——");
    const on = await ev(`window.dafeiyu.surfToggle(true)`);
    await sleep(400);
    check("开启后 enabled=true", on.enabled === true, JSON.stringify(on));
    const t1 = readTasks().filter((t) => t.type === "surf");
    check("tasks.json 出现 type=surf 任务", t1.length === 1, t1.length);
    check("默认 30 分钟一轮", t1[0] && t1[0].everyMinutes === 30, t1[0] && t1[0].everyMinutes);
    const off = await ev(`window.dafeiyu.surfToggle(false)`);
    await sleep(300);
    check("关闭后 enabled=false", off.enabled === false);
    check("关闭后任务被摘掉", readTasks().filter((t) => t.type === "surf").length === 0);

    console.log("\n—— 记忆工具（IPC 真调用）——");
    const w = await ev(`window.dafeiyu.pc("memory_write",{file:"video",text:${JSON.stringify(MARK)}})`);
    check("memory_write 成功", w && w.ok && w.result && w.result.file === "video_memory.md", w && JSON.stringify(w.result).slice(0, 80));
    check("文件写进 ~/.workbuddy/dafeiyu-memory", fs.readFileSync(path.join(MEM_DIR, "video_memory.md"), "utf8").includes(MARK));
    const s = await ev(`window.dafeiyu.pc("memory_search",{file:"video",query:${JSON.stringify(MARK)}})`);
    check("memory_search 查回刚写的记录", s.ok && s.result.matches.length >= 1);
    const perm = await ev(`window.dafeiyu.pc("comment_perm",{on:false})`);
    check("comment_perm 可关闭评论", perm.ok && perm.result.commentOn === false);

    console.log("\n—— 桌宠动作（EVENT → 动画）——");
    await ev(`window.__surfEmit("watching_video"); "ok"`);
    await sleep(300);
    const wv = await ev(`({clip: curClipName, line: bubble.textContent, state: S.state})`);
    check("watching_video 播放看视频动画", wv.clip === "sing", wv.clip);
    check("气泡提示看视频", /看视频/.test(wv.line), wv.line);
    await ev(`window.__surfEmit("thinking"); "ok"`);
    await sleep(250);
    check("thinking 切到思考动画", (await ev(`curClipName`)) === "startle");
    await ev(`window.__surfEmit("round_end"); "ok"`);
    await sleep(300);
    check("round_end 收尾回伸懒腰", (await ev(`curClipName`)) === "stretch");

    console.log("\n—— 聊天窗：冲浪提示词与 EVENT 剥离 ——");
    await ev(`window.dafeiyu.openChat(); "ok"`);
    let chat = null;
    for (let i = 0; i < 40 && !chat; i++) {
      await sleep(500);
      try { chat = (await getJson("/json/list")).find((t) => t.url.includes("chat.html")); } catch (e) {}
    }
    check("聊天窗能打开", !!chat);
    if (chat) {
      const cev = (expr) => cdpEval(chat.webSocketDebuggerUrl, expr);
      /* 聊天页要等 CDN 上的 SDK 脚本加载完，内联脚本才执行：轮询等它 ready */
      let ready = false;
      for (let i = 0; i < 40 && !ready; i++) {
        await sleep(500);
        try { ready = await cev(`typeof splitSurfEvents === "function" && typeof SURF_DOC === "string"`); } catch (e) {}
      }
      check("聊天页脚本初始化完成", ready);
      check("SURF_DOC 已内置", await cev(`typeof SURF_DOC === "string" && SURF_DOC.includes("自主冲浪模式") && SURF_DOC.includes("EVENT:watching_video")`));
      const sp = await cev(`splitSurfEvents("好呀\\nEVENT:watching_video\\n看完啦")`);
      check("EVENT 行被从正文剥掉", sp.shown === "好呀\n\n看完啦" || sp.shown === "好呀\n看完啦", JSON.stringify(sp.shown));
      check("EVENT 名被正确识别", sp.events.length === 1 && sp.events[0] === "watching_video", JSON.stringify(sp.events));
      const partial = await cev(`splitSurfEvents("看视频中\\nEVENT:watch")`);
      check("流式半截 EVENT 先藏起来", !partial.shown.includes("EVENT"), JSON.stringify(partial.shown));
      check("runTurn 支持 surf 参数", await cev(`runTurn.length >= 2 && String(runTurn).includes("opts.surf")`));
      check("冲浪模式会拼进系统提示", await cev(`String(runTurn).includes("opts.surf ? SURF_DOC")`));
    }
  } finally {
    try { await ev(`window.dafeiyu.surfToggle(false); "ok"`); } catch (e) {}
    try {
      const p = path.join(MEM_DIR, "video_memory.md");
      if (fs.existsSync(p)) {
        const kept = fs.readFileSync(p, "utf8").split(/\r?\n/).filter((l) => !l.includes(MARK));
        fs.writeFileSync(p, kept.join("\n"));
      }
    } catch (e) {}
    child.kill();
  }

  console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})();
