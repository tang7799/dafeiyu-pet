/* 临时：连到已运行的开发态桌宠，强制它在指定边上趴好并保持（用于截图检查观感） */
const http = require("http");
const PORT = Number(process.env.DFY_PORT || 9460);
const EDGE = process.argv[2] || "left";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (p) => new Promise((res, rej) => {
  const q = http.get({ host: "127.0.0.1", port: PORT, path: p, timeout: 3000 }, (r) => {
    let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  });
  q.on("error", rej); q.on("timeout", () => q.destroy(new Error("t")));
});
function ev(ws, expr) {
  return new Promise((res, rej) => {
    const w = new WebSocket(ws);
    w.onopen = () => w.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    w.onmessage = (e) => {
      const m = JSON.parse(e.data); if (m.id !== 1) return; w.close();
      if (m.result.exceptionDetails) rej(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 400)));
      else res(m.result.result.value);
    };
    w.onerror = () => rej(new Error("ws"));
  });
}
(async () => {
  let t = null;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try { t = await getJson("/json/list"); if (t && t.some((x) => x.url.includes("pet.html"))) break; } catch (e) {}
  }
  const p = t.find((x) => x.url.includes("pet.html"));
  const out = await ev(p.webSocketDebuggerUrl, `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    prefs.perch = false; S.perchAt = 1e12;
    if (S.perch) exitPerch(true);
    for (let i = 0; i < 100; i++) {
      await wait(30);
      startPerch("${EDGE}");
      await wait(700);
      if (S.perch && S.perch.edge === "${EDGE}") break;
      if (S.perch) exitPerch(true);
    }
    await wait(1200);
    if (S.perch) { S.perch.until = performance.now() / 1000 + 300; setState("idle"); }
    return { edge: S.perch && S.perch.edge, rot: S.perch && S.perch.g.rot, rect: { x: window.screenX, y: window.screenY, w: winW, h: winH } };
  })()`);
  console.log(JSON.stringify(out));
  process.exit(0);
})().catch((e) => { console.log("异常：" + e.message); process.exit(1); });
