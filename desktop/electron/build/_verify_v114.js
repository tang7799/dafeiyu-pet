/**
 * 验证四大新功能（v1.1.4）：喂食 / 番茄钟 / 心情系统 / 天气提醒
 * 用法：node build/_verify_v114.js [打包输出目录名]   缺省跑开发目录
 */
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const OUT = process.argv[2] || null;
const ROOT = path.join(__dirname, "..");
const EXE = OUT
  ? path.join(ROOT, OUT, "win-unpacked", (OUT === "dist" ? "DafeiyuPet.exe" : "DafeiyuPetClean.exe"))
  : path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const ARGS = OUT ? ["--remote-debugging-port=9458"] : ["--remote-debugging-port=9458", ROOT];
const PORT = 9458;
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
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error("cdp timeout")); }, 20000);
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
  await sleep(1500);
  const U = pet.webSocketDebuggerUrl;
  const ev = (expr) => cdpEval(U, expr);

  /* 静音随机行为：待机小动画/碎碎念别在断言间隙乱插话；等开机问候气泡说完 */
  await ev(`S.nextIdleFun = 1e12; S.nextDecide = 1e12; S.scale = 1; savePrefs(); "ok"`);
  await sleep(7500);

  console.log("\n—— 喂食（手动）——");
  let mood0 = await ev(`mood`);
  /* 开场问候可能还没说完/一次 decide 插话：先静音再喂，保证气泡是喂食文案 */
  await ev(`S.nextDecide = 1e12; S.nextIdleFun = 1e12; bubble.classList.remove("show"); handleAction("feed"); "ok"`);
  await sleep(500);
  let food = JSON.parse(await ev(`(() => { const f = document.querySelector(".food-drop");
    return JSON.stringify({ has: !!f, txt: f ? f.textContent : "", bubble: document.getElementById("bubble").textContent }); })()`));
  check("丢出了食物（.food-drop）", food.has, food.txt);
  check("气泡预告「哇！是…」", /哇！是/.test(food.bubble), food.bubble);
  await sleep(1400);
  let eating = await ev(`curClipName`);
  check("食物落肚后开吃（eat_* 动画）", /^eat_/.test(eating), eating);
  await sleep(3300);
  let spin = await ev(`JSON.stringify({ clip: curClipName, busy: feedBusy, mood: mood })`);
  const sp = JSON.parse(spin);
  check("吃完开心转圈圈（spin）", sp.clip === "spin" || sp.busy === false, "clip=" + sp.clip + " busy=" + sp.busy);
  check("喂食涨心情（" + mood0 + " → " + sp.mood + "）", sp.mood >= mood0 + 10, "+" + (sp.mood - mood0));
  await sleep(300);

  console.log("\n—— 心情系统（自动）——");
  /* 写入「10 分 + 1 小时前」→ 衰减 6 点 → 4 分 = 冷漠 */
  await ev(`localStorage.setItem("dfy_mood", JSON.stringify({ v: 10, t: Date.now() - 3600000 })); location.reload(); "ok"`);
  await sleep(4500);                                   /* 等重载 + 800ms 冷漠开场 */
  let m1 = JSON.parse(await ev(`JSON.stringify({ mood: mood, name: moodName(), bubble: document.getElementById("bubble").textContent })`));
  check("离线衰减：10 分 + 1h → " + Math.round(m1.mood) + " 分", m1.mood < 12 && m1.mood > 0, String(m1.mood));
  check("心情等级 = 冷漠", m1.name === "冷漠", m1.name);
  check("冷漠开场白（哼…）", /哼/.test(m1.bubble), m1.bubble.slice(0, 24));
  await ev(`lastMoodAt = -1e6; markActive(); "ok"`);   /* 清节流（perfNow 是秒），验证互动 +2 */
  let m2 = await ev(`mood`);
  check("互动涨心情（+2）", m2 >= m1.mood + 2, m1.mood + " → " + m2);
  await ev(`addMood(60); showSub("settings", document.querySelector("[data-sub=settings]")); "ok"`);
  let m3 = JSON.parse(await ev(`JSON.stringify({ mood: mood, name: moodName(), menu: (document.getElementById("mi-mood")||{textContent:""}).textContent })`));
  check("哄好了：等级回到 " + m3.name, m3.name === "开心" || m3.name === "一般", m3.name + " " + m3.mood);
  check("设置菜单显示心情", /❤️ 心情：/.test(m3.menu), m3.menu);
  await ev(`moodColdShown = false; closeMenus(); "ok"`);

  console.log("\n—— 番茄钟（自动）——");
  let p0 = JSON.parse(await ev(`JSON.stringify({ on: prefs.pomo, ls: localStorage.getItem("dfy_pomo") })`));
  check("默认开启", p0.on === true && p0.ls === "on", JSON.stringify(p0));
  /* 连续活跃 25 分钟 → 提醒休息（用测试钩子注入系统空闲=5 秒，等价「主人正在用电脑」） */
  await ev(`sysIdleForTest = 5; pomoActive = 24 * 60; pomoReminded = false; pomoBusy = false; "ok"`);
  await ev(`pomoTick(); "ok"`);
  let p1 = JSON.parse(await ev(`JSON.stringify({ said: pomoReminded, active: pomoActive, bubble: document.getElementById("bubble").textContent })`));
  check("活跃满 25 分钟触发提醒", p1.said === true && p1.active >= 1500, "active=" + p1.active);
  check("提醒文案（🍅 … 25 分钟）", /25 分钟/.test(p1.bubble), p1.bubble.slice(0, 30));
  /* 空闲 6 分钟 → 摸鱼吐槽 + 计时清零 */
  await ev(`setState("idle"); pomoActive = 0; pomoReminded = false; pomoBusy = false; lastSlackTease = -1e6;
            sysIdleForTest = 360; "ok"`);
  await ev(`pomoTick(); "ok"`);
  let p2 = JSON.parse(await ev(`JSON.stringify({ active: pomoActive, clip: curClipName, bubble: document.getElementById("bubble").textContent })`));
  check("摸鱼判定：累计活跃清零", p2.active === 0, String(p2.active));
  check("冒泡吐槽（bubble 动画）", p2.clip === "bubble", "clip=" + p2.clip);
  check("吐槽文案命中", SLACK_CHECK(p2.bubble), p2.bubble.slice(0, 24));
  /* 开关 */
  await ev(`sysIdleForTest = null; handleAction("pomo"); showSub("settings", document.querySelector("[data-sub=settings]")); "ok"`);
  let p3 = JSON.parse(await ev(`JSON.stringify({ on: prefs.pomo, ls: localStorage.getItem("dfy_pomo") })`));
  check("设置开关可关", p3.on === false && p3.ls === "off", JSON.stringify(p3));
  await ev(`handleAction("pomo"); showSub("settings", document.querySelector("[data-sub=settings]")); "ok"`);              /* 恢复开 */
  let p4 = JSON.parse(await ev(`JSON.stringify({ on: prefs.pomo, menu: (document.getElementById("mi-pomo")||{textContent:""}).textContent })`));
  check("设置菜单显示番茄钟", /🍅 番茄钟：开/.test(p4.menu), p4.menu);
  await ev(`closeMenus(); "ok"`);

  console.log("\n—— 天气提醒（自动）——");
  await ev(`localStorage.removeItem("dfy_wdate");
            weatherForTest = async () => ({ ok: true, text: "深圳市 🌧 小雨 +22°C 湿度80%", desc: "小雨", tempC: 22 });
            "ok"`);
  await ev(`bubble.classList.remove("show"); morningWeather(true); "ok"`);
  await sleep(600);
  let w1 = JSON.parse(await ev(`JSON.stringify({ bubble: document.getElementById("bubble").textContent, mark: localStorage.getItem("dfy_wdate") !== null })`));
  check("早间天气播报含实时天气", /深圳市/.test(w1.bubble), w1.bubble.slice(0, 40));
  check("雨天建议带伞 ☂️", /带伞/.test(w1.bubble), "");
  check("当天只播一次", await ev(`morningWeather(true)`) === false, "");
  let w2 = await ev(`JSON.stringify([
    weatherAdvice({ desc: "雷阵雨", tempC: 25 }),
    weatherAdvice({ desc: "小雪", tempC: -2 }),
    weatherAdvice({ desc: "晴", tempC: 35 }),
    weatherAdvice({ desc: "晴", tempC: 2 }),
    weatherAdvice({ desc: "多云", tempC: 22 })])`);
  const adv = JSON.parse(w2);
  check("雷雨 → 强提醒带伞", /雷雨|伞/.test(adv[0]), adv[0]);
  check("雪 → 保暖提示", /雪|穿/.test(adv[1]), adv[1]);
  check("高温 → 防晒", /热|防晒/.test(adv[2]), adv[2]);
  check("低温 → 加外套", /外套/.test(adv[3]), adv[3]);
  check("好天气 → 溜达", /溜达/.test(adv[4]), adv[4]);

  console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
  child.kill();
  await sleep(400);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("异常：" + e.message); process.exit(1); });

function SLACK_CHECK(t) {
  return /摸鱼|去哪儿|看不见|老板|监工/.test(t);
}
