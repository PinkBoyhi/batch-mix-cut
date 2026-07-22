# GitHub 管理和发布流程

## GitHub 负责什么

1. 管代码：功能更新、Bug 修复、版本记录都进仓库。
2. 打安装包：GitHub Actions 同时生成 Windows 和 macOS 安装包。
3. 发更新：GitHub Releases 保存安装包和 `latest.yml / latest-mac.yml`，软件从这里检查更新。

当前自动更新地址：

```text
https://github.com/PinkBoyhi/batch-mix-cut/releases/latest/download/
```

如果仓库保持私有，普通用户的软件可能无法直接下载更新文件。要让组员无感更新，建议让 Release 文件公开可访问，或者后续换成对象存储、NAS、Nginx 等固定静态地址。

## 每次更新功能

1. 改代码。
2. 修改 `package.json` 版本号。
3. 本地验证：

```bash
pnpm typecheck
pnpm test
pnpm build
```

4. 提交并推送：

```bash
git add .
git commit -m "描述这次更新"
git push
```

## 同步发布 Win + Mac

推荐用 tag 触发发布：

```bash
git tag v0.1.8
git push origin v0.1.8
```

GitHub Actions 会自动运行 `Desktop Release`，完成后 GitHub Releases 会出现对应版本。

也可以手动打开 GitHub 仓库的 Actions，选择 `Desktop Release`，点击 `Run workflow` 发布当前 `package.json` 版本。

Release 里应包含：

```text
*.exe
*.exe.blockmap
latest.yml
*.dmg
*.dmg.blockmap
latest-mac.yml
```

其中 Windows 客户端读取 `latest.yml`，macOS 客户端读取 `latest-mac.yml`。

## 分支建议

- `main`：稳定版本，组员使用的版本从这里发布。
- `dev`：日常开发版本，功能没完全稳定前先放这里。
- `codex/功能名`：让 Codex 修改某个功能时可以临时使用。

简单起步时只用 `main` 也可以。等组员开始依赖这个工具后，再加 `dev` 分支会更稳。

## 不要上传的内容

项目已经通过 `.gitignore` 排除了这些内容：

```text
node_modules/
.pnpm-store/
dist/
dist-electron/
release/
outputs/
```

这些都是依赖、构建产物或用户输出文件，不应该进 GitHub。
