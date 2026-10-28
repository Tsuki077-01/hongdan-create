// 红蛋截图 —— 主进程这边：红蛋举相机 → 藏起来 → macOS 自带的 screencapture -i → 存到 ~/Pictures/红蛋截图/ 并复制到剪贴板
// 截下来的图只存在本机，不发给任何 API
const { BrowserWindow, clipboard, desktopCapturer, ipcMain, nativeImage, screen, systemPreferences } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

// 气泡只有四行高，自己分好行
const PERM_MSG = '我还没有屏幕录制权限\n系统设置 → 隐私与安全性\n→ 屏幕录制 里打开红蛋\n打开后再重开我一下';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
}

// 等渲染进程发来某个信号，超时也继续（不能让截图卡死）
function waitIpc(channel, ms) {
  return new Promise((resolve) => {
    const h = () => { clearTimeout(t); resolve(true); };
    const t = setTimeout(() => { ipcMain.removeListener(channel, h); resolve(false); }, ms);
    ipcMain.once(channel, h);
  });
}

module.exports = function setupScreenshot({ app, getPetWindow, getChatWindow, logError, onShot }) {
  // 自动测试可以换掉这几样，免得真的弹框、写进你的图片文件夹和剪贴板
  const hooks = {
    dir: () => path.join(app.getPath('pictures'), '红蛋截图'),
    permission: async () => {
      if (process.platform !== 'darwin') return 'granted';
      let st = systemPreferences.getMediaAccessStatus('screen');
      if (st === 'not-determined') {
        // 第一次：碰一下屏幕，让系统把红蛋登记进"屏幕录制"列表并弹出询问
        try { await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }); } catch (_) {}
        st = systemPreferences.getMediaAccessStatus('screen');
      }
      return st;
    },
    // -i 自己框选（空格切换成截窗口，Esc 取消），-x 不放系统快门声（红蛋自己会咔嚓）
    capture: (file) => new Promise((resolve) => execFile('/usr/sbin/screencapture', ['-i', '-x', file], (err) => resolve(err))),
    copy: (img) => clipboard.writeImage(img),
  };

  const send = (ch, ...args) => {
    const w = getPetWindow();
    if (w && !w.isDestroyed()) w.webContents.send(ch, ...args);
  };

  // ---------- 屏幕边缘闪一下白光 ----------
  let flashWin = null;
  function closeFlash() {
    if (flashWin && !flashWin.isDestroyed()) flashWin.close();
    flashWin = null;
  }
  function flash() {
    closeFlash();
    const pet = getPetWindow();
    const b = pet ? pet.getBounds() : null;
    const d = b ? screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 }) : screen.getPrimaryDisplay();
    const f = flashWin = new BrowserWindow({
      ...d.bounds,
      frame: false, transparent: true, resizable: false, movable: false, focusable: false,
      hasShadow: false, skipTaskbar: true, fullscreenable: false, enableLargerThanScreen: true, show: false,
      type: process.platform === 'darwin' ? 'panel' : undefined,
      backgroundColor: '#00000000',
      webPreferences: { contextIsolation: true },
    });
    f.setIgnoreMouseEvents(true);
    f.setAlwaysOnTop(true, 'screen-saver');
    f.loadFile(path.join(__dirname, 'flash.html'));
    f.once('ready-to-show', () => { if (!f.isDestroyed()) f.showInactive(); });
    setTimeout(() => { if (flashWin === f) closeFlash(); else if (!f.isDestroyed()) f.close(); }, 650);
  }
  ipcMain.on('flash', () => flash());

  // ---------- 截图 ----------
  let busy = false;
  async function take() {
    if (busy) return { busy: true };
    busy = true;
    const pet = getPetWindow();
    let chat = null, chatShown = false, hidden = false;
    const restore = () => {
      if (!hidden) return;
      hidden = false;
      if (pet && !pet.isDestroyed()) pet.showInactive();
      if (chatShown && chat && !chat.isDestroyed()) chat.showInactive();
    };
    try {
      const perm = await hooks.permission();
      if (perm !== 'granted') {
        send('say', PERM_MSG);
        return { ok: false, permission: perm };
      }
      send('action', 'camera');
      await waitIpc('camera-ready', 2500); // 红蛋举相机、咔嚓完了
      closeFlash();
      chat = getChatWindow();
      chatShown = !!(chat && !chat.isDestroyed() && chat.isVisible());
      if (pet && !pet.isDestroyed()) pet.hide();
      if (chatShown) chat.hide();
      hidden = true;
      await sleep(180); // 等窗口真的从屏幕上消失，免得被截进去

      const dir = hooks.dir();
      fs.mkdirSync(dir, { recursive: true });
      let file = path.join(dir, `红蛋截图 ${stamp()}.png`);
      for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `红蛋截图 ${stamp()} (${i}).png`);
      const err = await hooks.capture(file);
      restore();

      if (fs.existsSync(file) && fs.statSync(file).size > 0) {
        try { hooks.copy(nativeImage.createFromPath(file)); } catch (e) { logError('复制截图到剪贴板失败：' + e.message); }
        onShot('shot');
        send('shot-done', { ok: true });
        return { ok: true, file };
      }
      if (err && err.code !== 1) logError('screencapture 出错：' + (err.message || err));
      onShot('shotCancel');
      send('shot-done', { cancelled: true });
      return { ok: false, cancelled: true };
    } catch (e) {
      logError('截图失败：' + (e && e.stack || e));
      restore();
      send('shot-done', { error: '没拍成，出了点错' });
      return { ok: false, error: String(e) };
    } finally {
      restore();
      busy = false;
    }
  }

  return { take, hooks, PERM_MSG };
};
