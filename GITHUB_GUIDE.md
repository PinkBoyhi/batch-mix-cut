# GitHub 管理和发布流程

## 推荐结构

GitHub 负责三件事：

1. 管代码：所有功能更新、Bug 修复、版本记录都进仓库。
2. 打安装包：用 GitHub Actions 在 Windows 环境生成 `.exe`。
3. 留发布记录：用 GitHub Releases 或独立更新目录保存每个版本的安装包。

自动更新文件仍建议放在一个固定静态地址，例如：

```text
https://your-domain.com/batch-mix-cut/updates/
```

也可以先用 GitHub Releases 管安装包，但 `electron-updater` 的 generic 更新源最好使用长期固定、可直接访问的静态目录。

## 第一次上传到 GitHub

1. 在 GitHub 新建一个空仓库，例如：

```text
batch-mix-cut
```

2. 本地绑定远程仓库：

```bash
git remote add origin https://github.com/你的用户名/batch-mix-cut.git
```

3. 提交代码：

```bash
git add .
git commit -m "Initial batch mix cut app"
git branch -M main
git push -u origin main
```

如果你用 SSH 地址，把第 2 步换成：

```bash
git remote add origin git@github.com:你的用户名/batch-mix-cut.git
```

## 每次更新功能

1. 改代码。
2. 本地验证：

```bash
pnpm typecheck
pnpm test
pnpm build
```

3. 提交：

```bash
git add .
git commit -m "描述这次更新"
git push
```

## 发 Windows 新版本

1. 修改 `package.json` 的版本号，例如：

```json
"version": "0.1.1"
```

2. 提交并推送：

```bash
git add package.json pnpm-lock.yaml
git commit -m "Release 0.1.1"
git push
```

3. 打开 GitHub 仓库的 Actions。
4. 选择 `Windows Release`。
5. 点击 `Run workflow`。
6. 填入自动更新静态目录 URL。
7. 下载 `windows-release` artifact。
8. 把里面的这些文件上传到更新目录：

```text
*.exe
latest.yml
*.blockmap
```

组员打开旧版本软件后，会自动检查到新版本。也可以在软件左侧“更新”区域手动检查。

## 分支建议

- `main`：稳定版本，组员使用的版本从这里发。
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
