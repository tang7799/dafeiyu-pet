/**
 * 干净版打包脚本
 *
 * 做的事：把 chat.html 里的内置账号彻底抹掉（CLOUD_CLEAN = true、CLOUD_DEFAULT = null），
 * 打一份独立配置的 NSIS 安装包，然后还原源文件。
 *
 * 关键约束：产出的包里不允许出现任何 wbpk_ 字样或作者的服务地址，
 * 确保「一分钱都花不到主人头上」——不是运行时不使用，而是根本不存在。
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const CHAT = path.join(ROOT, "chat.html");
const BACKUP = path.join(__dirname, "_chat.original.html");
/* 输出目录可用 DFY_OUT_DIR 覆写：旧产物被占用（杀软/编辑器句柄）时换个目录继续打 */
const OUT_NAME = process.env.DFY_OUT_DIR || "dist-clean";
const OUT_DIR = path.join(ROOT, OUT_NAME);

const OWNER_ENDPOINT = "dafeiyu-pet-44081.app.workbuddy.host";
/* 只看"真实公钥形态"（wbpk_ 后接一长串字符）；界面提示里的 "wbpk_..." 不算 */
const KEY_PATTERN = /wbpk_[A-Za-z0-9_\-]{16,}/;

function leakScan(text) {
  const found = [];
  const m = text.match(KEY_PATTERN);
  if (m) found.push("公钥 " + m[0].slice(0, 12) + "…");
  if (text.includes(OWNER_ENDPOINT)) found.push("作者的服务地址");
  return found;
}

function fail(msg) {
  console.error("\n[干净版] 失败：" + msg);
  process.exitCode = 1;
}

let original = fs.readFileSync(CHAT, "utf8");

/* 上次打包中途挂掉会留下干净模式的源码：这里自动从备份还原 */
if (fs.existsSync(BACKUP)) {
  const bk = fs.readFileSync(BACKUP, "utf8");
  if (original.includes("const CLOUD_CLEAN = true") && bk.includes("const CLOUD_CLEAN = false")) {
    fs.writeFileSync(CHAT, bk, "utf8");
    original = bk;
    console.log("[干净版] 检测到上次中断的干净模式源码，已自动还原");
  }
}

if (original.includes("const CLOUD_CLEAN = true")) {
  fail("chat.html 处于干净模式且没有可用备份，请手动把 CLOUD_CLEAN 改回 false 后重试");
  process.exit(1);
}

let cleaned = original
  .replace("const CLOUD_CLEAN = false;", "const CLOUD_CLEAN = true;")
  .replace(/const CLOUD_DEFAULT = \{[\s\S]*?\n\};/, "const CLOUD_DEFAULT = null;");

if (cleaned.includes("const CLOUD_CLEAN = true") === false || cleaned.includes("const CLOUD_DEFAULT = null;") === false) {
  fail("替换失败：没找到 CLOUD_CLEAN / CLOUD_DEFAULT 定义，源码结构可能改过了");
  process.exit(1);
}

// 替换后自查：key 与服务地址必须消失
const leftovers = leakScan(cleaned);
if (leftovers.length) {
  fail("替换后仍残留：" + leftovers.join("、"));
  process.exit(1);
}

fs.writeFileSync(BACKUP, original, "utf8");
fs.writeFileSync(CHAT, cleaned, "utf8");
console.log("[干净版] chat.html 已切到干净模式（原文件备份在 build/_chat.original.html）");

let ok = false;
try {
  const bin = path.join(
    ROOT, "node_modules", ".bin",
    process.platform === "win32" ? "electron-builder.cmd" : "electron-builder"
  );
  const res = spawnSync(
    bin,
    ["--win", "-c", path.join("build", "electron-builder-clean.yml"), "-c.directories.output=" + OUT_NAME],
    { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32", env: Object.assign({}, process.env) }
  );
  if (res.error) fail("无法启动 electron-builder：" + res.error.message);
  ok = res.status === 0;
  if (!ok) fail("electron-builder 退出码 " + res.status);
} finally {
  // 无论成败都还原源码，避免把干净模式留在开发目录里
  fs.writeFileSync(CHAT, original, "utf8");
  console.log("[干净版] chat.html 已还原");
}

if (!ok) process.exit(1);

// 产物自检：asar 里不能再出现公钥
const asar = path.join(OUT_DIR, "win-unpacked", "resources", "app.asar");
if (!fs.existsSync(asar)) {
  fail("没找到 app.asar，打包可能没完成");
  process.exit(1);
}
const inAsar = fs.readFileSync(asar).toString("latin1");
const bad = leakScan(inAsar);
if (bad.length) {
  fail("安装包里仍含：" + bad.join("、") + " —— 不要发布这个包");
  process.exit(1);
}
console.log("[干净版] 自检通过：安装包内不含任何内置账号信息");
const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".exe"));
console.log("[干净版] 产物：" + files.map((f) => path.join(OUT_NAME, f)).join("、"));
