const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 700, height: 480, show: false,
    webPreferences: { contextIsolation: true },
  });
  await win.loadFile("probe.html");
  await new Promise((r) => setTimeout(r, 2500));
  let info = null;
  for (let i = 0; i < 20; i++) {
    info = await win.webContents.executeJavaScript("window.__info || null");
    if (info) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log("META", JSON.stringify(info));
  const img = await win.webContents.capturePage();
  fs.writeFileSync("probe.png", img.toPNG());
  console.log("saved probe.png");
  app.quit();
});
