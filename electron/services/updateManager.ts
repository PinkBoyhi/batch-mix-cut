import { EventEmitter } from "node:events";
import type { OutgoingHttpHeaders } from "node:http";
import type { RemoteMixSettings, UpdateReleaseNotes, UpdateSnapshot } from "../../src/shared/types.js";

const latestReleaseApiUrl = "https://api.github.com/repos/PinkBoyhi/batch-mix-cut/releases/latest";
const githubUpdateBaseUrl = "https://github.com/PinkBoyhi/batch-mix-cut/releases/latest/download";
const latestReleasePageUrl = "https://github.com/PinkBoyhi/batch-mix-cut/releases/latest";
const UPDATE_REQUEST_TIMEOUT_MS = 20_000;

interface GithubReleasePayload {
  tag_name?: string;
  name?: string;
  published_at?: string;
  body?: string;
  html_url?: string;
}

interface UpdateMetadata {
  version: string;
  path: string;
  sha512: string;
  size?: number;
}

interface AutoUpdaterAdapter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  disableDifferentialDownload: boolean;
  requestHeaders: OutgoingHttpHeaders | null;
  setFeedURL: (options: { provider: "generic"; url: string }) => void;
  checkForUpdates: () => Promise<{ updateInfo?: { version?: string; files?: Array<{ url: string; sha512?: string }> } } | null>;
  downloadUpdate: () => Promise<string[]>;
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
  on: {
    (event: "download-progress", listener: (progress: { percent?: number }) => void): unknown;
    (event: "error", listener: (error: Error) => void): unknown;
  };
}

interface UpdateManagerOptions {
  platform?: NodeJS.Platform;
  isPackaged?: boolean;
  updater?: AutoUpdaterAdapter;
  fetchImpl?: typeof fetch;
  scheduleInstall?: (callback: () => void) => void;
}

export class UpdateManager extends EventEmitter {
  private snapshot: UpdateSnapshot;
  private latestRelease?: UpdateReleaseNotes;
  private trustedMetadata?: UpdateMetadata;
  private readonly platform: NodeJS.Platform;
  private readonly isPackaged: boolean;
  private readonly updater?: AutoUpdaterAdapter;
  private readonly fetchImpl: typeof fetch;
  private readonly scheduleInstall: (callback: () => void) => void;

  constructor(currentVersion: string, options: UpdateManagerOptions = {}) {
    super();
    this.platform = options.platform ?? process.platform;
    this.isPackaged = options.isPackaged ?? false;
    this.updater = options.updater;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.scheduleInstall = options.scheduleInstall ?? ((callback) => setTimeout(callback, 700));
    this.snapshot = {
      status: "idle",
      message: "点击检查是否有新版本",
      currentVersion,
      url: latestReleasePageUrl,
      canAutoUpdate: this.canAutoUpdate()
    };
    this.configureUpdaterEvents();
  }

  getSnapshot(): UpdateSnapshot {
    return structuredClone(this.snapshot);
  }

  async check(): Promise<UpdateSnapshot> {
    this.setSnapshot({
      status: "checking",
      message: "正在检查最新版本",
      error: undefined,
      progressPercent: undefined,
      downloadSource: undefined
    });
    try {
      const metadata = await this.fetchUpdateMetadata(githubUpdateBaseUrl);
      const release = await this.fetchLatestRelease().catch(() => ({
        version: metadata.version,
        name: `医博生物混剪工具 ${metadata.version}`,
        body: "更新日志暂时无法获取。",
        url: latestReleasePageUrl
      }));
      this.trustedMetadata = metadata;
      const hasUpdate = compareVersion(metadata.version, this.snapshot.currentVersion) > 0;
      const canAutoUpdate = this.canAutoUpdate();
      this.setSnapshot({
        status: hasUpdate ? "available" : "not-available",
        message: hasUpdate
          ? canAutoUpdate
            ? `发现新版本 ${metadata.version}，可直接下载并自动安装`
            : `发现新版本 ${metadata.version}，当前系统请打开下载页安装`
          : "已经是最新版本",
        availableVersion: metadata.version,
        canAutoUpdate,
        url: release.url
      });
      return this.getSnapshot();
    } catch (error) {
      this.setSnapshot({ status: "error", message: "更新检查失败", error: toMessage(error) });
      throw error;
    }
  }

  async downloadAndInstall(source?: RemoteMixSettings): Promise<UpdateSnapshot> {
    if (!this.canAutoUpdate() || !this.updater) {
      throw new Error("自动覆盖安装仅支持已安装的 Windows 正式版");
    }
    if (this.snapshot.status !== "available") await this.check();
    if (this.snapshot.status !== "available") return this.getSnapshot();

    try {
      const trusted = this.trustedMetadata ?? await this.fetchUpdateMetadata(githubUpdateBaseUrl);
      this.updater.autoDownload = false;
      this.updater.autoInstallOnAppQuit = false;
      this.updater.disableDifferentialDownload = true;
      const selected = await this.selectDownloadSource(source, trusted);
      try {
        await this.downloadFrom(selected, trusted);
      } catch (error) {
        if (selected.kind !== "intranet") throw error;
        this.setSnapshot({ message: "内网下载失败，正在自动回退 GitHub", error: undefined });
        await this.downloadFrom({ url: githubUpdateBaseUrl, headers: null, label: "GitHub", kind: "github" }, trusted);
      }
      this.setSnapshot({ status: "downloaded", message: "新版下载完成，正在重启并覆盖安装", progressPercent: 100 });
      this.scheduleInstall(() => {
        try {
          this.setSnapshot({ status: "installing", message: "正在退出程序并安装新版" });
          this.updater?.quitAndInstall(true, true);
        } catch (error) {
          this.setSnapshot({ status: "error", message: "自动安装启动失败", error: toMessage(error) });
        }
      });
      return this.getSnapshot();
    } catch (error) {
      this.setSnapshot({ status: "error", message: "自动更新失败", error: toMessage(error) });
      throw error;
    }
  }

