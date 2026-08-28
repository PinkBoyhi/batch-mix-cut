import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { scanProject } from "../services/projectScanner.js";
import { JobManager } from "../services/jobManager.js";
import { YunguanjiaClient } from "../services/yunguanjiaClient.js";
import { resolveWorkflowTitle } from "../services/workflowTitle.js";
import { DASHBOARD_CSS, DASHBOARD_HTML, DASHBOARD_JS } from "./dashboardPage.js";
import { FeishuNotifier } from "./feishuNotifier.js";
import { WorkflowStore } from "./workflowStore.js";
import type {
  BatchJobSnapshot,
  CloudLocalUploadJob,
  CloudLocalUploadVideo,
  CloudSettings,
  MixProjectConfig,
  WorkflowCreateInput,
  WorkflowPatchInput,
  WorkflowRecord,
  WorkflowStatus
} from "../../src/shared/types.js";

interface ServerJob {
  id: string;
  manager: JobManager;
  snapshot: BatchJobSnapshot;
  config: MixProjectConfig;
  createdAt: string;
  started: boolean;
  workflowId: string;
  desktopTracked: boolean;
}

const host = readArg("--host", process.env.MIX_SERVER_HOST ?? "0.0.0.0");
const port = Number(readArg("--port", process.env.MIX_SERVER_PORT ?? "8787"));
const workspaceRoot = path.resolve(readArg("--workspace", process.env.MIX_SERVER_WORKSPACE ?? path.join(process.cwd(), "mix-server-workspace")));
const allowAnyPath = process.env.MIX_SERVER_ALLOW_ANY_PATH === "1";
const maxUploadBytes = Number(process.env.MIX_SERVER_MAX_UPLOAD_MB ?? "20480") * 1024 * 1024;
const maxConcurrentJobs = Math.max(1, Number(process.env.MIX_SERVER_MAX_CONCURRENT_JOBS ?? "2") || 2);
const minFreeBytes = Math.max(1, Number(process.env.MIX_SERVER_MIN_FREE_GB ?? "30") || 30) * 1024 * 1024 * 1024;
const projectRetentionHours = readNonNegativeNumber(process.env.MIX_SERVER_PROJECT_RETENTION_HOURS, 24);
const projectCleanupIntervalMs = 60 * 60 * 1000;
const accessToken = process.env.MIX_SERVER_TOKEN || randomBytes(24).toString("hex");
const audioPipelineVersion = 4;
const combinationPipelineVersion = 3;
const jobs = new Map<string, ServerJob>();
const workflowStore = new WorkflowStore(workspaceRoot);
const feishuNotifier = new FeishuNotifier({
  webhook: process.env.FEISHU_BOT_WEBHOOK,
  secret: process.env.FEISHU_BOT_SECRET,
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  chatId: process.env.FEISHU_CHAT_ID,
  dashboardUrl: process.env.MIX_DASHBOARD_URL
});
let dispatchingJobs = false;

