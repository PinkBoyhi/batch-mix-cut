import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  BatchJobSnapshot,
  JobFailure,
  MixCombination,
  MixProjectConfig
} from "../../src/shared/types.js";
import { assertOutputAvailable } from "./outputFiles.js";
import { createCombinations } from "./combinator.js";
import { exportVideo, type ExportHandle } from "./ffmpeg.js";
import { generateJianyingDraft } from "./jianyingDraft.js";

export interface JobStartOptions {
  resumeExistingOutputs?: boolean;
}

export class JobManager extends EventEmitter {
  private snapshot: BatchJobSnapshot = createEmptySnapshot();
  private config?: MixProjectConfig;
  private combinations: MixCombination[] = [];
  private failedCombinationIds = new Set<string>();
  private currentExport?: ExportHandle;
  private stopped = false;
  private paused = false;
  private running = false;

  getSnapshot(): BatchJobSnapshot {
    return structuredClone(this.snapshot);
  }

  async start(config: MixProjectConfig, options: JobStartOptions = {}): Promise<BatchJobSnapshot> {
    if (this.running) {
      throw new Error("已有任务正在运行");
    }

    config = structuredClone(config);
    this.config = config;
    this.combinations = createCombinations(
      config.slots,
      config.bgmAssets,
      config.outputDir,
      config.maxCombinations ?? 100,
      config.outputNamePattern,
      config.bgmTracks
    );
    if (this.combinations.length === 0) throw new Error("没有可导出的组合，请检查段落素材和最大数量");
    if (options.resumeExistingOutputs) await cleanupStalePartialOutputs(config.outputDir);
    const pendingCombinations = options.resumeExistingOutputs
      ? await selectPendingCombinations(config, this.combinations)
      : this.combinations;
    const recoveredCount = this.combinations.length - pendingCombinations.length;
    this.failedCombinationIds.clear();
    this.stopped = false;
    this.paused = false;
    this.running = true;
    this.snapshot = {
      id: `job_${Date.now()}`,
      status: "running",
      total: this.combinations.length,
      completed: recoveredCount,
      failed: 0,
      message: recoveredCount > 0 ? `服务器重启恢复：已确认 ${recoveredCount} 条成片，继续处理剩余 ${pendingCombinations.length} 条` : "任务已开始",
      failures: [],
      startedAt: new Date().toISOString()
    };
    this.emitUpdate();

    void this.run(pendingCombinations);
    return this.getSnapshot();
  }

  async pause(): Promise<BatchJobSnapshot> {
    if (this.snapshot.status === "running") {
      this.paused = true;
      this.snapshot.status = "paused";
      this.snapshot.message = "任务已暂停，当前 FFmpeg 子任务会先完成";
      this.emitUpdate();
    }
    return this.getSnapshot();
  }

  async resume(): Promise<BatchJobSnapshot> {
    if (this.snapshot.status === "paused") {
      this.paused = false;
      this.snapshot.status = "running";
      this.snapshot.message = "任务已继续";
      this.emitUpdate();
    }
    return this.getSnapshot();
  }

  async stop(): Promise<BatchJobSnapshot> {
    if (this.running) {
      this.stopped = true;
      this.paused = false;
      this.snapshot.status = "stopping";
      this.snapshot.message = "正在停止任务";
      this.currentExport?.cancel();
      this.emitUpdate();
    }
    return this.getSnapshot();
  }

  async retryFailures(): Promise<BatchJobSnapshot> {
    if (this.running) {
      throw new Error("任务运行中，不能重试失败项");
    }
    if (!this.config || this.failedCombinationIds.size === 0) {
      return this.getSnapshot();
    }

    const retryItems = this.combinations.filter((item) => this.failedCombinationIds.has(item.id));
    this.failedCombinationIds.clear();
    this.stopped = false;
    this.paused = false;
    this.running = true;
    this.snapshot = {
      ...this.snapshot,
      status: "running",
      total: retryItems.length,
      completed: 0,
      failed: 0,
      failures: [],
      message: "正在重试失败项",
      startedAt: new Date().toISOString(),
      finishedAt: undefined
    };
    this.emitUpdate();

    void this.run(retryItems);
    return this.getSnapshot();
  }

