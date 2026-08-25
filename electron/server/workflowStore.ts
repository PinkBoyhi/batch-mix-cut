import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  WorkflowCreateInput,
  WorkflowPatchInput,
  WorkflowProgress,
  WorkflowRecord,
  WorkflowStage,
  WorkflowStatus
} from "../../src/shared/types.js";

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_RECORDS = 500;

export interface WorkflowStoreOptions {
  retentionDays?: number;
  maxRecords?: number;
}

export class WorkflowStore extends EventEmitter {
  private readonly records = new Map<string, WorkflowRecord>();
  private readonly filePath: string;
  private readonly retentionMs: number;
  private readonly maxRecords: number;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(workspaceRoot: string, options: WorkflowStoreOptions = {}) {
    super();
    this.filePath = path.join(workspaceRoot, "dashboard", "workflows.json");
    this.retentionMs = (options.retentionDays ?? DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  }

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8")) as { records?: WorkflowRecord[] };
      for (const record of parsed.records ?? []) {
        if (isWorkflowRecord(record)) {
          this.records.set(record.id, clone(record));
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    const now = new Date().toISOString();
    let changed = false;
    for (const [id, record] of this.records) {
      if (record.status === "active") {
        const next: WorkflowRecord = {
          ...record,
          stage: "interrupted",
          status: "interrupted",
          error: "混剪服务器重启，任务状态已中断",
          progress: { ...record.progress, message: "混剪服务器重启，任务状态已中断" },
          updatedAt: now,
          finishedAt: now,
          timeline: appendTimeline(record, "interrupted", "interrupted", "混剪服务器重启，任务状态已中断", now)
        };
        this.records.set(id, next);
        changed = true;
      }
    }
    changed = this.prune() || changed;
    if (changed) {
      await this.persistNow();
    }
  }

  create(input: WorkflowCreateInput): WorkflowRecord {
    const now = new Date().toISOString();
    const id = safeId(input.id) || `wf_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const existing = this.records.get(id);
    if (existing) {
      return clone(existing);
    }
    const message = "正在准备任务";
    const record: WorkflowRecord = {
      id,
      displayName: cleanText(input.displayName, 160) || "未命名任务",
      uploaderName: cleanText(input.uploaderName, 120) || undefined,
      uploaderLogin: cleanText(input.uploaderLogin, 120) || undefined,
      taskId: cleanText(input.taskId, 120) || undefined,
      executionTarget: input.executionTarget === "server" ? "server" : "local",
      exportTarget: ["cloud", "both"].includes(input.exportTarget) ? input.exportTarget : "local",
      stage: "asset_transfer",
      status: "active",
      progress: normalizeProgress({ current: 0, total: 0, percent: 0, unit: "items", message }),
      totalVideos: nonNegative(input.totalVideos),
      succeededVideos: 0,
      failedVideos: 0,
      startedAt: now,
      updatedAt: now,
      notificationStatus: "pending",
      timeline: [{ stage: "asset_transfer", status: "active", message, at: now }],
      videos: []
    };
    this.records.set(id, record);
    this.prune();
    this.queuePersist();
    this.emit("update", clone(record));
    return clone(record);
  }

  update(id: string, patch: WorkflowPatchInput): WorkflowRecord | undefined {
    const current = this.records.get(id);
    if (!current) return undefined;
    const wasTerminal = isTerminalWorkflowStatus(current.status);
    const now = new Date().toISOString();
    const nextStage = validStage(patch.stage) ? patch.stage : current.stage;
    const nextStatus = validStatus(patch.status) ? patch.status : current.status;
    const nextProgress = normalizeProgress({ ...current.progress, ...(patch.progress ?? {}) });
    const next: WorkflowRecord = {
      ...current,
      uploaderName: patch.uploaderName === undefined ? current.uploaderName : cleanText(patch.uploaderName, 120) || undefined,
      uploaderLogin: patch.uploaderLogin === undefined ? current.uploaderLogin : cleanText(patch.uploaderLogin, 120) || undefined,
      stage: nextStage,
      status: nextStatus,
      progress: nextProgress,
      totalVideos: patch.totalVideos === undefined ? current.totalVideos : nonNegative(patch.totalVideos),
      succeededVideos: patch.succeededVideos === undefined ? current.succeededVideos : nonNegative(patch.succeededVideos),
      failedVideos: patch.failedVideos === undefined ? current.failedVideos : nonNegative(patch.failedVideos),
      cloudRequestId: patch.cloudRequestId === undefined ? current.cloudRequestId : cleanText(patch.cloudRequestId, 180) || undefined,
      error: patch.error === undefined ? current.error : cleanText(patch.error, 1000) || undefined,
      finishedAt: patch.finishedAt === undefined ? current.finishedAt : normalizeDate(patch.finishedAt) ?? now,
      updatedAt: now,
      videos: patch.videos === undefined ? current.videos : sanitizeVideos(patch.videos),
      timeline: current.timeline
    };
    const message = nextProgress.message || stageLabel(nextStage);
    if (nextStage !== current.stage || nextStatus !== current.status || message !== current.progress.message) {
      next.timeline = appendTimeline(current, nextStage, nextStatus, message, now);
    }
    if (isTerminalWorkflowStatus(nextStatus) && !next.finishedAt) {
      next.finishedAt = now;
    }
    this.records.set(id, next);
    this.queuePersist();
    this.emit("update", clone(next));
    if (!wasTerminal && isTerminalWorkflowStatus(nextStatus)) {
      this.emit("terminal", clone(next));
    }
    return clone(next);
  }

  setNotification(id: string, status: WorkflowRecord["notificationStatus"], error?: string): void {
    const record = this.records.get(id);
    if (!record) return;
    record.notificationStatus = status;
    record.notificationError = error ? cleanText(error, 1000) : undefined;
    record.updatedAt = new Date().toISOString();
    this.queuePersist();
  }

  get(id: string): WorkflowRecord | undefined {
    const record = this.records.get(id);
    return record ? clone(record) : undefined;
  }

  list(status?: WorkflowStatus, limit = 200): WorkflowRecord[] {
    return Array.from(this.records.values())
      .filter((record) => !status || record.status === status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.min(Math.max(1, limit), 500))
      .map(clone);
  }

  async flush(): Promise<void> {
    await this.saveChain;
  }

  private prune(): boolean {
    const cutoff = Date.now() - this.retentionMs;
    const sorted = Array.from(this.records.values()).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const keep = new Set(
      sorted
        .filter((record, index) => record.status === "active" || (index < this.maxRecords && Date.parse(record.updatedAt) >= cutoff))
        .map((record) => record.id)
    );
    let changed = false;
    for (const id of this.records.keys()) {
      if (!keep.has(id)) {
        this.records.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  private queuePersist(): void {
    this.saveChain = this.saveChain.then(() => this.persistNow()).catch((error) => {
      console.error(`保存看板任务记录失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async persistNow(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    const payload = JSON.stringify({ version: 1, records: this.list(undefined, this.maxRecords) }, null, 2);
    await fs.writeFile(tempPath, `${payload}\n`, "utf8");
    await fs.rename(tempPath, this.filePath);
  }
}

export function isTerminalWorkflowStatus(status: WorkflowStatus): boolean {
  return ["success", "partial", "failed", "stopped", "interrupted", "attention"].includes(status);
}

function appendTimeline(
  current: WorkflowRecord,
  stage: WorkflowStage,
  status: WorkflowStatus,
  message: string,
  at: string
): WorkflowRecord["timeline"] {
  const timeline = [...current.timeline, { stage, status, message: cleanText(message, 500), at }];
  return timeline.slice(-80);
}

function normalizeProgress(progress: Partial<WorkflowProgress>): WorkflowProgress {
  const current = nonNegative(progress.current);
  const total = nonNegative(progress.total);
  const calculated = total > 0 ? Math.round((current / total) * 100) : nonNegative(progress.percent);
  return {
    current,
    total,
    percent: Math.min(100, calculated),
    unit: ["bytes", "videos"].includes(progress.unit ?? "") ? (progress.unit as WorkflowProgress["unit"]) : "items",
    message: cleanText(progress.message, 500) || "等待进度更新"
  };
}

function sanitizeVideos(videos: WorkflowPatchInput["videos"]): WorkflowRecord["videos"] {
  return (videos ?? []).slice(0, 50).map((video) => ({
    videoName: cleanText(video.videoName, 220) || "未命名视频",
    status: ["uploading", "processing", "success", "failed"].includes(video.status) ? video.status : "pending",
    message: cleanText(video.message, 500) || undefined,
    bytesUploaded: video.bytesUploaded === undefined ? undefined : nonNegative(video.bytesUploaded),
    bytesTotal: video.bytesTotal === undefined ? undefined : nonNegative(video.bytesTotal),
    videoId: typeof video.videoId === "number" || typeof video.videoId === "string" ? video.videoId : undefined
  }));
}

function validStage(value: unknown): value is WorkflowStage {
  return [
    "asset_transfer", "queued", "mixing", "output_download", "cloud_upload", "cloud_processing",
    "completed", "failed", "stopped", "interrupted", "attention"
  ].includes(String(value));
}

function validStatus(value: unknown): value is WorkflowStatus {
  return ["active", "success", "partial", "failed", "stopped", "interrupted", "attention"].includes(String(value));
}

function stageLabel(stage: WorkflowStage): string {
  const labels: Record<WorkflowStage, string> = {
    asset_transfer: "正在传输素材",
    queued: "正在排队",
    mixing: "正在混剪",
    output_download: "正在下载成片",
    cloud_upload: "正在上传云管家",
    cloud_processing: "云管家正在处理",
    completed: "任务已完成",
    failed: "任务失败",
    stopped: "任务已停止",
    interrupted: "任务意外中断",
    attention: "任务需要关注"
  };
  return labels[stage];
}

function nonNegative(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, maxLength) : "";
}

function safeId(value: unknown): string {
  const id = cleanText(value, 120);
  return /^[a-zA-Z0-9_-]+$/.test(id) ? id : "";
}

function normalizeDate(value: string): string | undefined {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function isWorkflowRecord(value: unknown): value is WorkflowRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as WorkflowRecord;
  return Boolean(safeId(candidate.id) && validStage(candidate.stage) && validStatus(candidate.status) && candidate.progress);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
