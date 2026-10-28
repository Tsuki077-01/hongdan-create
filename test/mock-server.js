// 自测用的本地假服务器：假装是 Claude / OpenAI 兼容接口，也假装是记忆库的 /hongdan 接口
// 只在 HONGDAN_TEST=1 时由 test/driver.js 启动，只监听 127.0.0.1
const http = require('http');

const KEY = 'test-key';
const MEM_TOKEN = 'test-mem-token';

exports.start = () => new Promise((resolve) => {
  const calls = [];           // 每次请求记一笔，测试用来检查
  const mem = [];             // 假记忆库
  let nextId = 1;
  let reply = (body) => 'mock 回话';  // 测试可以换掉
  let modelsMode = 'ok';      // ok | none | 404

  const send = (res, status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch (_) {}
      calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
      const p = url.pathname.replace(/^\/bad/, '');
      const badKey = url.pathname.startsWith('/bad');

      // ---- 模型 ----
      if (p === '/v1/messages' || p === '/chat/completions') {
        const ok = p === '/v1/messages' ? req.headers['x-api-key'] === KEY : req.headers.authorization === 'Bearer ' + KEY;
        if (!ok || badKey) return send(res, 401, { error: { message: 'invalid key' } });
        const text = reply(body);
        return p === '/v1/messages'
          ? send(res, 200, { content: [{ type: 'text', text }] })
          : send(res, 200, { choices: [{ message: { content: text } }] });
      }
      if (p === '/v1/models' || p === '/models') {
        const ok = p === '/v1/models' ? req.headers['x-api-key'] === KEY && req.headers['anthropic-version'] : req.headers.authorization === 'Bearer ' + KEY;
        if (!ok || badKey) return send(res, 401, { error: { message: 'invalid key' } });
        if (modelsMode === '404') return send(res, 404, { error: { message: 'not found' } });
        if (modelsMode === 'none') return send(res, 200, { data: [] });
        return p === '/v1/models'
          ? send(res, 200, { data: [{ id: 'claude-test-1', display_name: 'Claude Test 1' }, { id: 'claude-test-2' }] })
          : send(res, 200, { data: [{ id: 'gpt-test-b' }, { id: 'gpt-test-a' }] });
      }

      // ---- 假记忆库 ----
      if (p.startsWith('/hongdan/')) {
        if (req.headers.authorization !== 'Bearer ' + MEM_TOKEN) return send(res, 401, { error: 'Unauthorized' });
        const q = Object.fromEntries(url.searchParams);
        const out = (m) => ({ id: m.id, shelf: m.category + '/' + m.subcategory, layer: m.layer, date: m.date, content: m.content });
        const pick = (f) => mem.filter((m) => (!f.category || m.category === f.category) && (!f.subcategory || m.subcategory === f.subcategory) && (!f.date || m.date === f.date))
          .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
        if (p === '/hongdan/catalog') return send(res, 200, { total: mem.length, 目录: {} });
        if (p === '/hongdan/list') {
          const rows = pick(q);
          const limit = +q.limit || 10;
          return send(res, 200, { results: rows.slice(0, limit).map(out), total: rows.length, has_more: rows.length > limit });
        }
        if (p === '/hongdan/recall') {
          // 假装"按意思搜"：有任意两个字连着对上就算
          const qq = String(q.query || '');
          const grams = [...qq].map((_, i) => qq.slice(i, i + 2)).filter((g) => g.length === 2);
          return send(res, 200, { results: pick(q).filter((m) => grams.some((g) => m.content.includes(g))).slice(0, 5).map(out) });
        }
        if (p === '/hongdan/remember') {
          const m = { id: nextId++, category: '红蛋·自己', subcategory: body.subcategory, layer: body.layer || '摘要', date: body.date, content: body.content };
          mem.push(m);
          return send(res, 200, out(m));
        }
        if (p === '/hongdan/update') {
          const m = mem.find((x) => String(x.id) === String(body.id));
          if (!m) return send(res, 404, { error: '找不到' });
          if (body.content) m.content = body.content;
          return send(res, 200, out(m));
        }
        if (p === '/hongdan/forget') {
          const before = mem.length;
          for (const id of body.ids || []) { const i = mem.findIndex((x) => String(x.id) === String(id)); if (i >= 0) mem.splice(i, 1); }
          return send(res, 200, { deleted: before - mem.length });
        }
      }
      send(res, 404, { error: 'not found' });
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const base = 'http://127.0.0.1:' + server.address().port;
    resolve({
      base, calls, mem, KEY, MEM_TOKEN,
      setReply: (fn) => { reply = fn; },
      setModels: (m) => { modelsMode = m; },
      addMemory: (m) => { const r = { id: nextId++, layer: '摘要', ...m }; mem.push(r); return r; },
      close: () => server.close(),
    });
  });
});
