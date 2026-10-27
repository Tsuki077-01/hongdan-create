// 红蛋桌宠 —— 主进程：窗口、右键菜单、计数存档、拖拽跟随
const { app, BrowserWindow, Menu, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const WIN_W = 240;
const WIN_H = 230;
const TEST = process.env.HONGDAN_TEST === '1';

let win = null;

// ---------- 存档：今日被揍次数 + 静音 ----------
const storePath = () => path.join(app.getPath('userData'), 'hongdan.json');
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
let store = { date: today(), hits: 0, muted: false };

function loadStore() {
  try {
    store = { ...store, ...JSON.parse(fs.readFileSync(storePath(), 'utf8')) };
  } catch (_) { /* 第一次运行没有存档 */ }
  rollDay();
}
function saveStore() {
  try { fs.writeFileSync(storePath(), JSON.stringify(store)); } catch (_) {}
}
// 跨天自动清零
function rollDay() {
  if (store.date !== today()) {
    store.date = today();
    store.hits = 0;
    saveStore();
  }
}

// ---------- 窗口 ----------
function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: Math.round(wa.x + wa.width / 2 - WIN_W / 2),
    y: wa.y + wa.height - WIN_H,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    acceptFirstMouse: true,
    type: process.platform === 'darwin' ? 'panel' : undefined, // macOS：点它不抢你当前 App 的焦点
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false, // 拖到屏幕边缘时也不要冻住动画；空闲时我们自己会停掉循环
      contextIsolation: true,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true }); // 默认点穿，鼠标移到蛋上再接管
  win.loadFile('index.html');
  win.once('ready-to-show', () => win.showInactive());
}

const send = (ch, ...args) => win && !win.isDestroyed() && win.webContents.send(ch, ...args);

// ---------- 右键菜单 ----------
let koState = false;
function menuTemplate() {
  rollDay();
  return [
    { label: '揍', click: () => menuAction('punch') },
    { label: '扶起来', enabled: koState, click: () => menuAction('getup') },
    { type: 'separator' },
    { label: `今天挨了 ${store.hits} 顿`, enabled: false },
    { label: store.muted ? '取消静音' : '静音', click: () => menuAction('mute') },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ];
}
function showMenu() {
  Menu.buildFromTemplate(menuTemplate()).popup({ window: win });
}

function menuAction(name) {
  if (name === 'punch') {
    rollDay();
    store.hits += 1;
    saveStore();
    send('action', 'punch');
  } else if (name === 'getup') {
    send('action', 'getup');
  } else if (name === 'mute') {
    store.muted = !store.muted;
    saveStore();
    send('muted', store.muted);
  }
}

// ---------- 拖拽：轮询鼠标位置让窗口跟着走 ----------
let dragTimer = null;
let getCursor = () => screen.getCursorScreenPoint();

function startDrag(offX, offY) {
  stopDrag();
  dragTimer = setInterval(() => {
    const p = getCursor();
    win.setPosition(Math.round(p.x - offX), Math.round(p.y - offY));
  }, 16);
}
function stopDrag() {
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = null;
}

// ---------- IPC ----------
ipcMain.on('set-ignore', (_e, ignore) => {
  if (!win) return;
  if (ignore) win.setIgnoreMouseEvents(true, { forward: true });
  else win.setIgnoreMouseEvents(false);
});
ipcMain.on('move', (_e, x, y) => win && win.setPosition(Math.round(x), Math.round(y)));
ipcMain.on('menu', () => showMenu());
ipcMain.on('drag-start', (_e, offX, offY) => startDrag(offX, offY));
ipcMain.handle('drag-end', () => { stopDrag(); return win.getBounds(); });
ipcMain.on('ko-state', (_e, ko) => { koState = ko; });
ipcMain.handle('init', () => ({
  bounds: win.getBounds(),
  muted: store.muted,
  test: TEST,
}));
// 给定窗口位置，返回所在屏幕的可用区域（去掉 Dock / 菜单栏）
ipcMain.handle('work-area', (_e, x, y) =>
  screen.getDisplayNearestPoint({ x: Math.round(x + WIN_W / 2), y: Math.round(y + WIN_H / 2) }).workArea);

// ---------- 启动 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    if (process.platform === 'darwin' && app.dock) app.dock.hide(); // 不在 Dock 里占位置
    loadStore();
    createWindow();
    screen.on('display-metrics-changed', () => send('screen-changed'));
    screen.on('display-removed', () => send('screen-changed'));
    if (TEST) {
      require('./test/driver').run({
        app, win, getStore: () => store, menuAction, menuTemplate, WIN_W, WIN_H,
        setCursor: (fn) => { getCursor = fn; },
        getKo: () => koState,
      });
    }
  });
  app.on('window-all-closed', () => app.quit());
}
