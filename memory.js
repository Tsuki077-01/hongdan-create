// 红蛋的记忆库 —— 主进程这边：只走记忆库给红蛋单开的 /hongdan/* 小接口
// 令牌跟 API key 一样用 macOS 钥匙串加密，存在 ~/Library/Application Support/红蛋/memory-token.bin，不进代码仓库
// 权限在服务器那边管：红蛋只能写「红蛋·自己」里的 工作日记 / 给小克的留言，别的书架只能看，有些书架根本看不到
const { safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

const DEFAULT_URL = 'https://cloud-memory-mcp.tsuki-cc.workers.dev';
const OWN = '红蛋·自己';

module.exports = function setupMemory({ app, logError }) {
  const dir = () => app.getPath('userData');
  const tokenPath = () => path.join(dir(), 'memory-token.bin');
  const cfgPath = () => path.join(dir(), 'memory.json');

  let cfg = { url: DEFAULT_URL };
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(cfgPath(), 'utf8')) }; } catch (_) {}

  function saveToken(t) {
    t = String(t || '').trim();
    if (!t) { try { fs.unlinkSync(tokenPath()); } catch (_) {} return; }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('这台电脑上没法加密保存令牌');
    fs.writeFileSync(tokenPath(), safeStorage.encryptString(t), { mode: 0o600 });
  }
  function loadToken() {
    try { return safeStorage.decryptString(fs.readFileSync(tokenPath())); } catch (_) { return ''; }
  }
  function setUrl(url) {
    url = String(url || '').trim() || DEFAULT_URL;
    if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url)) throw new Error('地址要以 https:// 开头');
    cfg.url = url;
    try { fs.writeFileSync(cfgPath(), JSON.stringify(cfg)); } catch (e) { logError('保存记忆库地址失败：' + e.message); }
  }
  // 填的可能是连接器用的 …/mcp 地址，去掉
  const base = () => String(cfg.url || DEFAULT_URL).trim().replace(/\/+$/, '').replace(/\/(mcp|sse|hongdan)$/, '');
  const configured = () => !!loadToken();

  async function req(method, route, { query, body } = {}) {
    const token = loadToken();
    if (!token) throw new Error('还没填记忆库令牌');
    let url = base() + '/hongdan/' + route;
    if (query) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
      if ([...q].length) url += '?' + q;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let res;
    try {
      res = await fetch(url, {
        method, signal: ctrl.signal,
        headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error(e && e.name === 'AbortError' ? '记忆库太久没回音' : '连不上记忆库');
    } finally { clearTimeout(timer); }
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (res.status === 401) throw new Error('记忆库令牌不对');
    if (!res.ok) throw new Error((data && data.error) || '记忆库出错了（' + res.status + '）');
    return data;
  }

  return {
    OWN,
    DEFAULT_URL,
    configured,
    state: () => ({ hasToken: configured(), url: cfg.url }),
    saveToken, setUrl,
    catalog: () => req('GET', 'catalog'),
    list: (q) => req('GET', 'list', { query: q }),
    recall: (q) => req('GET', 'recall', { query: q }),
    remember: (b) => req('POST', 'remember', { body: { category: OWN, layer: '摘要', ...b } }),
    update: (b) => req('POST', 'update', { body: b }),
    forget: (ids) => req('POST', 'forget', { body: { ids } }),
  };
};
