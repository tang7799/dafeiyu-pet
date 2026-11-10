/**
 * surf.js 单元测试：记忆读写 / 评论风控 / 轮次上限 / 间隔范围
 * 用法：node build/_verify_surf_unit.js
 * 用临时 USERPROFILE 跑，不污染真实的 ~/.workbuddy
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dfy-surf-"));
process.env.USERPROFILE = TMP;
delete require.cache[require.resolve("../surf.js")];
const surf = require("../surf.js");

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + name + (extra !== undefined ? "  → " + extra : ""));
  cond ? pass++ : fail++;
};
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message || String(e); } };

console.log("—— 记忆文件 ——");
const w1 = surf.memoryWrite({ file: "video", text: "看了《测试视频》（BV1TEST001）：讲加法" });
check("memory_write 写入 video_memory.md", w1.file === "video_memory.md", w1.file);
check("文件真的落盘", fs.existsSync(path.join(TMP, ".workbuddy", "dafeiyu-memory", "video_memory.md")));
const s1 = surf.memorySearch({ file: "video", query: "BV1TEST001" });
check("memory_search 能查回记录", s1.matches.length === 1 && s1.matches[0].includes("BV1TEST001"), s1.matches[0] && s1.matches[0].slice(0, 40));
check("查不到时给提示", surf.memorySearch({ file: "video", query: "不存在的关键词" }).matches.length === 0);
check("空 text 被拒绝", !!throws(() => surf.memoryWrite({ file: "video", text: "" })));

console.log("\n—— 评论风控 ——");
check("手动聊天（非冲浪轮）不拦评论", throws(() => surf.assertCommentAllowed("BV1A")) === null);
surf.roundBegin();
check("冲浪轮默认禁评", (throws(() => surf.assertCommentAllowed("BV1A")) || "").includes("评论权限没开"));
surf.setCommentPerm({ on: true });
check("开启后允许首条", throws(() => surf.assertCommentAllowed("BV1A")) === null);
surf.noteComment("BV1A", "好看");
check("同视频不能评第二次", (throws(() => surf.assertCommentAllowed("BV1A")) || "").includes("已经评论过"));
check("15 分钟内不能评下一个", (throws(() => surf.assertCommentAllowed("BV1B")) || "").includes("15 分钟"));

// 单日上限：写 3 条今天的旧记录后重载
const statePath = path.join(TMP, ".workbuddy", "dafeiyu-surf.json");
const st = JSON.parse(fs.readFileSync(statePath, "utf8"));
const day = new Date();
const dayKey = day.getFullYear() + "-" + String(day.getMonth() + 1).padStart(2, "0") + "-" + String(day.getDate()).padStart(2, "0");
st.comments = [
  { bvid: "BVOLD1", ts: Date.now() - 3600e3, day: dayKey },
  { bvid: "BVOLD2", ts: Date.now() - 1800e3, day: dayKey },
  { bvid: "BVOLD3", ts: Date.now() - 20 * 60e3, day: dayKey },
];
st.surfRound = true;
st.commentOn = true;
fs.writeFileSync(statePath, JSON.stringify(st));
delete require.cache[require.resolve("../surf.js")];
const surf2 = require("../surf.js");
check("单日 3 条后第 4 条被拒", (throws(() => surf2.assertCommentAllowed("BVNEW")) || "").includes("今天已经评论 3 条"));
check("状态里能读出今日评论数", surf2.getState().commentsToday === 3, surf2.getState().commentsToday);

console.log("\n—— 轮次 / 间隔 / 夜间 ——");
const surf3 = require("../surf.js");
let rounds = 0;
while (surf3.takeRound()) rounds++;
check("每日轮次上限 24", rounds === 24, rounds);
check("超上限后拒绝", surf3.takeRound() === false);
check("间隔 5 分钟被拒", !!throws(() => surf3.setIntervalMinutes({ minutes: 5 })));
check("间隔 999 分钟被拒", !!throws(() => surf3.setIntervalMinutes({ minutes: 999 })));
check("间隔 45 生效", surf3.setIntervalMinutes({ minutes: 45 }).minutes === 45);
check("night 是布尔", typeof surf3.nightHours() === "boolean");
check("getState 字段齐全", ["enabled", "commentOn", "interval", "roundsToday", "commentsToday"].every((k) => k in surf3.getState()));

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
