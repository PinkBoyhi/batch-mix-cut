# 自动更新和同步发布说明

## 当前方案

软件使用 `electron-updater` 检查 GitHub Releases：

```text
https://github.com/PinkBoyhi/batch-mix-cut/releases/latest/download/
```

Windows 会读取 `latest.yml`，macOS 会读取 `latest-mac.yml`。只要同一个 GitHub Release 里同时有 Windows 和 Mac 的安装包、blockmap 和 yml 文件，两边客户端就能各自检查并下载新版本。

注意：已经安装的 `0.1.6` 仍然指向旧更新源，必须先手动安装一次 `0.1.7`。从 `0.1.7` 开始，后续版本才会从 GitHub Releases 自动检查更新。

## 发布新版本

1. 修改 `package.json` 里的版本号，例如从 `0.1.7` 改成 `0.1.8`。
2. 本地验证：

```bash
pnpm typecheck
pnpm test
pnpm build
```

3. 提交并推送：

```bash
git add .
git commit -m "Release 0.1.8"
git push
```

4. 创建并推送版本标签：

```bash
git tag v0.1.8
git push origin v0.1.8
```

5. GitHub Actions 会自动运行 `Desktop Release`，生成并发布：

```text
医博生物混剪工具-x.x.x-x64.exe
医博生物混剪工具-x.x.x-x64.exe.blockmap
latest.yml
医博生物混剪工具-x.x.x-arm64.dmg
医博生物混剪工具-x.x.x-arm64.dmg.blockmap
latest-mac.yml
```

也可以手动打开 GitHub 仓库的 Actions，选择 `Desktop Release`，点击 `Run workflow` 来发布当前 `package.json` 版本。

## 组员怎么更新

- 第一次安装：手动发送对应平台安装包。
- 后续更新：组员打开软件后会自动检查更新。
- 也可以在软件左侧“更新”区域点击“检查更新”。
- 下载完成后点击“重启安装”。

## 重要限制

- GitHub Releases 必须能被客户端电脑访问。如果仓库是私有的，普通用户的软件可能无法下载更新文件。
- 每次发布必须增加版本号，否则客户端会认为没有新版本。
- Windows 和 Mac 要同步发布同一个版本号，避免组员反馈时版本混乱。
- macOS 安装包当前没有 Apple 开发者签名，首次打开可能需要右键“打开”，或到“系统设置 > 隐私与安全性”里允许。
