# 手动更新和发布说明

## 当前方案

软件不再做应用内自动下载和自动安装。更新区只负责检查 GitHub Releases 是否有新版本，并打开下载页面：

```text
https://github.com/PinkBoyhi/batch-mix-cut/releases/latest
```

用户需要在 GitHub 发布页手动下载对应平台安装包，然后自行安装覆盖。

## 发布新版本

1. 修改 `package.json` 里的版本号，例如从 `0.1.21` 改成 `0.1.22`。
2. 本地验证：

```bash
pnpm typecheck
pnpm test
pnpm build
```

3. 打包：

```bash
pnpm dist:mac
pnpm dist:win
```

4. 提交并推送：

```bash
git add .
git commit -m "Release 0.1.22"
git push
```

5. 创建 GitHub Release，并上传 `release/` 目录里的 macOS、Windows 安装包。

## 组员怎么更新

- 打开软件左侧“更新”区域。
- 点击“检查更新”。
- 点击“打开下载页”。
- 在 GitHub Releases 页面下载对应系统安装包，手动安装。

## 重要限制

- GitHub Releases 必须能被用户电脑访问。
- 每次发布必须增加版本号，否则软件会认为没有新版本。
- Windows 和 Mac 要同步发布同一个版本号，避免反馈时版本混乱。
- macOS 安装包当前没有 Apple 开发者签名，首次打开可能需要右键“打开”，或到“系统设置 > 隐私与安全性”里允许。