  async getReleaseNotes(): Promise<UpdateReleaseNotes> {
    return this.latestRelease ?? this.fetchLatestRelease();
  }

  private canAutoUpdate(): boolean {
    return this.platform === "win32" && this.isPackaged && Boolean(this.updater);
  }

  private configureUpdaterEvents(): void {
    if (!this.updater) return;
    this.updater.on("download-progress", (progress: { percent?: number }) => {
      const percent = Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent ?? 0)) : 0;
      this.setSnapshot({ status: "downloading", progressPercent: percent, message: `正在下载新版 ${percent.toFixed(1)}%` });
    });
    this.updater.on("error", (error: Error) => {
      if (["downloading", "downloaded", "installing"].includes(this.snapshot.status)) {
        this.setSnapshot({ status: "error", message: "自动更新失败", error: toMessage(error) });
      }
    });
  }

  private async selectDownloadSource(
    source: RemoteMixSettings | undefined,
    trusted: UpdateMetadata
  ): Promise<{ url: string; headers: Record<string, string> | null; label: string; kind: "intranet" | "github" }> {
    if (source?.serverUrl && source.token) {
      const mirrorUrl = `${source.serverUrl.replace(/\/+$/, "")}/api/updates/windows`;
      const headers = { "x-mix-token": source.token };
      try {
        const mirror = await this.fetchUpdateMetadata(mirrorUrl, headers);
        if (!sameMetadata(mirror, trusted)) throw new Error("内网更新源校验信息不一致");
        return { url: mirrorUrl, headers, label: "公司内网服务器", kind: "intranet" };
      } catch {
        this.setSnapshot({ message: "内网更新源不可用，正在回退 GitHub" });
      }
    }
    return { url: githubUpdateBaseUrl, headers: null, label: "GitHub", kind: "github" };
  }

  private async downloadFrom(
    selected: { url: string; headers: Record<string, string> | null; label: string; kind: "intranet" | "github" },
    trusted: UpdateMetadata
  ): Promise<void> {
    if (!this.updater) throw new Error("自动更新组件未加载");
    this.updater.requestHeaders = selected.headers;
    this.updater.setFeedURL({ provider: "generic", url: selected.url });
    this.setSnapshot({
      status: "downloading",
      message: `正在从${selected.label}下载 ${trusted.version}`,
      progressPercent: 0,
      error: undefined,
      downloadSource: selected.kind
    });
    const checkResult = await this.updater.checkForUpdates();
    assertUpdaterMetadata(checkResult?.updateInfo, trusted);
    await this.updater.downloadUpdate();
  }

  private async fetchLatestRelease(): Promise<UpdateReleaseNotes> {
    const response = await this.fetchImpl(latestReleaseApiUrl, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "YiboBioMixCut-Updater" },
      signal: AbortSignal.timeout(UPDATE_REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`更新日志获取失败：HTTP ${response.status}`);
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

  private async fetchUpdateMetadata(baseUrl: string, headers?: Record<string, string>): Promise<UpdateMetadata> {
    const response = await this.fetchImpl(`${baseUrl.replace(/\/+$/, "")}/latest.yml`, {
      headers: { "User-Agent": "YiboBioMixCut-Updater", ...headers },
      signal: AbortSignal.timeout(UPDATE_REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`更新校验信息获取失败：HTTP ${response.status}`);
    return parseUpdateMetadata(await response.text());
  }

  private setSnapshot(patch: Partial<UpdateSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit("update", this.getSnapshot());
  }
}

export function parseUpdateMetadata(raw: string): UpdateMetadata {
  const version = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(raw)?.[1] ?? "";
  const filePath = /^path:\s*['"]?([^'"\r\n]+)['"]?\s*$/m.exec(raw)?.[1]?.trim() ?? "";
  const sha512 = /^sha512:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(raw)?.[1] ?? "";
  const sizeText = /^\s+size:\s*(\d+)\s*$/m.exec(raw)?.[1];
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) || !/^YiboBioMixCut-[0-9A-Za-z.+-]+-x64\.exe$/.test(filePath) || !sha512) {
    throw new Error("更新校验信息格式无效");
  }
  return { version, path: filePath, sha512, size: sizeText ? Number(sizeText) : undefined };
}

function sameMetadata(left: UpdateMetadata, right: UpdateMetadata): boolean {
  return left.version === right.version && left.path === right.path && left.sha512 === right.sha512 && left.size === right.size;
}

function assertUpdaterMetadata(
  updateInfo: { version?: string; files?: Array<{ url: string; sha512?: string }> } | undefined,
  trusted: UpdateMetadata
): void {
  const file = updateInfo?.files?.find((item) => item.url === trusted.path) ?? updateInfo?.files?.[0];
  if (updateInfo?.version !== trusted.version || file?.url !== trusted.path || file.sha512 !== trusted.sha512) {
    throw new Error("下载源返回的版本或校验值与 GitHub 不一致，已阻止安装");
  }
}

function compareVersion(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
