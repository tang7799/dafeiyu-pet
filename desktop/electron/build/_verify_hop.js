/**
 * 临时验证：蹦跶（连跳）的跳高/跳远是否随体型缩放
 * 用法：node build/_verify_hop.js
 */
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const EXE = path.join(__dirname, "..", "node_modules", "electron", "dist", "electron.exe");
const APP_DIR = path.join(__dirname, "..");
const PORT = 9446;
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
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error("cdp timeout")); }, 40000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== 1) return;
      clearTimeout(timer); ws.close();
      if (m.result && m.result.exceptionDetails) reject(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 400)));
      else resolve(m.result && m.result.result ? m.result.result.value : undefined);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
  });
}

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + name + (extra !== undefined ? "  → " + String(extra) : ""));
  cond ? pass++ : fail++;
};

(async () => {
  console.log("启动开发态桌宠：" + EXE);
  const child = spawn(EXE, ["--remote-debugging-port=" + PORT, APP_DIR], { env, stdio: "ignore", cwd: APP_DIR });

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

  // 每个缩放级别测一次"单次起跳"：跳高 = 起跳点 - 最高点，跳远 = 起跳点 - 落地点
  const res = await cdpEval(pet.webSocketDebuggerUrl, `(async () => {
    const out = {};
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    for (const sc of [0.5, 1, 2]) {
      S.scale = sc; applyScale();
      S.x = 700; S.dir = 1; S.vx = 0; S.vy = 0; S.hopCount = 0; S.state = "hop";
      S.y = groundY + footPadCur;
      clampX();
      await wait(200);
      const x0 = S.x, y0 = S.y;
      let minY = y0, maxX = x0;
      startHop();
      const t0 = performance.now();
      await new Promise(done => {
        const id = setInterval(() => {
          minY = Math.min(minY, S.y);
          maxX = Math.max(maxX, S.x);
          if (performance.now() - t0 > 3000) { clearInterval(id); done(); }
        }, 20);
      });
      out["scale" + sc] = {
        hopH: Math.round(y0 - minY),
        hopDx: Math.round(maxX - x0),
        petH: Math.round(180 * sc),
      };
      S.vx = 0; S.vy = 0; S.hopCount = 0; setState("idle"); S.y = groundY + footPadCur;
      await wait(250);
    }
    S.scale = 1; applyScale();
    return out;
  })()`);

  console.log("\n实测结果：");
  [0.5, 1, 2].forEach((sc) => {
    const r = res["scale" + sc];
    console.log("  scale=" + sc + "  角色高≈" + r.petH + "px  跳高=" + r.hopH + "px  跳远=" + r.hopDx + "px");
  });

  const h1 = res.scale1.hopH, h2 = res.scale2.hopH, h05 = res["scale0.5"].hopH;
  const d1 = res.scale1.hopDx || 0, d2 = res.scale2.hopDx || 0, d05 = res["scale0.5"].hopDx || 0;

  check("scale=1 跳高 >= 60px（原来约 34~80）", h1 >= 60, h1 + "px");
  check("scale=1 跳远 >= 90px（原来约 40~150）", d1 >= 90, d1 + "px");
  check("放大到 2x 后跳高明显更高（>1.2 倍）", h2 > h1 * 1.2, h2 + " vs " + h1);
  check("放大到 2x 后跳远明显更远（>1.2 倍）", d2 > d1 * 1.2, d2 + " vs " + d1);
  check("缩小到 0.5x 后跳高相应变小（<0.9 倍）", h05 < h1 * 0.9, h05 + " vs " + h1);
  check("跳高不超过窗口头部预留 240px", h2 <= 240, h2 + "px");

  console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
  child.kill();
  await sleep(400);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("异常：" + e.message); process.exit(1); });
