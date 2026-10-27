# 红蛋 🥚

一颗戴圆框眼镜的珊瑚橘色蛋蛋桌宠，住在 Mac 屏幕最下面。

## 安装（第一次）

1. 下载 `release/红蛋-Mac-Apple芯片.zip`（只支持 Apple 芯片 M1/M2/M3/M4… 的 Mac）。
2. 双击 zip 解压，把 `红蛋.app` 拖进「应用程序」文件夹。
3. 双击打开。因为没有苹果开发者证书，第一次会提示"无法验证开发者"：
   - 点「完成」/「好」关掉提示；
   - 打开「系统设置 → 隐私与安全性」，往下滚，看到"已阻止打开 红蛋"，点「仍要打开」，输入开机密码确认。
   - 之后就可以直接双击了。

## 怎么玩

- 平时：自己在屏幕底部慢慢滚，偶尔停下发呆、眨眼。蛋以外的地方鼠标能点穿。
- 单击：晃一晃、咕噜一声、冒气泡说话。
- 拖拽：拖到哪都行，松手会掉回屏幕底部弹一下。
- 右键菜单：揍 / 扶起来 / 今天挨了 N 顿 / 静音 / 退出。连续揍 3 下会 K.O.。

## 开发

```bash
npm install
npm start          # 运行
npm run dist:mac   # 打包 Apple 芯片版 Mac App 到 dist/
RCODESIGN=/path/to/rcodesign npm run release:mac   # 打包 + 本地签名 + 压缩到 release/
```

自动自测（在 Linux 虚拟屏幕上跑）：
`HONGDAN_TEST=1 xvfb-run -a npx electron . --no-sandbox --user-data-dir=/tmp/hd-test`
