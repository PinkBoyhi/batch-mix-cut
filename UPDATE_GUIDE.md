# Windows 打包和自动更新说明

## 方案

Windows 组员使用 NSIS 安装包。第一次安装时发送 `.exe` 安装包；之后每次发布新版本，把安装包和更新元数据上传到固定更新目录，软件会自动检查、下载，并提示重启安装。

当前更新源配置在 `package.json`：

```json
"publish": {
  "provider": "generic",
  "url": "https://example.com/batch-mix-cut/updates/"
}
```

正式发给组员前，把这个 URL 改成你自己的静态文件地址，例如：

```json
"url": "https://your-domain.com/batch-mix-cut/updates/"
```

这个地址只需要能公开或内网访问静态文件，不需要后端接口。

如果你还没有正式域名，可以先用内网静态目录，例如公司电脑、NAS、Nginx、IIS、对象存储都可以。关键是组员电脑能访问，并且地址长期不变。

## 第一次发安装包

1. 修改 `package.json` 的版本号，例如 `0.1.0`。
2. 把 `package.json` 里的更新 URL 改成正式地址。
3. 在 Windows 电脑上执行：

```bash
pnpm install
pnpm dist:win
```

4. 把 `release/` 目录里生成的 `.exe` 安装包发给组员安装。

## 后续发新版

1. 修改版本号，例如从 `0.1.0` 改成 `0.1.1`。
2. 执行：

```bash
pnpm dist:win
```

3. 上传生成的这些文件到更新源 URL 对应目录：

```text
批量混剪工具-0.1.1-x64.exe
latest.yml
*.blockmap
```

4. 组员打开软件后会自动检查更新。也可以在左侧“更新”区域手动点击“检查更新”。

## 注意

- Windows 自动更新依赖 `latest.yml`，不要只上传 `.exe`。
- 每次发布必须增加版本号，否则客户端不会认为有新版本。
- `publish:win` 脚本只负责构建并生成发布文件；generic 静态更新源通常仍需要你自己上传文件。
- 第一次安装必须手动发安装包，自动更新只负责后续版本。
- 如果更新源是内网地址，组员电脑必须能访问这个 URL。

## 推荐流程：GitHub Actions 自动打包

项目里已经提供 `.github/workflows/windows-release.yml`。放到 GitHub 仓库后，可以这样用：

1. 打开 GitHub 仓库的 Actions。
2. 选择 `Windows Release`。
3. 点击 `Run workflow`。
4. 填入你的更新源 URL。
5. 工作流结束后下载 `windows-release` artifact。
6. 第一次发布时，把 `.exe` 发给组员安装。
7. 后续发布时，把 artifact 里的 `.exe`、`latest.yml`、`*.blockmap` 上传到同一个更新目录。

这个方式的好处是：不用依赖你的 Mac 跨平台下载 Windows Electron 包，也不用让每个组员自己打包。以后你只维护代码和版本号，Windows 安装包由云端 Windows 环境生成。

## 本机打包失败时

在 macOS 上执行 `pnpm dist:win` 时，Electron Builder 会下载 Windows 版 Electron 和 NSIS 打包资源。如果网络不稳定，可能出现 `zip: not a valid zip file` 或 GitHub 下载失败。这不是代码错误，换到 Windows 电脑或 GitHub Actions 打包即可。
