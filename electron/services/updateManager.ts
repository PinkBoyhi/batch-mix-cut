import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { UpdateReleaseNotes } from "../../src/shared/types.js";
import type { AppUpdater, ProgressInfo, UpdateCheckResult, UpdateInfo } from "electron-updater";

const require = createRequire(import.meta.url);
const { autoUpdater } = require("electron-updater") as typeof import("electron-updater");
const latestReleaseApiUrl = "https://api.github.com/repos/PinkBoyhi/batch-mix-cut/releases/latest";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateSnapshot {
  status: UpdateStatus;
  message: string;
  currentVersion: string;
  availableVersion?: string;
  progressPercent?: number;
  error?: string;
}

export class UpdateManager extends EventEmitter {
  private readonly updater: AppUpdater;
  private readonly packaged: boolean;
  private snapshot: UpdateSnapshot;

  constructor(currentVersion: string, packaged: boolean) {
    super();
    this.updater = autoUpdater;
    this.packaged = packaged;
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.snapshot = {
      status: "idle",
      message: "等待检查更新",
      currentVersion
    };
    this.registerEvents();
  }

  getSnapshot(): UpdateSnapshot {
    return structuredClone(this.snapshot);
  }

  async check(): Promise<UpdateSnapshot> {
    this.setSnapshot({
      status: "checking",
      message: "正在检查更新",
      error: undefined,
      progressPercent: undefined
    });

    if (!this.packaged) {
      this.setSnapshot({
        status: "not-available",
        message: "开发模式不检查更新，打包安装后生效"
      });
      return this.getSnapshot();
    }

    await this.updater.checkForUpdates();
    return this.getSnapshot();
  }

  async getReleaseNotes(): Promise<UpdateReleaseNotes> {
    const response = await fetch(latestReleaseApiUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "YiboBioMixCut-Updater"
      }
    });

    if (!response.ok) {
      throw new Error(`更新日志获取失败：HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
      tag_name?: string;
      name?: string;
      published_at?: string;
      body?: string;
      html_url?: string;
    };
    const version = (payload.tag_name ?? "").replace(/^v/i, "") || this.snapshot.availableVersion || this.snapshot.currentVersion;

    return {
      version,
      name: payload.name || `医博生物混剪工具 ${version}`,
      publishedAt: payload.published_at,
      body: payload.body?.trim() || "这个版本暂时没有填写更新说明。",
      url: payload.html_url || "https://github.com/PinkBoyhi/batch-mix-cut/releases/latest"
    };
  }

  quitAndInstall(): void {
    this.updater.quitAndInstall(false, true);
  }

  private registerEvents(): void {
    this.updater.on("checking-for-update", () => {
      this.setSnapshot({ status: "checking", message: "正在检查更新" });
    });

    this.updater.on("update-available", (info: UpdateInfo) => {
      this.setSnapshot({
        status: "available",
        message: `发现新版本 ${info.version}，请手动下载`,
        availableVersion: info.version
      });
    });

    this.updater.on("update-not-available", (info: UpdateCheckResult["updateInfo"]) => {
      this.setSnapshot({
        status: "not-available",
        message: "已经是最新版本",
        availableVersion: info.version
      });
    });

    this.updater.on("download-progress", (progress: ProgressInfo) => {
      this.setSnapshot({
        status: "downloading",
        message: `正在下载更新 ${progress.percent.toFixed(0)}%`,
        progressPercent: progress.percent
      });
    });

    this.updater.on("update-downloaded", (info: UpdateInfo) => {
      this.setSnapshot({
        status: "downloaded",
        message: `新版本 ${info.version} 已下载，重启后安装`,
        availableVersion: info.version,
        progressPercent: 100
      });
    });

    this.updater.on("error", (error: Error) => {
      this.setSnapshot({
        status: "error",
        message: "更新检查失败",
        error: error.message
      });
    });
  }

  private setSnapshot(patch: Partial<UpdateSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit("update", this.getSnapshot());
  }
}
