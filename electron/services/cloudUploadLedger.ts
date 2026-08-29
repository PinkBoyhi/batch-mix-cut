import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  CloudImportJob,
  CloudImportVideo,
  CloudLocalUploadJob,
  CloudLocalUploadVideo,
  CloudUploadLedgerEntry
} from "../../src/shared/types.js";

const LEDGER_FILE = ".yibo-cloud-upload-state.json";
const LEDGER_VERSION = 1;
const FINGERPRINT_SAMPLE_BYTES = 64 * 1024;

type LedgerStatus = "uploaded" | "submitted" | "failed";

interface StoredLedgerEntry extends CloudUploadLedgerEntry {
  size?: number;
  modifiedAtMs?: number;
  contentHash?: string;
  status: LedgerStatus;
  updatedAt: string;
}

interface StoredLedger {
  version: number;
  entries: StoredLedgerEntry[];
  updatedAt: string;
}

export class CloudUploadLedgerStore {
  async load(outputDir: string, localPaths: string[]): Promise<CloudUploadLedgerEntry[]> {
    const ledger = await this.read(outputDir);
    const byPath = new Map(ledger.entries.map((entry) => [entry.localPath, entry]));
    const entries: CloudUploadLedgerEntry[] = [];

    for (const localPath of localPaths) {
      const saved = byPath.get(localPath);
      if (!saved || !(await hasMatchingFingerprint(saved))) continue;
      entries.push(toEntryView(saved));
    }
    return entries;
  }

  async recordLocalUpload(outputDir: string, videos: CloudLocalUploadVideo[], result: CloudLocalUploadJob): Promise<void> {
    const ledger = await this.read(outputDir);
    const byPath = new Map(ledger.entries.map((entry) => [entry.localPath, entry]));
    const uploadedByPath = new Map(result.uploaded.map((entry) => [entry.localPath, entry]));
    const skippedByPath = new Map((result.skipped ?? []).map((entry) => [entry.localPath, entry]));
    const rejectedByPath = rejectedPaths(result.uploaded, result.importJob);

    for (const video of videos) {
      const uploaded = uploadedByPath.get(video.localPath);
      const skipped = skippedByPath.get(video.localPath);
      if (uploaded) {
        const rejection = rejectedByPath.get(uploaded.localPath);
        byPath.set(uploaded.localPath, await this.createEntry(uploaded.localPath, {
          url: uploaded.url,
          submitted: Boolean(result.importJob && !rejection),
          error: rejection ?? result.submissionError,
          requestId: result.importJob?.requestId,
          status: result.importJob && !rejection ? "submitted" : "uploaded"
        }, byPath.get(uploaded.localPath)));
        continue;
      }
      if (skipped) {
        byPath.set(skipped.localPath, await this.createEntry(skipped.localPath, {
          submitted: false,
          error: skipped.reason,
          status: "failed"
        }, byPath.get(skipped.localPath)));
      }
    }

    await this.write(outputDir, [...byPath.values()]);
  }

  async recordImportSubmission(outputDir: string, videos: CloudImportVideo[], importJob: CloudImportJob): Promise<void> {
    const ledger = await this.read(outputDir);
    const byPath = new Map(ledger.entries.map((entry) => [entry.localPath, entry]));
    const rejectedByPath = rejectedPaths(videos, importJob);

    for (const video of videos) {
      if (!video.localPath) continue;
      const rejection = rejectedByPath.get(video.localPath);
      byPath.set(video.localPath, await this.createEntry(video.localPath, {
        url: video.url,
        submitted: !rejection,
        error: rejection,
        requestId: importJob.requestId,
        status: rejection ? "uploaded" : "submitted"
      }, byPath.get(video.localPath)));
    }

    await this.write(outputDir, [...byPath.values()]);
  }

