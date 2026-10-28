// 自测：截图流程（权限没给 / 拍好了 / 按 Esc 取消）。换掉真的 screencapture、图片文件夹和剪贴板，不打扰你
const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');

exports.run = async ({ win, shot, menuTemplate, check, sleep, waitFor, js, shotImg, outDir }) => {
  const dir = path.join(outDir, 'shots-dir');
  fs.rmSync(dir, { recursive: true, force: true });
  const copied = [];
  shot.hooks.dir = () => dir;
  shot.hooks.copy = (img) => copied.push(img.getSize());
  const bubble = () => js(`document.getElementById('bubble').classList.contains('show') ? document.getElementById('bubble').textContent : ''`);
  const quiet = async () => {
    await js(`__pet.autopilot = false; if (__pet.S.tripping || __pet.S.mode === 'roll') { __pet.cancelTrip(); __pet.S.baseAngle = Math.round(__pet.S.baseAngle / 360) * 360; __pet.render(); } 0`);
    await sleep(600);
  };

  check('右键菜单里有「截图」', menuTemplate().some((i) => i.label === '截图'));

  // ---- 权限没给：不静默失败，气泡告诉她去哪里开 ----
  await quiet();
  shot.hooks.permission = async () => 'denied';
  let capCalls = 0;
  shot.hooks.capture = async () => { capCalls++; };
  let r = await shot.take();
  await sleep(300);
  const b1 = await bubble();
  check('没有屏幕录制权限时，气泡说去哪里打开', !r.ok && /屏幕录制/.test(b1) && /隐私与安全性/.test(b1), b1.replace(/\n/g, ' / '));
  const bTop = await js(`document.getElementById('bubble').getBoundingClientRect().top`);
  check('权限提示整段都在窗口里，没被裁掉', bTop >= 0, 'top=' + bTop);
  check('没有权限时不调 screencapture', capCalls === 0);
  await shotImg('20-shot-permission');

  // ---- 拍好了 ----
  await sleep(3500);
  await quiet();
  shot.hooks.permission = async () => 'granted';
  let during = null, flashSeen = false, camUp = false;
  const flashWatch = setInterval(() => {
    if (BrowserWindow.getAllWindows().some((w) => w !== win && /flash\.html$/.test(w.webContents.getURL()))) flashSeen = true;
  }, 30);
  const camWatch = setInterval(async () => {
    try { if (await js(`document.getElementById('camera').classList.contains('up')`)) camUp = true; } catch (_) {}
  }, 60);
  let midShot = false;
  setTimeout(async () => { await shotImg('21-shot-camera-up'); }, 300);
  setTimeout(async () => { await shotImg('22-shot-flash'); midShot = true; }, 640);
  shot.hooks.capture = async (file) => {
    during = { petVisible: win.isVisible(), flashOpen: BrowserWindow.getAllWindows().some((w) => w !== win && !w.isDestroyed() && /flash\.html$/.test(w.webContents.getURL())) };
    const img = await win.webContents.capturePage();
    fs.writeFileSync(file, img.toPNG());
  };
  const t0 = Date.now();
  r = await shot.take();
  clearInterval(flashWatch); clearInterval(camWatch);
  check('先举相机（相机出现）', camUp);
  check('咔嚓时屏幕边缘闪白光（闪光窗口出现过）', flashSeen);
  check('举相机、咔嚓之后才开始截（约 1 秒）', Date.now() - t0 >= 900, (Date.now() - t0) + 'ms');
  check('截的时候红蛋藏起来了', during && during.petVisible === false, JSON.stringify(during));
  check('截的时候闪光已经关掉，不会被截进去', during && during.flashOpen === false);
  check('截完红蛋回来了', win.isVisible());
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  check('存进 红蛋截图 文件夹，文件名带日期时间', r.ok && files.length === 1 && /^红蛋截图 \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\.png$/.test(files[0]), files.join());
  check('同时复制到剪贴板', copied.length === 1 && copied[0].width > 0, JSON.stringify(copied));
  await sleep(200);
  const b2 = await bubble();
  check('红蛋说"拍好啦"', /拍好啦/.test(b2), b2);
  const sounds = await js('__soundLog.slice(-6)');
  check('咔嚓一声', sounds.includes('shutter') && sounds.includes('camUp'), sounds.join());
  await shotImg('23-shot-done');
  await sleep(1500);
  check('说完相机收起来', !(await js(`document.getElementById('camera').classList.contains('up')`)));

  // ---- 按 Esc 取消 ----
  await sleep(3000);
  await quiet();
  shot.hooks.capture = async () => { const e = new Error('cancel'); e.code = 1; return e; };
  r = await shot.take();
  await sleep(200);
  const b3 = await bubble();
  check('按 Esc 取消：不留文件、红蛋说"不拍了吗"', r.cancelled && fs.readdirSync(dir).length === 1 && /不拍了吗/.test(b3), b3);
  check('取消后红蛋也回来了', win.isVisible());

  // ---- 连按两次不会叠在一起 ----
  await sleep(1500);
  shot.hooks.capture = async (file) => { await sleep(300); fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); };
  const [a, b] = await Promise.all([shot.take(), shot.take()]);
  check('连按两次只截一张', (a.ok && b.busy) || (b.ok && a.busy), JSON.stringify([a, b]));
  await js('__pet.autopilot = true; 0');
};