async function main(): Promise<void> {
  await fs.mkdir(path.join(workspaceRoot, "uploads"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "projects"), { recursive: true });
  await cleanupExpiredServerProjects();
  const cleanupTimer = setInterval(() => {
    void cleanupExpiredServerProjects();
  }, projectCleanupIntervalMs);
  cleanupTimer.unref();
  await workflowStore.initialize();
  workflowStore.on("terminal", (record) => {
    if (!shouldNotifyWorkflow(record)) {
      workflowStore.setNotification(record.id, "disabled");
      return;
    }
    void feishuNotifier.notify(record).then((result) => {
      workflowStore.setNotification(record.id, result.status, result.error);
    });
  });
  for (const interrupted of workflowStore.list("interrupted", 500)) {
    if (interrupted.notificationStatus === "pending" && shouldNotifyWorkflow(interrupted)) {
      void feishuNotifier.notify(interrupted).then((result) => {
        workflowStore.setNotification(interrupted.id, result.status, result.error);
      });
    }
  }

  const server = http.createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`服务器请求失败：${request.method ?? "UNKNOWN"} ${request.url ?? "/"}\n${error instanceof Error ? error.stack ?? message : message}`);
      if (!response.headersSent && !response.writableEnded) {
        sendJson(response, 500, { ok: false, error: message });
      } else {
        response.destroy(error instanceof Error ? error : undefined);
      }
    });
  });

  server.listen(port, host, () => {
    console.log(`医博生物混剪服务器已启动：http://${host}:${port}`);
    console.log(`工作目录：${workspaceRoot}`);
    console.log(`访问 Token：${accessToken}`);
    console.log(`进度看板：http://${host}:${port}/dashboard`);
    console.log(`飞书提醒：${feishuNotifier.isEnabled() ? "已启用" : "未配置"}`);
  });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  setCors(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/dashboard") {
    sendText(response, 200, DASHBOARD_HTML, "text/html; charset=utf-8");
    return;
  }

  if (request.method === "GET" && url.pathname === "/dashboard/styles.css") {
    sendText(response, 200, DASHBOARD_CSS, "text/css; charset=utf-8");
    return;
  }

  if (request.method === "GET" && url.pathname === "/dashboard/app.js") {
    sendText(response, 200, DASHBOARD_JS, "text/javascript; charset=utf-8");
    return;
  }

  if (url.pathname !== "/health" && !isAuthorized(request)) {
    sendJson(response, 401, { ok: false, error: "未授权，请在 x-mix-token 请求头传入服务器启动时显示的 Token" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    const storage = await readStorageStatus();
    sendJson(response, 200, {
      ok: true,
      service: "yibo-batch-mix-server",
      workspaceRoot,
      authRequired: true,
      audioPipelineVersion,
      combinationPipelineVersion,
      jobs: jobs.size,
      activeJobs: countActiveJobs(),
      queuedJobs: countQueuedJobs(),
      maxConcurrentJobs,
      projectRetentionHours,
      storage
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/auth/check") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/workflows") {
    const body = await readJson<WorkflowCreateInput>(request);
    const record = workflowStore.create(body);
    sendJson(response, 201, { ok: true, record });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/workflows") {
    const rawStatus = url.searchParams.get("status") || undefined;
    const status = isWorkflowStatus(rawStatus) ? rawStatus : undefined;
    const limit = Number(url.searchParams.get("limit") ?? "200");
    sendJson(response, 200, { ok: true, records: workflowStore.list(status, limit) });
    return;
  }

  const workflowMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)$/);
  if (workflowMatch) {
    const workflowId = decodeURIComponent(workflowMatch[1]);
    if (request.method === "GET") {
      const record = workflowStore.get(workflowId);
      if (!record) {
        sendJson(response, 404, { ok: false, error: "看板任务不存在" });
        return;
      }
      sendJson(response, 200, { ok: true, record });
      return;
    }
    if (request.method === "PATCH") {
      const patch = await readJson<WorkflowPatchInput>(request);
      const record = workflowStore.update(workflowId, patch);
      if (!record) {
        sendJson(response, 404, { ok: false, error: "看板任务不存在" });
        return;
      }
      sendJson(response, 200, { ok: true, record });
      return;
    }
  }

  if (request.method === "POST" && url.pathname === "/api/projects/upload") {
    const name = safeSegment(url.searchParams.get("name") || "project");
    const uploadedZip = path.join(workspaceRoot, "uploads", `${Date.now()}-${name}.zip`);
    const projectDir = path.join(workspaceRoot, "projects", `${Date.now()}-${name}`);
    await saveRequestBodyToFile(request, uploadedZip);
    await fs.mkdir(projectDir, { recursive: true });
    await unzip(uploadedZip, projectDir);
    sendJson(response, 200, { ok: true, projectDir });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/files/upload") {
    const relativePath = url.searchParams.get("path") ?? "";
    const targetPath = resolveWorkspaceRelativePath(relativePath);
    await saveRequestBodyToFile(request, targetPath);
    sendJson(response, 200, { ok: true, path: targetPath });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/scan") {
    const body = await readJson<{ projectDir: string; templateDraftPath?: string }>(request);
    assertAllowedPath(body.projectDir);
    if (body.templateDraftPath) {
      assertAllowedPath(body.templateDraftPath);
    }
    const result = await scanProject(body.projectDir, body.templateDraftPath);
    sendJson(response, 200, { ok: true, result });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/jobs/from-project") {
    const body = await readJson<{ projectDir: string; templateDraftPath?: string; overrides?: Partial<MixProjectConfig>; workflowId?: string }>(request);
    assertAllowedPath(body.projectDir);
    if (body.templateDraftPath) {
      assertAllowedPath(body.templateDraftPath);
    }
    const scan = await scanProject(body.projectDir, body.templateDraftPath);
    const config = {
      ...scan.config,
      ...(body.overrides ?? {})
    };
    await validateMixConfig(config);
    const job = await startJob(config, body.workflowId);
    sendJson(response, 200, { ok: true, jobId: job.id, snapshot: job.snapshot, warnings: scan.warnings });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/jobs") {
    const body = await readJson<{ config: MixProjectConfig; workflowId?: string }>(request);
    await validateMixConfig(body.config);
    const job = await startJob(body.config, body.workflowId);
    sendJson(response, 200, { ok: true, jobId: job.id, snapshot: job.snapshot });
    return;
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)(?:\/([^/]+))?(?:\/(.+))?$/);
  if (jobMatch) {
    const [, jobId, action, rest] = jobMatch;
    const job = jobs.get(jobId);
    if (!job) {
      sendJson(response, 404, { ok: false, error: "任务不存在" });
      return;
    }

    if (request.method === "GET" && !action) {
      sendJson(response, 200, { ok: true, jobId, snapshot: job.snapshot });
      return;
    }

    if (request.method === "POST" && action === "pause") {
      if (!job.started) {
        sendJson(response, 200, { ok: true, snapshot: job.snapshot });
        return;
      }
      job.snapshot = await job.manager.pause();
      sendJson(response, 200, { ok: true, snapshot: job.snapshot });
      return;
    }

    if (request.method === "POST" && action === "resume") {
      if (!job.started) {
        sendJson(response, 200, { ok: true, snapshot: job.snapshot });
        return;
      }
      job.snapshot = await job.manager.resume();
      sendJson(response, 200, { ok: true, snapshot: job.snapshot });
      return;
    }

    if (request.method === "POST" && action === "stop") {
      if (!job.started) {
        job.snapshot = {
          ...job.snapshot,
          status: "idle",
          message: "已从服务器等待队列移除",
          finishedAt: new Date().toISOString()
        };
        syncWorkflowFromJob(job, job.snapshot);
        await dispatchQueuedJobs();
        sendJson(response, 200, { ok: true, snapshot: job.snapshot });
        return;
      }
      job.snapshot = await job.manager.stop();
      sendJson(response, 200, { ok: true, snapshot: job.snapshot });
      return;
    }

    if (request.method === "POST" && action === "retry") {
      if (!job.started) {
        sendJson(response, 409, { ok: false, error: "服务器任务尚未开始，暂时不能重试" });
        return;
      }
      job.snapshot = await job.manager.retryFailures();
      sendJson(response, 200, { ok: true, snapshot: job.snapshot });
      return;
    }

    if (request.method === "GET" && action === "outputs") {
      const videosDir = path.join(job.config.outputDir, "videos");
      if (!rest) {
        const files = await listOutputVideos(videosDir);
        sendJson(response, 200, { ok: true, files });
        return;
      }
      const filePath = path.join(videosDir, safeSegment(decodeURIComponent(rest)));
      assertAllowedPath(filePath);
      await sendFile(response, filePath);
      return;
    }

    if (request.method === "POST" && action === "cloud" && rest === "upload") {
      const body = await readJson<{ settings: CloudSettings; videos: CloudLocalUploadVideo[] }>(request);
      if (job.snapshot.status !== "completed") {
        sendJson(response, 409, { ok: false, error: "服务器混剪任务尚未完成，暂时不能上传成片" });
        return;
      }
      workflowStore.update(job.workflowId, {
        stage: "cloud_upload",
        status: "active",
        progress: { current: 0, total: body.videos.length, percent: 0, unit: "videos", message: "正在上传成片到云管家" },
        totalVideos: body.videos.length
      });
      const client = new YunguanjiaClient(() => path.join(workspaceRoot, ".cloud"));
      await client.saveSettings(body.settings);
      const uploadPlan = await resolveCloudUploadVideos(path.join(job.config.outputDir, "videos"), body.videos);
      const uploadedResult = await client.uploadLocalVideos(uploadPlan.videos);
      const result: CloudLocalUploadJob = {
        ...uploadedResult,
        uploaded: uploadedResult.uploaded.map((uploaded) => ({
          ...uploaded,
          localPath: uploadPlan.originalPathByResolvedPath.get(uploaded.localPath) ?? uploaded.localPath
        })),
        skipped: uploadPlan.skipped
      };
      workflowStore.update(job.workflowId, {
        stage: "cloud_processing",
        status: "active",
        cloudRequestId: result.importJob.requestId,
        progress: {
          current: result.uploaded.length,
          total: body.videos.length,
          percent: body.videos.length ? Math.round((result.uploaded.length / body.videos.length) * 100) : 100,
          unit: "videos",
          message: "成片已上传，等待云管家处理"
        }
      });
      sendJson(response, 200, { ok: true, result });
      return;
    }
  }

  sendJson(response, 404, { ok: false, error: "接口不存在" });
}

