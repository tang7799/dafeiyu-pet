/**
 * 临时验证：闲置贴边休息（只在屏幕上/左/右边框趴，移动过程对用户不可见）
 * 用法：node build/_verify_perch.js
 * 判定口径：渲染进程里读 window.screenX/screenY（OS 真实窗口位置），
 *         配合实测身体范围 bodyBox + 旋转角，算出「身体」四条边的屏幕坐标，
 *         直接和屏幕边框线比对（不看内部变量自证）。
 */
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const EXE = path.join(__dirname, "..", "node_modules", "electron", "dist", "electron.exe");
const APP_DIR = path.join(__dirname, "..");
const PORT = 9447;
const EDGES = ["top", "left", "right"];      /* 下边框已排除：鱼本来就趴在地面线上 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(p) {
  return new Promise((resolve, reject) => {
    const http_ = http.get({ host: "127.0.0.1", port: PORT, path: p, timeout: 3000 }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    http_.on("error", reject);
    http_.on("timeout", () => http_.destroy(new Error("timeout")));
  });
}

function cdpEval(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error("cdp timeout")); }, 180000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== 1) return;
      clearTimeout(timer); ws.close();
      if (m.result && m.result.exceptionDetails) reject(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 500)));
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
  await sleep(2500);   /* CDP 目标一出现就能连，但页面里的 const 还没初始化完 */

  const res = await cdpEval(pet.webSocketDebuggerUrl, `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const EDGES = ${JSON.stringify(EDGES)};
    const out = { edges: {}, misc: {}, screen: { w: screenW, h: screenH, ground: groundY } };

    /* 身体四条边的屏幕坐标：窗口位置(OS 真实) + (视觉中心 → 旋转后身体边界) */
    function bodyRect() {
      const p = S.perch, s = S.scale;
      const cx = PET_W / 2, cy = PET_H / 2;
      const dL = cx - bodyBox.l, dR = bodyBox.r - cx, dT = cy - bodyBox.t, dB = bodyBox.b - cy;
      const CCX = window.screenX + p.bc.x, CCY = window.screenY + p.bc.y;
      const rot = ((p.g.rot % 360) + 360) % 360;
      let l, r, t, b;
      if (rot === 0)        { l = -dL; r = dR; t = -dT; b = dB; }
      else if (rot === 180) { l = -dR; r = dL; t = -dB; b = dT; }
      else if (rot === 90)  { l = -dB; r = dT; t = -dL; b = dR; }
      else                  { l = -dT; r = dB; t = -dR; b = dL; }
      return { left: CCX + l * s, right: CCX + r * s, top: CCY + t * s, bottom: CCY + b * s };
    }

    async function forcePerch(edge) {
      for (let i = 0; i < 20; i++) {
        if (S.perch) exitPerch(true);
        await wait(40);
        startPerch(edge);              /* 贴边前有 340ms 的测量等待 + 200ms 淡出 */
        await wait(820);
        if (S.perch && S.perch.edge === edge && S.perch.phase === "rest") return true;
      }
      return false;
    }

    function measure() {
      const p = S.perch, g = p.g, br = bodyRect();
      return {
        edge: p.edge, rot: g.rot, phase: p.phase,
        win: { x: window.screenX, y: window.screenY, w: winW, h: winH },
        body: { left: Math.round(br.left), right: Math.round(br.right), top: Math.round(br.top), bottom: Math.round(br.bottom) },
        raw: br,
        cssRotate: pet.style.rotate,
        origin: pet.style.transformOrigin,
        bubbleTop: perchBubbleTop,
        opacity: Number(getComputedStyle(pet).opacity),
      };
    }

    /* 趴着时有"呼吸浮动"（只往内侧收 0~1.6px），所以取一个呼吸周期内最贴边的那一刻 */
    async function measureClosest() {
      const edge = S.perch.edge;
      let best = null, bestErr = Infinity;
      for (let i = 0; i < 14; i++) {
        const m = measure();
        const r = m.raw;
        const e = edge === "top" ? Math.abs(r.top)
          : edge === "left" ? Math.abs(r.left)
          : Math.abs(r.right - screenW);
        if (e < bestErr) { bestErr = e; best = m; }
        await wait(90);
      }
      best.closestErr = Math.round(bestErr * 10) / 10;
      return best;
    }

    for (const e of EDGES) {
      const ok = await forcePerch(e);
      if (!ok) { out.edges[e] = { error: "没能挑到这条边" }; continue; }
      await wait(300);
      out.edges[e] = await measureClosest();
    }

    /* 放大到 2x 再来一轮：此时窗口要按旋转后的身体重新裁，是最容易出问题的档位 */
    if (S.perch) exitPerch(true);
    S.scale = 2; applyScale();
    await wait(300);
    out.edges2 = {};
    for (const e of EDGES) {
      const ok = await forcePerch(e);
      if (!ok) { out.edges2[e] = { error: "没能挑到这条边" }; continue; }
      await wait(300);
      out.edges2[e] = await measureClosest();
    }
    if (S.perch) exitPerch(true);
    S.scale = 1; applyScale();
    await wait(300);

    /* —— 移动过程是否真的"看不见" ——
       期望：淡出期间窗口一动不动（phase=vanish + 幽灵态），
             淡完之后一步到位（窗口位置大幅跳变），且已经恢复正常不透明。 */
    async function vanishProbe(edge) {
      if (S.perch) exitPerch(true);
      await wait(120);
      S.x = screenW / 2; S.y = groundY + footPadCur; S.vx = S.vy = 0;
      await wait(150);
      const before = { x: window.screenX, y: window.screenY, w: winW, h: winH };
      startPerch(edge);
      await wait(430);                       /* 340ms 测量 + 90ms：正处在淡出中途 */
      const mid = {
        phase: S.perch && S.perch.phase,
        ghost: pet.classList.contains("pet-ghost"),
        x: window.screenX, y: window.screenY,
        opacity: Number(Number(getComputedStyle(pet).opacity).toFixed(2)),
      };
      await wait(700);
      const after = {
        phase: S.perch && S.perch.phase,
        ghost: pet.classList.contains("pet-ghost"),
        x: window.screenX, y: window.screenY, w: winW, h: winH,
        opacity: Number(Number(getComputedStyle(pet).opacity).toFixed(2)),
      };
      return { before, mid, after };
    }
    out.misc.vanishTop = await vanishProbe("top");
    out.misc.vanishLeft = await vanishProbe("left");

    /* —— 自然结束：趴够了自己松开 —— */
    if (S.perch) exitPerch(true);
    await wait(150);
    startPerch("right");
    await wait(820);
    const restEdge = S.perch && S.perch.edge;
    const exitFrom = { x: window.screenX, y: window.screenY };
    if (S.perch) S.perch.until = performance.now() / 1000 - 1;    /* 假装时间到了 */
    await wait(120);
    const leaving = {
      phase: S.perch && S.perch.phase,
      ghost: pet.classList.contains("pet-ghost"),
      x: window.screenX, y: window.screenY,
    };
    let settled = 0;
    for (let i = 0; i < 80; i++) {                 /* 等淡出+落地弹跳稳定，最多 8 秒 */
      await wait(100);
      settled = i * 100;
      if (!S.perch && Math.abs(S.y - (groundY + footPadCur)) <= 2 && S.vy === 0) break;
    }
    out.misc.afterExit = {
      perch: !!S.perch,
      rotate: pet.style.rotate,
      origin: pet.style.transformOrigin,
      ghost: pet.classList.contains("pet-ghost"),
      opacity: Number(Number(getComputedStyle(pet).opacity).toFixed(2)),
      winW: winW, winH: winH,
      onGround: Math.abs(S.y - (groundY + footPadCur)) <= 2,
      y: Math.round(S.y), ground: Math.round(groundY + footPadCur), settleMs: settled,
      restEdge, exitFrom, leaving,
      dropX: Math.round(S.x), screenW,
    };

    /* 闲置到点自动触发（挑边必须落在三条边里）。
       注意：闲置触发要求当时正好是 idle，闲逛逻辑可能刚好把它切到别的状态，
       所以这里反复催几次，只验证"闲置够久就会去趴"这条链路。 */
    if (S.perch) exitPerch(true);
    await wait(200);
    out.misc.autoTrigger = { after: false, edge: null, phase: null };
    for (let i = 0; i < 40; i++) {
      S.perchAt = performance.now() / 1000 - 1;
      await wait(150);
      if (S.perch) {
        out.misc.autoTrigger = { after: true, edge: S.perch.edge, phase: S.perch.phase };
        break;
      }
    }

    /* 有人操作 → 立刻归位（不能等淡出，否则拖不动） */
    const t0 = performance.now();
    markActive();
    const wakeMs = performance.now() - t0;
    await wait(120);
    out.misc.byUser = {
      perch: !!S.perch,
      rotate: pet.style.rotate,
      ghost: pet.classList.contains("pet-ghost"),
      opacity: Number(Number(getComputedStyle(pet).opacity).toFixed(2)),
      wakeMs: Math.round(wakeMs),
      cooldown: Math.round(S.perchAt - performance.now() / 1000),
    };

    prefs.perch = false;
    S.perchAt = performance.now() / 1000 - 1;
    await wait(600);
    out.misc.off = { perch: !!S.perch };
    prefs.perch = true;
    S.perchAt = performance.now() / 1000 + 9999;
    out.misc.edgesCfg = { list: PERCH_EDGES.join(","), hasBottom: PERCH_EDGES.indexOf("bottom") >= 0 };
    return out;
  })()`);

  const W = res.screen.w, H = res.screen.h;
  console.log("\n屏幕 " + W + "x" + H);
  console.log("\n三条边实测（身体框 = 旋转后身体真实边界，屏幕坐标）：");
  for (const e of EDGES) {
    const r = res.edges[e];
    if (!r || r.error) { console.log("  " + e + " : " + (r && r.error)); continue; }
    console.log("  " + e.padEnd(6) + " rot=" + String(r.rot).padStart(4) + "  身体框=" + JSON.stringify(r.body).padEnd(46) +
      " 窗口=" + JSON.stringify(r.win) + "  css=" + r.cssRotate);
  }

  console.log("\n断言：");
  const rotWant = { top: 180, left: 90, right: -90 };
  for (const e of EDGES) {
    const r = res.edges[e];
    if (!r || r.error) { check(e + " 边能趴上去", false, r && r.error); continue; }
    let err, label;
    if (e === "top") { err = Math.abs(r.raw.top - 0); label = "屏幕顶 y=0"; }
    else if (e === "left") { err = Math.abs(r.raw.left - 0); label = "屏幕左 x=0"; }
    else { err = Math.abs(r.raw.right - W); label = "屏幕右 x=" + W; }
    check(e + " 边：身体贴住" + label, err <= 2.5, "偏差 " + err.toFixed(1) + "px");
    check(e + " 边：旋转角正确", r.rot === rotWant[e] && r.cssRotate === r.rot + "deg" && r.origin === "center center", r.cssRotate + " / " + r.origin);
    check(e + " 边：身体完整在屏幕内",
      r.body.left >= -1 && r.body.right <= W + 1 && r.body.top >= -1 && r.body.bottom <= H + 1, JSON.stringify(r.body));
    check(e + " 边：气泡落点合理", r.bubbleTop >= 0 && r.bubbleTop <= r.win.h - 40, r.bubbleTop + " / 窗口高 " + r.win.h);
    check(e + " 边：落位后是趴着状态且不透明", r.phase === "rest" && r.opacity > 0.95, r.phase + " / opacity " + r.opacity);
  }

  const m = res.misc;
  console.log("\n移动过程（vanish）：");
  for (const [k, label] of [["vanishTop", "上边框"], ["vanishLeft", "左边框"]]) {
    const v = m[k];
    if (!v) { check(label + " 探针有数据", false); continue; }
    console.log("  " + label + " before=" + JSON.stringify(v.before) + " mid=" + JSON.stringify(v.mid) + " after=" + JSON.stringify(v.after));
    const still = v.mid.x === v.before.x && v.mid.y === v.before.y;
    const jumped = Math.abs(v.after.x - v.before.x) + Math.abs(v.after.y - v.before.y);
    check(label + "：淡出中途不透明（人在看的时候它已经隐了）", v.mid.phase === "vanish" && v.mid.ghost === true && v.mid.opacity < 0.6,
      v.mid.phase + " / ghost " + v.mid.ghost + " / opacity " + v.mid.opacity);
    check(label + "：淡出期间窗口原地不动（看不到横穿屏幕）", still, "Δ=" + (v.mid.x - v.before.x) + "," + (v.mid.y - v.before.y));
    check(label + "：淡完之后一步到位（不是滑过去的）", v.after.phase === "rest" && jumped > 200, "位移 " + jumped + "px");
    check(label + "：到位后恢复不透明", v.after.ghost === false && v.after.opacity > 0.9, "ghost " + v.after.ghost + " / opacity " + v.after.opacity);
  }

  if (res.edges2) {
    console.log("\n放大 2x 后：");
    for (const e of EDGES) {
      const r = res.edges2[e];
      if (!r || r.error) { check("2x " + e + " 边能趴上去", false, r && r.error); continue; }
      console.log("  " + e.padEnd(6) + " rot=" + String(r.rot).padStart(4) + "  身体框=" + JSON.stringify(r.body).padEnd(46) +
        " 窗口=" + JSON.stringify(r.win));
      let err, label;
      if (e === "top") { err = Math.abs(r.raw.top - 0); label = "屏幕顶"; }
      else if (e === "left") { err = Math.abs(r.raw.left - 0); label = "屏幕左"; }
      else { err = Math.abs(r.raw.right - W); label = "屏幕右"; }
      check("2x " + e + " 边：身体贴住" + label, err <= 2.5, "偏差 " + err.toFixed(1) + "px");
      check("2x " + e + " 边：身体完整在屏幕内",
        r.body.left >= -1 && r.body.right <= W + 1 && r.body.top >= -1 && r.body.bottom <= H + 1, JSON.stringify(r.body));
      check("2x " + e + " 边：窗口装得下旋转后的身体",
        r.win.w >= r.body.right - r.body.left - 1 && r.win.h >= r.body.bottom - r.body.top - 1,
        r.win.w + "x" + r.win.h + " vs 身体 " + (r.body.right - r.body.left) + "x" + (r.body.bottom - r.body.top));
    }
  }

  console.log("\n退出 / 触发：");
  console.log("  afterExit  = " + JSON.stringify(m.afterExit));
  console.log("  autoTrigger= " + JSON.stringify(m.autoTrigger));
  console.log("  byUser     = " + JSON.stringify(m.byUser));
  console.log("  off        = " + JSON.stringify(m.off));
  console.log("  edgesCfg   = " + JSON.stringify(m.edgesCfg));
  console.log("");
  check("可选边框只有上/左/右（不再挑底部）", m.edgesCfg.hasBottom === false && m.edgesCfg.list === "top,left,right", m.edgesCfg.list);
  check("趴够了自己松开：先淡出再归位", m.afterExit.leaving.phase === "leave" && m.afterExit.leaving.ghost === true, JSON.stringify(m.afterExit.leaving));
  check("退出后旋转归零、恢复不透明、回到正常布局",
    m.afterExit.perch === false && m.afterExit.rotate === "0deg" && m.afterExit.origin === "center bottom" &&
    m.afterExit.ghost === false && m.afterExit.opacity > 0.9, JSON.stringify({ r: m.afterExit.rotate, o: m.afterExit.origin, g: m.afterExit.ghost, a: m.afterExit.opacity }));
  check("退出后自然掉回地面线", m.afterExit.onGround === true, "y=" + m.afterExit.y + " 地面=" + m.afterExit.ground + "，稳定用时 " + m.afterExit.settleMs + "ms");
  check("退出位置在原来那条边的下方（不横穿屏幕）",
    Math.abs(m.afterExit.dropX - (m.afterExit.restEdge === "right" ? W : 0)) < 260, m.afterExit.restEdge + " 落点 x=" + m.afterExit.dropX);
  check("闲置到点自动贴边（三边之一）", m.autoTrigger.after === true && EDGES.indexOf(m.autoTrigger.edge) >= 0, m.autoTrigger.edge + " / " + m.autoTrigger.phase);
  check("有人操作立刻归位（不等淡出）",
    m.byUser.perch === false && m.byUser.rotate === "0deg" && m.byUser.ghost === false && m.byUser.opacity > 0.9,
    m.byUser.wakeMs + "ms / " + JSON.stringify(m.byUser));
  check("取消后有冷却（不会立刻又爬）", m.byUser.cooldown > 20, m.byUser.cooldown + "s");
  check("开关关掉后不自动贴边", m.off.perch === false, JSON.stringify(m.off));

  console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
  child.kill();
  await sleep(400);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("异常：" + e.message); process.exit(1); });
