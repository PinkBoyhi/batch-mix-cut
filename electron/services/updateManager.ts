import { EventEmitter } from "node:events";
import type { UpdateReleaseNotes } from "../../src/shared/types.js";

const latestReleaseApiUrl = "https://api.github.com/repos/PinkBoyhi/batch-mix-cut/releases/latest";
const latestReleasePageUrl = "https://github.com/PinkBoyhi/batch-mix-cut/releases/latest";

export type UpdateStatus = "idle" | "checking" | "available" | "not-available" | "error";

export interface UpdateSnapshot {
  status: UpdateStatus;
  message: string;
  currentVersion: string;
  availableVersion?: string;
  progressPercent?: number;
  error?: string;
  url?: string;
}

interface GithubReleasePayload {
  tag_name?: string;
  name?: string;
  published_at?: string;
  body?: string;
  html_url?: string;
}

export class UpdateManager extends EventEmitter {
  private snapshot: UpdateSnapshot;
  private latestRelease?: UpdateReleaseNotes;

  constructor(currentVersion: string) {
    super();
    this.snapshot = {
      status: "idle",
      message: "手动更新：检查后打开 GitHub 下载页",
      currentVersion,
      url: latestReleasePageUrl
    };
  }

  getSnapshot(): UpdateSnapshot {
    return structuredClone(this.snapshot);
  }

  async check(): Promise<UpdateSnapshot> {
    this.setSnapshot({
      status: "checking",
      message: "正在检查 GitHub 最新版本",
      error: undefined,
      progressPercent: undefined
    });

    const release = await this.fetchLatestRelease();
    const hasUpdate = compareVersion(release.version, this.snapshot.currentVersion) > 0;
    this.setSnapshot({
      status: hasUpdate ? "available" : "not-available",
      message: hasUpdate ? `发现新版本 ${release.version}，请打开 GitHub 手动下载` : "已经是最新版本",
      availableVersion: release.version,
      url: release.url
    });
    return this.getSnapshot();
  }

  async getReleaseNotes(): Promise<UpdateReleaseNotes> {
    return this.latestRelease ?? this.fetchLatestRelease();
  }

  private async fetchLatestRelease(): Promise<UpdateReleaseNotes> {
    const response = await fetch(latestReleaseApiUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "YiboBioMixCut-Updater"
      }
    });

    if (!response.ok) {
      throw new Error(`更新日志获取失败：HTTP ${response.status}`);
    }

    const payload = (await response.json()) as GithubReleasePayload;
    const version = (payload.tag_name ?? "").replace(/^v/i, "") || this.snapshot.availableVersion || this.snapshot.currentVersion;
    this.latestRelease = {
      version,
      name: payload.name || `医博生物混剪工具 ${version}`,
      publishedAt: payload.published_at,
      body: payload.body?.trim() || "这个版本暂时没有填写更新说明。",
      url: payload.html_url || latestReleasePageUrl
    };
    return this.latestRelease;
  }

  private setSnapshot(patch: Partial<UpdateSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit("update", this.getSnapshot());
  }
}

function compareVersion(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}
