// 红蛋桌宠 —— 渲染进程：动作、表情、眼神、声音、交互
(async () => {
  const WIN_W = 240;
  const WIN_H = 230;
  const GROUND = 224;          // 窗口内的"地面"高度
  const CX = 50, CY = 74;      // 蛋在 SVG 里的旋转中心
  const EYE_X = 50, EYE_Y = 70.5; // 两只眼睛的中点（算眼神方向用）
  const GAZE_MAX = 5.5;        // 眼珠最多偏离镜片中心几像素（不出框）
  const NEAR = 150;            // 鼠标离蛋中心多近算"靠近"：靠近才看你，靠近时不自己乱动
  const QUIET_AFTER_CLICK = 5000; // 点过之后至少安静这么久才自己动
  const GRAVITY = 2600;        // 掉落重力 px/s²
  const COMBO_WINDOW = 15000;  // 15 秒内连着揍才算"连续"
  const CRY_EVERY = 10;        // 今天每被揍满 10 下哭一次

  const CLICK_LINES = ['咕噜', '一机做事一机当，好机我也一机当', '蛋在求别踢', '早餐是溏心蛋吗', '蛋蛋好难'];
  const HIT_LINES = ['坏女人也会疼的', '笨笨嘟倒下了', '软饭吐出来了', '今天第几顿了', '我错了我错了'];
  const CRY_LINES = ['呜呜 揍太多了', '呜呜呜……蛋壳要裂了', '再揍要变散黄蛋了 呜'];
  const THANKS = '谢谢 yyq，还是你心软';
  const SHOT_LINES = ['拍好啦', '咔嚓，拍好啦', '拍好啦，在剪贴板里了'];
  const SHOT_CANCEL_LINES = ['不拍了吗', '不拍了吗，那我收起来啦'];

  const $ = (id) => document.getElementById(id);
  const egg = $('egg'), wrap = $('wrap'), bubble = $('bubble'), koText = $('ko'), shadow = $('shadow');
  const rotGroups = [...egg.querySelectorAll('.rot')];
  const clipRot = egg.querySelector('.clip-rot');
  const rand = (a, b) => a + Math.random() * (b - a);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- 蛋的轮廓采样：用来算每个角度下哪一点着地 ----------
  const bodyPath = $('body');
  const PERIM = bodyPath.getTotalLength();
  const outline = [];
  for (let i = 0; i < 72; i++) {
    const p = bodyPath.getPointAtLength((i / 72) * PERIM);
    outline.push([p.x - CX, p.y - CY]);
  }
  function support(deg) {
    const r = (deg * Math.PI) / 180, s = Math.sin(r), c = Math.cos(r);
    let m = -1e9;
    for (const [x, y] of outline) m = Math.max(m, x * s + y * c);
    return m + 1.8; // 描边一半
  }

  // ---------- 高光：贴着蛋轮廓上最朝左上方（光源方向）的那段边 ----------
  const LIGHT = [-0.66, -0.75];            // 光从左上方来
  const HL_INSET = 7.5;                    // 高光离边缘往里缩多少
  const fine = [];                         // 更密的轮廓采样，高光滑动才不会一跳一跳
  for (let i = 0; i < 360; i++) {
    const p = bodyPath.getPointAtLength((i / 360) * PERIM);
    fine.push([p.x - CX, p.y - CY]);
  }
  const hlPath = $('hl'), hlDot = $('hlDot');
  let hlKey = '';
  function updateHighlight(deg) {
    const key = deg.toFixed(1);
    if (key === hlKey) return;
    hlKey = key;
    const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    const n = fine.length;
    const at = (i) => {
      const [x, y] = fine[((i % n) + n) % n];
      const qx = x * c - y * s, qy = x * s + y * c; // 转动后的轮廓点
      const len = Math.hypot(qx, qy), k = (len - HL_INSET) / len;
      return [CX + qx * k, CY + qy * k];
    };
    // 找到最朝向光源的那一点
    let best = 0, bestDot = -1e9;
    for (let i = 0; i < n; i++) {
      const [x, y] = fine[i];
      const d = (x * c - y * s) * LIGHT[0] + (x * s + y * c) * LIGHT[1];
      if (d > bestDot) { bestDot = d; best = i; }
    }
    // 以它为中心画一段弧（约 ±22 个采样点），再在偏上的那头点一个小亮点
    const pts = [];
    for (let i = best - 22; i <= best + 22; i += 3) pts.push(at(i));
    hlPath.setAttribute('d', 'M' + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L'));
    const a = at(best - 36), b = at(best + 36);
    const [dx, dy] = a[1] < b[1] ? a : b;
    hlDot.setAttribute('cx', dx.toFixed(1));
    hlDot.setAttribute('cy', dy.toFixed(1));
  }

  // ---------- 状态 ----------
  const init = await window.pet.init();
  const CRY_MS = init.test ? 4000 : 20000; // 哭一会儿自己好
  const S = {
    mode: 'idle',           // idle | roll | drag | fall | ko
    x: init.bounds.x, y: init.bounds.y,
    baseAngle: 0,
    dir: Math.random() < 0.5 ? -1 : 1,
    ko: false, crying: false, scared: false,
    tripping: false,
    streak: 0, lastHit: 0,
    muted: init.muted,
    roll: null, fall: null,
  };
  let wa = await window.pet.workArea(S.x, S.y);
  const groundY = () => wa.y + wa.height - WIN_H;
  const minX = () => wa.x + 62 - WIN_W / 2;
  const maxX = () => wa.x + wa.width - 62 - WIN_W / 2;
  const room = (dir) => Math.max(0, dir > 0 ? maxX() - S.x : S.x - minX());

  // ---------- 补间动画（只在需要时跑） ----------
  const tweens = new Set();
  function tween(dur, apply, done) {
    const t = { t0: performance.now(), dur, apply, done };
    tweens.add(t);
    wake();
    return t;
  }
  const ease = {
    out: (t) => 1 - Math.pow(1 - t, 3),
    inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    sine: (t) => 0.5 - Math.cos(t * Math.PI) / 2,
  };
  let squash = 1;                                  // 落地压扁
  const offsets = { wobble: 0, hit: 0, shake: 0 }; // 叠加在滚动角度上的晃动
  let hopY = 0;                                    // 原地小跳的高度

  function wobble(amp, dur = 900) {
    tween(dur, (t) => { offsets.wobble = amp * Math.sin(t * Math.PI * 5) * (1 - t); },
      () => { offsets.wobble = 0; });
  }
  function hitTilt() {
    const back = -S.dir * 24;
    tween(750, (t) => {
      offsets.hit = t < 0.12 ? back * ease.out(t / 0.12)
        : back * Math.cos(((t - 0.12) / 0.88) * Math.PI * 1.5) * (1 - (t - 0.12) / 0.88);
    }, () => { offsets.hit = 0; });
  }
  function squashOnce(amount) {
    tween(320, (t) => { squash = 1 - amount * Math.sin(t * Math.PI) * (1 - t * 0.5); }, () => { squash = 1; });
  }

  // ---------- 主循环：没事干时完全停下省电 ----------
  let raf = 0, last = 0, inTick = false, lastMoveX = NaN, lastMoveY = NaN;
  function wake() {
    // 正在一帧里面时不另起循环，帧末尾会自己决定要不要继续，保证永远只有一个循环
    if (!raf && !inTick) { last = performance.now(); raf = requestAnimationFrame(tick); }
  }
  function tick(now) {
    raf = 0;
    inTick = true;
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
    last = now;

    if (S.mode === 'roll') stepRoll(now);
    else if (S.mode === 'fall') stepFall(dt);
    // 被抓着时轻轻发抖
    offsets.shake = dragging ? 2.6 * Math.sin(now * 0.075) + 1.2 * Math.sin(now * 0.19) : 0;

    for (const t of [...tweens]) {
      const p = Math.max(0, Math.min(1, (now - t.t0) / t.dur));
      t.apply(p);
      if (p >= 1) { tweens.delete(t); t.done && t.done(); }
    }
    render();

    inTick = false;
    if (S.mode === 'roll' || S.mode === 'fall' || dragging || tweens.size) raf = requestAnimationFrame(tick);
  }

  // 保险：坐标万一变成非法数字，记下现场并让蛋回到屏幕底部中间
  function recoverIfBroken() {
    if (Number.isFinite(S.x) && Number.isFinite(S.y) && Number.isFinite(S.baseAngle)) return;
    window.pet.log('坐标异常，已复位：' + JSON.stringify({ mode: S.mode, x: String(S.x), y: String(S.y), angle: String(S.baseAngle), wa, roll: S.roll, fall: S.fall }));
    S.roll = null; S.fall = null;
    if (S.mode === 'roll' || S.mode === 'fall') S.mode = S.ko ? 'ko' : 'idle';
    S.baseAngle = S.ko ? 90 : 0;
    S.x = wa.x + wa.width / 2 - WIN_W / 2;
    S.y = groundY();
  }

  let curAngle = 0, curTy = 0;
  function render() {
    recoverIfBroken();
    const a = S.baseAngle + offsets.wobble + offsets.hit + offsets.shake;
    curAngle = a;
    curTy = GROUND - support(a) - CY - hopY;
    egg.style.transform = `translate(${WIN_W / 2 - CX}px, ${curTy}px)`;
    // 蛋身和脸转；高光和暗面不转，只用转动后的蛋形裁剪
    const rot = `rotate(${a.toFixed(2)} ${CX} ${CY})`;
    for (const g of rotGroups) g.setAttribute('transform', rot);
    clipRot.setAttribute('transform', rot);
    updateHighlight(a);
    wrap.style.transform = squash === 1 ? '' : `scale(${2 - squash}, ${squash})`;
    if (S.mode !== 'drag' && (S.x !== lastMoveX || S.y !== lastMoveY)) {
      window.pet.move(S.x, S.y);
      lastMoveX = S.x; lastMoveY = S.y;
    }
    shadow.classList.toggle('air', S.mode === 'drag' || hopY > 3 || (S.mode === 'fall' && S.y < groundY() - 4));
    shadow.classList.toggle('wide', S.ko);
    updateGaze();
  }

  // ---------- 表情：眼睛 / 嘴 / 眉毛，按优先级决定 ----------
  let hitUntil = 0, talkUntil = 0, winkUntil = 0, faceTimer = 0;
  function setVariant(group, name) {
    for (const el of $(group).children) {
      el.style.display = (el.dataset.v || '').split(' ').includes(name) ? '' : 'none';
    }
  }
  function face() {
    const now = Date.now();
    let eyes = 'normal', mouth = 'smile', brows = 'none';
    if (S.scared) { eyes = 'scared'; mouth = 'o'; brows = 'scared'; }
    else if (S.crying) { eyes = 'cry'; mouth = 'frown'; brows = 'sad'; }
    else if (S.ko) { eyes = 'ko'; mouth = 'wavy'; }
    else if (now < hitUntil) { eyes = 'squint'; mouth = 'wavy'; }
    else if (now < winkUntil) { eyes = 'wink'; }
    else if (now < talkUntil) { mouth = 'open'; }
    if (egg.dataset.eyes !== eyes) { setVariant('eyes', eyes); egg.dataset.eyes = eyes; }
    if (egg.dataset.mouth !== mouth) { setVariant('mouth', mouth); egg.dataset.mouth = mouth; }
    if (egg.dataset.brows !== brows) { setVariant('brows', brows); egg.dataset.brows = brows; }
    // 到点自动切回下一个表情
    clearTimeout(faceTimer);
    const next = [hitUntil, talkUntil, winkUntil].filter((t) => t > now);
    if (next.length) faceTimer = setTimeout(face, Math.min(...next) - now + 10);
  }

  // ---------- 眼神：鼠标靠近（NEAR 以内）才跟着看；靠近时蛋也不自己乱动 ----------
  let cursor = null, near = false, idleLook = [0, 0], gazeKey = '';
  function eggWindowPos() {
    // 拖拽时窗口由主进程移动，用它报来的窗口位置；平时用自己算的位置（更及时）
    return dragging && cursor ? [cursor.wx, cursor.wy] : [S.x, S.y];
  }
  function updateNear() {
    if (!cursor) return;
    const [wx, wy] = eggWindowPos();
    const was = near;
    near = Math.hypot(cursor.x - (wx + WIN_W / 2), cursor.y - (wy + curTy + CY)) < NEAR;
    if (near && !was) onNear();
  }
  // 鼠标一靠近：正在滚就停下站好
  function onNear() {
    if (S.tripping || S.mode === 'roll') {
      cancelTrip();
      if (!S.ko) settleUpright();
    }
  }
  function updateGaze() {
    updateNear();
    let gx = idleLook[0], gy = idleLook[1];
    if (cursor && near) {
      // 眼睛在屏幕上的位置（考虑蛋当前的旋转）
      const r = (curAngle * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
      const lx = EYE_X - CX, ly = EYE_Y - CY;
      const [wx, wy] = eggWindowPos();
      const ex = wx + WIN_W / 2 + lx * c - ly * s;
      const ey = wy + curTy + CY + lx * s + ly * c;
      const vx = cursor.x - ex, vy = cursor.y - ey;
      // 转回蛋自己的坐标系，这样蛋转着的时候眼珠也朝对方向
      const ux = vx * c + vy * s, uy = -vx * s + vy * c;
      const d = Math.hypot(ux, uy);
      if (d > 0.5) {
        const k = (GAZE_MAX * Math.min(1, d / 70)) / d;
        gx = ux * k; gy = uy * k;
      } else { gx = 0; gy = 0; }
    }
    const key = `${gx.toFixed(1)},${gy.toFixed(1)}`;
    if (key === gazeKey) return;
    gazeKey = key;
    $('pupils').style.transform = `translate(${gx.toFixed(2)}px, ${gy.toFixed(2)}px)`;
  }
  window.pet.onCursor((c) => {
    cursor = c;
    updateGaze();
  });

  // ---------- 滚动：一段段"小行程"，速度距离随机，停下时顺势回到站正 ----------
  let tripToken = 0, rollResolve = null;
  function rollBy(dx, dur, easeFn = ease.sine, tag = 'main') {
    return new Promise((resolve) => {
      if (!Number.isFinite(dx) || Math.abs(dx) < 0.5) return resolve(true);
      S.dir = Math.sign(dx);
      S.roll = { startX: S.x, startAngle: S.baseAngle, dx, dur: Math.max(120, dur), t0: performance.now(), ease: easeFn, tag };
      S.mode = 'roll';
      rollResolve = resolve;
      wake();
    });
  }
  function stepRoll(now) {
    const r = S.roll;
    const p = Math.max(0, Math.min(1, (now - r.t0) / r.dur));
    const e = r.ease(p);
    S.x = r.startX + r.dx * e;
    S.baseAngle = r.startAngle + (r.dx * e / PERIM) * 360;
    if (p >= 1) finishRoll(true);
  }
  function finishRoll(ok) {
    S.roll = null;
    if (S.mode === 'roll') S.mode = 'idle';
    const res = rollResolve;
    rollResolve = null;
    if (res) res(ok);
  }
  function stopRoll() {
    if (S.roll) finishRoll(false);
  }
  function cancelTrip() {
    tripToken++;
    S.tripping = false;
    stopRoll();
  }
  // 停下时往前或往回滚一点点，回到站正（不会滚出屏幕）
  async function settle(bigWobble, speed = 45) {
    const a = S.baseAngle;
    const k = Math.floor(a / 360);
    const options = [k * 360, (k + 1) * 360].sort((p, q) => Math.abs(p - a) - Math.abs(q - a));
    let target = options.find((t) => {
      const nx = S.x + ((t - a) / 360) * PERIM;
      return nx >= minX() - 1 && nx <= maxX() + 1;
    });
    if (target === undefined) target = options[0];
    const diff = target - a;
    if (Math.abs(diff) < 0.5) { S.baseAngle = target; return true; }
    // 回正的速度跟这一趟差不多（慢慢挪的蛋不会突然猛转），但最慢也要像在"倒回去"
    const dx = (diff / 360) * PERIM;
    const v = Math.max(28, Math.min(speed, 90));
    const ok = await rollBy(dx, 250 + (Math.abs(dx) / v) * 1000 * 1.2, ease.sine, 'settle');
    if (ok) {
      S.baseAngle = target;
      wobble(bigWobble ? 10 : 4, bigWobble ? 1000 : 600);
    }
    return ok;
  }

  const STYLES = {
    creep:  { v: [10, 18],   d: [40, 130],  w: 0.25 }, // 慢慢挪
    normal: { v: [32, 55],   d: [140, 460], w: 0.5 },  // 正常滚
    dash:   { v: [180, 280], d: [260, 640], w: 0.25 }, // 一下冲很快
  };
  function pickStyle() {
    let r = Math.random();
    for (const [name, s] of Object.entries(STYLES)) { if ((r -= s.w) < 0) return name; }
    return 'normal';
  }
  async function trip(style = pickStyle(), opt = {}) {
    const my = ++tripToken;
    S.tripping = true;
    const alive = () => my === tripToken && !S.ko && !S.crying && !dragging && !near;
    try {
      const cfg = STYLES[style];
      const v = rand(...cfg.v);
      let dist = rand(...cfg.d);
      let dir = Math.random() < 0.5 ? -1 : 1;
      if (room(dir) < Math.min(dist, 60)) dir = -dir;
      dist = Math.min(dist, room(dir));
      if (dist < 25) return;
      // 正弦加减速：最高速度约是平均速度的 1.6 倍，所以时长放宽一点，让最高速度接近设定值
      const dur = (d) => (d / v) * 1000 * 1.25;
      S.lastTrip = { style, v, dist, dir };

      if ((opt.pause ?? Math.random() < 0.3) && dist > 110) {
        // 滚到一半停下来发呆……
        const d1 = dist * rand(0.35, 0.6);
        if (!(await rollBy(dir * d1, dur(d1))) || !alive()) return;
        if (!(await settle(false, v)) || !alive()) return;
        daydream();
        await wait(rand(1200, 3200));
        if (!alive()) return;
        // ……然后接着滚，或者往回滚
        const back = opt.reverse ?? Math.random() < 0.5;
        if (back) dir = -dir;
        const d2 = Math.min(back ? rand(60, 260) : dist - d1, room(dir));
        if (d2 > 20 && (!(await rollBy(dir * d2, dur(d2))) || !alive())) return;
      } else if (!(await rollBy(dir * dist, dur(dist))) || !alive()) {
        return;
      }
      await settle(style === 'dash', v);
    } finally {
      if (my === tripToken) S.tripping = false;
      // 不管是走完还是被打断（鼠标靠近、被点、被拖），都要排好下一次
      if (!S.ko && !S.crying) scheduleNext();
    }
  }

  // 原地小跳一下
  function hop() {
    tween(700, (t) => {
      if (t < 0.18) { squash = 1 - 0.1 * Math.sin((t / 0.18) * Math.PI); hopY = 0; }      // 蓄力
      else if (t < 0.82) { squash = 1; hopY = 20 * Math.sin(((t - 0.18) / 0.64) * Math.PI); } // 腾空
      else { hopY = 0; squash = 1 - 0.09 * Math.sin(((t - 0.82) / 0.18) * Math.PI); }      // 落地
    }, () => { hopY = 0; squash = 1; sound.land(); });
  }

  // ---------- 掉落 + 落地弹一下 ----------
  function startFall() {
    S.fall = { vy: 0, bounced: false };
    S.mode = 'fall';
    wake();
  }
  function stepFall(dt) {
    const f = S.fall, g = groundY();
    f.vy += GRAVITY * dt;
    S.y += f.vy * dt;
    if (S.y >= g) {
      S.y = g;
      if (!f.bounced && f.vy > 150) {
        f.bounced = true;
        squashOnce(0.16);
        sound.land();
        f.vy = -Math.max(160, Math.min(f.vy * 0.3, 520));
      } else {
        if (!f.bounced) { squashOnce(0.08); sound.land(); }
        S.fall = null;
        S.mode = S.ko ? 'ko' : 'idle';
        S.scared = false; // 落地了，不怕了
        face();
        if (!S.ko && !S.crying) scheduleNext(1500);
      }
    }
  }

  // ---------- 平时：发呆、眨眼、小跳、晃一晃、出门滚一段 ----------
  let behaviorTimer = 0, autopilot = true, lastClickAt = 0; // autopilot 只给自动测试用来暂停自发行为
  function scheduleNext(delay) {
    clearTimeout(behaviorTimer);
    if (S.ko || S.crying) return;
    behaviorTimer = setTimeout(() => {
      if (S.ko || S.crying) return; // 扶起来 / 哭完会重新开始
      // 暂时不方便动（正在滚、被拖着、自动测试暂停）：过一会儿再看，不要让这条"心跳"断掉
      if (S.mode !== 'idle' || S.tripping || dragging || !autopilot) { scheduleNext(); return; }
      const quiet = Math.max(near ? 1500 : 0, lastClickAt + QUIET_AFTER_CLICK - Date.now());
      if (quiet > 0) { scheduleNext(quiet + rand(300, 1500)); return; } // 鼠标在旁边 / 刚点过：先别动
      const r = Math.random();
      const what = r < 0.62 ? 'trip' : r < 0.74 ? 'hop' : r < 0.82 ? 'wobble' : 'daydream';
      S.lastAuto = { what, at: Date.now() }; // 记下最近一次"自己动"（测试用）
      if (what === 'trip') { trip(); return; }
      if (what === 'hop') hop();
      else if (what === 'wobble') wobble(9, 1000);
      else daydream();
      scheduleNext();
    }, delay ?? rand(2500, 7500));
  }
  function daydream() {
    const spots = [[-4, -3], [4, -3], [0, -4.5], [-4, 2], [4, 2]];
    idleLook = spots[Math.floor(Math.random() * spots.length)];
    updateGaze();
    setTimeout(() => { idleLook = [0, 0]; updateGaze(); }, rand(1600, 3000));
  }
  function scheduleBlink() {
    setTimeout(() => {
      if (egg.dataset.eyes === 'normal') {
        egg.classList.add('blink');
        setTimeout(() => egg.classList.remove('blink'), 130);
        if (Math.random() < 0.2) setTimeout(() => { egg.classList.add('blink'); setTimeout(() => egg.classList.remove('blink'), 120); }, 280);
      }
      scheduleBlink();
    }, rand(2500, 6500));
  }

  // ---------- 气泡 ----------
  let bubbleTimer = 0, lastLine = '';
  function say(text, { talk = false } = {}) {
    const ms = 1600 + text.length * 110;
    // 长句在逗号处换行，不要剩一个字孤零零掉到第二行
    // 已经自己分好行的（比如权限提示）就照原样
    const long = text.length > 13 || text.includes('\n');
    bubble.textContent = long && !text.includes('\n') ? text.replace(/([，,])/, '$1\n') : text;
    bubble.classList.toggle('long', long);
    bubble.classList.add('show');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.remove('show'), ms);
    if (talk) { talkUntil = Date.now() + ms; face(); }
  }
  function pick(list) {
    let s;
    do { s = list[Math.floor(Math.random() * list.length)]; } while (list.length > 1 && s === lastLine);
    lastLine = s;
    return s;
  }

  // ---------- 声音：全部用 Web Audio 现场合成 ----------
  const sound = (() => {
    let ctx = null, idleTimer = 0;
    const log = (window.__soundLog = []);
    function ac() {
      if (!ctx) ctx = new AudioContext();
      if (ctx.state === 'suspended') ctx.resume();
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ctx && ctx.suspend(), 3000); // 不响的时候把音频线程停掉省电
      return ctx;
    }
    function tone(c, { type = 'sine', f0, f1, at = 0, dur, vol, lp, vib }) {
      const t = c.currentTime + at;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      if (vib) { // 颤音（哭腔）
        const l = c.createOscillator(), lg = c.createGain();
        l.frequency.value = vib.rate; lg.gain.value = vib.depth;
        l.connect(lg).connect(o.frequency);
        l.start(t); l.stop(t + dur + 0.02);
      }
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      let node = o;
      if (lp) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; o.connect(f); node = f; }
      node.connect(g).connect(c.destination);
      o.start(t); o.stop(t + dur + 0.02);
    }
    function noise(c, { at = 0, dur, vol, lp }) {
      const t = c.currentTime + at;
      const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
      const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
      src.buffer = buf; f.type = 'lowpass'; f.frequency.value = lp; g.gain.value = vol;
      src.connect(f).connect(g).connect(c.destination);
      src.start(t);
    }
    const play = (name, fn) => () => {
      if (S.muted) return;
      log.push(name);
      fn(ac());
    };
    return {
      // 咕噜：两三个低低的小泡泡
      gulu: play('gulu', (c) => {
        const n = 2 + (Math.random() < 0.5 ? 1 : 0);
        for (let i = 0; i < n; i++) {
          const f = 230 + Math.random() * 70;
          tone(c, { f0: f, f1: f * 0.55, at: i * 0.11, dur: 0.1, vol: 0.07, lp: 900 });
        }
      }),
      punch: play('punch', (c) => {
        noise(c, { dur: 0.12, vol: 0.28, lp: 1100 });
        tone(c, { f0: 150, f1: 48, dur: 0.2, vol: 0.32 });
      }),
      ko: play('ko', (c) => {
        tone(c, { type: 'triangle', f0: 560, f1: 120, dur: 0.7, vol: 0.09 });
        tone(c, { f0: 90, f1: 40, at: 0.35, dur: 0.3, vol: 0.3 });
        [0, 0.12, 0.24].forEach((at, i) => tone(c, { f0: 1500 + i * 250, at: 0.75 + at, dur: 0.09, vol: 0.03 }));
      }),
      getup: play('getup', (c) => {
        [523, 659, 784].forEach((f, i) => tone(c, { f0: f, at: i * 0.12, dur: 0.22, vol: 0.05 }));
      }),
      land: play('land', (c) => tone(c, { f0: 120, f1: 60, dur: 0.12, vol: 0.12, lp: 600 })),
      // 呜呜：两声往下掉的颤音
      cry: play('cry', (c) => {
        tone(c, { type: 'triangle', f0: 460, f1: 340, dur: 0.5, vol: 0.06, lp: 1400, vib: { rate: 7, depth: 14 } });
        tone(c, { type: 'triangle', f0: 430, f1: 300, at: 0.6, dur: 0.65, vol: 0.06, lp: 1400, vib: { rate: 7, depth: 16 } });
      }),
      // 被抓起来：短促的一声"咿"
      eek: play('eek', (c) => tone(c, { f0: 700, f1: 1100, dur: 0.14, vol: 0.04, lp: 2500 })),
      // 举起相机：往上扬的一声"啵"
      camUp: play('camUp', (c) => tone(c, { f0: 480, f1: 900, dur: 0.12, vol: 0.045, lp: 2600 })),
      // 快门：清脆的"咔"，紧跟一声轻一点的"嚓"
      shutter: play('shutter', (c) => {
        noise(c, { dur: 0.035, vol: 0.4, lp: 7500 });
        tone(c, { type: 'square', f0: 2400, f1: 1500, dur: 0.035, vol: 0.025, lp: 6000 });
        noise(c, { at: 0.075, dur: 0.06, vol: 0.28, lp: 4200 });
        tone(c, { f0: 1800, at: 0.2, dur: 0.06, vol: 0.02 });
      }),
    };
  })();

  // ---------- 单击 / 揍 / K.O. / 哭 / 扶起来 ----------
  const needHelp = () => window.pet.koState(S.ko || S.crying);

  function onClick() {
    lastClickAt = Date.now();
    window.pet.note('click');
    if (S.tripping || S.mode === 'roll') { cancelTrip(); if (!S.ko) settleUpright(); }
    if (S.ko || S.crying) { wobble(3, 400); return; }
    wobble(12);
    sound.gulu();
    say(pick(CLICK_LINES), { talk: true });
  }

  function punch(hitsToday) {
    const now = Date.now();
    S.streak = now - S.lastHit < COMBO_WINDOW ? S.streak + 1 : 1;
    S.lastHit = now;
    sound.punch();
    say(pick(HIT_LINES));
    talkUntil = 0;
    const cry = hitsToday > 0 && hitsToday % CRY_EVERY === 0;
    if (S.ko) wobble(4, 450);
    else if (S.streak >= 3) knockOut();
    else {
      cancelTrip();
      settleUpright();
      hitTilt();
      hitUntil = now + 900;
      face();
      if (!cry) scheduleNext(2500);
    }
    if (cry) setTimeout(startCry, 500);
  }

  // 滚到一半被打断时，顺势转回站正
  function settleUpright() {
    const from = S.baseAngle, to = Math.round(from / 360) * 360;
    if (from === to) return;
    tween(300, (t) => { if (!S.ko) S.baseAngle = from + (to - from) * ease.out(t); },
      () => { if (!S.ko) S.baseAngle = to; });
  }

  function knockOut() {
    S.ko = true;
    window.pet.note('ko');
    needHelp();
    clearTimeout(behaviorTimer);
    cancelTrip();
    if (S.mode !== 'fall' && S.mode !== 'drag') S.mode = 'ko';
    egg.classList.remove('blink');
    face();
    idleLook = [0, 0];
    const from = S.baseAngle;
    const side = -S.dir; // 往后倒
    const to = Math.round((from - side * 90) / 360) * 360 + side * 90;
    tween(480, (t) => {
      // 倒地带一点点回弹
      const p = t < 0.75 ? ease.out(t / 0.75) * 1.06 : 1.06 - 0.06 * ((t - 0.75) / 0.25);
      S.baseAngle = from + (to - from) * p;
    }, () => {
      S.baseAngle = to;
      squashOnce(0.08);
      if (S.ko) koText.classList.add('show');
    });
    sound.ko();
  }

  let cryTimer = 0;
  function startCry() {
    if (S.crying) return;
    S.crying = true;
    window.pet.note('cry');
    needHelp();
    clearTimeout(behaviorTimer);
    cancelTrip();
    if (!S.ko) settleUpright();
    face();
    sound.cry();
    say(pick(CRY_LINES));
    clearTimeout(cryTimer);
    cryTimer = setTimeout(() => stopCry(), CRY_MS); // 哭一会儿自己好
  }
  function stopCry() {
    if (!S.crying) return;
    clearTimeout(cryTimer);
    S.crying = false;
    needHelp();
    face();
    if (!S.ko && S.mode === 'idle') scheduleNext(3000);
  }

  function getUp() {
    if (S.ko) {
      koText.classList.remove('show');
      const from = S.baseAngle;
      const to = Math.round(from / 360) * 360;
      tween(1400, (t) => { S.baseAngle = from + (to - from) * ease.inOut(t); }, () => {
        S.baseAngle = to;
        S.ko = false;
        S.streak = 0;
        stopCry();
        needHelp();
        if (S.mode === 'ko') S.mode = 'idle';
        thanks();
      });
    } else if (S.crying) {
      // 只是在哭：摸摸头就好了
      stopCry();
      thanks();
    }
  }
  function thanks() {
    window.pet.note('getup');
    face();
    wobble(6, 600);
    sound.getup();
    say(THANKS);
    scheduleNext(3500);
  }

  // ---------- 鼠标：点穿 / 单击 / 拖拽 / 右键 ----------
  let hovering = false, down = null, dragging = false;
  const overEgg = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return !!(el && el.closest && el.closest('#egg .rot'));
  };
  function setHover(v) {
    if (v === hovering) return;
    hovering = v;
    window.pet.setIgnore(!v);
  }
  document.addEventListener('mousemove', (e) => {
    // 保险：万一漏掉了松手事件，发现按键已松开就结束拖拽（自动测试里模拟的按键没有系统状态，跳过）
    if (dragging) { if (e.buttons === 0 && !init.test) endDrag(); return; }
    if (down) {
      if (Math.hypot(e.screenX - down.sx, e.screenY - down.sy) > 4) beginDrag();
      return;
    }
    setHover(overEgg(e.clientX, e.clientY));
  });
  document.addEventListener('mouseleave', () => { if (!down && !dragging) setHover(false); });
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !overEgg(e.clientX, e.clientY)) return;
    down = { sx: e.screenX, sy: e.screenY, cx: e.clientX, cy: e.clientY };
  });
  document.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;
    if (dragging) endDrag();
    else if (down) onClick();
    down = null;
  });
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (overEgg(e.clientX, e.clientY)) window.pet.menu();
  });

  function beginDrag() {
    if (!down) return;
    dragging = true;
    clearTimeout(behaviorTimer);
    cancelTrip();
    if (S.mode === 'fall') S.fall = null;
    S.mode = 'drag';
    if (!S.ko) settleUpright();
    hopY = 0;
    S.scared = true; // 被抓起来：害怕
    window.pet.note('drag');
    face();
    sound.eek();
    window.pet.dragStart(down.cx, down.cy);
    wake();
  }
  async function endDrag() {
    if (!dragging) return;
    dragging = false;
    down = null;
    offsets.shake = 0;
    const b = await window.pet.dragEnd();
    if (b && Number.isFinite(b.x) && Number.isFinite(b.y)) { S.x = b.x; S.y = b.y; }
    lastMoveX = S.x; lastMoveY = S.y;
    wa = await window.pet.workArea(S.x, S.y);
    S.x = Math.max(minX(), Math.min(maxX(), S.x));
    if (S.y > groundY()) S.y = groundY();
    startFall(); // 落地时 stepFall 里恢复正常表情
  }

  // ---------- 截图：举起小相机，眯一只眼，咔嚓 ----------
  const cam = $('camera');
  let cameraBusy = false, camDownTimer = 0;
  async function camera() {
    if (cameraBusy) return;
    cameraBusy = true;
    lastClickAt = Date.now();
    clearTimeout(behaviorTimer);
    clearTimeout(camDownTimer);
    if (S.tripping || S.mode === 'roll') cancelTrip();
    if (!S.ko) settleUpright();
    idleLook = [0, 0];
    cam.classList.add('up');
    sound.camUp();
    wobble(4, 400);
    await wait(480);
    // 咔嚓：闪光灯一亮，屏幕边缘闪白光，眼睛眯一下，身子轻轻一震
    cam.classList.add('flash');
    sound.shutter();
    window.pet.flash();
    winkUntil = Date.now() + 420;
    face();
    squashOnce(0.05);
    await wait(520);
    cam.classList.remove('flash');
    window.pet.cameraReady(); // 主进程这时把红蛋藏起来，开始截图
  }
  function shotDone(r) {
    cameraBusy = false;
    r = r || {};
    clearTimeout(camDownTimer);
    camDownTimer = setTimeout(() => cam.classList.remove('up'), r.ok ? 1100 : 350);
    lastClickAt = Date.now();
    if (r.ok) { wobble(8, 700); sound.gulu(); say(pick(SHOT_LINES), { talk: true }); }
    else if (r.cancelled) say(pick(SHOT_CANCEL_LINES), { talk: true });
    else if (r.error) say(r.error);
    if (!S.ko && !S.crying) scheduleNext(4000);
  }

  // ---------- 来自主进程 ----------
  window.pet.onAction((a, arg) => {
    if (a === 'punch') punch(arg);
    else if (a === 'getup') getUp();
    else if (a === 'camera') camera();
  });
  window.pet.onShotDone((r) => shotDone(r));
  // 主进程要红蛋说一句完整的话（比如提醒开权限、小克回信了）
  window.pet.onSay((text) => {
    const t = String(text || '').trim();
    if (!t) return;
    lastClickAt = Date.now();
    if (!S.ko && !S.crying) wobble(6, 600);
    say(t, { talk: !S.ko && !S.crying });
  });
  window.pet.onMuted((m) => { S.muted = m; });
  // 聊天窗口里红蛋回话了：蛋头上也冒个气泡、张嘴说话（太长的只冒开头，全文在聊天窗口里）
  window.pet.onTalk((text) => {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    const short = t.length > 26 ? t.slice(0, 25) + '…' : t;
    lastClickAt = Date.now();
    if (S.ko || S.crying) { wobble(3, 400); say(short); return; }
    if (S.tripping || S.mode === 'roll') { cancelTrip(); settleUpright(); }
    wobble(8, 700);
    sound.gulu();
    say(short, { talk: true });
  });
  window.pet.onScreenChanged(async () => {
    if (dragging) return;
    wa = await window.pet.workArea(S.x, S.y);
    cancelTrip();
    S.x = Math.max(minX(), Math.min(maxX(), S.x));
    if (S.mode !== 'fall') S.y = groundY();
    if (!S.ko) S.baseAngle = Math.round(S.baseAngle / 360) * 360;
    render();
    if (!S.ko && !S.crying) scheduleNext();
  });

  window.addEventListener('error', (e) => window.pet.log('页面错误：' + (e.error && e.error.stack || e.message)));
  window.addEventListener('unhandledrejection', (e) => window.pet.log('页面错误：' + (e.reason && e.reason.stack || e.reason)));

  // 测试用：让自动化测试读取内部状态、直接触发某个动作
  window.__pet = {
    S, onClick, punch, getUp, say, overEgg, trip, hop, startCry, render, cancelTrip, camera,
    set autopilot(v) { autopilot = v; },
    get dragging() { return dragging; }, get looping() { return !!raf; },
    get angle() { return curAngle; }, get hopY() { return hopY; }, get near() { return near; },
  };

  // ---------- 开始 ----------
  S.x = Math.max(minX(), Math.min(maxX(), S.x));
  S.y = groundY();
  face();
  render();
  scheduleBlink();
  scheduleNext(2000);
})();
