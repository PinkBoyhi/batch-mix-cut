# 服务器混剪节点

服务器节点用于把混剪计算放到 Linux 服务器上执行。素材需要先放到服务器工作目录，或通过 ZIP 上传接口传到服务器。

## 启动

```bash
pnpm build
MIX_SERVER_HOST=0.0.0.0 \
MIX_SERVER_PORT=8787 \
MIX_SERVER_TOKEN="替换为一段随机长密码" \
MIX_SERVER_MAX_CONCURRENT_JOBS=2 \
pnpm server -- --workspace /home/fczj/mix-work
```

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

查询输出视频：

```bash
curl -H "x-mix-token: <TOKEN>" http://10.0.0.133:8787/api/jobs/<JOB_ID>/outputs
```
