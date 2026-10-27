// 红蛋桌宠 —— 渲染进程：动作、声音、交互
(async () => {
  const WIN_W = 240;
  const WIN_H = 230;
  const GROUND = 224;          // 窗口内的"地面"高度
  const CX = 50, CY = 74;      // 蛋在 SVG 里的旋转中心
  const ROLL_SPEED = 42;       // 滚动速度 px/s
  const GRAVITY = 2600;        // 掉落重力 px/s²
  const COMBO_WINDOW = 15000;  // 15 秒内连着揍才算"连续"

  const CLICK_LINES = ['咕噜', '一机做事一机当，好机我也一机当', '蛋在求别踢', '早餐是溏心蛋吗', '蛋蛋好难'];
  const HIT_LINES = ['坏女人也会疼的', '笨笨嘟倒下了', '软饭吐出来了', '今天第几顿了', '我错了我错了'];
  const THANKS = '谢谢 yyq，还是你心软';

  const $ = (id) => document.getElementById(id);
  const egg = $('egg'), wrap = $('wrap'), bubble = $('bubble'), koText = $('ko'), shadow = $('shadow');

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

  // ---------- 状态 ----------
  const init = await window.pet.init();
  const S = {
    mode: 'idle',           // idle | roll | drag | fall | ko
    x: init.bounds.x, y: init.bounds.y,
    baseAngle: 0,
    dir: Math.random() < 0.5 ? -1 : 1,
    ko: false,
    streak: 0, lastHit: 0,
    muted: init.muted,
    roll: null, fall: null,
  };
  let wa = await window.pet.workArea(S.x, S.y);
  const groundY = () => wa.y + wa.height - WIN_H;
  const minX = () => wa.x + 62 - WIN_W / 2;
  const maxX = () => wa.x + wa.width - 62 - WIN_W / 2;

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
  };
  let angleOffset = 0;   // 晃动 / 被揍歪的叠加角度
  let squash = 1;        // 落地压扁
  const offsets = { wobble: 0, hit: 0 };

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
  let raf = 0, last = 0, lastMoveX = NaN, lastMoveY = NaN;
  function wake() {
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); }
  }
  function tick(now) {
    raf = 0;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (S.mode === 'roll') stepRoll(dt);
    else if (S.mode === 'fall') stepFall(dt);

    for (const t of [...tweens]) {
      const p = Math.min(1, (now - t.t0) / t.dur);
      t.apply(p);
      if (p >= 1) { tweens.delete(t); t.done && t.done(); }
    }
    render();

    if (S.mode === 'roll' || S.mode === 'fall' || tweens.size) raf = requestAnimationFrame(tick);
  }

  function render() {
    angleOffset = offsets.wobble + offsets.hit;
    const a = S.baseAngle + angleOffset;
    const ty = GROUND - support(a) - CY;
    egg.style.transform = `translate(${WIN_W / 2 - CX}px, ${ty}px) rotate(${a}deg)`;
    wrap.style.transform = squash === 1 ? '' : `scale(${2 - squash}, ${squash})`;
    if (S.mode !== 'drag' && (S.x !== lastMoveX || S.y !== lastMoveY)) {
      window.pet.move(S.x, S.y);
      lastMoveX = S.x; lastMoveY = S.y;
    }
    shadow.classList.toggle('air', S.mode === 'drag' || (S.mode === 'fall' && S.y < groundY() - 4));
    shadow.classList.toggle('wide', S.ko);
  }

  // ---------- 滚动：每次正好滚整圈，停下时站正 ----------
  function startRoll() {
    const turns = Math.random() < 0.7 ? 1 : 2;
    const dist = turns * PERIM;
    let dir = Math.random() < 0.5 ? -1 : 1;
    if (S.x + dir * dist > maxX() || S.x + dir * dist < minX()) dir = -dir;
    if (S.x + dir * dist > maxX() || S.x + dir * dist < minX()) return scheduleNext(); // 地方太小，不滚了
    S.dir = dir;
    S.roll = { startX: S.x, startAngle: S.baseAngle, dist, d: 0 };
    S.mode = 'roll';
    lookAt(dir * 2, 0);
    wake();
  }
  function stepRoll(dt) {
    const r = S.roll;
    r.d = Math.min(r.dist, r.d + ROLL_SPEED * dt);
    S.x = r.startX + S.dir * r.d;
    S.baseAngle = r.startAngle + (S.dir * r.d / PERIM) * 360;
    if (r.d >= r.dist) {
      S.baseAngle = Math.round(S.baseAngle / 360) * 360;
      S.roll = null;
      S.mode = 'idle';
      lookAt(0, 0);
      scheduleNext();
    }
  }
  function stopRoll() {
    if (S.mode === 'roll') { S.mode = 'idle'; S.roll = null; lookAt(0, 0); }
  }
  // 滚到一半被打断时，顺势转回站正
  function settleUpright() {
    const from = S.baseAngle, to = Math.round(from / 360) * 360;
    if (from === to) return;
    tween(300, (t) => { if (!S.ko) S.baseAngle = from + (to - from) * ease.out(t); },
      () => { if (!S.ko) S.baseAngle = to; });
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
      if (!f.bounced && f.vy > 380) {
        f.bounced = true;
        squashOnce(0.16);
        sound.land();
        f.vy = -Math.min(f.vy * 0.3, 520);
      } else {
        if (!f.bounced) { squashOnce(0.08); sound.land(); }
        S.fall = null;
        S.mode = S.ko ? 'ko' : 'idle';
        if (!S.ko) scheduleNext(1500);
      }
    }
  }

  // ---------- 平时：发呆、眨眼、东张西望 ----------
  let behaviorTimer = 0;
  function scheduleNext(delay) {
    clearTimeout(behaviorTimer);
    if (S.ko) return;
    behaviorTimer = setTimeout(() => {
      if (S.mode !== 'idle' || S.ko) return;
      if (Math.random() < 0.7) startRoll();
      else { daydream(); scheduleNext(); }
    }, delay ?? 3000 + Math.random() * 6000);
  }
  function daydream() {
    const spots = [[-2.5, -1.5], [2.5, -1.5], [0, -2.5], [-2, 1], [2, 1]];
    const [x, y] = spots[Math.floor(Math.random() * spots.length)];
    lookAt(x, y);
    setTimeout(() => { if (!S.ko && S.mode === 'idle') lookAt(0, 0); }, 1600 + Math.random() * 1500);
  }
  function lookAt(x, y) {
    $('pupils').style.transform = x || y ? `translate(${x}px, ${y}px)` : '';
  }
  function scheduleBlink() {
    setTimeout(() => {
      if (!S.ko && !egg.classList.contains('squint')) {
        egg.classList.add('blink');
        setTimeout(() => egg.classList.remove('blink'), 130);
        if (Math.random() < 0.2) setTimeout(() => { egg.classList.add('blink'); setTimeout(() => egg.classList.remove('blink'), 120); }, 280);
      }
      scheduleBlink();
    }, 2500 + Math.random() * 4000);
  }

  // ---------- 气泡 ----------
  let bubbleTimer = 0, lastLine = '';
  function say(text) {
    bubble.textContent = text;
    bubble.classList.toggle('long', text.length > 13);
    bubble.classList.add('show');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.remove('show'), 1600 + text.length * 110);
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
    function tone(c, { type = 'sine', f0, f1, at = 0, dur, vol, lp }) {
      const t = c.currentTime + at;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
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
    };
  })();

  // ---------- 单击 / 揍 / K.O. / 扶起来 ----------
  function onClick() {
    if (S.ko) { wobble(3, 400); return; }
    wobble(12);
    sound.gulu();
    say(pick(CLICK_LINES));
  }

  function punch() {
    const now = Date.now();
    S.streak = now - S.lastHit < COMBO_WINDOW ? S.streak + 1 : 1;
    S.lastHit = now;
    sound.punch();
    say(pick(HIT_LINES));
    if (S.ko) { wobble(4, 450); return; }
    if (S.streak >= 3) { knockOut(); return; }
    stopRoll();
    settleUpright();
    hitTilt();
    egg.classList.add('squint');
    setTimeout(() => egg.classList.remove('squint'), 600);
    scheduleNext(2500);
  }

  function knockOut() {
    S.ko = true;
    window.pet.koState(true);
    clearTimeout(behaviorTimer);
    stopRoll();
    if (S.mode !== 'fall' && S.mode !== 'drag') S.mode = 'ko';
    egg.classList.remove('squint', 'blink');
    egg.classList.add('ko');
    lookAt(0, 0);
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
      koText.classList.add('show');
    });
    sound.ko();
  }

  function getUp() {
    if (!S.ko) return;
    koText.classList.remove('show');
    const from = S.baseAngle;
    const to = Math.round(from / 360) * 360;
    tween(1400, (t) => { S.baseAngle = from + (to - from) * ease.inOut(t); }, () => {
      S.baseAngle = to;
      S.ko = false;
      S.streak = 0;
      window.pet.koState(false);
      egg.classList.remove('ko');
      if (S.mode === 'ko') S.mode = 'idle';
      wobble(6, 600);
      sound.getup();
      say(THANKS);
      scheduleNext(3500);
    });
  }

  // ---------- 鼠标：点穿 / 单击 / 拖拽 / 右键 ----------
  let hovering = false, down = null, dragging = false;
  const overEgg = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return !!(el && el.closest && el.closest('#egg'));
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
    dragging = true;
    clearTimeout(behaviorTimer);
    stopRoll();
    if (S.mode === 'fall') S.fall = null;
    S.mode = 'drag';
    if (!S.ko) settleUpright();
    window.pet.dragStart(down.cx, down.cy);
    wobble(8, 700);
    render();
  }
  async function endDrag() {
    if (!dragging) return;
    dragging = false;
    down = null;
    const b = await window.pet.dragEnd();
    S.x = b.x; S.y = b.y;
    lastMoveX = S.x; lastMoveY = S.y;
    wa = await window.pet.workArea(S.x, S.y);
    S.x = Math.max(minX(), Math.min(maxX(), S.x));
    if (S.y > groundY()) S.y = groundY();
    startFall();
  }

  // ---------- 来自主进程 ----------
  window.pet.onAction((a) => {
    if (a === 'punch') punch();
    else if (a === 'getup') getUp();
  });
  window.pet.onMuted((m) => { S.muted = m; });
  window.pet.onScreenChanged(async () => {
    if (dragging) return;
    wa = await window.pet.workArea(S.x, S.y);
    S.x = Math.max(minX(), Math.min(maxX(), S.x));
    if (S.mode !== 'fall') S.y = groundY();
    if (S.mode === 'roll') stopRoll();
    render();
    if (!S.ko) scheduleNext();
  });

  // 测试用：让自动化测试读取内部状态
  window.__pet = { S, onClick, punch, getUp, say, overEgg, get dragging() { return dragging; }, get looping() { return !!raf; } };

  // ---------- 开始 ----------
  S.x = Math.max(minX(), Math.min(maxX(), S.x));
  S.y = groundY();
  render();
  scheduleBlink();
  scheduleNext(2000);
})();
