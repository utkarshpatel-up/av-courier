const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  call: (method, ...args) => ipcRenderer.invoke('call', method, ...args),
  on: (channel, fn) => {
    const allowed = ['queue', 'requests', 'activity', 'status', 'add-files', 'open-request', 'go'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
  // Dropped files: Electron 32+ no longer exposes File.path.
  pathFor: (f) => webUtils.getPathForFile(f),
});
