const path = require("path"); const http = require("http"); const { spawn } = require("child_process");
const fs = require("fs");
const ROOT = path.join(__dirname, ".."); const PORT = 9457;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getJson(p) { return new Promise((res, rej) => { const q = http.get({ host: "127.0.0.1", port: PORT, path: p, timeout: 3000 }, (r) => { let d = ""; r.on("data", (c) => d += c); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }); q.on("error", rej); }); }
function cdp(wsUrl, method, params) { return new Promise((resolve, reject) => { const ws = new WebSocket(wsUrl); let id = 0;
  const t = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error("timeout")); }, 15000);
  ws.onopen = () => ws.send(JSON.stringify({ id: ++id, method, params }));
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) { clearTimeout(t); ws.close(); resolve(m.result); } };
  ws.onerror = () => { clearTimeout(t); reject(new Error("ws")); }; }); }
(async () => {
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(ROOT, "node_modules/electron/dist/electron.exe"), ["--remote-debugging-port=" + PORT, ROOT], { env, stdio: "ignore", cwd: ROOT });
  let t = null;
  for (let i = 0; i < 60; i++) { await sleep(500); try { const l = await getJson("/json/list"); t = (l || []).find((x) => x.url.includes("pet.html")); if (t) break; } catch (e) {} }
  if (!t) { console.log("no target"); child.kill(); process.exit(1); }
  await sleep(1200);
  await cdp(t.webSocketDebuggerUrl, "Runtime.evaluate", { expression: `S.scale=1; menuMode=null; applyScale(); S.x = screen.width/2; closeMenus(); window.dispatchEvent(new MouseEvent("contextmenu",{clientX:170,clientY:380,bubbles:true})); showSub("anim", document.querySelector("[data-sub=anim]")); "ok"` });
  await sleep(400);
  let shot = await cdp(t.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png" });
  fs.writeFileSync("C:/Users/Administrator/WorkBuddy/2026-11-05-13-53-01/_menu_v2_center.png", Buffer.from(shot.data, "base64"));
  // 右缘场景
  await cdp(t.webSocketDebuggerUrl, "Runtime.evaluate", { expression: `closeMenus(); S.x = screen.width + 120; "ok"` });
  await sleep(400);
  await cdp(t.webSocketDebuggerUrl, "Runtime.evaluate", { expression: `closeMenus(); window.dispatchEvent(new MouseEvent("contextmenu",{clientX:170,clientY:380,bubbles:true})); "ok"` });
  await sleep(400);
  shot = await cdp(t.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png" });
  fs.writeFileSync("C:/Users/Administrator/WorkBuddy/2026-11-05-13-53-01/_menu_v2_right.png", Buffer.from(shot.data, "base64"));
  console.log("saved 2");
  child.kill(); process.exit(0);
})().catch((e) => { console.log("err", e.message); process.exit(1); });
