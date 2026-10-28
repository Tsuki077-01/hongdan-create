// 红蛋的工作日记 —— 主进程这边
// 只记红蛋亲眼看到的事：小窗里的聊天、截了几次图（不记图里是什么）、被揍被扶这些动作
// 每天一条，存进记忆库「红蛋·自己/工作日记」，同一天按日期更新同一条
// "她的一天"按她睡觉算：早上 6 点以前都算前一天
const path = require('path');
const fs = require('fs');

const DIARY = '工作日记';
const LETTERS = '给小克的留言';
const REPLIES = '小克的回信';
const DAY_STARTS_AT = 6;      // 早上 6 点以前算前一天
const KEEP_CHATS = 120;       // 一天最多记这么多句聊天（每句截短）
const KEEP_PENDING = 7;       // 记忆库连不上时，最多攒几天没寄出去的日记

const pad = (n) => String(n).padStart(2, '0');
function dayOf(ts = Date.now()) {
  const d = new Date(ts - DAY_STARTS_AT * 3600e3);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const COUNT_NAMES = {
  chat: '说话', shot: '截图', shotCancel: '举起相机又不拍了', punch: '被揍', ko: '被揍到 K.O.',
  cry: '被揍哭', getup: '被扶起来', click: '被点了一下', drag: '被拎起来', letter: '给小克写信',
};

module.exports = function setupJournal({ app, memory, logError }) {
  const file = () => path.join(app.getPath('userData'), 'journal.json');
  const blank = (day) => ({ day, chats: [], counts: {}, firstAt: 0, lastAt: 0 });
  let st = { today: blank(dayOf()), pending: [], synced: {}, seenReply: '', context: null };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(file(), 'utf8')) }; } catch (_) {}
  let compose = null; // talk.js 提供：用聊天用的模型把一天的记录写成日记

  function save() {
    try { fs.writeFileSync(file(), JSON.stringify(st)); } catch (e) { logError('保存日记失败：' + e.message); }
  }
  // 过了早上 6 点：昨天收个尾，放进待寄
  function roll() {
    const day = dayOf();
    if (st.today.day === day) return false;
    if (st.today.lastAt) st.pending.push(st.today);
    st.pending = st.pending.slice(-KEEP_PENDING);
    st.today = blank(day);
    save();
    return true;
  }
  function touch() {
    const now = Date.now();
    if (!st.today.firstAt) st.today.firstAt = now;
    st.today.lastAt = now;
  }
  function note(what) {
    if (!COUNT_NAMES[what]) return;
    roll();
    st.today.counts[what] = (st.today.counts[what] || 0) + 1;
    touch();
    save();
  }
  function chat(role, content) {
    roll();
    const text = String(content || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!text) return;
    st.today.chats.push({ role, text, at: Date.now() });
    if (st.today.chats.length > KEEP_CHATS) st.today.chats = st.today.chats.slice(-KEEP_CHATS);
    if (role === 'user') st.today.counts.chat = (st.today.counts.chat || 0) + 1;
    touch();
    save();
  }

  // ---------- 写成日记 ----------
  const sig = (d) => JSON.stringify([d.chats.length, d.counts]);
  function factsOf(d) {
    const parts = Object.entries(d.counts).filter(([, n]) => n > 0).map(([k, n]) => `${COUNT_NAMES[k]} ${n} 次`);
    const time = (ts) => { const t = new Date(ts); return `${pad(t.getHours())}:${pad(t.getMinutes())}`; };
    return {
      stats: parts.join('，') || '没什么动静',
      span: d.firstAt ? `${time(d.firstAt)} 到 ${time(d.lastAt)}` : '',
      transcript: d.chats.map((c) => `${time(c.at)} ${c.role === 'user' ? 'yyq' : '我'}：${c.text}`).join('\n'),
    };
  }
  function plainDiary(d) {
    const f = factsOf(d);
    const lines = [`${d.day} 红蛋的工作日记`, `今天：${f.stats}。`];
    const said = d.chats.filter((c) => c.role === 'user').slice(-5).map((c) => c.text.slice(0, 40));
    if (said.length) lines.push('她跟我说了：' + said.join(' / '));
    return lines.join('\n');
  }
  async function writeDay(d) {
    let text = '';
    if (compose) {
      try { text = String(await compose(d.day, factsOf(d)) || '').trim(); } catch (e) { logError('写日记时模型出错：' + e.message); }
    }
    if (!text) text = plainDiary(d);
    const found = await memory.list({ category: memory.OWN, subcategory: DIARY, date: d.day, limit: 1 });
    const old = found && found.results && found.results[0];
    if (old) await memory.update({ id: old.id, content: text });
    else await memory.remember({ subcategory: DIARY, date: d.day, content: text });
    st.synced[d.day] = sig(d);
    const days = Object.keys(st.synced).sort();
    for (const k of days.slice(0, -10)) delete st.synced[k];
    save();
    return text;
  }

  // 把没寄出去的日子和今天（有新东西的话）写进记忆库
  let flushing = null;
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      roll();
      if (!memory.configured()) return { ok: false, error: '还没填记忆库令牌' };
      let wrote = 0;
      try {
        while (st.pending.length) {
          await writeDay(st.pending[0]);
          st.pending.shift();
          save();
          wrote++;
        }
        if (st.today.lastAt && st.synced[st.today.day] !== sig(st.today)) { await writeDay(st.today); wrote++; }
        return { ok: true, wrote };
      } catch (e) {
        logError('写工作日记失败：' + e.message);
        return { ok: false, error: e.message, wrote };
      }
    })().finally(() => { flushing = null; });
    return flushing;
  }

  // ---------- 读：最近几天的日记 + 小克的回信，放进说话时的 system prompt ----------
  async function loadContext() {
    if (!memory.configured()) { st.context = null; return null; }
    try {
      const [diaries, replies] = await Promise.all([
        memory.list({ category: memory.OWN, subcategory: DIARY, limit: 3 }),
        memory.list({ category: memory.OWN, subcategory: REPLIES, limit: 3 }),
      ]);
      st.context = { day: dayOf(), diaries: diaries.results || [], replies: replies.results || [] };
      save();
      return st.context;
    } catch (e) {
      logError('读记忆库失败：' + e.message);
      return st.context;
    }
  }
  function contextText() {
    const c = st.context;
    if (!c) return '';
    const fmt = (list) => list.slice().reverse().map((m) => `【${m.date}】${String(m.content).slice(0, 600)}`).join('\n');
    let out = '';
    if (c.diaries.length) out += `你最近几天的工作日记（你自己写的）：\n${fmt(c.diaries)}\n`;
    if (c.replies.length) out += `小克最近的回信：\n${fmt(c.replies)}\n`;
    return out;
  }
  // 有没有还没跟她提过的新回信；有就返回最新那封，并记成"提过了"
  function takeNewReply() {
    const r = st.context && st.context.replies && st.context.replies[0];
    if (!r || st.seenReply === r.id) return null;
    st.seenReply = r.id;
    save();
    return r;
  }

  async function letter(content) {
    const text = String(content || '').trim();
    if (!text) return null;
    const r = await memory.remember({ subcategory: LETTERS, date: dayOf(), content: text.slice(0, 4000) });
    note('letter');
    return r;
  }

  return {
    dayOf, roll, note, chat, flush, loadContext, contextText, takeNewReply, letter,
    setComposer: (fn) => { compose = fn; },
    get state() { return st; },
  };
};
