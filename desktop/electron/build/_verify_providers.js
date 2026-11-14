/**
 * 端到端验证：创作室「平台注册表」v4（1.1.13）
 *   ① 老配置迁移：imageApi → providers.custom，并且还能正常画
 *   ② 内置平台（通义万相）能被中文名/别名认出来
 *   ③ 任意自定义平台：只给 baseUrl + model + key 就能画（OpenAI 兼容协议）
 *   ④ 阿里云百炼异步协议（提交任务 → 轮询 → 下载）能画
 *   ⑤ 未知名平台的报错带已知平台列表，不静默换平台
 *   ⑥ 删除平台 / 删除 key / 指定通道
 *   ⑦ 通义假 key 真请求 DashScope（连通性，网络不通则 SKIP）
 * 用法：node build/_verify_providers.js [打包输出目录名]
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const zlib = require("zlib");
const { spawn } = require("child_process");
const OUT = process.argv[2] || null;
const ROOT = path.join(__dirname, "..");
const EXE = OUT
  ? path.join(ROOT, OUT, "win-unpacked", (OUT === "dist" ? "DafeiyuPet.exe" : "DafeiyuPetClean.exe"))
  : path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const ARGS = OUT ? ["--remote-debugging-port=9472"] : ["--remote-debugging-port=9472", ROOT];
const PORT = 9472;
const MOCK_PORT = 9481;
const ART_CFG = path.join(os.homedir(), ".workbuddy", "dafeiyu-art.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0, skip = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  ✅ " + name + (detail ? "  → " + detail : "")); }
  else { fail++; console.log("  ❌ " + name + "  → " + String(detail).slice(0, 300)); }
}
function skipIt(name, why) { skip++; console.log("  ⚠️  SKIP " + name + "（" + why + "）"); }

/* ---------- 造一张真 PNG（随机噪点，保证体积 > 500B 且能被 nativeImage 解码） ---------- */
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function makePng(w, h) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  let s = 12345;
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < w; x++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const o = y * stride + 1 + x * 3;
      raw[o] = s & 0xff; raw[o + 1] = (s >> 8) & 0xff; raw[o + 2] = (s >> 16) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/* ---------- 本地模拟接口：OpenAI 兼容 + 百炼异步 ---------- */
