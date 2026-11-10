/**
 * 临时验证：版权/开发者信息是否真的进了成品
 * 用法：node build/_verify_about.js [输出目录名]
 */
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const OUT = process.argv[2] || "dist-clean-110";
const EXE = path.join(__dirname, "..", OUT, "win-unpacked", "DafeiyuPetClean.exe");
const PORT = 9444;
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
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error("cdp timeout")); }, 15000);
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

(async () => {
  console.log("启动：" + EXE);
  const child = spawn(EXE, ["--remote-debugging-port=" + PORT], { env, stdio: "ignore" });

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

  const info = await cdpEval(pet.webSocketDebuggerUrl,
    "(async()=>{const i=await window.dafeiyu.appInfo();return i;})()");
  check("appInfo.version 是 1.1.5", info && info.version === "1.1.5", info && info.version);
  check("appInfo.developer 是 Dudu Studio", info && info.developer === "Dudu Studio", info && info.developer);
  check("appInfo.copyright 含 © 2026 Dudu Studio",
    !!info && /©\s*2026\s*Dudu Studio/.test(info.copyright), info && info.copyright);

  await cdpEval(pet.webSocketDebuggerUrl, "handleAction('about'); 'ok'");
  await sleep(600);
  const box = await cdpEval(pet.webSocketDebuggerUrl, `(() => {
    const b = document.getElementById('about-box');
    const cs = getComputedStyle(b);
    return {
      shown: cs.display !== 'none',
      text: b.innerText.replace(/\\s+/g, ' ').trim(),
      ver: document.getElementById('about-ver').textContent,
      inMenu: !![...document.querySelectorAll('#submenu .item')].length || true
    };
  })()`);
  check("右键菜单→关于：弹窗显示出来了", box && box.shown === true);
  check("弹窗里版本号是 v1.1.5", box && box.ver === "v1.1.5", box && box.ver);
  check("弹窗含开发者 Dudu Studio", !!box && box.text.includes("Dudu Studio"));
  check("弹窗含版权 © 2026", !!box && box.text.includes("© 2026"));
  check("弹窗保留素材署名", !!box && box.text.includes("CC BY-NC-SA"));

  // 菜单项是否存在
  await cdpEval(pet.webSocketDebuggerUrl, "showSub('settings', document.querySelector('[data-sub=settings]')); 'ok'");
  const menu = await cdpEval(pet.webSocketDebuggerUrl,
    "[...document.querySelectorAll('#submenu .item')].map(e=>e.textContent).join('|')");
  check("设置子菜单里有「关于 / 版权」", /关于 \/ 版权/.test(menu || ""), menu);

  // 聊天窗口底部版权行
  await cdpEval(pet.webSocketDebuggerUrl, "window.dafeiyu.openChat(); 'ok'");
  let chatT = null;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try {
      const t = await getJson("/json/list");
      chatT = (t || []).find((x) => x.url.includes("chat.html"));
      if (chatT) break;
    } catch (e) {}
  }
  check("聊天窗口已打开", !!chatT);
  if (chatT) {
    await sleep(1200);
    const ver = await cdpEval(chatT.webSocketDebuggerUrl,
      "document.getElementById('ver') && document.getElementById('ver').innerText");
    check("聊天窗底部显示开发者与版权", !!ver && ver.includes("Dudu Studio") && ver.includes("© 2026"), ver);
  }

  console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
  child.kill();
  await sleep(400);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("异常：" + e.message); process.exit(1); });
