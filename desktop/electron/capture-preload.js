const { contextBridge } = require("electron");
contextBridge.exposeInMainWorld("dafeiyu", {
  move: () => {},
  resize: () => {},
  ignoreMouse: () => {},
  setTopmost: () => {},
  getStartup: async () => false,
  toggleStartup: async () => false,
  onExternalState: () => {},
});
