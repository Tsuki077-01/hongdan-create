// 自动自测：只在 HONGDAN_TEST=1 时加载，不会打包进 App
const fs = require('fs');
const path = require('path');

const CLICK_LINES = ['咕噜', '一机做事一机当，好机我也一机当', '蛋在求别踢', '早餐是溏心蛋吗', '蛋蛋好难'];
const HIT_LINES = ['坏女人也会疼的', '笨笨嘟倒下了', '软饭吐出来了', '今天第几顿了', '我错了我错了'];
const CRY_LINES = ['呜呜 揍太多了', '呜呜呜……蛋壳要裂了', '再揍要变散黄蛋了 呜'];
const GAZE_MAX = 5.5;

exports.run = async ({ app, win, getStore, menuAction, menuTemplate, setCursor, getKo }) => {
  const outDir = process.env.HONGDAN_SHOTS || path.join(__dirname, 'shots');
  const only = process.env.HONGDAN_ONLY; // 只跑某一组，调试用
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
  const state = () => js(`(() => {
    const e = document.getElementById('egg'), S = __pet.S;
    const pt = document.getElementById('pupils').style.transform.match(/-?[\\d.]+/g) || [0, 0];
    return {
      mode: S.mode, ko: S.ko, crying: S.crying, scared: S.scared, tripping: S.tripping,
      x: S.x, y: S.y, angle: S.baseAngle, liveAngle: __pet.angle, hopY: __pet.hopY,
      eyes: e.dataset.eyes, mouth: e.dataset.mouth, brows: e.dataset.brows,
      gaze: [+pt[0], +pt[1]],
      bubble: document.getElementById('bubble').classList.contains('show') ? document.getElementById('bubble').textContent : '',
      koShown: document.getElementById('ko').classList.contains('show'),
      sounds: __soundLog.slice(), lastTrip: S.lastTrip || null,
      rollTag: S.roll ? S.roll.tag : null,
      rotT: e.querySelector('.rot').getAttribute('transform'),
      clipT: e.querySelector('.clip-rot').getAttribute('transform'),
      fixedT: [...e.querySelectorAll('.fixed')].map((g) => g.getAttribute('transform')),
      near: __pet.near, lastAuto: S.lastAuto || null,
    };
  })()`);
  const mouse = (type, x, y, extra = {}) => {
    const b = win.getBounds();
    win.webContents.sendInputEvent({ type, x, y, globalX: b.x + x, globalY: b.y + y, button: 'left', clickCount: 1, ...extra });
  };
  const idleCalm = async () => {
    // 停掉自发行为，等蛋静下来，方便单项测试
    await js('__pet.autopilot = false; if (__pet.S.tripping || __pet.S.mode === "roll") { __pet.cancelTrip(); if (!__pet.S.ko) __pet.S.baseAngle = Math.round(__pet.S.baseAngle / 360) * 360; __pet.render(); } 0');
    await waitFor(async () => { const s = await state(); return s.mode === 'idle' && !s.tripping && Math.abs(s.angle % 360) < 0.01; }, 30000);
    await js('(() => { const S = __pet.S; S.lastHit = 0; S.streak = 0; })()');
  };
  const wantGroup = (g) => !only || only.split(',').includes(g);

  // 记录点穿开关
  const ignoreLog = [];
  const orig = win.setIgnoreMouseEvents.bind(win);
  win.setIgnoreMouseEvents = (v, o) => { ignoreLog.push(v); orig(v, o); };
  // 鼠标位置由测试控制
  let fakeCursor = { x: 10, y: 10 };
  setCursor(() => fakeCursor);

  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    await sleep(800);

    check('窗口打开、透明无边框、置顶', win.isVisible() && win.isAlwaysOnTop(), JSON.stringify(win.getBounds()));
    const s0 = await state();
    check('平时：小黑点眼睛 + 小弧线笑', s0.eyes === 'normal' && s0.mouth === 'smile', `${s0.eyes}/${s0.mouth}`);
    await shot('01-idle');
    const rolledAlone = await waitFor(async () => (await state()).mode === 'roll', 25000);
    check('自己会出门滚', rolledAlone, JSON.stringify((await state()).lastTrip));

    if (wantGroup('gaze')) {
      // ---- 眼神：鼠标离蛋中心 150 以内才跟着看 ----
      await idleCalm();
      const b = win.getBounds();
      const cx = b.x + 120, cy = b.y + 224 - 48; // 蛋中心（站着时）大约在窗口里 (120, 176)
      const cases = [
        ['左边靠近', { x: cx - 110, y: cy - 5 }, (g) => g[0] < -5 && Math.abs(g[1]) < 2, true],
        ['右边靠近', { x: cx + 110, y: cy - 5 }, (g) => g[0] > 5 && Math.abs(g[1]) < 2, true],
        ['正上方靠近', { x: cx, y: cy - 130 }, (g) => g[1] < -5 && Math.abs(g[0]) < 1, true],
        ['左上靠近', { x: cx - 85, y: cy - 90 }, (g) => g[0] < -2 && g[1] < -2, true],
        ['贴着蛋身', { x: cx + 25, y: cy - 30 }, (g) => g[0] > 0 && Math.hypot(...g) <= GAZE_MAX, true],
        ['左边远处（屏幕边）', { x: 0, y: cy }, (g) => Math.hypot(...g) < 0.01, false],
        ['屏幕左上角', { x: 0, y: 0 }, (g) => Math.hypot(...g) < 0.01, false],
        ['离蛋 160（刚出范围）', { x: cx + 160, y: cy }, (g) => Math.hypot(...g) < 0.01, false],
      ];
      for (const [name, p, ok, wantNear] of cases) {
        fakeCursor = p;
        await sleep(450);
        const s = await state();
        const g = s.gaze;
        check(`眼神：${name} → ${wantNear ? '跟着看' : '不跟'}`, s.near === wantNear && ok(g) && Math.hypot(...g) <= GAZE_MAX + 0.01, `近=${s.near} 眼珠偏移 (${g[0].toFixed(1)}, ${g[1].toFixed(1)})`);
        if (name === '左边靠近') await shot('02-gaze-left');
        if (name === '右边靠近') await shot('03-gaze-right');
      }
      // 蛋转了 180° 眼珠依然朝着鼠标（换算到蛋自己的坐标里应该朝"左"）
      fakeCursor = { x: cx + 110, y: cy };
      await js('__pet.S.baseAngle = 180; __pet.render(); 0'); await sleep(300);
      const gr = (await state()).gaze;
      check('蛋转了 180° 眼珠依然朝着鼠标', gr[0] < -5, `本地坐标偏移 (${gr[0].toFixed(1)}, ${gr[1].toFixed(1)})`);
      await js('__pet.S.baseAngle = 0; __pet.render(); 0');
      fakeCursor = { x: 10, y: 10 };
      await sleep(300);
    }

    if (wantGroup('quiet')) {
      // ---- 鼠标靠近就不自己动；点过 5 秒内不自己动 ----
      await idleCalm();
      const center = () => { const b = win.getBounds(); return { x: b.x + 120, y: b.y + 176 }; };
      fakeCursor = { x: 10, y: 10 };
      await sleep(200);
      js(`__pet.trip('normal', { pause: false }); 0`);
      await waitFor(async () => (await state()).mode === 'roll', 3000);
      await sleep(1500);
      const c = center();
      fakeCursor = { x: c.x + 60, y: c.y - 40 };
      await sleep(500);
      const s1 = await state();
      await sleep(1500);
      const s2 = await state();
      check('滚着滚着鼠标靠近 → 马上停下站好', !s2.tripping && s2.mode === 'idle' && Math.abs(s2.x - s1.x) < 1 && Math.abs(s2.angle % 360) < 0.01, `停在 x=${s2.x.toFixed(0)} 角度 ${s2.angle.toFixed(0)}`);

      // 鼠标一直在旁边：打开自发行为也不动
      await js('__pet.autopilot = true; 0');
      const before = await state();
      let moved = false, maxHop = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < 12000) {
        const s = await state();
        if (Math.abs(s.x - before.x) > 1 || s.mode === 'roll') moved = true;
        maxHop = Math.max(maxHop, s.hopY);
        await sleep(200);
      }
      const after = await state();
      check('鼠标在旁边 12 秒：一直不自己动', !moved && maxHop === 0 && JSON.stringify(after.lastAuto) === JSON.stringify(before.lastAuto), `自发动作 ${JSON.stringify(after.lastAuto)}`);

      // 鼠标走开：会恢复自己动
      fakeCursor = { x: 10, y: 10 };
      const resumed = await waitFor(async () => { const s = await state(); return s.lastAuto && (!before.lastAuto || s.lastAuto.at > before.lastAuto.at); }, 15000);
      check('鼠标走开后恢复自己动', resumed, JSON.stringify((await state()).lastAuto));

      // 点一下：之后至少 5 秒不自己动
      await idleCalm();
      await js('__pet.autopilot = true; 0');
      fakeCursor = { x: 10, y: 10 };
      await sleep(200);
      const tClick = await js('__pet.onClick(); Date.now()');
      const acted = await waitFor(async () => { const s = await state(); return s.lastAuto && s.lastAuto.at > tClick; }, 20000);
      const la = (await state()).lastAuto;
      check('点过之后至少 5 秒才再自己动', acted && la.at - tClick >= 5000, `点击后 ${((la.at - tClick) / 1000).toFixed(1)} 秒才动（${la.what}）`);
      await js('__pet.autopilot = false; 0');
    }

    if (wantGroup('roll')) {
      // ---- 4. 滚动花样 + 6. 高光固定 ----
      fakeCursor = { x: 700, y: 200 };
      // 整段行程采样，取 300ms 窗口里的最高速度（有加速减速，不能只看一个时刻）
      const speedOf = async (style, shotName) => {
        await idleCalm();
        await js(`__pet.trip('${style}', { pause: false }); 0`);
        const samples = [];
        const t0 = Date.now();
        let best = { v: 0 }, lastS = null;
        while (Date.now() - t0 < 40000) {
          const s = await state();
          samples.push({ t: Date.now(), x: s.x, s });
          lastS = s;
          const old = samples.find((p) => p.t >= Date.now() - 300 - 60);
          if (s.rollTag !== 'main') { samples.length = 0; } // 只量主段，不算最后回正那一下
          else if (old && samples.length > 3 && Date.now() - old.t > 200) {
            const v = Math.abs(s.x - old.x) / ((Date.now() - old.t) / 1000);
            if (v > best.v) { best = { v, s }; if (shotName) await shot(shotName); }
          }
          if (!s.tripping && Date.now() - t0 > 500) break;
          await sleep(50);
        }
        return { v: best.v, trip: lastS.lastTrip, s: best.s || lastS };
      };
      const creep = await speedOf('creep');
      check('慢慢挪：速度很慢', creep.v > 3 && creep.v < 26, `${creep.v.toFixed(0)} px/s（设定 ${creep.trip.v.toFixed(0)}）`);
      await idleCalm();
      const normal = await speedOf('normal', '04-rolling');
      check('正常滚：中等速度', normal.v > 30 && normal.v < 80, `${normal.v.toFixed(0)} px/s（设定 ${normal.trip.v.toFixed(0)}）`);
      const r = normal.s;
      const rotAngle = +(r.rotT.match(/rotate\(([-\d.]+)/) || [])[1];
      check('滚动时蛋身和脸跟着转', Math.abs(rotAngle % 360) > 5, `rot=${r.rotT}`);
      check('高光层本身不转（只用转动的蛋形裁剪）', r.fixedT.every((t) => t === null) && r.clipT === r.rotT, `fixed=${JSON.stringify(r.fixedT)} clip=${r.clipT}`);
      // 不同角度下：高光都在左上方，并且贴着蛋的边缘
      await idleCalm();
      const hlInfo = (deg) => js(`(() => {
        __pet.S.baseAngle = ${deg}; __pet.render();
        const CX = 50, CY = 74, L = [-0.66, -0.75];
        const pts = document.getElementById('hl').getAttribute('d').slice(1).split(' L').map((t) => t.split(' ').map(Number));
        const body = document.getElementById('body'), len = body.getTotalLength();
        const r = ${deg} * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
        const outline = [];
        for (let i = 0; i < 360; i++) { const p = body.getPointAtLength(i / 360 * len); const x = p.x - CX, y = p.y - CY; outline.push([CX + x * c - y * s, CY + x * s + y * c]); }
        const edge = pts.map(([x, y]) => Math.min(...outline.map(([ox, oy]) => Math.hypot(ox - x, oy - y))));
        const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length - CX, my = pts.reduce((a, p) => a + p[1], 0) / pts.length - CY;
        const dir = (mx * L[0] + my * L[1]) / Math.hypot(mx, my);
        return { dir, minEdge: Math.min(...edge), maxEdge: Math.max(...edge) };
      })()`);
      const angles = [0, 45, 90, 135, 180, 225, 270, 315];
      const infos = [];
      for (const deg of angles) infos.push(await hlInfo(deg));
      check('任何角度：高光都在左上方', infos.every((i) => i.dir > 0.85), infos.map((i, k) => `${angles[k]}°:${i.dir.toFixed(2)}`).join(' '));
      check('任何角度：高光贴着边缘（离边 5~10 点）', infos.every((i) => i.minEdge > 4 && i.maxEdge < 10.5), infos.map((i, k) => `${angles[k]}°:${i.minEdge.toFixed(1)}~${i.maxEdge.toFixed(1)}`).join(' '));
      for (const deg of [0, 90, 180, 270]) { await js(`__pet.S.baseAngle = ${deg}; __pet.render(); 0`); await sleep(120); await shot(`hl-${deg}`); }
      await js('__pet.S.baseAngle = 0; __pet.render(); 0');
      await idleCalm();
      const end = await state();
      check('一段滚完停下时是站正的', Math.abs(end.angle % 360) < 0.01, `角度 ${end.angle.toFixed(1)}`);
      // 冲刺
      const dash = await speedOf('dash', '05-dash');
      check('一下冲很快', dash.v > 150, `${dash.v.toFixed(0)} px/s（设定 ${dash.trip.v.toFixed(0)}）`);
      await idleCalm();
      // 滚到一半停下发呆，再往回滚
      await sleep(300);
      const startX = (await state()).x;
      const track = [];
      js(`__pet.trip('normal', { pause: true, reverse: true }); 0`);
      const t0 = Date.now();
      let sawPause = false;
      while (Date.now() - t0 < 30000) {
        const s = await state();
        track.push(s.x);
        if (s.tripping && s.mode === 'idle') sawPause = true;
        if (!s.tripping && Date.now() - t0 > 1000) break;
        await sleep(150);
      }
      const dirs = [];
      for (let i = 1; i < track.length; i++) {
        const d = Math.sign(Math.round(track[i] - track[i - 1]));
        if (d && dirs[dirs.length - 1] !== d) dirs.push(d);
      }
      check('滚到一半停下发呆、再往回滚', sawPause && dirs.length >= 2, `方向变化 ${JSON.stringify(dirs)}，起点 ${startX.toFixed(0)}`);
      // 原地小跳
      await idleCalm();
      js('__pet.hop(); 0');
      let maxHop = 0;
      for (let i = 0; i < 8; i++) { await sleep(70); const h = (await state()).hopY; if (h > maxHop) { maxHop = h; if (h > 15) await shot('06-hop'); } }
      check('原地小跳', maxHop > 12, `跳了 ${maxHop.toFixed(0)} px`);
    }

    if (wantGroup('face')) {
      // ---- 2. 嘴巴变化 ----
      await idleCalm();
      mouse('mouseMove', 120, 170); await sleep(100);
      mouse('mouseDown', 120, 170); mouse('mouseUp', 120, 170);
      await sleep(250);
      const c = await state();
      await shot('07-click-talk');
      check('单击：冒气泡 + 咕噜声 + 嘴张开', CLICK_LINES.includes(c.bubble) && c.sounds.includes('gulu') && c.mouth === 'open', `"${c.bubble}" 嘴=${c.mouth}`);
      await waitFor(async () => (await state()).bubble === '', 6000);
      await sleep(100);
      check('说完话嘴恢复笑', (await state()).mouth === 'smile');

      await idleCalm();
      menuAction('punch'); await sleep(200);
      const p1 = await state();
      await shot('08-punch');
      check('被揍：往后歪 + > < 眼 + 歪波浪嘴 + 声音', p1.eyes === 'squint' && p1.mouth === 'wavy' && HIT_LINES.includes(p1.bubble) && p1.sounds.includes('punch'), `${p1.eyes}/${p1.mouth}`);
      await sleep(1000);
      const p1b = await state();
      check('挨完揍恢复正常表情', p1b.eyes === 'normal' && p1b.mouth === 'smile', `${p1b.eyes}/${p1b.mouth}`);
      menuAction('punch'); await sleep(700);
      menuAction('punch'); await sleep(1300);
      const k = await state();
      await shot('09-ko');
      check('揍满 3 下 K.O.：侧躺 + 叉叉眼 + 歪波浪嘴 + K.O.', k.ko && k.eyes === 'ko' && k.mouth === 'wavy' && k.koShown && Math.abs(Math.abs(k.angle % 180) - 90) < 0.5, `角度 ${k.angle}° ${k.eyes}/${k.mouth}`);
      const kx = win.getBounds().x;
      await sleep(6000);
      check('倒下后不再自己滚', win.getBounds().x === kx && (await state()).mode === 'ko');
      check('菜单"扶起来"可点', getKo() && menuTemplate().find((i) => i.label === '扶起来').enabled);
      menuAction('getup'); await sleep(1900);
      const g = await state();
      await shot('10-thanks');
      check('扶起来：站正 + 正常眼 + 恢复笑 + 说谢谢', !g.ko && g.eyes === 'normal' && g.mouth === 'smile' && Math.abs(g.angle % 360) < 0.01 && g.bubble === '谢谢 yyq，还是你心软', `${g.eyes}/${g.mouth} "${g.bubble}"`);
    }

    if (wantGroup('cry')) {
      // ---- 3. 揍满 10 次会哭 ----
      await idleCalm();
      getStore().hits = 9;
      menuAction('punch'); await sleep(900);
      const c = await state();
      await sleep(500);
      await shot('11-cry');
      check('今天第 10 下：哭（泪汪汪 + 嘴往下撇 + 皱眉）', c.crying && c.eyes === 'cry' && c.mouth === 'frown' && c.brows === 'sad', `${c.eyes}/${c.mouth}/${c.brows}`);
      check('哭的气泡 + 呜呜声', CRY_LINES.includes(c.bubble) && c.sounds.includes('cry'), `"${c.bubble}"`);
      const tears = await js(`(() => { const t = document.querySelector('.tear'); const cs = getComputedStyle(t); let el = t, vis = true; while (el && el !== document) { if (getComputedStyle(el).display === 'none') vis = false; el = el.parentNode; } return { vis, anim: cs.animationName }; })()`);
      check('眼泪一滴滴往下掉', tears.vis && tears.anim === 'tear', JSON.stringify(tears));
      check('今日计数照旧（10）', getStore().hits === 10, `${getStore().hits}`);
      check('哭的时候"扶起来"可点', menuTemplate().find((i) => i.label === '扶起来').enabled);
      const cx = win.getBounds().x;
      await sleep(2000);
      check('哭的时候不乱滚', win.getBounds().x === cx);
      menuAction('getup'); await sleep(400);
      const u = await state();
      check('扶一下就不哭了，恢复笑', !u.crying && u.eyes === 'normal' && u.mouth === 'smile' && u.bubble === '谢谢 yyq，还是你心软', `${u.eyes}/${u.mouth}`);
      // 第 20 下再哭，这次不管它，看会不会自己好
      await idleCalm();
      getStore().hits = 19;
      menuAction('punch'); await sleep(900);
      check('第 20 下又哭', (await state()).crying);
      const self = await waitFor(async () => !(await state()).crying, 7000);
      const u2 = await state();
      check('过一会儿自己好了', self && u2.eyes === 'normal' && u2.mouth === 'smile', `${u2.eyes}/${u2.mouth}`);
      // K.O. 的同时第 10 下 → 躺着哭
      await idleCalm();
      getStore().hits = 27;
      menuAction('punch'); await sleep(500); menuAction('punch'); await sleep(500); menuAction('punch'); await sleep(1300);
      const kc = await state();
      await shot('12-ko-cry');
      check('K.O. 加第 30 下：躺着哭', kc.ko && kc.crying && kc.eyes === 'cry' && kc.koShown, `${kc.eyes}/${kc.mouth}`);
      menuAction('getup'); await sleep(1900);
      const kg = await state();
      check('扶起来：不哭也站起来了', !kg.ko && !kg.crying && kg.mouth === 'smile');
    }

    if (wantGroup('drag')) {
      // ---- 5. 被抓起来 ----
      await idleCalm();
      const b0 = win.getBounds();
      mouse('mouseMove', 120, 170); await sleep(100);
      mouse('mouseDown', 120, 170);
      mouse('mouseMove', 130, 160, { modifiers: ['leftButtonDown'] });
      fakeCursor = { x: 500 + 120, y: 300 + 170 };
      await sleep(250);
      const angles = [];
      for (let i = 0; i < 6; i++) { angles.push((await state()).liveAngle); await sleep(40); }
      const d = await state();
      await shot('13-drag-scared');
      const b1 = win.getBounds();
      check('能拖着走', b1.x === 500 && b1.y === 300, `${b0.x},${b0.y} → ${b1.x},${b1.y}`);
      check('被抓起来：瞪眼缩眼珠 + 小 o 嘴 + 冒汗眉毛', d.scared && d.eyes === 'scared' && d.mouth === 'o' && d.brows === 'scared', `${d.eyes}/${d.mouth}/${d.brows}`);
      const spread = Math.max(...angles) - Math.min(...angles);
      check('身体轻轻发抖', spread > 1 && spread < 10, `角度抖动范围 ${spread.toFixed(1)}°`);
      mouse('mouseUp', 120, 170);
      await sleep(150);
      const mid = await state();
      check('松手下落中还是害怕', mid.scared && mid.mode === 'fall');
      await waitFor(async () => (await state()).mode !== 'fall', 4000);
      await sleep(200);
      const l = await state();
      check('落地弹一下、恢复正常表情', win.getBounds().y === b0.y && !l.scared && l.eyes === 'normal' && l.mouth === 'smile' && l.sounds.includes('land'), `y=${win.getBounds().y} ${l.eyes}/${l.mouth}`);
    }

    if (wantGroup('misc')) {
      // 之前 Mac 上的崩溃：窗口横坐标四舍五入成 -0
      await idleCalm();
      const before = win.getBounds();
      await js('__pet.S.x = -0.3; __pet.render(); 0'); await sleep(200);
      const nb = win.getBounds();
      check('窗口坐标 -0.3（会变成 -0）不再崩溃', nb.x === 0, `x=${nb.x}`);
      await js(`__pet.S.x = ${before.x}; __pet.render(); 0`); await sleep(100);

      // 点穿
      await idleCalm();
      ignoreLog.length = 0;
      mouse('mouseMove', 120, 170); await sleep(150);
      mouse('mouseMove', 8, 8); await sleep(150);
      check('鼠标在蛋上接管、离开蛋就点穿', ignoreLog.includes(false) && ignoreLog[ignoreLog.length - 1] === true, JSON.stringify(ignoreLog));
      // 静音
      menuAction('mute'); await sleep(100);
      check('菜单显示"取消静音"', menuTemplate().some((i) => i.label === '取消静音'));
      let n = (await state()).sounds.length;
      await js('__pet.onClick()'); await sleep(200);
      const m1 = await state();
      check('静音后不出声（气泡照常）', m1.sounds.length === n && m1.bubble !== '');
      menuAction('mute'); await sleep(100);
      n = m1.sounds.length;
      await js('__pet.onClick()'); await sleep(200);
      check('取消静音后又有声音', (await state()).sounds.length === n + 1);
      // 跨天清零
      getStore().date = '2000-01-01';
      const lbl = menuTemplate().find((i) => /今天挨了/.test(i.label || '')).label;
      check('第二天自动清零', lbl === '今天挨了 0 顿', lbl);
      check('退出菜单项存在', menuTemplate().some((i) => i.label === '退出'));
      // 省电
      await idleCalm();
      fakeCursor = { x: fakeCursor.x + 50, y: fakeCursor.y }; // 动一下鼠标也不该让动画循环一直跑
      await sleep(500);
      const idleNoLoop = await waitFor(async () => js('__pet.S.mode === "idle" && !__pet.S.tripping && !__pet.looping'), 3000);
      check('发呆时动画循环完全停下（省电）', idleNoLoop);
    }

    if (wantGroup('chaos')) {
      // ---- 稳定性：90 秒随机乱点乱揍乱拖，坐标不能坏、不能报错 ----
      await js('__pet.autopilot = true; 0');
      const t0 = Date.now();
      let actions = 0, bad = 0;
      while (Date.now() - t0 < 90000) {
        const r = Math.random();
        if (r < 0.2) await js('__pet.onClick()');
        else if (r < 0.4) menuAction('punch');
        else if (r < 0.5) menuAction('getup');
        else if (r < 0.6) js(`__pet.trip(['creep','normal','dash'][Math.floor(Math.random()*3)]); 0`);
        else if (r < 0.65) js('__pet.hop(); 0');
        else if (r < 0.75) {
          mouse('mouseMove', 120, 160); mouse('mouseDown', 120, 160);
          mouse('mouseMove', 135, 150, { modifiers: ['leftButtonDown'] });
          fakeCursor = { x: Math.floor(Math.random() * 1600) - 80, y: Math.floor(Math.random() * 980) - 40 };
          await sleep(200 + Math.random() * 500);
          mouse('mouseUp', 120, 160);
        } else if (r < 0.8) win.webContents.send('screen-changed');
        else fakeCursor = { x: Math.floor(Math.random() * 1440), y: Math.floor(Math.random() * 900) };
        actions++;
        await sleep(100 + Math.random() * 600);
        const s = await state();
        if (![s.x, s.y, s.angle].every(Number.isFinite)) bad++;
      }
      await sleep(3000);
      const wb = win.getBounds();
      check('乱玩 90 秒：坐标始终正常', bad === 0, `${actions} 个随机动作，异常 ${bad} 次`);
      check('乱玩后还在屏幕里', wb.x > -130 && wb.x < 1440 - 100 && wb.y > -50 && wb.y <= 900 - 230, JSON.stringify(wb));
    }
  } catch (e) {
    console.log('❌ 测试异常', e.stack);
    results.push({ name: 'exception', ok: false });
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n结果：${results.length - failed}/${results.length} 通过`);
  app.exit(failed ? 1 : 0);
};
