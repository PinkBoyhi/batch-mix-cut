import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import type {
  AssetInfo,
  BatchJobSnapshot,
  MixCombination,
  MixProjectConfig,
  RemoteMixSettings,
  RemoteMixSettingsView
} from "../../src/shared/types.js";
import { createCombinations } from "./combinator.js";

const CONFIG_FILE = "remote-mix-server.json";
const DEFAULT_SERVER_URL = "http://10.0.0.133:8787";
const MIN_SERVER_AUDIO_PIPELINE_VERSION = 2;

interface StoredRemoteSettings extends RemoteMixSettings {}

interface RemoteHealth {
  ok: boolean;
  workspaceRoot: string;
  audioPipelineVersion?: number;
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
  private currentSettings?: StoredRemoteSettings;
  private stopped = false;
  private snapshot: BatchJobSnapshot = emptySnapshot();

  constructor(private readonly getUserDataDir: () => string) {
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
    if (!supportsAudioPipeline(health)) {
      return {
        serverUrl: activeSettings.serverUrl,
        hasToken: Boolean(activeSettings.token),
        ok: false,
        message: "服务器混剪引擎过旧，存在成片静音风险。请更新服务器后再使用服务器混剪。"
      };
    }
    return {
      serverUrl: activeSettings.serverUrl,
      hasToken: Boolean(activeSettings.token),
      ok: Boolean(health.ok && activeSettings.token),
      message: activeSettings.token ? `已连接服务器：${health.workspaceRoot}` : "服务器可访问，请填写 Token 后使用服务器混剪"
    };
  }

