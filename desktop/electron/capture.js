const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
const out = process.argv[2] || "capture.png";
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 340, height: 420, show: false, frame: false, transparent: true,
    webPreferences: { preload: path.join(__dirname, "capture-preload.js"), contextIsolation: true },
  });
  await win.loadFile("pet.html");
  await new Promise((r) => setTimeout(r, 1600));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  console.log("saved", out);
  app.quit();
});