async function startJob(config: MixProjectConfig, requestedWorkflowId?: string): Promise<ServerJob> {
  await assertStorageCapacity();
  const id = `srv_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const existingWorkflow = requestedWorkflowId ? workflowStore.get(requestedWorkflowId) : undefined;
  const workflow = existingWorkflow ?? workflowStore.create({
    displayName: resolveWorkflowTitle(config),
    executionTarget: "server",
    exportTarget: config.exportTarget,
    totalVideos: config.maxCombinations
  });
  const manager = new JobManager();
  let loggedFailureCount = 0;
  const job: ServerJob = {
    id,
    manager,
    snapshot: {
      id,
      status: "queued",
      total: 0,
      completed: 0,
      failed: 0,
      message: "正在等待服务器分身",
      failures: [],
      startedAt: new Date().toISOString()
    },
    config,
    createdAt: new Date().toISOString(),
    started: false,
    workflowId: workflow.id,
    desktopTracked: Boolean(existingWorkflow)
  };
  jobs.set(id, job);
  manager.on("update", (snapshot: BatchJobSnapshot) => {
    job.snapshot = snapshot;
    syncWorkflowFromJob(job, snapshot);
    if (snapshot.failures.length > loggedFailureCount) {
      const failure = snapshot.failures.at(-1);
      loggedFailureCount = snapshot.failures.length;
      console.error(`服务器混剪失败：${job.id} ${failure?.combinationId ?? "unknown"} ${failure?.message ?? snapshot.message}`);
    }
    if (isTerminalStatus(snapshot.status)) {
      console.log(`服务器任务结束：${job.id}，完成 ${snapshot.completed}，失败 ${snapshot.failed}，${snapshot.message}`);
    }
    if (isTerminalStatus(snapshot.status)) {
      void dispatchQueuedJobs();
    }
  });
  await dispatchQueuedJobs();
  return job;
}

async function dispatchQueuedJobs(): Promise<void> {
  if (dispatchingJobs) {
    return;
  }
  dispatchingJobs = true;
  try {
    while (countActiveJobs() < maxConcurrentJobs) {
      const nextJob = Array.from(jobs.values()).find((job) => !job.started && job.snapshot.status === "queued");
      if (!nextJob) {
        return;
      }
      nextJob.started = true;
      workflowStore.update(nextJob.workflowId, {
        stage: "mixing",
        status: "active",
        progress: { current: 0, total: 0, percent: 0, unit: "videos", message: "服务器已分配资源，正在启动混剪" }
      });
      try {
        nextJob.snapshot = await nextJob.manager.start(nextJob.config);
      } catch (error) {
        nextJob.snapshot = {
          ...nextJob.snapshot,
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
          finishedAt: new Date().toISOString()
        };
        syncWorkflowFromJob(nextJob, nextJob.snapshot);
      }
    }
  } finally {
    dispatchingJobs = false;
  }
}

function countActiveJobs(): number {
  return Array.from(jobs.values()).filter((job) => job.started && !isTerminalStatus(job.snapshot.status)).length;
}

function countQueuedJobs(): number {
  return Array.from(jobs.values()).filter((job) => !job.started && job.snapshot.status === "queued").length;
}

function isTerminalStatus(status: BatchJobSnapshot["status"]): boolean {
  return status === "idle" || status === "completed" || status === "failed";
}

function syncWorkflowFromJob(job: ServerJob, snapshot: BatchJobSnapshot): void {
  const total = snapshot.total || job.config.maxCombinations || 0;
  const current = snapshot.completed + snapshot.failed;
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;
  if (snapshot.status === "queued") {
    workflowStore.update(job.workflowId, {
      stage: "queued",
      status: "active",
      progress: { current, total, percent, unit: "videos", message: snapshot.message },
      totalVideos: total,
      failedVideos: snapshot.failed
    });
    return;
  }
  if (["running", "paused", "stopping"].includes(snapshot.status)) {
    workflowStore.update(job.workflowId, {
      stage: "mixing",
      status: "active",
      progress: { current, total, percent, unit: "videos", message: snapshot.message },
      totalVideos: total,
      succeededVideos: snapshot.completed,
      failedVideos: snapshot.failed
    });
    return;
  }
  if (snapshot.status === "failed") {
    workflowStore.update(job.workflowId, {
      stage: "failed",
      status: "failed",
      progress: { current, total, percent, unit: "videos", message: snapshot.message },
      totalVideos: total,
      succeededVideos: snapshot.completed,
      failedVideos: Math.max(snapshot.failed, total - snapshot.completed),
      error: snapshot.message,
      finishedAt: snapshot.finishedAt
    });
    return;
  }
  if (snapshot.status === "idle") {
    workflowStore.update(job.workflowId, {
      stage: "stopped",
      status: "stopped",
      progress: { current, total, percent, unit: "videos", message: snapshot.message },
      totalVideos: total,
      succeededVideos: snapshot.completed,
      failedVideos: snapshot.failed,
      finishedAt: snapshot.finishedAt
    });
    return;
  }
  if (snapshot.status === "completed") {
    if (job.desktopTracked && job.config.exportMode !== "draft") {
      workflowStore.update(job.workflowId, {
        stage: "output_download",
        status: "active",
        progress: { current: 0, total: snapshot.completed, percent: 0, unit: "videos", message: "混剪完成，等待下载成片" },
        totalVideos: total,
        succeededVideos: snapshot.completed,
        failedVideos: snapshot.failed
      });
      return;
    }
    if (job.config.exportMode !== "draft" && ["cloud", "both"].includes(job.config.exportTarget)) {
      workflowStore.update(job.workflowId, {
        stage: "cloud_upload",
        status: "active",
        progress: { current: 0, total: snapshot.completed, percent: 0, unit: "videos", message: "混剪完成，等待上传云管家" },
        totalVideos: total,
        succeededVideos: snapshot.completed,
        failedVideos: snapshot.failed
      });
      return;
    }
    workflowStore.update(job.workflowId, {
      stage: "completed",
      status: snapshot.failed > 0 ? "partial" : "success",
      progress: { current: total, total, percent: 100, unit: "videos", message: snapshot.failed > 0 ? "任务完成，部分组合失败" : "任务已完成" },
      totalVideos: total,
      succeededVideos: snapshot.completed,
      failedVideos: snapshot.failed,
      finishedAt: snapshot.finishedAt
    });
  }
}

export function shouldNotifyWorkflow(record: WorkflowRecord): boolean {
  if (["failed", "stopped", "interrupted", "attention"].includes(record.status)) return true;
  if (!["cloud", "both"].includes(record.exportTarget)) return false;
  if (!["success", "partial"].includes(record.status)) return false;
  return record.stage === "completed" && Boolean(record.cloudRequestId);
}

function isWorkflowStatus(value: string | undefined): value is WorkflowStatus {
  return ["active", "success", "partial", "failed", "stopped", "interrupted", "attention"].includes(value ?? "");
}

function readArg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function readNonNegativeNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isAuthorized(request: IncomingMessage): boolean {
  return request.headers["x-mix-token"] === accessToken;
}

function setCors(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "content-type,x-mix-token");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function sendText(response: ServerResponse, status: number, data: string, contentType: string): void {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(data);
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 25 * 1024 * 1024) {
      throw new Error("JSON 请求体过大");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

async function saveRequestBodyToFile(request: IncomingMessage, targetPath: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const declaredSize = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declaredSize) && declaredSize > maxUploadBytes) {
    throw new Error("上传文件超过服务器限制");
  }
  const temporaryPath = `${targetPath}.uploading-${randomUUID()}`;
  try {
    await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(temporaryPath);
    let size = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) {
        request.unpipe(output);
        output.destroy();
        reject(error);
        return;
      }
      resolve();
    };
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxUploadBytes) {
        const error = new Error("上传文件超过服务器限制");
        finish(error);
        request.destroy(error);
      }
    });
    request.pipe(output);
    output.on("finish", () => {
      if (Number.isFinite(declaredSize) && declaredSize > 0 && size !== declaredSize) {
        finish(new Error(`上传文件不完整：预期 ${declaredSize} 字节，实际 ${size} 字节`));
        return;
      }
      finish();
    });
    output.on("error", (error) => finish(error));
    request.on("aborted", () => finish(new Error("客户端中断上传")));
    request.on("error", (error) => finish(error));
    });
    await fs.rename(temporaryPath, targetPath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function unzip(zipPath: string, targetDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("unzip", ["-q", zipPath, "-d", targetDir]);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `unzip 退出码 ${code}`));
      }
    });
  });
}

async function validateMixConfig(config: MixProjectConfig): Promise<void> {
  validateConfigPaths(config);
  if (config.slots.length === 0) {
    throw new Error("至少需要添加一个视频段落后才能开始服务器混剪");
  }
  const emptySlot = config.slots.find((slot) => slot.assets.length === 0);
  if (emptySlot) {
    throw new Error(`段落 ${emptySlot.name} 没有视频素材，无法开始服务器混剪`);
  }
  const assets = new Map<string, { name: string; path: string }>();
  for (const slot of config.slots) {
    for (const asset of slot.assets) assets.set(asset.path, asset);
  }
  for (const asset of config.bgmAssets) assets.set(asset.path, asset);
  for (const track of config.bgmTracks ?? []) {
    for (const asset of track.assets) assets.set(asset.path, asset);
  }
  for (const asset of assets.values()) {
    if (/^https?:\/\//i.test(asset.path)) continue;
    const stat = await fs.stat(asset.path).catch(() => undefined);
    if (!stat?.isFile() || stat.size <= 0) {
      throw new Error(`服务器素材不存在或上传不完整：${asset.name}`);
    }
  }
}

function validateConfigPaths(config: MixProjectConfig): void {
  assertAllowedPath(config.projectDir);
  assertAllowedPath(config.outputDir);
  if (config.templateDraftPath) {
    assertAllowedPath(config.templateDraftPath);
  }
  for (const slot of config.slots) {
    for (const asset of slot.assets) {
      assertAllowedAssetPath(asset.path);
    }
  }
  for (const asset of config.bgmAssets) {
    assertAllowedAssetPath(asset.path);
  }
  for (const track of config.bgmTracks ?? []) {
    for (const asset of track.assets) {
      assertAllowedAssetPath(asset.path);
    }
  }
}

async function assertStorageCapacity(): Promise<void> {
  const storage = await readStorageStatus();
  if (storage.freeBytes < storage.minFreeBytes) {
    throw new Error(`服务器可用空间不足（剩余 ${formatGigabytes(storage.freeBytes)}GB，需要至少 ${formatGigabytes(storage.minFreeBytes)}GB）。请先清理已回传到本地的旧服务器项目。`);
  }
}

async function cleanupExpiredServerProjects(): Promise<void> {
  if (projectRetentionHours <= 0) {
    return;
  }
  const activeProjectDirs = new Set(
    Array.from(jobs.values())
      .filter((job) => !isTerminalStatus(job.snapshot.status))
      .map((job) => path.resolve(job.config.projectDir))
  );
  const removed = await cleanupExpiredProjects(
    path.join(workspaceRoot, "projects"),
    projectRetentionHours * 60 * 60 * 1000,
    activeProjectDirs
  );
  if (removed > 0) {
    console.log(`已自动清理 ${removed} 个超过 ${projectRetentionHours} 小时的服务器项目`);
  }
}

export async function cleanupExpiredProjects(
  projectsDir: string,
  retentionMs: number,
  activeProjectDirs: ReadonlySet<string> = new Set(),
  now = Date.now()
): Promise<number> {
  if (retentionMs <= 0) {
    return 0;
  }
  const entries = await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    const projectDir = path.resolve(projectsDir, entry.name);
    if (activeProjectDirs.has(projectDir)) {
      continue;
    }
    const stat = await fs.stat(projectDir).catch(() => undefined);
    if (!stat || now - stat.mtimeMs < retentionMs) {
      continue;
    }
    await fs.rm(projectDir, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

async function readStorageStatus(): Promise<{ freeBytes: number; totalBytes: number; usedPercent: number; minFreeBytes: number }> {
  const stats = await fs.statfs(workspaceRoot);
  const blockSize = Number(stats.bsize);
  const totalBytes = Number(stats.blocks) * blockSize;
  const freeBytes = Number(stats.bavail) * blockSize;
  const usedPercent = totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 100) : 0;
  return { freeBytes, totalBytes, usedPercent, minFreeBytes };
}

function formatGigabytes(bytes: number): string {
  return (Math.max(0, bytes) / 1024 / 1024 / 1024).toFixed(1);
}

function assertAllowedAssetPath(filePath: string): void {
  if (/^https?:\/\//i.test(filePath)) {
    return;
  }
  assertAllowedPath(filePath);
}

function assertAllowedPath(filePath: string): void {
  if (allowAnyPath) {
    return;
  }
  const resolved = path.resolve(filePath);
  if (resolved !== workspaceRoot && !resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error(`路径不在服务器工作目录内：${resolved}`);
  }
}

function resolveWorkspaceRelativePath(relativePath: string): string {
  const normalized = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
  if (path.isAbsolute(normalized) || normalized.startsWith(`..${path.sep}`) || normalized === "..") {
    throw new Error("上传路径非法");
  }
  const resolved = path.resolve(workspaceRoot, normalized);
  assertAllowedPath(resolved);
  return resolved;
}

function safeSegment(value: string): string {
  return value.replace(/[\\/:\0]/g, "_").replace(/^\.+$/, "_").slice(0, 120) || "untitled";
}

async function listOutputVideos(dir: string): Promise<Array<{ name: string; path: string; size: number; url: string }>> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".mp4")) {
      continue;
    }
    const filePath = path.join(dir, entry.name);
    const stat = await fs.stat(filePath);
    files.push({
      name: entry.name,
      path: filePath,
      size: stat.size,
      url: `/api/jobs/:jobId/outputs/${encodeURIComponent(entry.name)}`
    });
  }
  return files.sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true }));
}

async function sendFile(response: ServerResponse, filePath: string): Promise<void> {
  const stat = await fs.stat(filePath);
  response.writeHead(200, {
    "content-type": "video/mp4",
    "content-length": stat.size,
    "content-disposition": `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`
  });
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.pipe(response);
    stream.on("end", resolve);
    stream.on("error", (error) => {
      response.destroy(error);
      reject(error);
    });
  });
}

export interface CloudUploadPlan {
  videos: CloudLocalUploadVideo[];
  originalPathByResolvedPath: Map<string, string>;
  skipped: NonNullable<CloudLocalUploadJob["skipped"]>;
}

export async function resolveCloudUploadVideos(outputDir: string, requestedVideos: CloudLocalUploadVideo[]): Promise<CloudUploadPlan> {
  const outputFiles = await listOutputVideos(outputDir);
  const filesByName = new Map(outputFiles.map((file) => [file.name, file.path]));
  const videos: CloudLocalUploadVideo[] = [];
  const originalPathByResolvedPath = new Map<string, string>();
  const skipped: NonNullable<CloudLocalUploadJob["skipped"]> = [];

  for (const video of requestedVideos) {
    const fileName = safeSegment(fileNameFromAnyPlatformPath(video.localPath));
    const resolvedPath = filesByName.get(fileName);
    if (!resolvedPath) {
      skipped.push({
        localPath: video.localPath,
        videoName: video.videoName,
        reason: "服务器未找到对应的已生成 MP4 成片"
      });
      continue;
    }
    videos.push({ ...video, localPath: resolvedPath });
    originalPathByResolvedPath.set(resolvedPath, video.localPath);
  }

  if (videos.length === 0) {
    throw new Error(`服务器没有找到可上传的 MP4 成片。实际生成 ${outputFiles.length} 个，匹配到 0 个；请检查导出方式是否包含视频。`);
  }

  return { videos, originalPathByResolvedPath, skipped };
}

function fileNameFromAnyPlatformPath(filePath: string): string {
  return filePath.trim().split(/[\\/]/).filter(Boolean).pop() ?? "";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
