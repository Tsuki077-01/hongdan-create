// 生成 App 图标：用 Electron 把 index.html 里的蛋渲染成 PNG，再拼成 macOS 的 .icns
// 用法：npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const svg = html.match(/<svg id="egg"[\s\S]*?<\/svg>/)[0]
  .replace('width="100" height="122"', 'width="640" height="781"');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const sizes = { ic07: 128, ic08: 256, ic09: 512, ic10: 1024 };
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, useContentSize: true });
  const page = `<html><body style="margin:0;width:1024px;height:1024px;display:flex;align-items:center;justify-content:center;background:transparent">
    <div style="width:824px;height:824px;border-radius:185px;background:linear-gradient(#FFF6EE,#FDE3D3);display:flex;align-items:center;justify-content:center">
    <style>#squint,#xeyes{display:none}</style>${svg}</div></body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
  await new Promise((r) => setTimeout(r, 300));
  const big = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const chunks = [];
  for (const [type, size] of Object.entries(sizes)) {
    const png = big.resize({ width: size, height: size, quality: 'best' }).toPNG();
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    chunks.push(head, png);
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);
  fs.writeFileSync(path.join(root, 'build', 'icon.icns'), Buffer.concat([header, body]));
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), big.toPNG());
  app.quit();
});