  private async run(items: MixCombination[]): Promise<void> {
    const config = this.config;
    if (!config) {
      return;
    }

    try {
      await fs.mkdir(config.outputDir, { recursive: true });
      // Reject the whole batch before encoding if an output already exists.
      for (const combination of items) {
        if (this.stopped) break;
        if (config.exportMode !== "draft") await assertOutputAvailable(combination.targetVideoPath);
      }

      for (const combination of items) {
        await this.waitWhilePaused();
        if (this.stopped) {
          break;
        }

        this.snapshot.currentCombinationId = combination.id;
        this.snapshot.message = `正在处理 ${combination.id}`;
        this.emitUpdate();

        try {
          if (config.exportMode === "video" || config.exportMode === "both") {
            this.currentExport = exportVideo(config, combination);
            await this.currentExport.promise;
            this.currentExport = undefined;
          }

          if (config.exportMode === "draft" || config.exportMode === "both") {
            await generateJianyingDraft(config, combination);
          }

          this.snapshot.completed += 1;
          this.snapshot.message = `${combination.id} 已完成`;
          this.emitUpdate();
        } catch (error) {
          this.currentExport = undefined;
          if (this.stopped) break;
          const phase = config.exportMode === "draft" ? "draft" : "video";
          this.recordFailure(combination, phase, error);
        }
      }

      this.running = false;
      this.snapshot.currentCombinationId = undefined;
      this.snapshot.finishedAt = new Date().toISOString();
      this.snapshot.status = this.stopped ? "idle" : "completed";
      this.snapshot.message = this.stopped ? "任务已停止" : "批量任务已完成";
      this.emitUpdate();
    } catch (error) {
      this.running = false;
      this.snapshot.status = "failed";
      this.snapshot.finishedAt = new Date().toISOString();
      this.snapshot.message = error instanceof Error ? error.message : String(error);
      this.emitUpdate();
    }
  }

  private recordFailure(combination: MixCombination, phase: JobFailure["phase"], error: unknown): void {
    this.failedCombinationIds.add(combination.id);
    this.snapshot.failed += 1;
    this.snapshot.failures.push({
      combinationId: combination.id,
      phase,
      message: error instanceof Error ? error.message : String(error)
    });
    this.snapshot.message = `${combination.id} 失败，已继续后续任务`;
    this.emitUpdate();
  }

  private async waitWhilePaused(): Promise<void> {
    while (this.paused && !this.stopped) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  private emitUpdate(): void {
    this.emit("update", this.getSnapshot());
  }
}

async function selectPendingCombinations(config: MixProjectConfig, combinations: MixCombination[]): Promise<MixCombination[]> {
  const pending: MixCombination[] = [];
  for (const combination of combinations) {
    if (!(await hasPublishedOutput(config, combination))) pending.push(combination);
  }
  return pending;
}

async function hasPublishedOutput(config: MixProjectConfig, combination: MixCombination): Promise<boolean> {
  const videoReady = config.exportMode === "draft" || await isPublishedFile(combination.targetVideoPath);
  const draftReady = config.exportMode === "video" || await pathExists(combination.targetDraftPath);
  return videoReady && draftReady;
}

async function isPublishedFile(filePath: string): Promise<boolean> {
  const stat = await fs.stat(filePath).catch(() => undefined);
  return Boolean(stat?.isFile() && stat.size > 0);
}

async function pathExists(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then(() => true, () => false);
}

async function cleanupStalePartialOutputs(outputDir: string): Promise<void> {
  const entries = await fs.readdir(outputDir, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(outputDir, entry.name);
    if (entry.isDirectory()) {
      await cleanupStalePartialOutputs(entryPath);
    } else if (entry.isFile() && entry.name.includes(".partial")) {
      await fs.rm(entryPath, { force: true });
    }
  }));
}

function createEmptySnapshot(): BatchJobSnapshot {
  return {
    id: "idle",
    status: "idle",
    total: 0,
    completed: 0,
    failed: 0,
    message: "等待开始",
    failures: []
  };
}
