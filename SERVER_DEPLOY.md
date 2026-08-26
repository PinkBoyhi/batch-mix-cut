# 服务器混剪节点

服务器节点用于把混剪计算放到 Linux 服务器上执行。素材需要先放到服务器工作目录，或通过 ZIP 上传接口传到服务器。

## 启动

```bash
pnpm build
MIX_SERVER_HOST=0.0.0.0 \
MIX_SERVER_PORT=8787 \
MIX_SERVER_TOKEN="替换为一段随机长密码" \
MIX_SERVER_MAX_CONCURRENT_JOBS=2 \
FEISHU_BOT_WEBHOOK="https://open.feishu.cn/open-apis/bot/v2/hook/替换为机器人地址" \
FEISHU_BOT_SECRET="机器人开启签名校验时填写，否则留空" \
FEISHU_APP_ID="也可以填写飞书自建应用 App ID" \
FEISHU_APP_SECRET="飞书自建应用 App Secret" \
FEISHU_CHAT_ID="接收提醒的群会话 ID" \
MIX_DASHBOARD_URL="http://10.0.0.133:8787" \
pnpm server -- --workspace /home/fczj/mix-work
```

## 进度看板与飞书提醒

服务器启动后，在公司内网的手机或电脑浏览器打开：

```text
http://10.0.0.133:8787/dashboard
```

首次进入时输入同一个 `MIX_SERVER_TOKEN`。看板会显示素材传输、排队、混剪、成片下载、云管家上传和云端处理结果。任务历史保存在服务器工作目录的 `dashboard/workflows.json`，默认保留 30 天、最多 500 条。

飞书提醒配置：

- `FEISHU_BOT_WEBHOOK`：目标飞书群的自定义机器人 Webhook；不填则只使用看板。
- `FEISHU_BOT_SECRET`：飞书机器人开启“签名校验”后填写，没有开启时可以留空。
- `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_CHAT_ID`：使用飞书自建应用机器人时填写；与 Webhook 二选一，Webhook 配置存在时优先使用 Webhook。
- `MIX_DASHBOARD_URL`：手机能访问的服务器地址，飞书消息会附带看板链接。

成功提醒仅在云管家返回最终成功或部分成功结果后发送；混剪完成、文件上传完成但云端仍在处理时不会提前通知。上传失败、处理超时或任务意外中断会发送异常提醒。飞书通知发送失败会自动重试 3 次，不会影响混剪或云管家上传结果。

## 升级到 0.1.44 及以上

服务器混剪节点只负责混剪和提供成片下载；云管家上传统一由桌面端在本机执行。0.1.44 起服务器会报告组合引擎版本，旧服务器将被桌面端阻止启动，避免多条成片连续使用同一个 A 段开头。进入服务器上的本项目代码目录后执行：

```bash
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
```

然后使用你原来的方式重启 `pnpm server` 服务（例如 systemd、pm2 或启动脚本）。桌面端会在服务器任务完成后下载当前任务 `outputs/videos/` 中真实生成的 MP4；任务中失败的组合会被自动跳过，不会再因不存在的文件中断整批发布。

启动日志会打印访问 Token，调用除 `/health` 外的接口时需要带请求头：

```bash
x-mix-token: <启动日志里的 Token>
```

## 任务分身与并发

- 桌面端点击“新建任务分身”可创建独立项目窗口；每个窗口可使用不同素材、输出目录和服务器设置。
- 服务器默认同时执行 `2` 个独立项目，由 `MIX_SERVER_MAX_CONCURRENT_JOBS` 调整。
- 超出并发数的任务会显示“正在等待服务器分身”，当前面项目完成后自动开始。
- 单个项目内部仍按组合顺序导出，避免一个项目同时启动大量 FFmpeg。
- 4 核 CPU 建议设置 `1-2`，8 核及以上可从 `2-3` 开始测试；高分辨率、高码率素材需要降低并发数。

## 安全建议

- 不要把 8787 端口直接暴露到公网；优先经公司 VPN、内网、反向代理 HTTPS 或防火墙白名单访问。
- `MIX_SERVER_TOKEN` 相当于服务器密码，不要放在截图、群聊或公开仓库。
- 服务器工作目录会保存上传素材和导出结果，请预留足够磁盘空间并定期清理历史项目。

## 接口

健康检查：

```bash
curl http://10.0.0.133:8787/health
```

上传项目 ZIP：

```bash
curl -X POST "http://10.0.0.133:8787/api/projects/upload?name=test" \
  -H "x-mix-token: <TOKEN>" \
  --data-binary @project.zip
```

扫描服务器项目目录：

```bash
curl -X POST "http://10.0.0.133:8787/api/scan" \
  -H "content-type: application/json" \
  -H "x-mix-token: <TOKEN>" \
  -d '{"projectDir":"/home/fczj/mix-work/projects/test"}'
```

扫描并启动混剪：

```bash
curl -X POST "http://10.0.0.133:8787/api/jobs/from-project" \
  -H "content-type: application/json" \
  -H "x-mix-token: <TOKEN>" \
  -d '{"projectDir":"/home/fczj/mix-work/projects/test","overrides":{"maxCombinations":10,"outputNamePattern":"成品","exportMode":"video"}}'
```

查询任务：

```bash
curl -H "x-mix-token: <TOKEN>" http://10.0.0.133:8787/api/jobs/<JOB_ID>
```

查询看板任务：

```bash
curl -H "x-mix-token: <TOKEN>" "http://10.0.0.133:8787/api/workflows?limit=200"
```

查询输出视频：

```bash
curl -H "x-mix-token: <TOKEN>" http://10.0.0.133:8787/api/jobs/<JOB_ID>/outputs
```
