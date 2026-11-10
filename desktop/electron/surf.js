/* 自主冲浪支撑层：记忆文件、评论权限与风控限流、轮次计数、夜间策略。
   记忆是真实文件（~/.workbuddy/dafeiyu-memory/），跨定时任务永久生效；
   评论默认关闭，且即使开启也仍要过「确认窗」由主人放行。 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const HOME = os.homedir();
const WORK_DIR = path.join(HOME, ".workbuddy");
const MEM_DIR = path.join(WORK_DIR, "dafeiyu-memory");
const STATE_PATH = path.join(WORK_DIR, "dafeiyu-surf.json");

const FILES = {
  video: "video_memory.md",
  reply: "reply_memory.md",
  log: "surf_log.md",
};

let st = {
  enabled: false,
  commentOn: false,
  interval: 30,
  rounds: {},
  comments: [],
  surfRound: false,
  lastRound: 0,
};
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (raw && typeof raw === "object") st = Object.assign(st, raw);
  } catch (e) { /* 首次运行没有文件 */ }
  if (!Array.isArray(st.comments)) st.comments = [];
  if (!st.rounds || typeof st.rounds !== "object") st.rounds = {};
}
function save() {
  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
  } catch (e) { /* 写不了就只在内存里生效 */ }
}
load();

const todayKey = () => {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
};

function ensureDir() {
  fs.mkdirSync(MEM_DIR, { recursive: true });
}

function filePath(name) {
  const k = String(name || "").toLowerCase();
  if (/video|视频/.test(k)) return path.join(MEM_DIR, FILES.video);
  if (/reply|评论|回复/.test(k)) return path.join(MEM_DIR, FILES.reply);
  return path.join(MEM_DIR, FILES.log);
}

/* ---------- 记忆工具 ---------- */
function memorySearch(a) {
  a = a || {};
  ensureDir();
  const names = a.files ? [].concat(a.files) : (a.file ? [a.file] : ["video", "reply", "log"]);
  const q = String(a.query || "").trim();
  const limit = Math.max(1, Math.min(60, Number(a.limit) || 20));
  const out = [];
  let anyFile = false;
  for (const n of names) {
    const p = filePath(n);
    let raw = "";
    try { raw = fs.readFileSync(p, "utf8"); } catch (e) { continue; }
    anyFile = true;
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    const hits = q ? lines.filter((l) => l.includes(q)) : lines;
    for (const l of hits.slice(-limit)) out.push(l.slice(0, 300));
  }
  const matches = out.slice(-limit * 2);
  return {
    files: names.map((n) => path.basename(filePath(n))),
    query: q || null,
    matches,
    note: !anyFile
      ? "还没有任何记忆文件，这是第一次冲浪"
      : (matches.length ? "以上是历史记录：看过的视频、发过的评论不要重复" : "没有找到相关记录（可以放心当新鲜的看）"),
  };
}

function memoryWrite(a) {
  a = a || {};
  const text = String(a.text || a.content || a.note || "").trim();
  if (!text) throw new Error("memory_write 需要 text（要记的内容）");
  ensureDir();
  const p = filePath(a.file || a.target || "log");
  const stamp = new Date().toLocaleString("zh-CN", { hour12: false });
  const line = "- [" + stamp + "] " + text.replace(/\s*\n\s*/g, " ");
  fs.appendFileSync(p, line + "\n", "utf8");
  return { file: path.basename(p), appended: line.slice(0, 300) };
}

/* ---------- 评论权限 / 风控 ---------- */
function assertCommentAllowed(bvid) {
  if (!st.surfRound) return;   // 主人手动聊天的评论：确认窗本身就是人工把关，不拦
  if (!st.commentOn) {
    throw new Error("评论权限没开（默认关闭）：自主冲浪这一轮只能看视频和总结，不许评论。要开需要主人明确说「开启评论权限」。");
  }
  const day = todayKey();
  const today = st.comments.filter((c) => c.day === day);
  if (bvid && st.comments.some((c) => c.bvid === bvid)) {
    throw new Error("这个视频已经评论过了：同一个视频只允许评论一次。");
  }
  if (today.length >= 3) throw new Error("今天已经评论 3 条了（每日上限），这一轮不能再评论。");
  const last = st.comments[st.comments.length - 1];
  if (last && Date.now() - last.ts < 15 * 60 * 1000) {
    throw new Error("距上次评论不到 15 分钟（风控要求），这一轮先别评论。");
  }
}

function noteComment(bvid, text) {
  st.comments.push({ bvid: bvid || "", text: String(text || "").slice(0, 120), ts: Date.now(), day: todayKey() });
  st.comments = st.comments.slice(-200);
  save();
  try { memoryWrite({ file: "reply", text: "评论了 " + (bvid || "") + "：" + String(text || "").slice(0, 120) }); } catch (e) {}
}

function setCommentPerm(a) {
  a = a || {};
  const on = a.on === true || a.enable === true || String(a.on).toLowerCase() === "true";
  st.commentOn = on;
  save();
  return {
    commentOn: on,
    note: on
      ? "评论权限已开启。注意：每条评论仍会弹确认窗等主人点「发布」；单日最多 3 条、间隔 ≥15 分钟、同视频 1 条。"
      : "评论权限已关闭：自主冲浪只看和总结，不评论。",
  };
}

/* ---------- 轮次 / 夜间 / 间隔 ---------- */
const DAILY_ROUND_CAP = 24;

function takeRound() {
  const day = todayKey();
  const n = Number(st.rounds[day]) || 0;
  if (n >= DAILY_ROUND_CAP) return false;
  st.rounds = { [day]: n + 1 };   // 只留当天计数
  save();
  return true;
}
/* 一轮冲浪最长 20 分钟：中途崩了/被占用没跑起来，也要自动解除"冲浪中"状态，
   否则评论风控会一直挂在冲浪模式上 */
let roundTimer = null;
function roundBegin() {
  st.surfRound = true;
  st.lastRound = Date.now();
  save();
  if (roundTimer) clearTimeout(roundTimer);
  roundTimer = setTimeout(() => { st.surfRound = false; save(); roundTimer = null; }, 20 * 60 * 1000);
}
function roundEnd() {
  st.surfRound = false;
  if (roundTimer) { clearTimeout(roundTimer); roundTimer = null; }
  save();
}
function nightHours() { const h = new Date().getHours(); return h >= 23 || h < 7; }

function setIntervalMinutes(a) {
  const m = Math.round(Number(a.minutes));
  if (!Number.isFinite(m) || m < 10 || m > 180) throw new Error("冲浪间隔需在 10~180 分钟之间");
  st.interval = m;
  save();
  return { minutes: m };
}

function getState() {
  const day = todayKey();
  return {
    enabled: !!st.enabled,
    commentOn: !!st.commentOn,
    interval: st.interval || 30,
    roundsToday: Number(st.rounds[day]) || 0,
    dailyCap: DAILY_ROUND_CAP,
    commentsToday: st.comments.filter((c) => c.day === day).length,
    night: nightHours(),
    lastRound: st.lastRound || 0,
  };
}

function setEnabled(v) { st.enabled = !!v; save(); return getState(); }

module.exports = {
  MEM_DIR, STATE_PATH, FILES,
  memorySearch, memoryWrite,
  assertCommentAllowed, noteComment, setCommentPerm,
  takeRound, roundBegin, roundEnd, nightHours,
  setIntervalMinutes, getState, setEnabled,
};
