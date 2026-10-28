// 红蛋桌宠 —— 主进程：窗口、右键菜单、计数存档、拖拽跟随
const { app, BrowserWindow, Menu, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const WIN_W = 240;
const WIN_H = 230;
const TEST = process.env.HONGDAN_TEST === '1';

let win = null;
let talk = null; // 跟红蛋说话（talk.js）
let shot = null; // 截图（screenshot.js）
let journal = null; // 红蛋的工作日记（journal.js）

// 截图快捷键：⌃⇧⌥S，被别的 App 占了就换 ⌃⇧⌥P
const SHOT_KEYS = ['Control+Shift+Alt+S', 'Control+Shift+Alt+P'];
let shotKey = null;

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

// ---------- 错误日志：~/Library/Application Support/红蛋/error.log ----------
function logError(msg) {
  try {
    const p = path.join(app.getPath('userData'), 'error.log');
    if (fs.existsSync(p) && fs.statSync(p).size > 512 * 1024) fs.renameSync(p, p + '.old');
    fs.appendFileSync(p, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) {}
  if (TEST) console.log('[log]', msg);
}
// 出错只记日志，不弹窗打扰
process.on('uncaughtException', (e) => logError('主进程错误：' + (e && e.stack || e)));

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
    { label: '跟红蛋说话', click: () => talk && talk.openChat() },
    { label: '截图', accelerator: shotKey || undefined, registerAccelerator: false, click: () => shot && shot.take() },
    { type: 'separator' },
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
    send('action', 'punch', store.hits);
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
    const x = Math.round(p.x - offX) | 0, y = Math.round(p.y - offY) | 0;
    if (Number.isFinite(x) && Number.isFinite(y)) win.setPosition(x, y);
  }, 16);
}
function stopDrag() {
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = null;
}

// ---------- 眼神跟随：每 100ms 取一次鼠标位置，没动就不发 ----------
let lastCursor = null;
function startCursorWatch() {
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const p = getCursor();
    if (lastCursor && p.x === lastCursor.x && p.y === lastCursor.y) return;
    lastCursor = p;
    const b = win.getBounds();
    send('cursor', { x: p.x, y: p.y, wx: b.x, wy: b.y });
  }, 100);
}

// ---------- IPC ----------
ipcMain.on('set-ignore', (_e, ignore) => {
  if (!win) return;
  if (ignore) win.setIgnoreMouseEvents(true, { forward: true });
  else win.setIgnoreMouseEvents(false);
});
ipcMain.on('move', (_e, x, y) => {
  if (!win || win.isDestroyed()) return;
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e6 || Math.abs(y) > 1e6) {
    logError(`收到异常坐标 move(${x}, ${y})，已忽略`);
    return;
  }
  // | 0：转成真正的整数。Math.round(-0.3) 得到的是 -0，Electron 不认 -0 会直接报错
  win.setPosition(Math.round(x) | 0, Math.round(y) | 0);
});
ipcMain.on('log', (_e, msg) => logError(msg));
ipcMain.on('note', (_e, what) => journal && journal.note(what)); // 红蛋做了什么动作，记进今天的日记
ipcMain.on('menu', () => showMenu());
ipcMain.on('drag-start', (_e, offX, offY) => startDrag(offX, offY));
ipcMain.handle('drag-end', () => { stopDrag(); return win.getBounds(); });
ipcMain.on('ko-state', (_e, needHelp) => { koState = needHelp; }); // K.O. 或在哭时可以"扶起来"
ipcMain.handle('init', () => ({
  bounds: win.getBounds(),
  muted: store.muted,
  test: TEST,
}));
// 给定窗口位置，返回所在屏幕的可用区域（去掉 Dock / 菜单栏）
ipcMain.handle('work-area', (_e, x, y) =>
  screen.getDisplayNearestPoint({ x: Math.round(x + WIN_W / 2), y: Math.round(y + WIN_H / 2) }).workArea);

function registerShotKey() {
  for (const k of SHOT_KEYS) {
    try { if (globalShortcut.register(k, () => shot && shot.take())) { shotKey = k; return; } } catch (_) {}
    logError('截图快捷键 ' + k + ' 被占用了，换下一个');
  }
  logError('截图快捷键都被占用了，只能从右键菜单截图');
}

// ---------- 启动 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    if (process.platform === 'darwin' && app.dock) app.dock.hide(); // 不在 Dock 里占位置
    loadStore();
    createWindow();
    talk = require('./talk')({ app, getPetWindow: () => win, logError });
    shot = require('./screenshot')({
      app, logError,
      getPetWindow: () => win,
      getChatWindow: () => talk.getChatWindow(),
      onShot: (what) => journal && journal.note(what),
    });
    if (!TEST) registerShotKey();
    startCursorWatch();
    screen.on('display-metrics-changed', () => send('screen-changed'));
    screen.on('display-removed', () => send('screen-changed'));
    if (TEST) {
      require('./test/driver').run({
        app, win, getStore: () => store, menuAction, menuTemplate, WIN_W, WIN_H,
        setCursor: (fn) => { getCursor = fn; }, talk, shot,
        getKo: () => koState,
      });
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
