#!/bin/bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "用法：$0 <macOS.dmg>" >&2
  exit 2
fi

dmg_path="$1"
if [ ! -f "$dmg_path" ]; then
  echo "找不到 macOS 安装包：$dmg_path" >&2
  exit 2
fi

mount_dir="$(mktemp -d "${TMPDIR:-/tmp}/yibo-macos-signing.XXXXXX")"
cleanup() {
  hdiutil detach "$mount_dir" >/dev/null 2>&1 || true
  rmdir "$mount_dir" >/dev/null 2>&1 || true
}
trap cleanup EXIT

hdiutil verify "$dmg_path" >/dev/null
hdiutil attach "$dmg_path" -nobrowse -readonly -mountpoint "$mount_dir" >/dev/null
app_path="$(find "$mount_dir" -maxdepth 1 -type d -name '*.app' -print -quit)"
if [ -z "$app_path" ]; then
  echo "DMG 中没有找到应用程序。" >&2
  exit 1
fi

signature_details="$(codesign -dv --verbose=4 "$app_path" 2>&1)"
if ! grep -q '^Authority=Developer ID Application:' <<<"$signature_details"; then
  echo "应用未使用 Developer ID Application 证书签名。" >&2
  exit 1
fi
if ! grep -Eq '^TeamIdentifier=.+$' <<<"$signature_details" || grep -q '^TeamIdentifier=not set$' <<<"$signature_details"; then
  echo "应用签名缺少有效的 Apple TeamIdentifier。" >&2
  exit 1
fi

codesign --verify --deep --strict --verbose=2 "$app_path"
xcrun stapler validate "$app_path"
spctl -a -vvv -t open "$app_path"
echo "macOS 签名与公证验收通过：$app_path"
