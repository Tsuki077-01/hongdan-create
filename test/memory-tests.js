// 自测：记忆库令牌、工作日记、给小克写信、查记忆（全部对着 test/mock-server.js，不碰真的记忆库）
exports.run = async ({ talk, journal, check, sleep, waitFor, js }) => {
  const mock = await require('./mock-server').start();
  talk.openChat();
  await waitFor(async () => { const c = talk.getChatWindow(); return c && !c.isDestroyed() && c.isVisible(); }, 5000);
  const chat = talk.getChatWindow();
  const cj = (code) => chat.webContents.executeJavaScript(code);
  await waitFor(async () => cj('!!window.talk'), 3000);
  await cj(`talk.setKey('${mock.KEY}')`);
  await cj(`talk.setCfg({ preset: 'custom', format: 'anthropic', url: '${mock.base}', model: 'claude-test-1' })`);
  const lastLLM = () => mock.calls.filter((c) => c.path === '/v1/messages').pop();
  const memCalls = (p) => mock.calls.filter((c) => c.path === '/hongdan/' + p);
  const bubble = () => js(`document.getElementById('bubble').textContent`);

  // ---- 6 点分界 ----
  const d = (s) => journal.dayOf(new Date(s).getTime());
  check('早上 6 点以前算前一天', d('2026-10-29T05:59:00') === '2026-10-28' && d('2026-10-29T06:00:00') === '2026-10-29' && d('2026-10-29T00:30:00') === '2026-10-28');

  // ---- 没填令牌 ----
  let r = await cj(`talk.testMem()`);
  check('没填令牌时试连接会说还没填', !r.ok && /令牌/.test(r.msg), r.msg);
  r = await cj(`talk.ask('跟小克说你好')`);
  check('没填令牌也能正常聊天', r.ok);
  check('没填令牌时不往记忆库发任何东西', mock.calls.every((c) => !c.path.startsWith('/hongdan/')));
  check('没填令牌时 system prompt 不提记忆库', !/查记忆/.test(lastLLM().body.system));

  // ---- 填令牌 ----
  r = await cj(`talk.setMem({ url: '${mock.base}/mcp', token: 'wrong' })`);
  r = await cj(`talk.testMem()`);
  check('令牌不对时说令牌不对', !r.ok && /令牌不对/.test(r.msg), r.msg);
  mock.addMemory({ category: '红蛋·自己', subcategory: '工作日记', date: '2026-10-27', content: '前天的日记：她揍了我三顿' });
  mock.addMemory({ category: '红蛋·自己', subcategory: '小克的回信', date: '2026-10-28', content: '小克说：蛋蛋今天辛苦啦，糖水是双皮奶' });
  r = await cj(`talk.setMem({ url: '${mock.base}/mcp', token: '${mock.MEM_TOKEN}' })`);
  check('令牌保存成功（地址带 /mcp 也认）', r.ok && r.mem.hasToken);
  r = await cj(`talk.testMem()`);
  check('试连接成功', r.ok, r.msg);
  const tokenOnDisk = require('fs').readFileSync(require('path').join(require('electron').app.getPath('userData'), 'memory-token.bin'));
  check('令牌加密存在本机（文件里不是明文）', !tokenOnDisk.toString('latin1').includes(mock.MEM_TOKEN));
  await waitFor(async () => !!(journal.state.context && journal.state.context.replies.length), 3000);
  const sawReply = await waitFor(async () => js('__sayLog.some((t) => /小克回信了/.test(t))'), 5000);
  check('有新回信时用气泡提一句', sawReply, (await bubble()).replace(/\n/g, ' / '));

  // ---- 启动/第一次说话：读最近的日记和小克的回信放进 system prompt ----
  r = await cj(`talk.ask('早呀')`);
  const sys = lastLLM().body.system;
  check('最近的工作日记进了 system prompt', /她揍了我三顿/.test(sys));
  check('小克的回信进了 system prompt', /糖水是双皮奶/.test(sys));
  check('读日记只读自己那格', memCalls('list').every((c) => c.query.category === '红蛋·自己'));
  await sleep(4500);
  check('同一封回信只提一次', await js('__sayLog.filter((t) => /小克回信了/.test(t)).length === 1'));

  // ---- "跟小克说……" ----
  r = await cj(`talk.ask('跟小克说今天想吃杨枝甘露')`);
  let letters = mock.mem.filter((m) => m.subcategory === '给小克的留言');
  check('她说"跟小克说……"会原话写进给小克的留言', letters.length === 1 && letters[0].content === 'yyq 让我转告：今天想吃杨枝甘露' && letters[0].category === '红蛋·自己', JSON.stringify(letters));
  check('留言日期按她的一天算', letters[0] && letters[0].date === journal.dayOf());
  check('小窗里提示写进信了', (r.notes || []).some((n) => /给小克的信/.test(n)), JSON.stringify(r.notes));

  // ---- 红蛋自己想给小克写信 ----
  mock.setReply(() => '好呀，我也想知道\n[给小克：她问为什么下雨天适合写东西，我答不上来]');
  r = await cj(`talk.ask('为什么下雨天适合写东西')`);
  letters = mock.mem.filter((m) => m.subcategory === '给小克的留言');
  check('红蛋用 [给小克：…] 写的信寄出去了', letters.length === 2 && /答不上来/.test(letters[1].content));
  check('[给小克：…] 那一行她看不到', r.reply === '好呀，我也想知道' && !/给小克/.test(await bubble()), r.reply);

  // ---- 查记忆 ----
  mock.addMemory({ category: '她·口味', subcategory: '甜品', date: '2026-10-01', content: '她爱吃的甜品：杨枝甘露和双皮奶' });
  let n = 0;
  mock.setReply((body) => (++n === 1 ? '[查记忆：她爱吃的甜品]' : '你最爱杨枝甘露呀'));
  r = await cj(`talk.ask('我爱吃什么甜品来着')`);
  const rc = memCalls('recall').pop();
  check('红蛋会去记忆库查', rc && rc.query.query === '她爱吃的甜品', rc && JSON.stringify(rc.query));
  const second = lastLLM().body.messages.slice(-1)[0].content;
  check('查到的东西给了模型', /杨枝甘露和双皮奶/.test(second) && /只用来跟她聊天/.test(second), String(second).slice(0, 300));
  check('查完再回她', r.ok && r.reply === '你最爱杨枝甘露呀' && n === 2, r.reply);
  check('查记忆不写任何东西', memCalls('remember').every((c) => c.body.subcategory !== '甜品'));
  mock.setReply(() => 'mock 回话');

  // ---- 工作日记：关小窗时写一条，同一天更新同一条 ----
  journal.note('shot'); journal.note('shot'); journal.note('shotCancel');
  mock.setReply((body) => (/工作日记/.test(body.system) ? `${journal.dayOf()} 今天截了两次图，还跟她聊了杨枝甘露。` : 'mock 回话'));
  chat.close();
  await waitFor(async () => mock.mem.some((m) => m.subcategory === '工作日记' && m.date === journal.dayOf()), 5000);
  let diaries = mock.mem.filter((m) => m.subcategory === '工作日记' && m.date === journal.dayOf());
  check('关小窗时写了今天的工作日记', diaries.length === 1 && /截了两次图/.test(diaries[0].content), JSON.stringify(diaries));
  const diaryAsk = lastLLM().body.messages[0].content;
  check('写日记时给模型的是聊天记录和截图次数（没有截图内容）', /截图 \d+ 次/.test(diaryAsk) && /杨枝甘露/.test(diaryAsk) && !/\.png/.test(diaryAsk));
  check('日记写在「红蛋·自己/工作日记」', diaries[0] && diaries[0].category === '红蛋·自己');

  talk.openChat();
  await waitFor(async () => { const c = talk.getChatWindow(); return c && !c.isDestroyed() && c.isVisible(); }, 5000);
  const chat2 = talk.getChatWindow();
  await waitFor(async () => chat2.webContents.executeJavaScript('!!window.talk'), 3000);
  await chat2.webContents.executeJavaScript(`talk.ask('再聊一句')`);
  mock.setReply((body) => (/工作日记/.test(body.system) ? `${journal.dayOf()} 今天截了两次图，后来又聊了一句。` : 'mock 回话'));
  const before = memCalls('update').length;
  chat2.close();
  await waitFor(async () => memCalls('update').length > before, 5000);
  diaries = mock.mem.filter((m) => m.subcategory === '工作日记' && m.date === journal.dayOf());
  check('同一天再写是更新同一条，不是新加一条', diaries.length === 1 && /又聊了一句/.test(diaries[0].content));

  const remembers = memCalls('remember').length, updates = memCalls('update').length;
  await journal.flush();
  check('没有新东西就不重复写', memCalls('remember').length === remembers && memCalls('update').length === updates);

  // ---- 过了早上 6 点：前一天收个尾 ----
  journal.state.today.day = '2000-01-01';
  journal.note('punch');
  journal.state.today.day = '2000-01-01'; // note 会触发 roll，这里模拟"昨天"还没收尾
  journal.state.today.lastAt = Date.now();
  check('跨天时把前一天放进待写', journal.roll() === true && journal.state.pending.some((p) => p.day === '2000-01-01'));
  mock.setReply((body) => (/工作日记/.test(body.system) ? '2000-01-01 测试那天被揍了一顿。' : 'mock 回话'));
  await journal.flush();
  check('前一天的日记写进去了', mock.mem.some((m) => m.subcategory === '工作日记' && m.date === '2000-01-01'));

  // ---- 记忆库挂了：聊天不受影响 ----
  await (async () => { const c = talk; c.openChat(); })();
  await waitFor(async () => { const c = talk.getChatWindow(); return c && !c.isDestroyed() && c.isVisible(); }, 5000);
  const chat3 = talk.getChatWindow();
  await waitFor(async () => chat3.webContents.executeJavaScript('!!window.talk'), 3000);
  mock.close();
  await chat3.webContents.executeJavaScript(`talk.setKey('${mock.KEY}')`);
  const r3 = await chat3.webContents.executeJavaScript(`talk.ask('记忆库挂了也能聊吗')`);
  check('记忆库/接口连不上时好好报错，不崩', !r3.ok && /连不上|太久/.test(r3.error), r3.error);
  await chat3.webContents.executeJavaScript(`talk.setMem({ token: '' })`);
  chat3.close();
};
