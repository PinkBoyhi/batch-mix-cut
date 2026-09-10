import fs from "node:fs/promises";
import path from "node:path";
import type { BatchJobSnapshot, MixProjectConfig } from "../../src/shared/types.js";

export interface PersistedServerJob {
  version: 1;
  id: string;
  config: MixProjectConfig;
  snapshot: BatchJobSnapshot;
  createdAt: string;
  workflowId: string;
  desktopTracked: boolean;
}

export class ServerJobStore {
  private readonly directory: string;
  private readonly chains = new Map<string, Promise<void>>();

  constructor(workspaceRoot: string) {
    this.directory = path.join(workspaceRoot, "queue");
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
  }

  async load(): Promise<PersistedServerJob[]> {
    await this.initialize();
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    const records: PersistedServerJob[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(this.directory, entry.name), "utf8"));
        if (isPersistedServerJob(parsed)) records.push(parsed);
      } catch (error) {
        console.error(`无法读取服务器恢复任务 ${entry.name}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  save(record: PersistedServerJob): Promise<void> {
    return this.enqueue(record.id, async () => {
      await this.initialize();
      const target = this.filePath(record.id);
      const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
      await fs.rename(temporary, target);
    });
  }

  remove(jobId: string): Promise<void> {
    return this.enqueue(jobId, async () => {
      await fs.unlink(this.filePath(jobId)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    });
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.chains.values());
  }

  private enqueue(jobId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(jobId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.chains.set(jobId, next);
    void next.finally(() => {
      if (this.chains.get(jobId) === next) this.chains.delete(jobId);
    }).catch(() => undefined);
    return next;
  }

  private filePath(jobId: string): string {
    if (!/^srv_[a-zA-Z0-9_-]+$/.test(jobId)) throw new Error("服务器任务 ID 非法");
    return path.join(this.directory, `${jobId}.json`);
  }
}

function isPersistedServerJob(value: unknown): value is PersistedServerJob {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PersistedServerJob>;
  return record.version === 1
    && typeof record.id === "string"
    && typeof record.createdAt === "string"
    && typeof record.workflowId === "string"
    && typeof record.desktopTracked === "boolean"
    && Boolean(record.config && typeof record.config === "object")
    && Boolean(record.snapshot && typeof record.snapshot === "object");
}
