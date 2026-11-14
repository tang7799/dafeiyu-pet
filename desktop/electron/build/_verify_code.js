/**
 * 端到端验证：1.1.12 写代码三件套（run_cmd / run_code / edit_file）
 *   ① run_cmd 执行命令、拿 stdout
 *   ② 中文输出不乱码（powershell UTF-8 前置是否生效）
 *   ③ 非零退出码如实返回
 *   ④ 危险命令（format / shutdown / reg delete）被拦死
 *   ⑤ cwd 生效 / cwd 不存在报错清晰
 *   ⑥ run_code node / python 能跑
 *   ⑦ 代码报错能拿到 stderr
 *   ⑧ lang 不填能自动识别
 *   ⑨ edit_file 精确替换（不碰其它行）
 *   ⑩ 找不到原文 → 诊断报错
 *   ⑪ 重复原文 → 拒绝乱改并给行号
 *   ⑫ all:true 全替换
 *   ⑬ 行号模式改单行
 *   ⑭ 中文内容替换 + CRLF 原样保留
 *   ⑮ 权限关闭时全部拦住（PERM_OFF）
 *   ⑯ 桌宠设置里有「💻 命令确认」开关
 * 跳过原生确认框：脚本给子进程设 DFY_CMD_AUTOYES=1（仅测试用，打包版正常会弹窗）
 * 用法：node build/_verify_code.js [打包输出目录名]
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
const ARGS = OUT ? ["--remote-debugging-port=9473"] : ["--remote-debugging-port=9473", ROOT];
const PORT = 9473;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0, skip = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  ✅ " + name + (detail ? "  → " + String(detail).slice(0, 120) : "")); }
  else { fail++; console.log("  ❌ " + name + "  → " + String(detail).slice(0, 300)); }
}
function skipIt(name, why) { skip++; console.log("  ⏭  " + name + "（" + why + "）"); }

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
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error("cdp timeout")); }, timeoutMs || 60000);
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
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  env.DFY_CMD_AUTOYES = "1";          /* 跳过原生确认框，否则脚本会卡在弹窗上 */
  const child = spawn(EXE, ARGS, { env, stdio: "ignore", cwd: ROOT });

  let chat = null, pet = null;
  for (let i = 0; i < 60 && !chat; i++) {
    await sleep(500);
    try {
      const t = await getJson("/json/list");
      pet = (t || []).find((x) => x.url.includes("pet.html")) || pet;
      if (pet && !(t || []).find((x) => x.url.includes("chat.html"))) {
        await cdpEval(pet.webSocketDebuggerUrl, 'window.dafeiyu.openChat(); "ok"', 8000).catch(() => {});
      }
      chat = (t || []).find((x) => x.url.includes("chat.html"));
    } catch (e) {}
  }
  if (!chat) { console.error("❌ chat.html 没起来"); child.kill(); process.exit(1); }
  await sleep(1800);

  const pc = (tool, args, to) => cdpEval(chat.webSocketDebuggerUrl,
    "window.dafeiyu.pc(" + JSON.stringify(tool) + "," + JSON.stringify(args || {}) + ").then(r=>JSON.stringify({ok:r.ok,result:r.result,error:r.error}))", to || 180000);
  const unw = (s) => { try { return JSON.parse(s); } catch (e) { return { ok: false, error: String(s) }; } };
  const ev = (expr, to) => cdpEval(chat.webSocketDebuggerUrl, expr, to || 30000);

  /* 独立工作目录（带时间戳，避免和上次残留冲突；不删旧目录，绕开沙箱删除限制） */
  const TMP = path.join(os.tmpdir(), "dfy-code-" + Date.now());
  fs.mkdirSync(TMP, { recursive: true });
  console.log("  工作目录：" + TMP + "\n");

  try {
    /* ① run_cmd 基本执行 */
    const r1 = unw(await pc("run_cmd", { cmd: "echo hello-dfy" }));
    check("run_cmd 执行命令并返回 stdout", r1.ok && /hello-dfy/.test(r1.result.stdout) && r1.result.exitCode === 0,
      "exit=" + (r1.result && r1.result.exitCode) + " out=" + String(r1.result && r1.result.stdout).trim());

    /* ② 中文不乱码 */
    const r2 = unw(await pc("run_cmd", { cmd: 'Write-Output "大肥鱼会写代码了"' }));
    check("run_cmd 中文输出不乱码", r2.ok && /大肥鱼会写代码了/.test(r2.result.stdout),
      JSON.stringify(String(r2.result && r2.result.stdout).trim()));

    /* ③ 非零退出码 */
    const r3 = unw(await pc("run_cmd", { cmd: "cmd /c exit 3; exit $LASTEXITCODE" }));
    check("非零退出码如实返回", !r3.result.ok && r3.result.exitCode === 3,
      "exit=" + (r3.result && r3.result.exitCode) + " note=" + (r3.result && r3.result.note));

    /* ④ 危险命令拦截 */
    const bads = [
      ["format c: /q", "格式化磁盘"],
      ["shutdown /s /t 0", "关机"],
      ["reg delete HKLM\\SOFTWARE\\Foo /f", "删注册表"],
    ];
    let blocked = 0, lastErr = "";
    for (const [c] of bads) {
      const rb = unw(await pc("run_cmd", { cmd: c }));
      if (!rb.ok && /拦下/.test(rb.error || "")) blocked++;
      else lastErr = c + " → " + (rb.ok ? "竟然执行了！" : rb.error);
    }
    check("危险命令全部拦死（format/关机/删注册表）", blocked === 3, blocked + "/3" + (lastErr ? " 漏网:" + lastErr : ""));

    /* ⑤ cwd */
    const r5 = unw(await pc("run_cmd", { cmd: "(Get-Location).Path", cwd: TMP }));
    const gotPath = String(r5.result && r5.result.stdout || "").trim().toLowerCase();
    check("run_cmd 的 cwd 真正生效", r5.ok && gotPath.includes(path.basename(TMP).toLowerCase()), gotPath);
    const r5b = unw(await pc("run_cmd", { cmd: "echo x", cwd: TMP + "\\no-such-dir" }));
    check("cwd 不存在时报错清晰", !r5b.ok && /工作目录不存在/.test(r5b.error || ""), r5b.error);

    /* ⑥⑦⑧ run_code */
    const r6 = unw(await pc("run_code", { lang: "node", code: "console.log(1+2)" }));
    check("run_code node 能跑", r6.ok && /(^|\s)3(\s|$)/.test(String(r6.result.stdout || "")),
      "out=" + String(r6.result && r6.result.stdout).trim());

    const r7 = unw(await pc("run_code", { lang: "node", code: "throw new Error('boom-dfy')" }));
    check("run_code 报错能拿到 stderr", !r7.result.ok && /boom-dfy/.test(String(r7.result.stderr || "")),
      "exit=" + (r7.result && r7.result.exitCode));

    let pyOK = false;
    const rPy = unw(await pc("run_code", { lang: "python", code: "print(sum(range(10)))" }));
    if (!rPy.ok && /没找到 python/.test(rPy.error || "")) {
      skipIt("run_code python", "本机没装 Python，引导报错正确");
    } else {
      pyOK = true;
      check("run_code python 能跑", rPy.ok && /45/.test(String(rPy.result.stdout || "")),
        "out=" + String(rPy.result && rPy.result.stdout).trim());
    }

    if (pyOK) {
      const r8 = unw(await pc("run_code", { code: "print('guess-py-ok')" }));
      check("lang 不填自动识别 python", r8.ok && r8.result.lang === "python" && /guess-py-ok/.test(String(r8.result.stdout)),
        "lang=" + (r8.result && r8.result.lang));
    } else {
      const r8 = unw(await pc("run_code", { code: "console.log('guess-js-ok')" }));
      check("lang 不填自动识别 node", r8.ok && r8.result.lang === "node" && /guess-js-ok/.test(String(r8.result.stdout)),
        "lang=" + (r8.result && r8.result.lang));
    }

    /* ⑨ edit_file 精确替换 */
    const f1 = path.join(TMP, "a.js");
    fs.writeFileSync(f1, "const a = 1;\nconst b = 2;\nconst c = 3;\n", "utf8");
    const e1 = unw(await pc("edit_file", { path: f1, find: "const a = 1;", replace: "const a = 42;" }));
    const t1 = fs.readFileSync(f1, "utf8");
    check("edit_file 精确替换一处，其它行不动",
      e1.ok && e1.result.replaced === 1 && /const a = 42;/.test(t1) && /const b = 2;/.test(t1) && /const c = 3;/.test(t1),
      JSON.stringify(t1));

    /* ⑩ 找不到原文 */
    const e2 = unw(await pc("edit_file", { path: f1, find: "const zzz = 9;", replace: "x" }));
    check("找不到原文时给出诊断而不是乱写", !e2.ok && /找不到这段原文/.test(e2.error || ""), e2.error);

    /* ⑪ 重复原文拒绝 */
    const f2 = path.join(TMP, "dup.txt");
    fs.writeFileSync(f2, "hello\nworld\nhello\n", "utf8");
    const e3 = unw(await pc("edit_file", { path: f2, find: "hello", replace: "HI" }));
    check("重复原文拒绝盲改并报行号", !e3.ok && /出现了 2 次/.test(e3.error || ""), e3.error);

    /* ⑫ all:true */
    const e4 = unw(await pc("edit_file", { path: f2, find: "hello", replace: "HI", all: true }));
    const t2 = fs.readFileSync(f2, "utf8");
    check("all:true 全部替换", e4.ok && e4.result.replaced === 2 && !/hello/.test(t2) && /world/.test(t2), JSON.stringify(t2));

    /* ⑬ 行号模式 */
    const e5 = unw(await pc("edit_file", { path: f2, line: 2, content: "WORLD" }));
    const lines2 = fs.readFileSync(f2, "utf8").split("\n");
    check("行号模式改单行", e5.ok && lines2[1] === "WORLD", JSON.stringify(lines2));

    /* ⑭ 中文 + CRLF */
    const f3 = path.join(TMP, "cn.txt");
    fs.writeFileSync(f3, "第一行\r\n中文内容\r\n第三行\r\n", "utf8");
    const e6 = unw(await pc("edit_file", { path: f3, find: "中文内容", replace: "改过的中文" }));
    const raw3 = fs.readFileSync(f3, "utf8");
    const loneLF = raw3.replace(/\r\n/g, "").includes("\n");
    check("中文替换正确且 CRLF 原样保留",
      e6.ok && raw3.includes("改过的中文") && !raw3.includes("中文内容") && /\r\n/.test(raw3) && !loneLF,
      JSON.stringify(raw3));

    /* ⑮ 权限关闭拦截（先记原状态，测完恢复） */
    const st0 = unw(await ev("window.dafeiyu.pcStatus().then(s=>JSON.stringify(s))"));
    const wasEnabled = st0.enabled !== false;
    await ev("window.dafeiyu.setPcPerm(false).then(()=>'ok')");
    const rp = unw(await pc("run_cmd", { cmd: "echo should-not-run" }));
    const rp2 = unw(await pc("edit_file", { path: f1, find: "const a = 42;", replace: "x" }));
    check("电脑操作关掉时命令/改文件全部拦住",
      !rp.ok && /电脑操作权限已关闭/.test(rp.error || "") && !rp2.ok && /电脑操作权限已关闭/.test(rp2.error || ""),
      rp.error);
    await ev("window.dafeiyu.setPcPerm(" + (wasEnabled ? "true" : "false") + ").then(()=>'ok')");
    const stBack = unw(await ev("window.dafeiyu.pcStatus().then(s=>JSON.stringify(s))"));
    check("权限状态已恢复原值", stBack.enabled === wasEnabled, "enabled=" + stBack.enabled);

    /* ⑯ 桌宠设置菜单有「命令确认」开关 */
    if (pet) {
      const menuTxt = await cdpEval(pet.webSocketDebuggerUrl,
        'JSON.stringify((function(){ try { showSub("settings", document.querySelector("[data-sub=settings]")); var t=(document.getElementById("mi-cmdconfirm")||{}).textContent||""; closeMenus(); return t; } catch(e) { return "ERR:"+e.message; } })())',
        15000).catch((e) => "ERR:" + e.message);
      check("设置里有「命令确认」开关且显示当前状态",
        /命令确认/.test(menuTxt) && /(每次问我|不问直接跑)/.test(menuTxt), menuTxt);
    } else {
      skipIt("设置菜单开关", "pet 页没抓到");
    }

    /* 补：run_cmd 真跑一个脚本文件（写→跑→改→再跑 的完整闭环） */
    const proj = path.join(TMP, "proj");
    fs.mkdirSync(proj, { recursive: true });
    unw(await pc("write_file", { path: path.join(proj, "calc.js"), content: "const r = 1 + 1;\nconsole.log('result=' + r);\nif (r !== 3) { console.error('WRONG'); process.exit(1); }\n" }));
    const c1 = unw(await pc("run_cmd", { cmd: "node calc.js", cwd: proj }));
    const fixd = unw(await pc("edit_file", { path: path.join(proj, "calc.js"), find: "1 + 1", replace: "1 + 2" }));
    const c2 = unw(await pc("run_cmd", { cmd: "node calc.js", cwd: proj }));
    check("写→跑（报错）→改→再跑（通过）完整闭环",
      !c1.result.ok && /WRONG/.test(String(c1.result.stderr)) && fixd.ok && c2.ok && /result=3/.test(String(c2.result.stdout)),
      "第一轮 exit=" + (c1.result && c1.result.exitCode) + "，改后 exit=" + (c2.result && c2.result.exitCode) + " out=" + String(c2.result && c2.result.stdout).trim());
  } catch (e) {
    check("验证过程未抛异常", false, e && e.message);
  }

  console.log("\n  结果：" + pass + " 通过 / " + fail + " 失败 / " + skip + " 跳过");
  child.kill();
  process.exit(fail ? 1 : 0);
})();
