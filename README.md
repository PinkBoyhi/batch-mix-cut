# 医博生物混剪工具

本地 Electron 桌面工具，用于按片段文件夹自动排列组合混剪视频、批量轮换 BGM，并可基于剪映模板草稿生成替换后的草稿副本。

## 素材目录约定

```text
项目目录/
  A/
    a1.mp4
    a2.mp4
  B/
    b1.mp4
    b2.mp4
  BGM/
    music1.mp3
    music2.mp3
  template-draft/
    draft_content.json
    ...
```

- `A/`、`B/`、`C/` 等文件夹会作为片段槽位。
- `BGM/` 会作为背景音乐池。
- `outputs/videos/` 输出直接合成的视频。
- `outputs/jianying-drafts/` 输出剪映草稿副本。

## 开发运行

```bash
pnpm install
pnpm dev
```

## 打包 macOS

```bash
pnpm dist
```

## macOS 首次打开提示损坏

当前测试版没有 Apple Developer ID 签名和公证。macOS 从浏览器下载后，可能提示“已损坏，无法打开”。这是 Gatekeeper 拦截，不是安装包真的坏了。

安装到“应用程序”后，在终端执行：

```bash
xattr -dr com.apple.quarantine /Applications/医博生物混剪工具.app
open /Applications/医博生物混剪工具.app
```

正式给外部成员长期分发时，需要购买 Apple Developer Program，并给 macOS 包做 Developer ID 签名和 Notarization。

## 剪映草稿说明

V1 通过复制模板草稿目录并替换草稿 JSON 中主轨视频素材引用来实现。剪映草稿不是官方稳定 API，所以工具始终只修改模板副本。拿到真实模板草稿后，应以该版本剪映的 JSON 结构继续增强适配。
