const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
const out = process.argv[2] || "capture.png";
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 360, height: 470, show: false, frame: false, transparent: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true },
  });
  win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    console.log("CONSOLE[" + level + "] " + message + " @" + String(sourceId).split(/[\\/]/).pop() + ":" + line);
  });
  await win.loadFile("chat.html");
  await new Promise((r) => setTimeout(r, 2500));
  const info = await win.webContents.executeJavaScript(
    "({msgs: document.getElementById('msgs').innerText.slice(0,200), n: document.querySelectorAll('.msg').length, sdk: typeof WorkBuddyCloud, cloud: !!cloud, model: modelId})"
  );
  console.log("INFO " + JSON.stringify(info));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  console.log("saved", out);
  app.quit();
});
