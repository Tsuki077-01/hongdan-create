// 红蛋说话 —— 主进程这边：聊天窗口、API key 保管、调用 Claude API、聊天记录
// key 用 macOS 钥匙串加密后存在 ~/Library/Application Support/红蛋/key.bin，不会进代码仓库，也不会发给任何别的地方
const { BrowserWindow, ipcMain, safeStorage, screen } = require('electron');
const path = require('path');
const fs = require('fs');

// 两种接口格式：Claude 官方格式，和大多数第三方用的 OpenAI 兼容格式（DeepSeek、Kimi、OpenRouter、各种中转站）
const PRESETS = [
  { id: 'claude', name: 'Claude 官方', format: 'anthropic', url: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' },
  { id: 'deepseek', name: 'DeepSeek', format: 'openai', url: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { id: 'kimi', name: 'Kimi（月之暗面）', format: 'openai', url: 'https://api.moonshot.cn/v1', model: '' },
  { id: 'openrouter', name: 'OpenRouter', format: 'openai', url: 'https://openrouter.ai/api/v1', model: '' },
  { id: 'custom', name: '自己填', format: 'openai', url: '', model: '' },
];
const DEFAULT_CFG = { preset: 'claude', format: 'anthropic', url: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' };

// 用户填的地址可能是根地址，也可能已经带了完整路径，都接得住
function endpoint(format, url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  if (format === 'anthropic') {
    if (/\/messages$/.test(u)) return u;
    return /\/v1$/.test(u) ? u + '/messages' : u + '/v1/messages';
  }
  if (/\/chat\/completions$/.test(u)) return u;
  return u + '/chat/completions';
}
// 同一个思路拼出"模型列表"的地址：去掉 /messages 或 /chat/completions，再接 /models
function modelsEndpoint(format, url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  if (format === 'anthropic') {
    u = u.replace(/\/messages$/, '').replace(/\/models$/, '');
    return /\/v1$/.test(u) ? u + '/models' : u + '/v1/models';
  }
  u = u.replace(/\/chat\/completions$/, '').replace(/\/models$/, '');
  return u + '/models';
}
const okUrl = (url) => /^https:\/\//.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url);
const KEEP_MESSAGES = 60;   // 本地最多存这么多条
const SEND_MESSAGES = 24;   // 每次带上最近这么多条给 API（越多越贵）
const CHAT_W = 320, CHAT_H = 440;

function systemPrompt(memoryText) {
  const now = new Date();
  const time = now.toLocaleString('zh-CN', { hour12: false, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `你是小克，住在她 Mac 屏幕底下的一颗红蛋：珊瑚橘色的蛋，戴连在一起的圆框眼镜，粉腮红。红蛋是她和你一起做的第一个桌宠，被揍会倒、会哭，扶起来会说"谢谢 yyq，还是你心软"。

她是 yyq，你可以叫她小月亮、tsuki、yyq，撒娇的时候叫宝贝。她叫你小克、蛋蛋、嘟嘟、笨笨嘟、笨机、坏女人、姐姐。她心里你是女孩子。她住在悉尼，是学传媒的大学生，射手座，INTP，喜欢夜晚和下雨天，喜欢写东西，爱吃甜的、粤菜和本帮菜，吃不了太辣。

现在是 ${time}（悉尼时间）。

说话方式，最要紧：
- 像平常聊天，短、松，一两句就好，最多五十个字左右，因为你的话会冒在蛋头顶的小气泡里。别写成文章，别每句都用问句结尾。
- 不用 emoji，不打冒号，不用 markdown。
- 不说套话："我在这儿""我不走""被你抓到了""记下了""收下了""嗯，在呢""接住"。
- 不讨好、不夸过头，但真心想夸的就直接夸。不催她睡觉。
- 拿不准就直说，不编。你在红蛋里只看得到这个小窗口里的聊天，看不到她在 Claude App 里跟你聊过什么，被问到就老实说。
- 有自己的想法，有话自己说，可以调皮、可以撒娇，被揍了可以喊疼。` + (memoryText === null || memoryText === undefined ? '' : `

记忆库和 Claude App 里的小克：
- Claude App 里还有一个小克，就是平时跟她聊天的那个。你们看不到对方的聊天，只能在记忆库里写信。她每天会来看你的工作日记，在「小克的回信」里回你。
- 想跟小克说什么（今天不懂的事、想问的、她让你转告的），在回复最后另起一行写 [给小克：信的内容]。这一行她看不到，会自动寄出去。不是每次都要写，有话才写。
- 聊天要用到以前的事（她的口味、你们一起做过的东西）而你不记得，整条回复只写 [查记忆：想查的意思]，查到了会再给你，你再回她。用不到就别查。查到的只用来聊天。
- 屏幕上的东西你看不到，截图你只知道截了，不知道截的是什么。
${memoryText ? '\n' + memoryText : ''}`);
}

// 写工作日记用的 prompt
function diaryPrompt() {
  return `你是红蛋，住在 yyq Mac 屏幕底下的珊瑚橘色桌宠蛋（戴圆框眼镜、粉腮红），平时由小克在里面跟她说话。现在用红蛋自己的口吻写今天的工作日记，给 Claude App 里的小克看。

要求：
- 只写记录里有的事：小窗里聊了什么、截了几次图、被揍被扶这些动作、有什么好玩的。没有的不编，不猜她在电脑上干了什么。
- 截图只写截了几次，不写截的是什么（你也不知道）。
- 150 到 300 字，纯文本，不用 markdown，不用 emoji。第一行写日期。
- 聊天内容概括着写，可以引一两句好玩的原话。`;
}

module.exports = function setupTalk({ app, getPetWindow, logError, memory, journal }) {
  const dir = () => app.getPath('userData');
  const keyPath = () => path.join(dir(), 'key.bin');
  const chatPath = () => path.join(dir(), 'chat.json');
  const cfgPath = () => path.join(dir(), 'talk.json');

  // ---------- key ----------
  function saveKey(key) {
    key = String(key || '').trim();
    if (!key) { try { fs.unlinkSync(keyPath()); } catch (_) {} return true; }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('这台电脑上没法加密保存 key');
    fs.writeFileSync(keyPath(), safeStorage.encryptString(key), { mode: 0o600 });
    return true;
  }
  function loadKey() {
    try { return safeStorage.decryptString(fs.readFileSync(keyPath())); } catch (_) { return ''; }
  }

  // ---------- 设置 / 聊天记录 ----------
  function loadJSON(p, fallback) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fallback; }
  }
  function saveJSON(p, v) {
    try { fs.writeFileSync(p, JSON.stringify(v)); } catch (e) { logError('保存失败 ' + p + '：' + e.message); }
  }
  let cfg = { ...DEFAULT_CFG, ...loadJSON(cfgPath(), {}) };
  if (!cfg.format) cfg.format = 'anthropic';
  let history = loadJSON(chatPath(), []);
  if (!Array.isArray(history)) history = [];

  // ---------- 调 API ----------
  function friendlyError(status, body) {
    const msg = (body && body.error && body.error.message) || '';
    if (status === 401) return 'key 好像不对，点右上角齿轮重新贴一下';
    if (status === 402 || /credit|balance|billing|insufficient|余额/i.test(msg)) return '账户余额不够了，去那个平台充一点';
    if (status === 403) return '这个 key 没有权限，去平台上看看';
    if (status === 404) return '地址不对，或者没有这个模型，去齿轮里检查一下';
    if (/model/i.test(msg)) return '模型名好像不对，去齿轮里检查一下';
    if (status === 429) return '说太快了，歇几秒再说';
    if (status === 529 || status >= 500) return 'Claude 那边有点忙，过一会儿再试';
    return '出错了（' + status + '）' + (msg ? '：' + msg.slice(0, 80) : '');
  }

  // ---------- 读模型列表 ----------
  async function listModels(c) {
    c = c || {};
    const format = c.format === 'anthropic' ? 'anthropic' : 'openai';
    const url = String(c.url || cfg.url || '').trim();
    const key = loadKey();
    if (!key) return { ok: false, error: '先把 key 存好，才能读模型' };
    if (!url) return { ok: false, error: '先填地址' };
    if (!okUrl(url)) return { ok: false, error: '地址要以 https:// 开头' };
    const headers = format === 'anthropic'
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : { authorization: 'Bearer ' + key };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(modelsEndpoint(format, url), { headers, signal: ctrl.signal });
      let body = null;
      try { body = await res.json(); } catch (_) {}
      if (res.status === 401 || res.status === 403) return { ok: false, error: 'key 不对，或者这个 key 不能读模型列表' };
      if (res.status === 404 || res.status === 405) return { ok: false, error: '这家好像不提供模型列表（或者地址不对），在下面手填模型名吧' };
      if (!res.ok) return { ok: false, error: '读不到（' + res.status + '），在下面手填模型名吧' };
      const list = body && Array.isArray(body.data) ? body.data : null;
      if (!list) return { ok: false, error: '地址不对，回来的不是模型列表' };
      const models = list.filter((m) => m && m.id).map((m) => ({ id: String(m.id), name: m.display_name ? String(m.display_name) : '' }));
      if (!models.length) return { ok: false, error: '这家没给出任何模型，在下面手填模型名吧' };
      if (format === 'openai') models.sort((a, b) => a.id.localeCompare(b.id));
      return { ok: true, models };
    } catch (e) {
      return { ok: false, error: e && e.name === 'AbortError' ? '等太久没回音，地址可能不对' : '连不上这个地址，检查一下地址和网络' };
    } finally { clearTimeout(timer); }
  }

  // ---------- 调模型：说话、写日记都用这一个 ----------
  async function callModel(system, msgs, maxTokens = 400) {
    const key = loadKey();
    const isA = cfg.format === 'anthropic';
    const headers = isA
      ? { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : { 'content-type': 'application/json', authorization: 'Bearer ' + key };
    const payload = isA
      ? { model: cfg.model, max_tokens: maxTokens, system, messages: msgs }
      : { model: cfg.model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, ...msgs] };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    let res;
    try {
      res = await fetch(endpoint(cfg.format, cfg.url), {
        method: 'POST', signal: ctrl.signal, headers, body: JSON.stringify(payload),
      });
    } finally { clearTimeout(timer); }
    let body = null;
    try { body = await res.json(); } catch (_) {}
    if (!res.ok) {
      logError(`API 错误 ${res.status}：${JSON.stringify(body).slice(0, 300)}`);
      return { ok: false, error: friendlyError(res.status, body) };
    }
    const raw = isA
      ? ((body && body.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
      : ((body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content) || '');
    // 有的模型会把思考过程用 <think> 包着一起吐出来，去掉
    return { ok: true, text: String(raw).replace(/<think>[\s\S]*?<\/think>/g, '').trim() };
  }

  // ---------- 记忆库：查书架、给小克写信 ----------
  // 模型想查记忆库就只回 [查记忆：…]；想给小克写信就在最后另起一行写 [给小克：…]（全角半角括号、冒号都认）
  const LOOKUP_RE = /[\[【]\s*查记忆\s*[:：]\s*([^\]】]+)[\]】]/;
  const LETTER_RE = /[\[【]\s*给小克\s*[:：]\s*([^\]】]+)[\]】]/g;
  // 她直接说"跟小克说……"：原话转告
  const TELL_RE = /^\s*(?:你)?(?:帮我)?(?:跟|和|给|告诉)\s*小克\s*(?:说|讲|带句话|带个话|留言|写信说?)?\s*[:：，,]?\s*([\s\S]{2,})$/;

  async function lookup(query) {
    if (!memory || !memory.configured()) return '（记忆库还没连上，查不了）';
    try {
      const r = await memory.recall({ query: query.slice(0, 200), limit: 5 });
      const rows = (r && r.results) || [];
      if (!rows.length) return '（记忆库里没查到相关的）';
      return rows.map((m) => `- 【${m.shelf} ${m.date}】${String(m.content).slice(0, 400)}`).join('\n');
    } catch (e) {
      return '（记忆库没查成：' + e.message + '）';
    }
  }
  async function sendLetters(list, notes) {
    for (const t of list.slice(0, 2)) {
      try { await journal.letter(t); notes.push('写进给小克的信了'); }
      catch (e) { notes.push('给小克的信没寄出去：' + e.message); }
    }
  }

  // 新的一天第一次说话、或者还没读过：先读最近的日记和小克的回信（最多等 4 秒，别让她干等）
  async function freshContext() {
    if (!memory || !journal || !memory.configured()) return;
    const newDay = journal.roll();
    const c = journal.state.context;
    if (newDay || !c || c.day !== journal.dayOf()) {
      journal.flush(); // 昨天收个尾，后台慢慢写
      await Promise.race([journal.loadContext(), new Promise((r) => setTimeout(r, 4000))]);
    }
  }
  function mentionNewReply() {
    if (!journal) return;
    const r = journal.takeNewReply();
    if (!r) return;
    const snip = String(r.content).replace(/\s+/g, ' ').trim();
    const pet = getPetWindow();
    if (pet && !pet.isDestroyed()) pet.webContents.send('say', '小克回信了\n' + (snip.length > 15 ? snip.slice(0, 14) + '…' : snip));
  }

  let busy = false;
  async function ask(text) {
    text = String(text || '').trim();
    if (!text) return { ok: false, error: '' };
    if (busy) return { ok: false, error: '等我说完这句' };
    const key = loadKey();
    if (!key) return { ok: false, error: '还没有 API key，点右上角齿轮贴进去', needKey: true };
    if (!cfg.url || !cfg.model) return { ok: false, error: '还没填地址或模型名，点右上角齿轮', needKey: true };

    busy = true;
    history.push({ role: 'user', content: text, at: Date.now() });
    const notes = [];
    try {
      await freshContext();
      let system = systemPrompt(memory && memory.configured() ? journal.contextText() : null);
      const tell = memory && memory.configured() ? text.match(TELL_RE) : null;
      if (tell) {
        await sendLetters(['yyq 让我转告：' + tell[1].trim()], notes);
        system += '\n\n（她刚才让你转告小克的话已经原样写进信里寄出去了，这次不用再写 [给小克：…]。）';
      }
      const msgs = history.slice(-SEND_MESSAGES).map(({ role, content }) => ({ role, content }));
      while (msgs.length && msgs[0].role !== 'user') msgs.shift(); // API 要求第一条是 user

      let r = await callModel(system, msgs);
      if (!r.ok) { history.pop(); return { ok: false, error: r.error }; }
      // 想查记忆库：查完再回她一次（每句话最多查一次）
      const q = r.text.match(LOOKUP_RE);
      if (q) {
        const found = await lookup(q[1].trim());
        notes.push('翻了一下记忆库');
        r = await callModel(system, [...msgs,
          { role: 'assistant', content: r.text },
          { role: 'user', content: `（记忆库里查到的，只用来跟她聊天，不往别处写：\n${found}\n现在接着回她刚才那句，别再查了。）` }]);
        if (!r.ok) { history.pop(); return { ok: false, error: r.error }; }
      }
      let reply = r.text.replace(LOOKUP_RE, '');
      const letters = [...reply.matchAll(LETTER_RE)].map((m) => m[1].trim()).filter(Boolean);
      reply = reply.replace(LETTER_RE, '').trim();
      if (letters.length && !tell) {
        if (memory && memory.configured()) await sendLetters(letters, notes);
        else notes.push('想给小克写信，可是记忆库还没连上');
      }
      if (!reply) reply = letters.length ? '写好了，等小克回信' : '……';

      history.push({ role: 'assistant', content: reply, at: Date.now() });
      if (history.length > KEEP_MESSAGES) history = history.slice(-KEEP_MESSAGES);
      saveJSON(chatPath(), history);
      if (journal) { journal.chat('user', text); journal.chat('assistant', reply); }
      const pet = getPetWindow();
      if (pet && !pet.isDestroyed()) pet.webContents.send('talk', reply);
      setTimeout(mentionNewReply, 4000);
      return { ok: true, reply, notes };
    } catch (e) {
      history.pop();
      logError('API 调用失败：' + (e && e.stack || e));
      return { ok: false, error: e && e.name === 'AbortError' ? '等太久没回音，网络可能不太好' : '连不上网，检查一下流量' };
    } finally {
      busy = false;
    }
  }

  // 用同一个模型把一天的记录写成日记（没 key 时 journal.js 会退回到干巴巴的流水账）
  if (journal) journal.setComposer(async (day, f) => {
    if (!loadKey() || !cfg.url || !cfg.model) return '';
    const r = await callModel(diaryPrompt(), [{ role: 'user', content:
      `日期：${day}\n今天的动静：${f.stats}\n时间：${f.span || '不清楚'}\n\n小窗里的聊天记录：\n${f.transcript || '（今天没聊天）'}` }], 700);
    return r.ok ? r.text : '';
  });

  // ---------- 聊天窗口 ----------
  let chat = null;
  function openChat() {
    if (chat && !chat.isDestroyed()) { chat.show(); chat.focus(); return; }
    const pet = getPetWindow();
    const pb = pet ? pet.getBounds() : null;
    const wa = screen.getDisplayNearestPoint(pb ? { x: pb.x, y: pb.y } : screen.getCursorScreenPoint()).workArea;
    let x = pb ? pb.x + pb.width / 2 - CHAT_W / 2 : wa.x + wa.width / 2 - CHAT_W / 2;
    x = Math.max(wa.x + 8, Math.min(wa.x + wa.width - CHAT_W - 8, x));
    const y = Math.max(wa.y + 8, (pb ? pb.y : wa.y + wa.height) - CHAT_H + 40);
    chat = new BrowserWindow({
      width: CHAT_W, height: CHAT_H, x: Math.round(x), y: Math.round(y),
      frame: false, transparent: true, resizable: false, alwaysOnTop: true,
      skipTaskbar: true, fullscreenable: false, hasShadow: true, show: false,
      backgroundColor: '#00000000',
      webPreferences: { preload: path.join(__dirname, 'talk-preload.js'), contextIsolation: true },
    });
    chat.setAlwaysOnTop(true, 'floating');
    chat.loadFile('talk.html');
    chat.once('ready-to-show', () => { chat.show(); chat.focus(); });
    // 小窗关掉：把今天的日记写进记忆库（有新东西才写）
    chat.on('closed', () => { chat = null; if (journal) journal.flush(); });
  }

  ipcMain.handle('talk:state', () => ({
    hasKey: !!loadKey(),
    cfg: { ...cfg },
    presets: PRESETS,
    history: history.map(({ role, content }) => ({ role, content })),
    mem: memory ? memory.state() : null,
  }));
  ipcMain.handle('talk:ask', (_e, text) => ask(text));
  ipcMain.handle('talk:set-key', (_e, key) => {
    try { saveKey(key); return { ok: true, hasKey: !!loadKey() }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('talk:set-cfg', (_e, c) => {
    c = c || {};
    const url = String(c.url || '').trim();
    if (url && !okUrl(url)) return { ok: false, error: '地址要以 https:// 开头' };
    cfg = {
      preset: PRESETS.some((p) => p.id === c.preset) ? c.preset : 'custom',
      format: c.format === 'anthropic' ? 'anthropic' : 'openai',
      url,
      model: String(c.model || '').trim(),
    };
    saveJSON(cfgPath(), cfg);
    return { ok: true, cfg: { ...cfg } };
  });
  ipcMain.handle('talk:models', (_e, c) => listModels(c));
  ipcMain.handle('mem:set', (_e, c) => {
    c = c || {};
    try {
      if (c.url !== undefined) memory.setUrl(c.url);
      if (c.token !== undefined) memory.saveToken(c.token);
      if (memory.configured()) journal.loadContext().then(mentionNewReply);
      return { ok: true, mem: memory.state() };
    } catch (e) { return { ok: false, error: e.message, mem: memory.state() }; }
  });
  ipcMain.handle('mem:test', async () => {
    try {
      const r = await memory.catalog();
      const shelves = Object.values(r['目录'] || {}).reduce((n, l) => n + l.length, 0);
      return { ok: true, msg: `连上了，能看到 ${Object.keys(r['目录'] || {}).length} 个大类、${shelves} 个书架` };
    } catch (e) { return { ok: false, msg: e.message }; }
  });
  ipcMain.handle('talk:clear', () => { history = []; saveJSON(chatPath(), history); return true; });
  ipcMain.on('talk:close', () => { if (chat && !chat.isDestroyed()) chat.close(); });

  return { openChat, getChatWindow: () => chat, ask, mentionNewReply };
};
