# 手动更新和发布说明

## 当前方案

Windows 版可以在应用内检查、下载并安装更新；大体积安装包优先从公司内网混剪服务器下载，内网不可用时回退 GitHub。macOS 版仍打开 GitHub 发布页手动下载：

```text
https://github.com/PinkBoyhi/batch-mix-cut/releases/latest
```

0.1.67 起，Windows 用户可在“检查更新”后直接确认下载，完成后程序自动重启并覆盖安装。首次安装 0.1.67 或更高版本仍需手动下载安装一次。

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
- Windows：确认更新后等待下载和自动安装。
- macOS：点击“打开下载页”，下载对应安装包后手动安装。

## 重要限制

- Windows 检查版本信息仍需访问 GitHub；大体积安装包可从内网服务器下载。
- 每次发布必须增加版本号，否则软件会认为没有新版本。
- Windows 和 Mac 要同步发布同一个版本号，避免反馈时版本混乱。
- macOS 安装包当前没有 Apple 开发者签名，首次打开可能需要右键“打开”，或到“系统设置 > 隐私与安全性”里允许。
