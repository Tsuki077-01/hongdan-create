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
  onAction: (fn) => ipcRenderer.on('action', (_e, a) => fn(a)),
  onMuted: (fn) => ipcRenderer.on('muted', (_e, m) => fn(m)),
  onScreenChanged: (fn) => ipcRenderer.on('screen-changed', () => fn()),
});
