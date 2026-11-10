/**
 * 安装向导驱动器（定位崩溃用）
 * 用法：
 *   node build/_drive.js list                 列出所有窗口标题
 *   node build/_drive.js focus <标题片段>      聚焦窗口并打印其位置大小
 *   node build/_drive.js click <x> <y>        移动并单击
 *   node build/_drive.js rclick <x> <y>
 *   node build/_drive.js key <键名>           回车/空格/esc 等
 */
const { getWindows, windowWithTitle, mouse, keyboard, Key, Point, straightTo, centerOf } = require("@nut-tree-fork/nut-js");

mouse.config.autoDelayMs = 120;
keyboard.config.autoDelayMs = 80;

const KEYMAP = { enter: Key.Enter, space: Key.Space, esc: Key.Escape, tab: Key.Tab, down: Key.Down, up: Key.Up };

async function pressChord(keys) {
  for (const k of keys) await keyboard.pressKey(k);
  for (const k of keys.reverse()) await keyboard.releaseKey(k);
}

(async () => {
  const cmd = process.argv[2];
  if (cmd === "list") {
    const wins = await getWindows();
    for (const w of wins) console.log((await w.getTitle()).replace(/\n/g, " "));
    return;
  }
  if (cmd === "focus") {
    const q = windowWithTitle(new RegExp(process.argv[3]));
    const w = await getWindows().then((ws) => ws.find((x) => q.matches ? 0 : 0)); // fallback below
    const wins = await getWindows();
    for (const w2 of wins) {
      const t = await w2.getTitle();
      if (t.includes(process.argv[3])) {
        await w2.focus();
        const r = await w2.getRegion();
        console.log("FOCUSED", JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height, title: t }));
        return;
      }
    }
    console.log("NOT FOUND");
    return;
  }
  if (cmd === "click" || cmd === "rclick") {
    const x = Number(process.argv[3]), y = Number(process.argv[4]);
    await mouse.setPosition(new Point(x, y));
    if (cmd === "rclick") await mouse.rightClick(); else await mouse.leftClick();
    console.log("CLICKED", x, y);
    return;
  }
  if (cmd === "wind") {
    await pressChord([Key.LeftWin, Key.KeyD]);
    console.log("WIND");
    return;
  }
  if (cmd === "altesc") {
    await pressChord([Key.LeftAlt, Key.Escape]);
    console.log("ALTESC");
    return;
  }
  if (cmd === "key") {
    const k = KEYMAP[process.argv[3].toLowerCase()];
    if (k === undefined) { console.log("unknown key"); return; }
    await keyboard.pressKey(k);
    await keyboard.releaseKey(k);
    console.log("KEY", process.argv[3]);
    return;
  }
  console.log("usage: list | focus <title> | click x y | rclick x y | key enter|space|esc|tab|down|up");
})().catch((e) => { console.log("ERR", e.message); process.exit(1); });
