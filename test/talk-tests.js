// 自测：跟红蛋说话、读模型列表（用 test/mock-server.js 假装 API，不花钱、不碰真 key）
const fs = require('fs');
const path = require('path');

exports.run = async ({ app, win, talk, check, sleep, waitFor, js }) => {
  const mock = await require('./mock-server').start();
  const errLog = path.join(app.getPath('userData'), 'error.log');
  const errBefore = fs.existsSync(errLog) ? fs.readFileSync(errLog, 'utf8').length : 0;

  talk.openChat();
  const chatUp = await waitFor(async () => {
    const c = talk.getChatWindow();
    return c && !c.isDestroyed() && c.isVisible();
  }, 5000);
  check('右键「跟红蛋说话」能打开聊天小窗', chatUp);
  const chat = talk.getChatWindow();
  const cj = (code) => chat.webContents.executeJavaScript(code);
  await waitFor(async () => cj('!!window.talk && !!document.getElementById("modelSel")'), 3000);

  // ---- 读模型列表 ----
  let r = await cj(`talk.models({ format: 'anthropic', url: '${mock.base}' })`);
  check('没存 key 时读模型会提示先存 key', !r.ok && /key/.test(r.error), r.error);

  await cj(`talk.setKey('${mock.KEY}')`);
  r = await cj(`talk.models({ format: 'anthropic', url: '${mock.base}' })`);
  const last = mock.calls[mock.calls.length - 1];
  check('Claude 格式：GET 根地址/v1/models，带 x-api-key 和 anthropic-version',
    r.ok && last.path === '/v1/models' && last.headers['x-api-key'] === mock.KEY && last.headers['anthropic-version'] === '2023-06-01',
    JSON.stringify(r.models));
  check('有 display_name 就带上', r.ok && r.models[0].name === 'Claude Test 1' && r.models[1].name === '');
  r = await cj(`talk.models({ format: 'anthropic', url: '${mock.base}/v1' })`);
  check('地址带 /v1 也能拼对', r.ok && mock.calls[mock.calls.length - 1].path === '/v1/models');
  r = await cj(`talk.models({ format: 'anthropic', url: '${mock.base}/v1/messages' })`);
  check('地址是完整的 /v1/messages 也能拼对', r.ok && mock.calls[mock.calls.length - 1].path === '/v1/models');

  r = await cj(`talk.models({ format: 'openai', url: '${mock.base}' })`);
  const lo = mock.calls[mock.calls.length - 1];
  check('OpenAI 格式：GET 根地址/models，带 Bearer',
    r.ok && lo.path === '/models' && lo.headers.authorization === 'Bearer ' + mock.KEY && r.models.map((m) => m.id).join() === 'gpt-test-a,gpt-test-b',
    JSON.stringify(r.models));
  r = await cj(`talk.models({ format: 'openai', url: '${mock.base}/chat/completions' })`);
  check('OpenAI 地址带 /chat/completions 也能拼对', r.ok && mock.calls[mock.calls.length - 1].path === '/models');

  r = await cj(`talk.models({ format: 'openai', url: '${mock.base}/bad' })`);
  check('key 不对时说 key 不对', !r.ok && /key 不对/.test(r.error), r.error);
  mock.setModels('404');
  r = await cj(`talk.models({ format: 'openai', url: '${mock.base}' })`);
  check('这家不提供列表时说清楚、让手填', !r.ok && /不提供模型列表/.test(r.error), r.error);
  mock.setModels('none');
  r = await cj(`talk.models({ format: 'openai', url: '${mock.base}' })`);
  check('列表是空的也说清楚', !r.ok && /手填/.test(r.error), r.error);
  mock.setModels('ok');
  r = await cj(`talk.models({ format: 'openai', url: 'http://127.0.0.1:9' })`);
  check('地址连不上时说地址/网络', !r.ok && /连不上|太久/.test(r.error), r.error);
  r = await cj(`talk.models({ format: 'openai', url: 'http://example.com' })`);
  check('不是 https 的地址不发', !r.ok && /https/.test(r.error), r.error);

  // ---- 设置页：下拉框 ----
  await cj(`talk.setCfg({ preset: 'custom', format: 'anthropic', url: '${mock.base}', model: '' })`);
  await cj(`(async () => { location.reload(); })()`).catch(() => {});
  await sleep(800);
  await waitFor(async () => cj('!!document.getElementById("settings")').catch(() => false), 3000);
  await cj(`document.getElementById('gear').click(); 0`);
  const filled = await waitFor(async () => cj(`document.getElementById('modelSel').options.length === 3`), 4000);
  check('打开设置自动读出模型放进下拉框', filled, await cj(`[...document.getElementById('modelSel').options].map(o => o.textContent).join(' | ')`));
  await cj(`(() => { const s = document.getElementById('modelSel'); s.value = 'claude-test-2'; s.dispatchEvent(new Event('change')); })(); 0`);
  await sleep(400);
  const st = await cj('talk.state()');
  check('在下拉框里选了就保存', st.cfg.model === 'claude-test-2', st.cfg.model);
  check('手填输入框还在（后备）', await cj(`document.getElementById('modelName').value === 'claude-test-2' && document.getElementById('modelName').offsetParent !== null`));

  // ---- 说话 ----
  await cj(`document.getElementById('back').click(); 0`);
  r = await cj(`talk.ask('你好呀')`);
  const lm = mock.calls.filter((c) => c.path === '/v1/messages').pop();
  check('Claude 格式能说话', r.ok && r.reply === 'mock 回话', JSON.stringify(r));
  check('发出去的是选好的模型', lm && lm.body.model === 'claude-test-2');
  const bubble = await js(`document.getElementById('bubble').textContent`);
  check('回的话也冒在蛋头顶的气泡里', bubble === 'mock 回话', bubble);

  await cj(`talk.setCfg({ preset: 'custom', format: 'openai', url: '${mock.base}', model: 'gpt-test-a' })`);
  r = await cj(`talk.ask('再说一句')`);
  check('OpenAI 兼容格式能说话', r.ok && r.reply === 'mock 回话', JSON.stringify(r));

  await cj(`talk.setCfg({ preset: 'custom', format: 'openai', url: '${mock.base}/bad', model: 'gpt-test-a' })`);
  r = await cj(`talk.ask('坏 key')`);
  check('key 不对时友好提示', !r.ok && /key/.test(r.error), r.error);

  const errAfter = fs.existsSync(errLog) ? fs.readFileSync(errLog, 'utf8').slice(errBefore) : '';
  const unexpected = errAfter.split('\n').filter((l) => l && !/API 错误 401/.test(l));
  check('没有意外报错', unexpected.length === 0, unexpected.join(' / ').slice(0, 300));

  talk.getChatWindow() && talk.getChatWindow().close();
  await sleep(300);
  return mock;
};
