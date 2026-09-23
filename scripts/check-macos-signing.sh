#!/bin/bash
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "用法：$0 <macOS.dmg> [--allow-adhoc-preview]" >&2
  exit 2
fi

dmg_path="$1"
mode="${2:-official}"
if [ "$mode" != "official" ] && [ "$mode" != "--allow-adhoc-preview" ]; then
  echo "未知验收模式：$mode" >&2
  exit 2
fi
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
codesign --verify --deep --strict --verbose=2 "$app_path"

if [ "$mode" = "--allow-adhoc-preview" ]; then
  if ! grep -q '^Signature=adhoc$' <<<"$signature_details"; then
    echo "测试包不是预期的完整 ad-hoc 签名。" >&2
    exit 1
  fi
  echo "macOS 测试包结构签名验收通过（未公证，仅用于测试）：$app_path"
else
  if ! grep -q '^Authority=Developer ID Application:' <<<"$signature_details"; then
    echo "应用未使用 Developer ID Application 证书签名。" >&2
    exit 1
  fi
  if ! grep -Eq '^TeamIdentifier=.+$' <<<"$signature_details" || grep -q '^TeamIdentifier=not set$' <<<"$signature_details"; then
    echo "应用签名缺少有效的 Apple TeamIdentifier。" >&2
    exit 1
  fi
  xcrun stapler validate "$app_path"
  spctl -a -vvv -t open "$app_path"
  echo "macOS 正式签名与公证验收通过：$app_path"
fi
