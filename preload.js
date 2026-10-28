const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  init: () => ipcRenderer.invoke('init'),
  workArea: (x, y) => ipcRenderer.invoke('work-area', x, y),
  setIgnore: (v) => ipcRenderer.send('set-ignore', v),
  move: (x, y) => ipcRenderer.send('move', x, y),
  menu: () => ipcRenderer.send('menu'),
  dragStart: (ox, oy) => ipcRenderer.send('drag-start', ox, oy),
  dragEnd: () => ipcRenderer.invoke('drag-end'),
  koState: (v) => ipcRenderer.send('ko-state', v),
  log: (msg) => ipcRenderer.send('log', String(msg)),
  onAction: (fn) => ipcRenderer.on('action', (_e, a, arg) => fn(a, arg)),
  onCursor: (fn) => ipcRenderer.on('cursor', (_e, c) => fn(c)),
  onMuted: (fn) => ipcRenderer.on('muted', (_e, m) => fn(m)),
  onTalk: (fn) => ipcRenderer.on('talk', (_e, text) => fn(text)),
  onScreenChanged: (fn) => ipcRenderer.on('screen-changed', () => fn()),
});
