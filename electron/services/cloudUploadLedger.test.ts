import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudUploadLedgerStore } from "./cloudUploadLedger.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("CloudUploadLedgerStore", () => {
  it("restores a submitted local upload after the app restarts", async () => {
    const { outputDir, videoPath } = await createVideo();
    const store = new CloudUploadLedgerStore();

    await store.recordLocalUpload(outputDir, [localVideo(videoPath)], {
      uploaded: [{ localPath: videoPath, videoName: "成品_001", url: "https://cdn.example.com/001.mp4" }],
      importJob: { requestId: "request-001", errorList: [] }
    });

    await expect(new CloudUploadLedgerStore().load(outputDir, [videoPath])).resolves.toEqual([
      {
        localPath: videoPath,
        url: "https://cdn.example.com/001.mp4",
        submitted: true,
        requestId: "request-001"
      }
    ]);
  });

  it("keeps other files recoverable when one file fails, and ignores a replaced file", async () => {
    const { outputDir, videoPath } = await createVideo();
    const failedPath = path.join(outputDir, "videos", "成品_002.mp4");
    await fs.writeFile(failedPath, "failed-video");
    const store = new CloudUploadLedgerStore();

    await store.recordLocalUpload(outputDir, [localVideo(videoPath), localVideo(failedPath)], {
      uploaded: [{ localPath: videoPath, videoName: "成品_001", url: "https://cdn.example.com/001.mp4" }],
      skipped: [{ localPath: failedPath, videoName: "成品_002", reason: "网络中断" }],
      importJob: { requestId: "request-002", errorList: [] }
    });

    await expect(store.load(outputDir, [videoPath, failedPath])).resolves.toEqual([
      expect.objectContaining({ localPath: videoPath, submitted: true, url: "https://cdn.example.com/001.mp4" }),
      expect.objectContaining({ localPath: failedPath, submitted: false, error: "网络中断" })
    ]);

    const originalStat = await fs.stat(videoPath);
    await fs.writeFile(videoPath, "other-video");
    await fs.utimes(videoPath, originalStat.atime, originalStat.mtime);
    await expect(store.load(outputDir, [videoPath, failedPath])).resolves.toEqual([
      expect.objectContaining({ localPath: failedPath, submitted: false, error: "网络中断" })
    ]);
  });
});

async function createVideo(): Promise<{ outputDir: string; videoPath: string }> {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-upload-ledger-"));
  temporaryDirectories.push(outputDir);
  const videosDir = path.join(outputDir, "videos");
  await fs.mkdir(videosDir, { recursive: true });
  const videoPath = path.join(videosDir, "成品_001.mp4");
  await fs.writeFile(videoPath, "first-video");
  return { outputDir, videoPath };
}

function localVideo(localPath: string) {
  return {
    localPath,
    videoName: path.basename(localPath, ".mp4"),
    videoType: 0,
    twoLevelTypeId: 1,
    labelIds: "1",
    videoRight: 0,
    rotation: "none" as const
  };
}