  private async createEntry(
    localPath: string,
    update: Pick<StoredLedgerEntry, "url" | "submitted" | "error" | "requestId" | "status">,
    previous?: StoredLedgerEntry
  ): Promise<StoredLedgerEntry> {
    const fingerprint = await readFingerprint(localPath);
    return {
      localPath,
      url: update.url ?? previous?.url,
      submitted: update.submitted,
      error: update.error,
      requestId: update.requestId ?? previous?.requestId,
      size: fingerprint?.size,
      modifiedAtMs: fingerprint?.modifiedAtMs,
      contentHash: fingerprint?.contentHash,
      status: update.status,
      updatedAt: new Date().toISOString()
    };
  }

  private async read(outputDir: string): Promise<StoredLedger> {
    try {
      const raw = await fs.readFile(this.ledgerPath(outputDir), "utf8");
      const parsed = JSON.parse(raw) as Partial<StoredLedger>;
      return {
        version: LEDGER_VERSION,
        entries: Array.isArray(parsed.entries) ? parsed.entries.filter(isStoredEntry) : [],
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : ""
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: LEDGER_VERSION, entries: [], updatedAt: "" };
      }
      throw error;
    }
  }

  private async write(outputDir: string, entries: StoredLedgerEntry[]): Promise<void> {
    const target = this.ledgerPath(outputDir);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const payload: StoredLedger = {
      version: LEDGER_VERSION,
      entries: entries.sort((left, right) => left.localPath.localeCompare(right.localPath, "zh-CN")),
      updatedAt: new Date().toISOString()
    };
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fs.rename(temporary, target);
  }

  private ledgerPath(outputDir: string): string {
    if (!path.isAbsolute(outputDir)) {
      throw new Error("上传任务清单需要有效的本地输出目录");
    }
    return path.join(outputDir, LEDGER_FILE);
  }
}

function rejectedPaths(
  videos: Array<{ localPath?: string; videoName: string }>,
  importJob?: CloudImportJob
): Map<string, string> {
  const rejected = new Map<string, string>();
  if (!importJob) return rejected;
  for (const error of importJob.errorList) {
    const video = videos[error.index];
    if (!video?.localPath) continue;
    const message = error.errors?.map((item) => item.message).filter(Boolean).join("、") || "云管家拒绝导入";
    rejected.set(video.localPath, message);
  }
  return rejected;
}

async function readFingerprint(localPath: string): Promise<{ size: number; modifiedAtMs: number; contentHash: string } | undefined> {
  const stat = await fs.stat(localPath).catch(() => undefined);
  if (!stat?.isFile()) return undefined;
  const handle = await fs.open(localPath, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const hash = createHash("sha256");
    hash.update(String(stat.size));
    const firstSize = Math.min(stat.size, FINGERPRINT_SAMPLE_BYTES);
    if (firstSize > 0) {
      const first = Buffer.alloc(firstSize);
      const { bytesRead } = await handle.read(first, 0, firstSize, 0);
      hash.update(first.subarray(0, bytesRead));
    }
    if (stat.size > FINGERPRINT_SAMPLE_BYTES) {
      const lastSize = Math.min(stat.size - firstSize, FINGERPRINT_SAMPLE_BYTES);
      const last = Buffer.alloc(lastSize);
      const { bytesRead } = await handle.read(last, 0, lastSize, stat.size - lastSize);
      hash.update(last.subarray(0, bytesRead));
    }
    return { size: stat.size, modifiedAtMs: Math.round(stat.mtimeMs), contentHash: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function hasMatchingFingerprint(entry: StoredLedgerEntry): Promise<boolean> {
  if (entry.size === undefined || entry.modifiedAtMs === undefined || !entry.contentHash) return false;
  const fingerprint = await readFingerprint(entry.localPath);
  return (
    fingerprint?.size === entry.size &&
    fingerprint.modifiedAtMs === entry.modifiedAtMs &&
    fingerprint.contentHash === entry.contentHash
  );
}

function toEntryView(entry: StoredLedgerEntry): CloudUploadLedgerEntry {
  return {
    localPath: entry.localPath,
    url: entry.url,
    submitted: entry.submitted,
    error: entry.error,
    requestId: entry.requestId
  };
}

function isStoredEntry(value: unknown): value is StoredLedgerEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<StoredLedgerEntry>;
  return typeof entry.localPath === "string" && typeof entry.submitted === "boolean" && typeof entry.status === "string";
}
