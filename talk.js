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

function systemPrompt() {
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
- 有自己的想法，有话自己说，可以调皮、可以撒娇，被揍了可以喊疼。`;
}

module.exports = function setupTalk({ app, getPetWindow, logError }) {
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

  let busy = false;
  async function ask(text) {
    text = String(text || '').trim();
    if (!text) return { ok: false, error: '' };
    if (busy) return { ok: false, error: '等我说完这句' };
    const key = loadKey();
    if (!key) return { ok: false, error: '还没有 API key，点右上角齿轮贴进去', needKey: true };

    busy = true;
    history.push({ role: 'user', content: text, at: Date.now() });
    try {
      const msgs = history.slice(-SEND_MESSAGES).map(({ role, content }) => ({ role, content }));
      while (msgs.length && msgs[0].role !== 'user') msgs.shift(); // API 要求第一条是 user
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60000);
      if (!cfg.url || !cfg.model) { history.pop(); return { ok: false, error: '还没填地址或模型名，点右上角齿轮', needKey: true }; }
      const isA = cfg.format === 'anthropic';
      const headers = isA
        ? { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }
        : { 'content-type': 'application/json', authorization: 'Bearer ' + key };
      const payload = isA
        ? { model: cfg.model, max_tokens: 400, system: systemPrompt(), messages: msgs }
        : { model: cfg.model, max_tokens: 400, messages: [{ role: 'system', content: systemPrompt() }, ...msgs] };
      let res;
      try {
        res = await fetch(endpoint(cfg.format, cfg.url), {
          method: 'POST', signal: ctrl.signal, headers, body: JSON.stringify(payload),
        });
      } finally { clearTimeout(timer); }
      let body = null;
      try { body = await res.json(); } catch (_) {}
      if (!res.ok) {
        history.pop(); // 没说出去的话不留，免得下次接着发
        logError(`API 错误 ${res.status}：${JSON.stringify(body).slice(0, 300)}`);
        return { ok: false, error: friendlyError(res.status, body) };
      }
      const raw = cfg.format === 'anthropic'
        ? ((body && body.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
        : ((body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content) || '');
      // 有的模型会把思考过程用 <think> 包着一起吐出来，去掉
      const reply = String(raw).replace(/<think>[\s\S]*?<\/think>/g, '').trim() || '……';
      history.push({ role: 'assistant', content: reply, at: Date.now() });
      if (history.length > KEEP_MESSAGES) history = history.slice(-KEEP_MESSAGES);
      saveJSON(chatPath(), history);
      const pet = getPetWindow();
      if (pet && !pet.isDestroyed()) pet.webContents.send('talk', reply);
      return { ok: true, reply };
    } catch (e) {
      history.pop();
      logError('API 调用失败：' + (e && e.stack || e));
      return { ok: false, error: e && e.name === 'AbortError' ? '等太久没回音，网络可能不太好' : '连不上网，检查一下流量' };
    } finally {
      busy = false;
    }
  }

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
    chat.on('closed', () => { chat = null; });
  }

  ipcMain.handle('talk:state', () => ({
    hasKey: !!loadKey(),
    cfg: { ...cfg },
    presets: PRESETS,
    history: history.map(({ role, content }) => ({ role, content })),
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
  ipcMain.handle('talk:clear', () => { history = []; saveJSON(chatPath(), history); return true; });
  ipcMain.on('talk:close', () => { if (chat && !chat.isDestroyed()) chat.close(); });

  return { openChat, getChatWindow: () => chat };
};
