#!/usr/bin/env bash
# 打包后处理：删多余语言包 → rcodesign 本地签名 → 压缩到 release/
# 用法：RCODESIGN=/path/to/rcodesign scripts/sign-and-zip.sh（没有 rcodesign 时自动用 codesign）
set -euo pipefail
cd "$(dirname "$0")/.."
RC="${RCODESIGN:-rcodesign}"
APP="dist/红蛋-darwin-arm64/红蛋.app"

# 桌宠用不到的界面语言包，只留英文和中文
find "$APP" -type d -name "*.lproj" ! -name "en.lproj" ! -name "zh_CN.lproj" ! -name "zh_TW.lproj" ! -name "Base.lproj" -prune -exec rm -rf {} +

rm -rf "$APP/Contents/_CodeSignature"
if command -v "$RC" >/dev/null 2>&1; then
  "$RC" sign "$APP"
else
  # 没有 rcodesign 就用 macOS 自带的 codesign 做本地（ad-hoc）签名
  codesign --force --deep -s - "$APP"
  codesign --verify --deep --strict "$APP"
fi

mkdir -p release
rm -f "release/红蛋-Mac-Apple芯片.zip"
(cd "$(dirname "$APP")" && zip -qry9 "$OLDPWD/release/红蛋-Mac-Apple芯片.zip" 红蛋.app) # -y 保留 App 内部的链接
ls -la release