  async start(config: MixProjectConfig): Promise<BatchJobSnapshot> {
    if (this.snapshot.status === "running" || this.snapshot.status === "paused") {
      throw new Error("已有服务器混剪任务正在运行");
    }
    const settings = await this.readSettings();
    if (!settings.token) {
      throw new Error("请先配置服务器混剪 Token");
    }
    const health = await this.requestJson<RemoteHealth>(settings, "GET", "/health");
    if (!health.workspaceRoot) {
      throw new Error("服务器没有返回工作目录");
    }
    if (!supportsAudioPipeline(health)) {
      throw new Error("服务器混剪引擎过旧，已阻止任务开始，避免生成静音成片。请先更新服务器。");
    }

    this.stopped = false;
    this.currentSettings = settings;
    const projectId = `desktop-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const remoteConfig = await this.uploadProjectAssets(settings, health.workspaceRoot, projectId, config);
    this.currentConfig = remoteConfig;

    const response = await this.requestJson<RemoteJobResponse>(settings, "POST", "/api/jobs", { config: remoteConfig });
    this.currentJobId = response.jobId;
    this.snapshot = response.snapshot;
    this.emitSnapshot({ ...this.snapshot, message: `服务器任务已开始：${response.jobId}` });
    void this.pollUntilDone(settings, config);
    return this.snapshot;
  }

  async pause(): Promise<BatchJobSnapshot> {
    return this.forwardJobAction("pause");
  }

  async resume(): Promise<BatchJobSnapshot> {
    return this.forwardJobAction("resume");
  }

  async stop(): Promise<BatchJobSnapshot> {
    this.stopped = true;
    return this.forwardJobAction("stop");
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
    this.emitSnapshot(response.snapshot);
    return this.snapshot;
  }

  private async pollUntilDone(settings: StoredRemoteSettings, originalConfig: MixProjectConfig): Promise<void> {
    while (!this.stopped && this.currentJobId) {
      await delay(1200);
      const response = await this.requestJson<{ ok: boolean; snapshot: BatchJobSnapshot }>(
        settings,
        "GET",
        `/api/jobs/${encodeURIComponent(this.currentJobId)}`
      );
      if (!["completed", "failed", "idle"].includes(response.snapshot.status)) {
        this.emitSnapshot(response.snapshot);
        continue;
      }
      if (response.snapshot.status === "completed" && shouldDownloadRemoteOutputs(originalConfig)) {
        this.emitSnapshot({
          ...response.snapshot,
          status: "running",
          message: "服务器混剪已完成，正在下载成片到本地..."
        });
        try {
          await this.downloadOutputs(settings, originalConfig, response.snapshot);
        } catch (error) {
          this.emitSnapshot({
            ...response.snapshot,
            status: "failed",
            message: `服务器成片下载失败：${toErrorMessage(error)}`,
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
    config: MixProjectConfig
  ): Promise<MixProjectConfig> {
    const assetMap = new Map<string, string>();
    const uploadAsset = async (asset: AssetInfo, folder: string): Promise<AssetInfo> => {
      if (/^https?:\/\//i.test(asset.path)) {
        return asset;
      }
      const cached = assetMap.get(asset.path);
      if (cached) {
        return { ...asset, path: cached };
      }
      const remoteRelativePath = path.posix.join("projects", projectId, folder, remoteFileName(asset.path));
      const remoteAbsolutePath = path.posix.join(workspaceRoot, remoteRelativePath);
      this.emitSnapshot({ ...this.snapshot, status: "running", message: `正在上传服务器素材：${asset.name}` });
      await uploadFile(settings, `/api/files/upload?path=${encodeURIComponent(remoteRelativePath)}`, asset.path);
      assetMap.set(asset.path, remoteAbsolutePath);
      return { ...asset, path: remoteAbsolutePath };
    };

    const slots = [];
    for (const slot of config.slots) {
      const assets = [];
      for (const asset of slot.assets) {
        assets.push(await uploadAsset(asset, slot.name));
      }
      slots.push({ ...slot, assets });
    }

    const bgmTracks = [];
    for (const track of config.bgmTracks ?? []) {
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
    completedSnapshot: BatchJobSnapshot
  ): Promise<void> {
    if (!this.currentJobId) {
      return;
    }
    const response = await this.requestJson<RemoteOutputsResponse>(settings, "GET", `/api/jobs/${encodeURIComponent(this.currentJobId)}/outputs`);
    const localVideosDir = path.join(originalConfig.outputDir, "videos");
    await fs.mkdir(localVideosDir, { recursive: true });
    for (const file of response.files) {
      this.emitSnapshot({ ...this.snapshot, message: `正在下载服务器成片：${file.name}` });
      await downloadFile(settings, `/api/jobs/${encodeURIComponent(this.currentJobId)}/outputs/${encodeURIComponent(file.name)}`, path.join(localVideosDir, file.name));
    }
    this.emitSnapshot({
      ...completedSnapshot,
      status: "completed",
      message: `服务器混剪已完成${response.files.length > 0 ? "，成片已下载到本地输出目录" : ""}`
    });
  }

  private emitSnapshot(snapshot: BatchJobSnapshot): void {
    this.snapshot = structuredClone(snapshot);
    this.emit("update", this.getSnapshot());
  }

  private async requestJson<T>(settings: StoredRemoteSettings, method: "GET" | "POST", endpoint: string, body?: unknown): Promise<T> {
    const response = await fetch(`${settings.serverUrl}${endpoint}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-mix-token": settings.token ?? ""
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
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
      const raw = await fs.readFile(this.configPath(), "utf8");
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
    return path.join(this.getUserDataDir(), CONFIG_FILE);
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

function shouldDownloadRemoteOutputs(config: MixProjectConfig): boolean {
  return config.exportMode !== "draft";
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

async function uploadFile(settings: StoredRemoteSettings, endpoint: string, filePath: string): Promise<void> {
  const stat = await fs.stat(filePath);
  await streamRequest(settings, "POST", endpoint, createReadStream(filePath), stat.size);
}

async function downloadFile(settings: StoredRemoteSettings, endpoint: string, targetPath: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const url = new URL(`${settings.serverUrl}${endpoint}`);
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: "GET",
        headers: { "x-mix-token": settings.token ?? "" }
      },
      (response) => {
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
          response.resume();
          reject(new Error(`下载服务器成片失败：HTTP ${response.statusCode ?? 0}`));
          return;
        }
        const output = createWriteStream(targetPath);
        response.pipe(output);
        output.on("finish", () => output.close(() => resolve()));
        output.on("error", reject);
      }
    );
    request.on("error", reject);
    request.end();
  });
}

async function streamRequest(
  settings: StoredRemoteSettings,
  method: "POST",
  endpoint: string,
  stream: NodeJS.ReadableStream,
  contentLength: number
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const url = new URL(`${settings.serverUrl}${endpoint}`);
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method,
        headers: {
          "Content-Length": String(contentLength),
          "x-mix-token": settings.token ?? ""
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          if ((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300) {
            resolve();
            return;
          }
          const text = Buffer.concat(chunks).toString("utf8");
          reject(new Error(text || `上传服务器失败：HTTP ${response.statusCode ?? 0}`));
        });
      }
    );
    request.on("error", reject);
    stream.on("error", (error) => request.destroy(error));
    stream.pipe(request);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
