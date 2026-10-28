const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('talk', {
  state: () => ipcRenderer.invoke('talk:state'),
  ask: (text) => ipcRenderer.invoke('talk:ask', String(text)),
  setKey: (key) => ipcRenderer.invoke('talk:set-key', String(key)),
  setCfg: (c) => ipcRenderer.invoke('talk:set-cfg', c),
  models: (c) => ipcRenderer.invoke('talk:models', c),
  setMem: (c) => ipcRenderer.invoke('mem:set', c),
  testMem: () => ipcRenderer.invoke('mem:test'),
  clear: () => ipcRenderer.invoke('talk:clear'),
  close: () => ipcRenderer.send('talk:close'),
});
