import fs from "node:fs/promises";
import path from "node:path";
import type {
  BatchJobSnapshot,
  MixExecutionTarget,
  MixProjectConfig,
  WorkflowCreateInput,
  WorkflowPatchInput,
  WorkflowRecord
} from "../../src/shared/types.js";

const CONFIG_FILE = "remote-mix-server.json";

interface ServerSettings {
  serverUrl: string;
  token: string;
}

export interface WorkflowUploader {
  uploaderName?: string;
  uploaderLogin?: string;
}

export class WorkflowMonitorClient {
  private workflowId?: string;
  private settings?: ServerSettings;
  private lastReportAt = 0;

  constructor(private readonly getUserDataDir: () => string) {}

  get id(): string | undefined {
    return this.workflowId;
  }

  reset(): void {
    this.workflowId = undefined;
    this.lastReportAt = 0;
  }

  async start(
    taskId: string,
    config: MixProjectConfig,
    executionTarget: MixExecutionTarget,
    uploader: WorkflowUploader = {}
  ): Promise<string | undefined> {
    this.settings = await this.readSettings().catch(() => undefined);
    if (!this.settings?.serverUrl || !this.settings.token) return undefined;
    const input: WorkflowCreateInput = {
      displayName: path.basename(config.outputDir) || config.outputNamePattern || "混剪任务",
      uploaderName: uploader.uploaderName,
      uploaderLogin: uploader.uploaderLogin,
      taskId,
      executionTarget,
      exportTarget: config.exportTarget,
      totalVideos: config.maxCombinations
    };
    try {
      const response = await this.request<{ ok: true; record: WorkflowRecord }>("POST", "/api/workflows", input);
      this.workflowId = response.record.id;
      return this.workflowId;
    } catch {
      this.workflowId = undefined;
      return undefined;
    }
  }

  async startCloudOnly(
    taskId: string,
    displayName: string,
    totalVideos: number,
    uploader: WorkflowUploader = {}
  ): Promise<string | undefined> {
    this.settings = await this.readSettings().catch(() => undefined);
    if (!this.settings?.serverUrl || !this.settings.token) return undefined;
    try {
      const response = await this.request<{ ok: true; record: WorkflowRecord }>("POST", "/api/workflows", {
        displayName,
        uploaderName: uploader.uploaderName,
        uploaderLogin: uploader.uploaderLogin,
        taskId,
        executionTarget: "local",
        exportTarget: "cloud",
        totalVideos
      } satisfies WorkflowCreateInput);
      this.workflowId = response.record.id;
      return this.workflowId;
    } catch {
      this.workflowId = undefined;
      return undefined;
    }
  }

  async update(patch: WorkflowPatchInput, throttle = false): Promise<void> {
    if (!this.workflowId || !this.settings) return;
    const now = Date.now();
    if (throttle && now - this.lastReportAt < 750) return;
    this.lastReportAt = now;
    await this.request("PATCH", `/api/workflows/${encodeURIComponent(this.workflowId)}`, patch).catch(() => undefined);
  }

  async reportLocalJob(snapshot: BatchJobSnapshot, config: MixProjectConfig): Promise<void> {
    const total = snapshot.total || config.maxCombinations || 0;
    const current = snapshot.completed + snapshot.failed;
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    if (snapshot.status === "failed") {
      await this.update({
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
    if (snapshot.status === "idle" && snapshot.finishedAt) {
      await this.update({
        stage: "stopped",
        status: "stopped",
        progress: { current, total, percent, unit: "videos", message: snapshot.message },
        succeededVideos: snapshot.completed,
        failedVideos: snapshot.failed,
        finishedAt: snapshot.finishedAt
      });
      return;
    }
    if (snapshot.status === "completed") {
      const cloudPending = config.exportTarget === "cloud" || config.exportTarget === "both";
      await this.update({
        stage: cloudPending ? "cloud_upload" : "completed",
        status: cloudPending ? "active" : snapshot.failed > 0 ? "partial" : "success",
        progress: {
          current: cloudPending ? 0 : total,
          total: cloudPending ? snapshot.completed : total,
          percent: cloudPending ? 0 : 100,
          unit: "videos",
          message: cloudPending ? "混剪完成，等待上传云管家" : snapshot.failed > 0 ? "任务完成，部分组合失败" : "任务已完成"
        },
        totalVideos: total,
        succeededVideos: snapshot.completed,
        failedVideos: snapshot.failed,
        finishedAt: cloudPending ? undefined : snapshot.finishedAt
      });
      return;
    }
    await this.update({
      stage: snapshot.status === "queued" ? "queued" : "mixing",
      status: "active",
      progress: { current, total, percent, unit: "videos", message: snapshot.message },
      totalVideos: total,
      succeededVideos: snapshot.completed,
      failedVideos: snapshot.failed
    }, true);
  }

  private async request<T>(method: "POST" | "PATCH", endpoint: string, body: unknown): Promise<T> {
    if (!this.settings) throw new Error("监控服务器未配置");
    const response = await fetch(`${this.settings.serverUrl}${endpoint}`, {
      method,
      headers: { "Content-Type": "application/json", "x-mix-token": this.settings.token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) throw new Error(`监控服务器请求失败：HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }

  private async readSettings(): Promise<ServerSettings> {
    const parsed = JSON.parse(await fs.readFile(path.join(this.getUserDataDir(), CONFIG_FILE), "utf8")) as Partial<ServerSettings>;
    const serverUrl = String(parsed.serverUrl ?? "").trim().replace(/\/+$/, "");
    const token = String(parsed.token ?? "").trim();
    if (!serverUrl || !token) throw new Error("服务器地址或 Token 缺失");
    return { serverUrl, token };
  }
}
