# 服务器混剪节点

服务器节点用于把混剪计算放到 Linux 服务器上执行。素材需要先放到服务器工作目录，或通过 ZIP 上传接口传到服务器。

## 启动

```bash
pnpm build
MIX_SERVER_HOST=0.0.0.0 MIX_SERVER_PORT=8787 pnpm server -- --workspace /home/fczj/mix-work
```

启动日志会打印访问 Token，调用除 `/health` 外的接口时需要带请求头：

```bash
x-mix-token: <启动日志里的 Token>
```

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
