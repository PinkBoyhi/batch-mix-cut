import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { assertOutputAvailable, publishOutput } from "./outputFiles.js";
import type {
  AssetInfo,
  BatchJobSnapshot,
  MixCombination,
  MixProjectConfig,
  RemoteMixSettings,
  RemoteMixSettingsView
} from "../../src/shared/types.js";
import { createCombinations } from "./combinator.js";
import { getLegacyConfigPath, getTaskScopedConfigPath } from "./taskScopedConfig.js";
import { WorkflowMonitorClient } from "./workflowMonitorClient.js";

const CONFIG_FILE = "remote-mix-server.json";
const DEFAULT_SERVER_URL = "http://10.0.0.133:8787";
const MIN_SERVER_AUDIO_PIPELINE_VERSION = 7;
const MIN_SERVER_COMBINATION_PIPELINE_VERSION = 3;
const REQUEST_TIMEOUT_MS = 20_000;
const TRANSFER_RETRY_ATTEMPTS = 3;
const POLL_FAILURE_LIMIT = 8;
const LOCAL_DOWNLOAD_MIN_RESERVE_BYTES = 1024 ** 3;
const LOCAL_DOWNLOAD_RESERVE_RATIO = 0.1;

interface StoredRemoteSettings extends RemoteMixSettings {}

interface RemoteHealth {
  ok: boolean;
  workspaceRoot: string;
  audioPipelineVersion?: number;
  combinationPipelineVersion?: number;
  storage?: {
    freeBytes?: number;
    minFreeBytes?: number;
  };
}

interface RemoteJobResponse {
  ok: boolean;
  jobId: string;
  snapshot: BatchJobSnapshot;
}

interface RemoteOutputsResponse {
  ok: boolean;
  files: Array<{ name: string; size: number; url: string }>;
}

export class RemoteMixClient extends EventEmitter {
  private currentJobId?: string;
  private currentConfig?: MixProjectConfig;
  private originalConfig?: MixProjectConfig;
  private monitor?: WorkflowMonitorClient;
  private currentSettings?: StoredRemoteSettings;
  private stopped = false;
  private starting = false;
  private polling = false;
  private transferController = new AbortController();
  private downloadedOutputs = new Map<string, number>();
  private snapshot: BatchJobSnapshot = emptySnapshot();

  constructor(
    private readonly getUserDataDir: () => string,
    private readonly taskId = "default"
  ) {
    super();
  }

  async getSettingsView(): Promise<RemoteMixSettingsView> {
    const settings = await this.readSettings();
    return {
      serverUrl: settings.serverUrl,
      hasToken: Boolean(settings.token)
    };
  }

  async saveSettings(settings: RemoteMixSettings): Promise<RemoteMixSettingsView> {
    const current = await this.readSettings();
    const next: StoredRemoteSettings = {
      serverUrl: normalizeServerUrl(settings.serverUrl || current.serverUrl || DEFAULT_SERVER_URL),
      token: settings.token?.trim() || current.token || ""
    };
    await this.writeSettings(next);
    return this.testConnection(next);
  }

  async testConnection(settings?: StoredRemoteSettings): Promise<RemoteMixSettingsView> {
    const activeSettings = settings ?? (await this.readSettings());
    const health = await this.requestJson<RemoteHealth>(activeSettings, "GET", "/health");
    if (activeSettings.token) {
      await this.requestJson<{ ok: boolean }>(activeSettings, "GET", "/api/auth/check");
    }
    if (!supportsCombinationPipeline(health)) {
      return {
        serverUrl: activeSettings.serverUrl,
        hasToken: Boolean(activeSettings.token),
        ok: false,
        message: "服务器混剪引擎较旧，无法保证开头素材轮换；请更新服务器后再开始混剪。"
      };
    }
    if (!supportsAudioPipeline(health)) {
      return {
        serverUrl: activeSettings.serverUrl,
        hasToken: Boolean(activeSettings.token),
        ok: false,
        message: "服务器混剪引擎较旧，无法保证完整音轨和音画同步；请更新服务器后再开始混剪。"
      };
    }
    if (hasInsufficientStorage(health)) {
      return {
        serverUrl: activeSettings.serverUrl,
        hasToken: Boolean(activeSettings.token),
        ok: false,
        message: describeInsufficientStorage(health)
      };
    }
    return {
      serverUrl: activeSettings.serverUrl,
      hasToken: Boolean(activeSettings.token),
      ok: Boolean(health.ok && activeSettings.token),
      message: activeSettings.token ? `已连接服务器：${health.workspaceRoot}` : "服务器可访问，请填写 Token 后使用服务器混剪"
    };
  }

