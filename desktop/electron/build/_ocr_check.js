/* OCR/截图质量自检：真实跑 screenshot（整屏+局部）和 ocr_screen，打印输出规格
   用法: electron build/_ocr_check.js */
const { app } = require("electron");
const { TOOLS } = require("../pc.js");

app.whenReady().then(async () => {
  const out = [];
  try {
    const full = await TOOLS.screenshot({});
    out.push(["整屏截图", full.format, full.width + "x" + full.height, Math.round(full.bytes / 1024) + "KB"]);
  } catch (e) { out.push(["整屏截图", "ERROR", e.message]); }
  try {
    const reg = await TOOLS.screenshot({ region: { x: 100, y: 100, w: 400, h: 150 } });
    out.push(["局部截图", reg.format, reg.width + "x" + reg.height, Math.round(reg.bytes / 1024) + "KB", "zoomed=" + reg.region.zoomed]);
  } catch (e) { out.push(["局部截图", "ERROR", e.message]); }
  try {
    const ocr = await TOOLS.ocr_screen({ region: { x: 100, y: 100, w: 400, h: 150 } });
    out.push(["局部OCR", ocr.text ? "ok" : "empty", "识别" + (ocr.text || "").length + "字", (ocr.ms || 0) + "ms"]);
  } catch (e) { out.push(["局部OCR", "ERROR", e.message]); }
  console.log("\n===== OCR/截图自检结果 =====");
  for (const row of out) console.log(row.join("  |  "));
  app.exit(0);
});
