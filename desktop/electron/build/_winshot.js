// 抓取指定标题的窗口画面（即使被其它窗口遮挡）
// 用法: electron build/_winshot.js <标题关键字> <输出png>
const { app, desktopCapturer, nativeImage } = require("electron");
const fs = require("fs");

const kw = process.argv[2] || "Dafeiyu";
const out = process.argv[3] || "C:/Users/Administrator/WorkBuddy/2026-11-05-13-53-01/_win.png";

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const sources = await desktopCapturer.getSources({
    types: ["window"],
    thumbnailSize: { width: 1200, height: 900 },
    fetchWindowIcons: false,
  });
  const rows = sources.map((s) => ({ id: s.id, name: s.name, w: s.thumbnail.getSize().width, h: s.thumbnail.getSize().height }));
  console.log("窗口源列表：");
  rows.forEach((r) => console.log("  " + JSON.stringify(r)));

  const hit = sources.find((s) => s.name && s.name.includes(kw));
  if (!hit) {
    console.log("未找到包含 '" + kw + "' 的窗口");
    app.exit(2);
    return;
  }
  const img = hit.thumbnail;
  if (img.isEmpty()) {
    console.log("缩略图为空: " + hit.name);
    app.exit(3);
    return;
  }
  fs.writeFileSync(out, img.toPNG());
  console.log("已保存: " + out + "  来源: " + JSON.stringify(hit.name) + "  尺寸: " + img.getSize().width + "x" + img.getSize().height);
  app.exit(0);
});