  async start(config: MixProjectConfig, monitor?: WorkflowMonitorClient): Promise<BatchJobSnapshot> {
    if (this.starting || this.polling || ["queued", "running", "paused", "stopping"].includes(this.snapshot.status)) {
      throw new Error("已有服务器混剪任务正在运行");
    }
    this.starting = true;
    this.stopped = false;
    this.currentJobId = undefined;
    this.transferController = new AbortController();
    this.downloadedOutputs.clear();
    this.snapshot = emptySnapshot();
    try {
      const settings = await this.readSettings();
      if (!settings.token) {
        throw new Error("请先配置服务器混剪 Token");
      }
      const health = await this.requestJson<RemoteHealth>(settings, "GET", "/health");
      if (!health.workspaceRoot) {
        throw new Error("服务器没有返回工作目录");
      }
      if (!supportsCombinationPipeline(health)) {
        throw new Error("服务器混剪引擎较旧，无法保证开头素材轮换；请先更新服务器后再开始混剪。");
      }
      if (!supportsAudioPipeline(health)) {
        throw new Error("服务器混剪引擎较旧，无法保证完整音轨和音画同步；请先更新服务器后再开始混剪。");
      }
      if (hasInsufficientStorage(health)) {
        throw new Error(describeInsufficientStorage(health));
      }

      this.transferController.signal.throwIfAborted();
      for (const combination of createCombinations(config.slots, config.bgmAssets, config.outputDir, config.maxCombinations, config.outputNamePattern, config.bgmTracks)) {
        if (config.exportMode !== "draft") await assertOutputAvailable(combination.targetVideoPath);
      }
      this.currentSettings = settings;
      this.originalConfig = config;
      this.monitor = monitor;
      const projectId = `desktop-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
      const remoteConfig = await this.uploadProjectAssets(
        settings,
        health.workspaceRoot,
        projectId,
        config,
        false,
        monitor
      );
      this.transferController.signal.throwIfAborted();
      this.currentConfig = remoteConfig;

      const response = await this.requestJson<RemoteJobResponse>(settings, "POST", "/api/jobs", {
        config: remoteConfig,
        workflowId: monitor?.id
      });
      this.currentJobId = response.jobId;
      this.snapshot = response.snapshot;
      if (this.stopped) await this.forwardJobAction("stop");
      else this.emitSnapshot({ ...this.snapshot, message: `服务器任务已开始：${response.jobId}` });
      this.beginPolling(settings, config, monitor);
      return this.snapshot;
    } catch (error) {
      const message = this.stopped ? "任务已停止" : toErrorMessage(error);
      this.emitSnapshot({ ...this.snapshot, status: this.stopped ? "idle" : "failed", message, finishedAt: new Date().toISOString() });
      await monitor?.update({ stage: this.stopped ? "stopped" : "failed", status: this.stopped ? "stopped" : "failed", progress: { message }, finishedAt: new Date().toISOString() });
      if (!this.stopped) throw error;
      return this.getSnapshot();
    } finally {
      this.starting = false;
    }
  }

  private beginPolling(settings: StoredRemoteSettings, config: MixProjectConfig, monitor?: WorkflowMonitorClient): void {
    this.polling = true;
    void this.pollUntilDone(settings, config, monitor).catch(async (error) => {
      const message = `服务器任务监控失败：${toErrorMessage(error)}`;
      this.emitSnapshot({ ...this.snapshot, status: "failed", message, finishedAt: new Date().toISOString() });
      await monitor?.update({ stage: "failed", status: "failed", error: message, progress: { message }, finishedAt: new Date().toISOString() });
    }).finally(() => { this.polling = false; });
  }

  async pause(): Promise<BatchJobSnapshot> {
    return this.forwardJobAction("pause");
  }

  async resume(): Promise<BatchJobSnapshot> {
    return this.forwardJobAction("resume");
  }

  async stop(): Promise<BatchJobSnapshot> {
    if (!this.starting && !this.polling && !["running", "queued", "paused", "stopping"].includes(this.snapshot.status)) return this.getSnapshot();
    this.stopped = true;
    this.transferController.abort();
    this.emitSnapshot({ ...this.snapshot, status: "stopping", message: "正在停止任务" });
    if (!this.currentJobId) return this.getSnapshot();
    return this.forwardJobAction("stop");
  }

  async retryFailures(): Promise<BatchJobSnapshot> {
    if (this.starting || this.polling) throw new Error("任务仍在运行或停止中，请稍后重试");
    const settings = this.currentSettings ?? (await this.readSettings());
    if (!this.currentJobId || !this.originalConfig) {
      return this.snapshot;
    }
    this.stopped = false;
    this.transferController = new AbortController();
    const response = await this.requestJson<{ ok: boolean; snapshot: BatchJobSnapshot }>(
      settings,
      "POST",
      `/api/jobs/${encodeURIComponent(this.currentJobId)}/retry`
    );
    this.emitSnapshot(response.snapshot);
    this.beginPolling(settings, this.originalConfig, this.monitor);
    return this.snapshot;
  }

  async resumeDownload(outputDir?: string): Promise<BatchJobSnapshot> {
    if (this.starting || this.polling) throw new Error("任务仍在运行或停止中，请稍后继续下载");
    if (!this.currentJobId || !this.originalConfig || this.snapshot.recoveryAction !== "resume_download") {
      throw new Error("当前没有可继续的服务器成片下载任务");
    }
    const settings = this.currentSettings ?? (await this.readSettings());
    if (outputDir?.trim()) {
      this.originalConfig = { ...this.originalConfig, outputDir: outputDir.trim() };
    }
    this.stopped = false;
    this.transferController = new AbortController();
    this.emitSnapshot({
      ...this.snapshot,
      status: "running",
      recoveryAction: undefined,
      message: "正在检查已下载成片并继续下载缺失文件..."
    });
    this.beginPolling(settings, this.originalConfig, this.monitor);
    return this.snapshot;
  }

  getSnapshot(): BatchJobSnapshot {
    return structuredClone(this.snapshot);
  }

  private async forwardJobAction(action: "pause" | "resume" | "stop"): Promise<BatchJobSnapshot> {
    const settings = this.currentSettings ?? (await this.readSettings());
    if (!this.currentJobId) {
      return this.snapshot;
    }
    const response = await this.requestJson<{ ok: boolean; snapshot: BatchJobSnapshot }>(
      settings,
      "POST",
      `/api/jobs/${encodeURIComponent(this.currentJobId)}/${action}`
    );
    // A download may finish its cancellation before the stop HTTP response arrives.
    if (action === "stop" && ["idle", "failed"].includes(this.snapshot.status)) return this.getSnapshot();
    this.emitSnapshot(action === "stop" ? { ...response.snapshot, status: "stopping", message: "正在等待服务器确认停止" } : response.snapshot);
    return this.snapshot;
  }

  private async pollUntilDone(
    settings: StoredRemoteSettings,
    originalConfig: MixProjectConfig,
    monitor?: WorkflowMonitorClient
  ): Promise<void> {
    let consecutiveFailures = 0;
    while (this.currentJobId) {
      await delay(1200);
      let response: { ok: boolean; snapshot: BatchJobSnapshot };
      try {
        response = await this.requestJson<{ ok: boolean; snapshot: BatchJobSnapshot }>(
          settings,
          "GET",
          `/api/jobs/${encodeURIComponent(this.currentJobId)}`
        );
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        const message = `服务器连接暂时中断（${consecutiveFailures}/${POLL_FAILURE_LIMIT}），正在重试：${toErrorMessage(error)}`;
        this.emitSnapshot({
          ...this.snapshot,
          status: this.stopped ? "stopping" : this.snapshot.status === "paused" ? "paused" : "running",
          message
        });
        await monitor?.update({
          stage: "mixing",
          status: "active",
          progress: { message }
        });
        if (consecutiveFailures >= POLL_FAILURE_LIMIT) {
          throw new Error(`服务器连接连续失败 ${POLL_FAILURE_LIMIT} 次：${toErrorMessage(error)}`);
        }
        continue;
      }
      if (!["completed", "failed", "idle"].includes(response.snapshot.status)) {
        this.emitSnapshot(this.stopped ? { ...response.snapshot, status: "stopping", message: "正在等待服务器确认停止" } : response.snapshot);
        continue;
      }
      if (this.stopped) {
        this.emitSnapshot({ ...response.snapshot, status: "idle", message: "任务已停止", finishedAt: new Date().toISOString() });
        await monitor?.update({ stage: "stopped", status: "stopped", progress: { message: "任务已停止" }, finishedAt: new Date().toISOString() });
        return;
      }
      if (response.snapshot.status === "completed" && shouldDownloadRemoteOutputs(originalConfig)) {
        const completionError = getRemoteCompletionError(response.snapshot);
        if (completionError) {
          this.emitSnapshot({
            ...response.snapshot,
            status: "failed",
            message: completionError,
            finishedAt: new Date().toISOString()
          });
          await monitor?.update({
            stage: "failed",
            status: "failed",
            error: completionError,
            progress: { message: completionError },
            finishedAt: new Date().toISOString()
          });
          return;
        }
        this.emitSnapshot({
          ...response.snapshot,
          status: "running",
          message: "服务器混剪已完成，正在下载成片到本地..."
        });
        try {
          await this.downloadOutputs(settings, originalConfig, response.snapshot, monitor);
          const cloudPending = originalConfig.exportTarget === "cloud" || originalConfig.exportTarget === "both";
          await monitor?.update({
            stage: cloudPending ? "cloud_upload" : "completed",
            status: cloudPending ? "active" : response.snapshot.failed > 0 ? "partial" : "success",
            progress: {
              current: cloudPending ? 0 : response.snapshot.total,
              total: cloudPending ? response.snapshot.completed : response.snapshot.total,
              percent: cloudPending ? 0 : 100,
              unit: "videos",
              message: cloudPending ? "成片已下载，等待上传云管家" : "成片已下载到本地，任务完成"
            },
            totalVideos: response.snapshot.total,
            succeededVideos: response.snapshot.completed,
            failedVideos: response.snapshot.failed,
            finishedAt: cloudPending ? undefined : response.snapshot.finishedAt
          });
        } catch (error) {
          if (this.stopped) {
            this.emitSnapshot({ ...response.snapshot, status: "idle", message: "任务已停止", finishedAt: new Date().toISOString() });
            await monitor?.update({ stage: "stopped", status: "stopped", progress: { message: "任务已停止" }, finishedAt: new Date().toISOString() });
            return;
          }
          const message = describeOutputDownloadFailure(error, originalConfig.outputDir);
          this.emitSnapshot({
            ...response.snapshot,
            status: "failed",
            recoveryAction: "resume_download",
            message,
            finishedAt: new Date().toISOString()
          });
          await monitor?.update({
            stage: "failed",
            status: "failed",
            error: message,
            progress: { message },
            finishedAt: new Date().toISOString()
          });
        }
        return;
      }
      this.emitSnapshot(response.snapshot);
      return;
    }
  }

  private async uploadProjectAssets(
    settings: StoredRemoteSettings,
    workspaceRoot: string,
    projectId: string,
    config: MixProjectConfig,
    useLegacyAudioCompatibility: boolean,
    monitor?: WorkflowMonitorClient
  ): Promise<MixProjectConfig> {
    const assetMap = new Map<string, string>();
    const signal = this.transferController.signal;
    const uploadAsset = async (asset: AssetInfo, folder: string): Promise<AssetInfo> => {
      signal.throwIfAborted();
      if (/^https?:\/\//i.test(asset.path)) {
        return asset;
      }
      const cached = assetMap.get(asset.path);
      if (cached) {
        return toRemoteAsset(asset, cached, useLegacyAudioCompatibility);
      }
      const remoteRelativePath = path.posix.join("projects", projectId, folder, remoteFileName(asset.path));
      const remoteAbsolutePath = path.posix.join(workspaceRoot, remoteRelativePath);
      this.emitSnapshot({ ...this.snapshot, status: "running", message: `正在上传服务器素材：${asset.name}` });
      await retryTransfer(`上传素材 ${asset.name}`, async () => {
        await uploadFile(settings, `/api/files/upload?path=${encodeURIComponent(remoteRelativePath)}`, asset.path, (current, total) => {
          void monitor?.update({
            stage: "asset_transfer",
            status: "active",
            progress: { current, total, unit: "bytes", message: `正在传输素材：${asset.name}` }
          }, true);
        }, signal);
      }, (attempt, error) => {
        const message = `上传素材失败，正在重试（${attempt}/${TRANSFER_RETRY_ATTEMPTS}）：${asset.name}，${toErrorMessage(error)}`;
        this.emitSnapshot({ ...this.snapshot, status: "running", message });
        void monitor?.update({ stage: "asset_transfer", status: "active", progress: { message } });
      }, signal);
      assetMap.set(asset.path, remoteAbsolutePath);
      return toRemoteAsset(asset, remoteAbsolutePath, useLegacyAudioCompatibility);
    };

    const slots = [];
    for (const slot of config.slots) {
      const assets = [];
      for (const asset of slot.assets) {
        assets.push(await uploadAsset(asset, slot.name));
      }
      slots.push({ ...slot, assets });
    }

    const sourceBgmTracks = config.bgmTracks?.length
      ? config.bgmTracks
      : config.bgmAssets.length > 0
        ? [{
            id: "bgm_1",
            name: "BGM 1",
            assets: config.bgmAssets,
            range: config.bgmRange,
            sortOrder: 0
          }]
        : [];
    const bgmTracks = [];
    for (const track of sourceBgmTracks) {
      const assets = [];
      for (const asset of track.assets) {
        assets.push(await uploadAsset(asset, `BGM/${track.id}`));
      }
      bgmTracks.push({ ...track, assets });
    }

    const bgmAssets = bgmTracks[0]?.assets ?? [];
    return {
      ...config,
      projectDir: path.posix.join(workspaceRoot, "projects", projectId),
      outputDir: path.posix.join(workspaceRoot, "projects", projectId, "outputs"),
      slots,
      bgmTracks,
      bgmAssets
    };
  }

  private async downloadOutputs(
    settings: StoredRemoteSettings,
    originalConfig: MixProjectConfig,
    completedSnapshot: BatchJobSnapshot,
    monitor?: WorkflowMonitorClient
  ): Promise<void> {
    const jobId = this.currentJobId;
    if (!jobId) {
      return;
    }
    const response = await this.requestJson<RemoteOutputsResponse>(settings, "GET", `/api/jobs/${encodeURIComponent(jobId)}/outputs`);
    if (response.files.length === 0) {
      throw new Error("服务器任务已完成，但没有返回可下载的 MP4 成片");
    }
    const localVideosDir = path.join(originalConfig.outputDir, "videos");
    await fs.mkdir(localVideosDir, { recursive: true });
    const signal = this.transferController.signal;
    const pendingFiles = [];
    for (const file of response.files) {
      const targetPath = path.join(localVideosDir, path.basename(file.name));
      const existing = await fs.stat(targetPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (existing?.isFile() && existing.size === file.size) {
        this.downloadedOutputs.set(targetPath, file.size);
        continue;
      }
      if (existing) await assertOutputAvailable(targetPath);
      pendingFiles.push(file);
    }
    await assertSufficientLocalDownloadSpace(localVideosDir, pendingFiles.reduce((sum, file) => sum + Math.max(0, file.size), 0));
    for (const [index, file] of response.files.entries()) {
      signal.throwIfAborted();
      const targetPath = path.join(localVideosDir, path.basename(file.name));
      if (this.downloadedOutputs.get(targetPath) === file.size && (await fs.stat(targetPath).catch(() => undefined))?.size === file.size) continue;
      await assertOutputAvailable(targetPath);
      this.emitSnapshot({ ...this.snapshot, message: `正在下载服务器成片：${file.name}` });
      await retryTransfer(`下载成片 ${file.name}`, async () => {
        await downloadFile(
          settings,
          `/api/jobs/${encodeURIComponent(jobId)}/outputs/${encodeURIComponent(file.name)}`,
          targetPath,
          file.size,
          (current, total) => {
            void monitor?.update({
              stage: "output_download",
              status: "active",
              progress: { current, total, unit: "bytes", message: `正在下载成片 ${index + 1}/${response.files.length}：${file.name}` }
            }, true);
          }, signal
        );
      }, (attempt, error) => {
        const message = `下载成片失败，正在重试（${attempt}/${TRANSFER_RETRY_ATTEMPTS}）：${file.name}，${toErrorMessage(error)}`;
        this.emitSnapshot({ ...this.snapshot, status: "running", message });
        void monitor?.update({ stage: "output_download", status: "active", progress: { message } });
      }, signal);
      this.downloadedOutputs.set(targetPath, file.size);
    }
    signal.throwIfAborted();
    this.emitSnapshot({
      ...completedSnapshot,
      status: "completed",
      message: `服务器混剪已完成，${response.files.length} 条成片已下载到本地输出目录${
        completedSnapshot.failed > 0 ? `，另有 ${completedSnapshot.failed} 条失败` : ""
      }`
    });
  }

  private emitSnapshot(snapshot: BatchJobSnapshot): void {
    this.snapshot = structuredClone(snapshot);
    this.emit("update", this.getSnapshot());
  }

  private async requestJson<T>(settings: StoredRemoteSettings, method: "GET" | "POST", endpoint: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${settings.serverUrl}${endpoint}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          "x-mix-token": settings.token ?? ""
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      throw new Error(`服务器请求超时或连接失败：${toErrorMessage(error)}`);
    }
    const text = await response.text();
    let payload: T;
    try {
      payload = JSON.parse(text) as T;
    } catch {
      throw new Error(`服务器返回了非 JSON 响应：HTTP ${response.status}`);
    }
    if (!response.ok) {
      const error = payload as { error?: string };
      throw new Error(error.error || `服务器请求失败：HTTP ${response.status}`);
    }
    return payload;
  }

  private async readSettings(): Promise<StoredRemoteSettings> {
    try {
      const raw = await this.readSettingsFile();
      const parsed = JSON.parse(raw) as StoredRemoteSettings;
      return {
        serverUrl: normalizeServerUrl(parsed.serverUrl || DEFAULT_SERVER_URL),
        token: parsed.token ?? ""
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { serverUrl: DEFAULT_SERVER_URL, token: "" };
      }
      throw error;
    }
  }

  private async writeSettings(settings: StoredRemoteSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.configPath()), { recursive: true });
    await fs.writeFile(this.configPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }

  private configPath(): string {
    return getTaskScopedConfigPath(this.getUserDataDir(), this.taskId, CONFIG_FILE);
  }

  private legacyConfigPath(): string {
    return getLegacyConfigPath(this.getUserDataDir(), CONFIG_FILE);
  }

  private async readSettingsFile(): Promise<string> {
    try {
      return await fs.readFile(this.configPath(), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      return fs.readFile(this.legacyConfigPath(), "utf8");
    }
  }
}

function remoteFileName(filePath: string): string {
  const hash = crypto.createHash("sha1").update(filePath).digest("hex").slice(0, 10);
  return `${hash}-${path.basename(filePath).replace(/[\\/:\0]/g, "_")}`;
}

function normalizeServerUrl(value: string): string {
  return value.trim().replace(/\/+$/, "") || DEFAULT_SERVER_URL;
}

function supportsAudioPipeline(health: RemoteHealth): boolean {
  return (health.audioPipelineVersion ?? 0) >= MIN_SERVER_AUDIO_PIPELINE_VERSION;
}

function supportsCombinationPipeline(health: RemoteHealth): boolean {
  return (health.combinationPipelineVersion ?? 0) >= MIN_SERVER_COMBINATION_PIPELINE_VERSION;
}

function hasInsufficientStorage(health: RemoteHealth): boolean {
  const freeBytes = health.storage?.freeBytes;
  const minFreeBytes = health.storage?.minFreeBytes;
  return typeof freeBytes === "number" && typeof minFreeBytes === "number" && freeBytes < minFreeBytes;
}

function describeInsufficientStorage(health: RemoteHealth): string {
  const freeGb = bytesToGb(health.storage?.freeBytes ?? 0);
  const minGb = bytesToGb(health.storage?.minFreeBytes ?? 0);
  return `服务器可用空间不足（剩余 ${freeGb}GB，需要至少 ${minGb}GB）。请先清理服务器已回传的旧项目，再开始混剪。`;
}

export function toRemoteAsset(asset: AssetInfo, remotePath: string, useLegacyAudioCompatibility: boolean): AssetInfo {
  if (useLegacyAudioCompatibility && asset.kind === "video" && asset.hasAudio === true) {
    // Older servers re-probe uploaded videos and can falsely report no audio.
    // Their exporter only uses kind to decide whether to re-probe, not to render video.
    return { ...asset, path: remotePath, kind: "audio" };
  }
  return { ...asset, path: remotePath };
}

function shouldDownloadRemoteOutputs(config: MixProjectConfig): boolean {
  return config.exportMode !== "draft";
}

export function getRemoteCompletionError(snapshot: BatchJobSnapshot): string | undefined {
  if (snapshot.completed > 0) {
    return undefined;
  }
  const reason = snapshot.failures[0]?.message;
  return reason ? `服务器未生成成片：${reason}` : "服务器未生成成片，请检查服务器日志后重试";
}

export function describeOutputDownloadFailure(error: unknown, outputDir: string): string {
  const detail = toErrorMessage(error);
  if (detail.startsWith("本地输出磁盘空间不足：")) {
    return `${detail} 已完整下载的成片会自动跳过，不会重新混剪。`;
  }
  if (isNoSpaceError(error)) {
    return `本地输出磁盘空间不足，无法写入成片（${outputDir}）。请清理空间或更换输出磁盘后点击“继续下载”；已完整下载的成片会自动跳过，不会重新混剪。`;
  }
  return `服务器成片下载失败：${detail}。请检查网络后点击“继续下载”；已完整下载的成片会自动跳过，不会重新混剪。`;
}

export function getRequiredLocalDownloadBytes(pendingBytes: number): number {
  const safePendingBytes = Math.max(0, pendingBytes);
  const reserveBytes = Math.max(LOCAL_DOWNLOAD_MIN_RESERVE_BYTES, Math.ceil(safePendingBytes * LOCAL_DOWNLOAD_RESERVE_RATIO));
  return safePendingBytes + reserveBytes;
}

async function assertSufficientLocalDownloadSpace(directory: string, pendingBytes: number): Promise<void> {
  if (pendingBytes <= 0) return;
  const storage = await fs.statfs(directory);
  const freeBytes = Number(BigInt(storage.bavail) * BigInt(storage.bsize));
  const requiredBytes = getRequiredLocalDownloadBytes(pendingBytes);
  if (freeBytes >= requiredBytes) return;
  const error = new Error(
    `本地输出磁盘空间不足：剩余 ${bytesToGb(freeBytes)}GB，待下载成片 ${bytesToGb(pendingBytes)}GB，` +
    `为避免下载中途失败需要至少 ${bytesToGb(requiredBytes)}GB。请清理空间或更换输出磁盘后点击“继续下载”。`
  ) as NodeJS.ErrnoException;
  error.code = "ENOSPC";
  throw error;
}

function isNoSpaceError(error: unknown): boolean {
  const candidate = error as NodeJS.ErrnoException | undefined;
  if (candidate?.code === "ENOSPC") return true;
  const message = toErrorMessage(error);
  return /\bENOSPC\b|no space left on device|磁盘空间不足/i.test(message);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptySnapshot(): BatchJobSnapshot {
  return {
    id: "remote_idle",
    status: "idle",
    total: 0,
    completed: 0,
    failed: 0,
    message: "等待服务器混剪",
    failures: []
  };
}

async function uploadFile(
  settings: StoredRemoteSettings, endpoint: string, filePath: string,
  onProgress?: (current: number, total: number) => void, signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  const stat = await fs.stat(filePath);
  await new Promise<void>((resolve, reject) => {
    const url = new URL(`${settings.serverUrl}${endpoint}`);
    const request = (url.protocol === "https:" ? https : http).request(url, {
      method: "POST", headers: { "Content-Length": String(stat.size), "x-mix-token": settings.token ?? "" }, signal
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("aborted", () => reject(new Error("服务器上传响应中断")));
      response.on("end", () => {
        if ((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300) resolve();
        else reject(new Error(Buffer.concat(chunks).toString("utf8") || `上传服务器失败：HTTP ${response.statusCode}`));
      });
    });
    request.setTimeout(30_000, () => request.destroy(new Error("上传服务器超时：30 秒无传输进展")));
    request.on("error", reject);
    const input = createReadStream(filePath);
    request.on("close", () => input.destroy());
    let current = 0;
    input.on("data", (chunk) => { current += Buffer.byteLength(chunk); onProgress?.(current, stat.size); });
    input.on("error", (error) => request.destroy(error));
    input.pipe(request);
  });
}

async function downloadFile(
  settings: StoredRemoteSettings, endpoint: string, targetPath: string, expectedSize: number,
  onProgress?: (current: number, total: number) => void, signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.downloading-${crypto.randomUUID()}`;
  try {
    await new Promise<void>((resolve, reject) => {
      let streaming = false;
      const url = new URL(`${settings.serverUrl}${endpoint}`);
      const request = (url.protocol === "https:" ? https : http).get(url, {
        headers: { "x-mix-token": settings.token ?? "" }, signal
      }, (response) => {
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
          response.resume();
          reject(new Error(`下载服务器成片失败：HTTP ${response.statusCode}`));
          return;
        }
        streaming = true;
        const total = Number(response.headers["content-length"] ?? expectedSize);
        let current = 0;
        response.on("data", (chunk: Buffer) => { current += chunk.length; onProgress?.(current, total); });
        pipeline(response, createWriteStream(temporaryPath), { signal }).then(() => {
          if (total > 0 && current !== total) reject(new Error(`服务器成片下载不完整：预期 ${total} 字节，实际 ${current} 字节`));
          else resolve();
        }, reject);
      });
      request.setTimeout(30_000, () => request.destroy(new Error("下载成片超时：30 秒无传输进展")));
      request.on("error", (error) => { if (!streaming) reject(error); });
    });
    const stat = await fs.stat(temporaryPath);
    if (expectedSize > 0 && stat.size !== expectedSize) throw new Error(`服务器成片下载不完整：预期 ${expectedSize} 字节，实际 ${stat.size} 字节`);
    signal?.throwIfAborted();
    await publishOutput(temporaryPath, targetPath);
  } finally {
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryTransfer<T>(
  label: string,
  operation: () => Promise<T>,
  onRetry: (attempt: number, error: unknown) => void,
  signal?: AbortSignal
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TRANSFER_RETRY_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      signal?.throwIfAborted();
      lastError = error;
      if (isNoSpaceError(error)) throw error;
      if (attempt === TRANSFER_RETRY_ATTEMPTS) {
        break;
      }
      onRetry(attempt + 1, error);
      await delay(attempt * 800);
    }
  }
  throw new Error(`${label}失败，已重试 ${TRANSFER_RETRY_ATTEMPTS} 次：${toErrorMessage(lastError ?? "未知错误")}`);
}

function bytesToGb(value: number): string {
  return (Math.max(0, value) / 1024 / 1024 / 1024).toFixed(1);
}
