import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseUpdateMetadata } from "../services/updateManager.js";

const METADATA_REFRESH_MS = 5 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

export class WindowsUpdateCache {
  private lastMetadataRefreshAt = 0;
  private metadataRefresh?: Promise<string>;
  private readonly downloads = new Map<string, Promise<string>>();

  constructor(
    private readonly cacheDir: string,
    private readonly sourceBaseUrl = "https://github.com/PinkBoyhi/batch-mix-cut/releases/latest/download",
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async warm(): Promise<string> {
    await fs.mkdir(this.cacheDir, { recursive: true });
    const metadataPath = await this.refreshMetadata(true);
    const metadata = parseUpdateMetadata(await fs.readFile(metadataPath, "utf8"));
    return this.resolve(metadata.path);
  }

  async resolve(requestedName: string): Promise<string> {
    await fs.mkdir(this.cacheDir, { recursive: true });
    const metadataPath = await this.refreshMetadata();
    if (requestedName === "latest.yml") return metadataPath;

    const metadata = parseUpdateMetadata(await fs.readFile(metadataPath, "utf8"));
    const allowed = new Set([metadata.path, `${metadata.path}.blockmap`]);
    if (!allowed.has(requestedName) || path.basename(requestedName) !== requestedName) {
      throw new Error("更新文件不存在");
    }
    const existing = path.join(this.cacheDir, requestedName);
    if (requestedName === metadata.path && await matchesMetadata(existing, metadata.sha512, metadata.size)) return existing;
    if (requestedName.endsWith(".blockmap") && (await fs.stat(existing).catch(() => undefined))?.isFile()) return existing;
    return this.downloads.get(requestedName) ?? this.startDownload(requestedName, metadata.sha512, metadata.size);
  }

  private async refreshMetadata(force = false): Promise<string> {
    const target = path.join(this.cacheDir, "latest.yml");
    const hasCachedMetadata = (await fs.stat(target).catch(() => undefined))?.isFile() === true;
    if (hasCachedMetadata && !force) {
      if (Date.now() - this.lastMetadataRefreshAt >= METADATA_REFRESH_MS) {
        void this.refreshMetadata(true).catch(() => undefined);
      }
      return target;
    }
    if (this.metadataRefresh) return this.metadataRefresh;
    const refresh = this.downloadMetadata(target).finally(() => {
      if (this.metadataRefresh === refresh) this.metadataRefresh = undefined;
    });
    this.metadataRefresh = refresh;
    return refresh;
  }

  private async downloadMetadata(target: string): Promise<string> {
    try {
      const response = await this.fetchImpl(`${this.sourceBaseUrl.replace(/\/+$/, "")}/latest.yml`, {
        headers: { "User-Agent": "YiboBioMixCut-Update-Mirror" },
        signal: AbortSignal.timeout(20_000)
      });
      if (!response.ok) throw new Error(`GitHub 更新信息返回 HTTP ${response.status}`);
      const raw = await response.text();
      parseUpdateMetadata(raw);
      await atomicWrite(target, Buffer.from(raw, "utf8"));
      this.lastMetadataRefreshAt = Date.now();
      return target;
    } catch (error) {
      if ((await fs.stat(target).catch(() => undefined))?.isFile()) {
        this.lastMetadataRefreshAt = Date.now();
        return target;
      }
      throw error;
    }
  }

  private startDownload(requestedName: string, sha512: string, size?: number): Promise<string> {
    const promise = this.download(requestedName, sha512, size).finally(() => this.downloads.delete(requestedName));
    this.downloads.set(requestedName, promise);
    return promise;
  }

  private async download(requestedName: string, sha512: string, size?: number): Promise<string> {
    const target = path.join(this.cacheDir, requestedName);
    const temporary = `${target}.${randomUUID()}.partial`;
    const response = await this.fetchImpl(`${this.sourceBaseUrl.replace(/\/+$/, "")}/${encodeURIComponent(requestedName)}`, {
      headers: { "User-Agent": "YiboBioMixCut-Update-Mirror" },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    });
    if (!response.ok || !response.body) throw new Error(`GitHub 更新文件返回 HTTP ${response.status}`);
    try {
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temporary));
      if (!requestedName.endsWith(".blockmap") && !(await matchesMetadata(temporary, sha512, size))) {
        throw new Error("服务器下载的 Windows 安装包校验失败");
      }
      await fs.rename(temporary, target);
      return target;
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

async function matchesMetadata(filePath: string, expectedSha512: string, expectedSize?: number): Promise<boolean> {
  const stat = await fs.stat(filePath).catch(() => undefined);
  if (!stat?.isFile() || (expectedSize !== undefined && stat.size !== expectedSize)) return false;
  const hash = createHash("sha512");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("base64") === expectedSha512;
}

async function atomicWrite(target: string, contents: Buffer): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, contents);
  await fs.rename(temporary, target);
}
