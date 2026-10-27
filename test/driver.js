// 自动自测：只在 HONGDAN_TEST=1 时加载，不会打包进 App
const fs = require('fs');
const path = require('path');

const CLICK_LINES = ['咕噜', '一机做事一机当，好机我也一机当', '蛋在求别踢', '早餐是溏心蛋吗', '蛋蛋好难'];
const HIT_LINES = ['坏女人也会疼的', '笨笨嘟倒下了', '软饭吐出来了', '今天第几顿了', '我错了我错了'];

exports.run = async ({ app, win, getStore, menuAction, menuTemplate, setCursor, getKo }) => {
  const outDir = process.env.HONGDAN_SHOTS || path.join(__dirname, 'shots');
  fs.mkdirSync(outDir, { recursive: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const results = [];
  const check = (name, ok, info = '') => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? '✅' : '❌'} ${name} ${info}`);
  };
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, name + '.png'), img.toPNG());
  };
  const waitFor = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); }
    return false;
  };
  const state = () => js('({mode: __pet.S.mode, ko: __pet.S.ko, x: __pet.S.x, y: __pet.S.y, angle: __pet.S.baseAngle, bubble: document.getElementById("bubble").classList.contains("show") ? document.getElementById("bubble").textContent : "", koShown: document.getElementById("ko").classList.contains("show"), eggClass: document.getElementById("egg").getAttribute("class") || "", sounds: __soundLog.slice()})');
  const mouse = (type, x, y, extra = {}) => {
    const b = win.getBounds();
    win.webContents.sendInputEvent({ type, x, y, globalX: b.x + x, globalY: b.y + y, button: 'left', clickCount: 1, ...extra });
  };

  // 记录点穿开关
  const ignoreLog = [];
  const orig = win.setIgnoreMouseEvents.bind(win);
  win.setIgnoreMouseEvents = (v, o) => { ignoreLog.push(v); orig(v, o); };

  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    await sleep(800);

    // 1. 能打开
    check('窗口打开、透明无边框、置顶', win.isVisible() && win.isAlwaysOnTop(), JSON.stringify(win.getBounds()));
    await shot('01-idle');

    // 2. 能滚
    const x0 = (await state()).x;
    const rolled = await waitFor(async () => (await state()).mode === 'roll', 25000);
    await sleep(1500);
    const s2 = await state();
    await shot('02-rolling');
    check('自己会滚', rolled && Math.abs(s2.x - x0) > 20, `x ${x0} → ${s2.x}, 角度 ${s2.angle.toFixed(0)}°`);
    const settled = await waitFor(async () => (await state()).mode === 'idle', 25000);
    const s2b = await state();
    check('滚完停下时是站正的', settled && Math.abs(s2b.angle % 360) < 0.01, `角度 ${s2b.angle}`);

    // 3. 点穿
    ignoreLog.length = 0;
    mouse('mouseMove', 120, 170); await sleep(150);
    mouse('mouseMove', 8, 8); await sleep(150);
    check('鼠标在蛋上接管、离开蛋就点穿', ignoreLog[0] === false && ignoreLog[1] === true, JSON.stringify(ignoreLog));

    // 4. 能点
    mouse('mouseMove', 120, 170); await sleep(100);
    mouse('mouseDown', 120, 170); mouse('mouseUp', 120, 170);
    await sleep(250);
    const s4 = await state();
    await shot('03-click');
    check('单击：冒气泡 + 咕噜声', CLICK_LINES.includes(s4.bubble) && s4.sounds.includes('gulu'), `"${s4.bubble}"`);

    // 5. 能拖，松手掉回底部
    await waitFor(async () => (await state()).mode !== 'roll', 25000);
    const b0 = win.getBounds();
    mouse('mouseMove', 120, 170); await sleep(100);
    mouse('mouseDown', 120, 170);
    mouse('mouseMove', 130, 160, { modifiers: ['leftButtonDown'] });
    setCursor(() => ({ x: 500 + 120, y: 300 + 170 }));
    await sleep(300);
    const b1 = win.getBounds();
    await shot('04-dragging');
    check('能拖着走', b1.x === 500 && b1.y === 300, `${b0.x},${b0.y} → ${b1.x},${b1.y}`);
    mouse('mouseUp', 120, 170);
    await sleep(120);
    const mid = win.getBounds();
    const landed = await waitFor(async () => { const s = await state(); return s.mode !== 'fall' && s.mode !== 'drag'; }, 4000);
    await sleep(200);
    const b2 = win.getBounds();
    const s5 = await state();
    check('松手后掉回底部并弹一下', landed && b2.y === b0.y && mid.y < b0.y && s5.sounds.filter((n) => n === 'land').length >= 1,
      `下落中 y=${mid.y}，落地 y=${b2.y}（地面 ${b0.y}）`);

    // 6. 揍三下 → K.O.
    const before = getStore().hits;
    menuAction('punch'); await sleep(250);
    const p1 = await state();
    await shot('05-punch');
    check('揍第 1 下：往后歪 + 气泡 + 声音', !p1.ko && HIT_LINES.includes(p1.bubble) && p1.sounds.includes('punch') && p1.eggClass.includes('squint'), `"${p1.bubble}"`);
    await sleep(900);
    menuAction('punch'); await sleep(900);
    check('揍第 2 下还没倒', !(await state()).ko);
    menuAction('punch'); await sleep(1200);
    const p3 = await state();
    await shot('06-ko');
    check('揍满 3 下 K.O.：侧躺 + 叉叉眼 + K.O. 字样', p3.ko && p3.eggClass.includes('ko') && p3.koShown && Math.abs(Math.abs(p3.angle % 180) - 90) < 0.5,
      `角度 ${p3.angle}°`);
    check('菜单里"扶起来"变成可点', getKo() && menuTemplate().find((i) => i.label === '扶起来').enabled);
    const label = menuTemplate().find((i) => /今天挨了/.test(i.label || '')).label;
    check('今日被揍次数 +3，菜单显示', getStore().hits === before + 3 && label === `今天挨了 ${before + 3} 顿`, label);
    const koX = win.getBounds().x;
    await sleep(9000);
    check('倒下后不再自己滚', win.getBounds().x === koX && (await state()).mode === 'ko');

    // 7. 扶起来
    menuAction('getup');
    await sleep(700);
    await shot('07-getting-up');
    await sleep(1100);
    const g = await state();
    await shot('08-thanks');
    check('扶起来：站正、眼睛恢复、说谢谢', !g.ko && !g.eggClass.includes('ko') && Math.abs(g.angle % 360) < 0.01 && g.bubble === '谢谢 yyq，还是你心软' && g.sounds.includes('getup'), `"${g.bubble}"`);
    const gx = win.getBounds().x;
    const rollAgain = await waitFor(async () => Math.abs(win.getBounds().x - gx) > 10, 30000);
    check('扶起来后继续滚', rollAgain);

    // 8. 静音 / 取消静音
    menuAction('mute'); await sleep(100);
    check('菜单显示"取消静音"', menuTemplate().some((i) => i.label === '取消静音'));
    let n = (await state()).sounds.length;
    await js('__pet.onClick()'); menuAction('punch'); await sleep(200);
    const m1 = await state();
    check('静音后不出声（气泡照常）', m1.sounds.length === n && m1.bubble !== '');
    menuAction('mute'); await sleep(100);
    n = m1.sounds.length;
    await js('__pet.onClick()'); await sleep(200);
    check('取消静音后又有声音', (await state()).sounds.length === n + 1);

    // 9. 跨天清零
    getStore().date = '2000-01-01';
    const lbl = menuTemplate().find((i) => /今天挨了/.test(i.label || '')).label;
    check('第二天自动清零', lbl === '今天挨了 0 顿', lbl);

    // 10. 省电：发呆时动画循环是停的
    const idleNoLoop = await waitFor(async () => js('__pet.S.mode === "idle" && !__pet.looping'), 30000);
    check('发呆时动画循环完全停下（省电）', idleNoLoop);
    check('退出菜单项存在', menuTemplate().some((i) => i.label === '退出'));
  } catch (e) {
    console.log('❌ 测试异常', e.stack);
    results.push({ name: 'exception', ok: false });
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n结果：${results.length - failed}/${results.length} 通过`);
  app.exit(failed ? 1 : 0);
};
