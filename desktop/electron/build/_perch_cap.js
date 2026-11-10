/* 临时：连到开发态桌宠，强制趴到指定边，然后用 CDP 抓窗口自身画面（透明 PNG） */
const http = require("http");
const fs = require("fs");
const PORT = Number(process.env.DFY_PORT || 9460);
const EDGE = process.argv[2] || "left";
const OUT = process.argv[3] || ("C:/Users/Administrator/WorkBuddy/2026-11-05-13-53-01/_perch_" + EDGE + ".png");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (p) => new Promise((res, rej) => {
  const q = http.get({ host: "127.0.0.1", port: PORT, path: p, timeout: 3000 }, (r) => {
    let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  });
  q.on("error", rej); q.on("timeout", () => q.destroy(new Error("t")));
});
function cdp(ws, method, params, id) {
  return new Promise((res, rej) => {
    const w = new WebSocket(ws);
    w.onopen = () => w.send(JSON.stringify({ id: id || 1, method, params: params || {} }));
    w.onmessage = (e) => {
      const m = JSON.parse(e.data); if (m.id !== (id || 1)) return; w.close();
      if (m.error) rej(new Error(JSON.stringify(m.error)));
      else res(m.result);
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
  /* 1) 强制趴到指定边 */
  await cdp(p.webSocketDebuggerUrl, "Runtime.evaluate", {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
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
      await wait(900);
      if (S.perch) { S.perch.until = performance.now() / 1000 + 600; }
      return { edge: S.perch && S.perch.edge, rect: { x: window.screenX, y: window.screenY, w: winW, h: winH } };
    })()`,
  }, 1).then((r) => console.log(JSON.stringify(r.result.value)));
  /* 2) 抓窗口画面 */
  const shot = await cdp(p.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, 2);
  fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));
  console.log("saved:", OUT);
  process.exit(0);
})().catch((e) => { console.log("异常：" + e.message); process.exit(1); });