const PNG = makePng(96, 96);
const hits = [];
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    hits.push({ method: req.method, url: req.url, auth: req.headers.authorization || "", async: req.headers["x-dashscope-async"] || "", body: body.slice(0, 500) });
    const send = (code, obj, type) => {
      res.writeHead(code, { "Content-Type": type || "application/json" });
      res.end(type ? obj : JSON.stringify(obj));
    };
    if (req.method === "POST" && /images\/generations$/.test(req.url)) {
      const a = req.headers.authorization || "";
      if (!/Bearer (mock-key|legacy-key)/.test(a)) return send(401, { error: { message: "bad key" } });
      try {
        const j = JSON.parse(body);
        if (!j.prompt || !j.model) return send(400, { error: { message: "missing prompt/model" } });
      } catch (e) { return send(400, { error: { message: "bad json" } }); }
      return send(200, { data: [{ b64_json: PNG.toString("base64") }] });
    }
    if (req.method === "POST" && /image-synthesis$/.test(req.url)) {
      if (!req.headers["x-dashscope-async"]) return send(400, { code: "MissingAsync" });
      if (!/Bearer mock-key/.test(req.headers.authorization || "")) {
        return send(401, { code: "InvalidApiKey", message: "Invalid API-key provided." });
      }
      try {
        const j = JSON.parse(body);
        if (!j.input || !j.input.prompt || !j.model) return send(400, { code: "BadRequest", message: "missing input.prompt/model" });
        if (!/^\d+\*\d+$/.test((j.parameters && j.parameters.size) || "")) return send(400, { code: "BadSize", message: "size must be W*H" });
      } catch (e) { return send(400, { code: "BadJson" }); }
      return send(200, { output: { task_id: "task-1", task_status: "PENDING" } });
    }
    if (req.method === "GET" && req.url === "/api/v1/tasks/task-1") {
      return send(200, { output: { task_status: "SUCCEEDED", results: [{ url: "http://127.0.0.1:" + MOCK_PORT + "/out.png" }] } });
    }
    if (req.method === "GET" && req.url === "/out.png") return send(200, PNG, "image/png");
    send(404, { error: "not found " + req.url });
  });
});

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
  let child = null, backup = null;
  try {
    /* 0) 备份用户配置，然后写入一份「老格式」配置来验证迁移 */
    try { backup = fs.readFileSync(ART_CFG); } catch (e) { backup = null; }
    fs.mkdirSync(path.dirname(ART_CFG), { recursive: true });
    fs.writeFileSync(ART_CFG, JSON.stringify({
      imageProvider: "custom",
      keys: {},
      imageApi: { baseUrl: "http://127.0.0.1:" + MOCK_PORT + "/v1", key: "legacy-key", model: "mock-legacy" },
    }, null, 2));

    await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

    const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(EXE, ARGS, { env, stdio: "ignore", cwd: ROOT });
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
    if (!chat) { console.error("❌ chat.html 没起来"); process.exit(1); }
    await sleep(1500);
    const pcRaw = (tool, args, to) => cdpEval(chat.webSocketDebuggerUrl,
      "window.dafeiyu.pc(" + JSON.stringify(tool) + "," + JSON.stringify(args || {}) + ").then(r=>JSON.stringify({ok:r.ok,result:r.result,error:r.error}))", to || 200000);
    const call = async (tool, args, to) => JSON.parse(await pcRaw(tool, args, to));
    const need = async (tool, args, to) => {
      const w = await call(tool, args, to);
      if (!w.ok) throw new Error(w.error || "tool failed");
      return w.result;
    };

    console.log("\n【1】老配置迁移");
    const cfg0 = await need("art_config", {});
    check("imageApi 迁移成 custom 平台", !!(cfg0.providers && cfg0.providers.custom), JSON.stringify(cfg0.providers && cfg0.providers.custom));
    check("迁移后 key 生效（ready 含 custom）", (cfg0.readyProviders || []).includes("custom"), JSON.stringify(cfg0.readyProviders));
    check("迁移后通道仍然可用（custom/auto）", cfg0.imageProvider === "custom" || cfg0.imageProvider === "auto", cfg0.imageProvider);

    console.log("\n【2】迁移后的老配置仍然能画（OpenAI 兼容通道）");
    const d0 = await need("draw_image", { prompt: "一只测试鲸鱼", width: 512, height: 512 });
    check("自动通道出图成功", !!d0.path && fs.existsSync(d0.path) && d0.size > 500, d0.provider + " " + d0.size + "B");
    check("老 key 被带上（mock 校验通过）", hits.some((h) => /images\/generations$/.test(h.url) && /Bearer legacy-key/.test(h.auth)));

    console.log("\n【3】内置平台与中文名/别名识别");
    check("内置通义万相已登记", !!(cfg0.providers && cfg0.providers.tongyi), cfg0.providers && cfg0.providers.tongyi && cfg0.providers.tongyi.label);
    check("通义图像模型是万相 2.1", cfg0.providers && cfg0.providers.tongyi && cfg0.providers.tongyi.imageModel === "wanx2.1-t2i-turbo", cfg0.providers && cfg0.providers.tongyi && cfg0.providers.tongyi.imageModel);
    const a1 = await need("art_config", { provider: "通义万相", key: "sk-test-tongyi-111111" });
    check("中文名「通义万相」识别为 tongyi", a1.saved === "tongyi", a1.saved);
    check("key 已保存且脱敏", a1.providers.tongyi.ready === true && /^sk-te\*\*\*/.test(a1.providers.tongyi.key), a1.providers.tongyi.key);
    const a2 = await need("art_config", { provider: "阿里云百炼", key: "sk-test-tongyi-222222" });
    check("别名「阿里云百炼」也命中 tongyi", a2.saved === "tongyi", a2.saved);
    const a2b = await need("art_config", { provider: "dashscope", key: "sk-test-tongyi-222222" });
    check("英文别名 dashscope 命中 tongyi", a2b.saved === "tongyi", a2b.saved);

    console.log("\n【4】任意自定义平台（只给 baseUrl + model + key）");
    const before = hits.length;
    const a3 = await need("art_config", { provider: "我的画画接口", key: "mock-key", baseUrl: "http://127.0.0.1:" + MOCK_PORT, model: "mock-v1" });
    check("新建自定义平台成功", !!a3.saved && !!(a3.providers[a3.saved]), a3.saved);
    check("返回里能看到自定义平台的地址", !!(a3.providers[a3.saved].custom && a3.providers[a3.saved].custom.baseUrl), JSON.stringify(a3.providers[a3.saved].custom));
    const d1 = await need("draw_image", { prompt: "自定义接口画的小鲸鱼", provider: "我的画画接口", width: 768, height: 768 });
    check("指定自定义平台出图成功", !!d1.path && fs.existsSync(d1.path), d1.provider + " " + d1.size + "B");
    const hit1 = hits.slice(before).find((h) => /images\/generations$/.test(h.url));
    check("根路径自动补全为 /v1/images/generations", !!hit1 && hit1.url === "/v1/images/generations", hit1 && hit1.url);
    check("请求带上了自定义 key 与模型", !!hit1 && /Bearer mock-key/.test(hit1.auth) && /mock-v1/.test(hit1.body), hit1 && hit1.body.slice(0, 90));
    check("尺寸以 768x768 传给接口", !!hit1 && /768x768/.test(hit1.body), hit1 && hit1.body.slice(0, 120));

    console.log("\n【5】百炼异步协议（提交 → 轮询 → 下载）");
    const a4 = await need("art_config", {
      provider: "mockdash", key: "mock-key",
      baseUrl: "http://127.0.0.1:" + MOCK_PORT + "/dashscope/image-synthesis",
      model: "wanx-mock", proto: "dashscope",
    });
    check("新建 dashscope 协议平台", !!a4.saved && a4.providers[a4.saved].custom.proto === "dashscope", a4.saved);
    const before2 = hits.length;
    const d2 = await need("draw_image", { prompt: "异步协议测试", provider: "mockdash", width: 512, height: 512 }, 120000);
    check("异步任务出图成功", !!d2.path && fs.existsSync(d2.path), d2.provider + " " + d2.size + "B");
    const sub = hits.slice(before2).find((h) => /image-synthesis$/.test(h.url));
    check("提交时带 X-DashScope-Async 头", !!sub && sub.async === "enable", sub && sub.async);
    check("请求体是百炼格式（input.prompt + parameters.size=W*H）", !!sub && /"input"/.test(sub.body) && /512\*512/.test(sub.body), sub && sub.body.slice(0, 140));
    check("确实轮询了任务状态", hits.slice(before2).some((h) => h.method === "GET" && /\/api\/v1\/tasks\/task-1/.test(h.url)));
    check("结果是从 URL 下载的（非 b64）", hits.slice(before2).some((h) => h.url === "/out.png"));

    console.log("\n【6】未知名平台：明确报错，不静默换平台");
    const e1 = await call("draw_image", { prompt: "x", provider: "根本不存在的平台" });
    check("未知名平台直接报错", e1.ok === false, e1.ok);
    check("报错里列出已知平台（含通义万相）", /认不出画图平台/.test(e1.error || "") && /通义万相/.test(e1.error || ""), (e1.error || "").slice(0, 120));
    check("报错里给出自定义接法（baseUrl+model）", /baseUrl/.test(e1.error || ""), (e1.error || "").slice(0, 200));

    console.log("\n【7】指定平台失败不偷偷降级");
    /* custom 平台有可用 key；把 mockdash 的 key 换成错的，指定它画图必须报错，不能悄悄用 custom 画出来 */
    await need("art_config", { provider: "mockdash", key: "wrong-key" });
    const e2 = await call("draw_image", { prompt: "x", provider: "mockdash" }, 60000);
    check("指定平台失败就直接报错（没换别的平台出图）", e2.ok === false && /401|鉴权|bad key/.test(e2.error || ""), (e2.error || "").slice(0, 140));
    await need("art_config", { provider: "mockdash", key: "mock-key" });

    console.log("\n【8】通义假 key 真实连通性（DashScope）");
    const e3 = await call("make_video", { prompt: "一条小鲸鱼游过星空", duration: "5", provider: "通义万相" }, 120000);
    const msg3 = e3.error || "";
    if (/鉴权|401|403|InvalidApiKey|invalid|key/i.test(msg3)) {
      check("通义假 key 被 DashScope 真实拒绝（链路通）", e3.ok === false, msg3.slice(0, 140));
    } else if (/超时|timeout|ENOTFOUND|EAI_AGAIN|fetch failed|network|ERR_/i.test(msg3)) {
      skipIt("通义连通性", "网络不通：" + msg3.slice(0, 80));
    } else {
      check("通义假 key 被拒绝", e3.ok === false, msg3.slice(0, 160));
    }

    console.log("\n【9】删除平台与 key");
    const a5 = await need("art_config", { delProvider: "我的画画接口" });
    check("delProvider 删掉自定义平台", !a5.providers[a3.saved], a3.saved);
    const a6 = await need("art_config", { provider: "mockdash", key: "" });
    check("key 传空 = 删除", a6.providers.mockdash.ready === false, a6.providers.mockdash.key);
    const e4 = await call("draw_image", { prompt: "x", provider: "mockdash" });
    check("没 key 时指定该平台报错并给注册提示", e4.ok === false && /key/i.test(e4.error || ""), (e4.error || "").slice(0, 120));

    console.log("\n【10】切换默认通道");
    const a7 = await need("art_config", { imageProvider: "tongyi", videoProvider: "tongyi" });
    check("imageProvider/videoProvider 切换生效", a7.imageProvider === "tongyi" && a7.videoProvider === "tongyi", a7.imageProvider + "/" + a7.videoProvider);
    const a8 = await need("art_config", {});
    check("配置能持久化读取", a8.imageProvider === "tongyi" && a8.videoProvider === "tongyi", a8.imageProvider + "/" + a8.videoProvider);
    check("返回里有注册链接（没 key 的平台）", /https?:\/\//.test(a8.note || "") || Object.keys(a8.providers).some((k) => a8.providers[k].apply), (a8.note || "").slice(0, 100));
  } catch (e) {
    console.error("❌ 运行异常：" + (e && e.message));
    fail++;
  } finally {
    try { if (child) child.kill(); } catch (e) {}
    try { mock.close(); } catch (e) {}
    try {
      if (backup) fs.writeFileSync(ART_CFG, backup);
      else fs.rmSync(ART_CFG, { force: true });
      console.log("\n（已恢复原创作室配置）");
    } catch (e) {}
    await sleep(300);
    console.log("\n结果：" + pass + " 通过 / " + fail + " 失败 / " + skip + " 跳过");
    process.exit(fail ? 1 : 0);
  }
})();
