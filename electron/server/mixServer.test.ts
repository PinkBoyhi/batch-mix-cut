import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowRecord } from "../../src/shared/types.js";
import { resolveCloudUploadVideos, shouldNotifyWorkflow } from "./mixServer.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("resolveCloudUploadVideos", () => {
  it("only maps existing server outputs and supports paths sent from Windows", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mix-server-upload-"));
    temporaryDirectories.push(workspace);
    const outputDir = path.join(workspace, "outputs", "videos");
    const generatedVideo = path.join(outputDir, "mix_0001.mp4");
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(generatedVideo, "video");

    const plan = await resolveCloudUploadVideos(outputDir, [
      {
        localPath: "C:\\mix-output\\mix_0001.mp4",
        videoName: "mix_0001",
        videoType: 0,
        twoLevelTypeId: 1,
        labelIds: "1",
        videoRight: 0
      },
      {
        localPath: "/home/fcz/mix-work/outputs/videos/mix_0002.mp4",
        videoName: "mix_0002",
        videoType: 0,
        twoLevelTypeId: 1,
        labelIds: "1",
        videoRight: 0
      }
    ]);

    expect(plan.videos).toEqual([expect.objectContaining({ localPath: generatedVideo, videoName: "mix_0001" })]);
    expect(plan.originalPathByResolvedPath.get(generatedVideo)).toBe("C:\\mix-output\\mix_0001.mp4");
    expect(plan.skipped).toEqual([
      expect.objectContaining({
        localPath: "/home/fcz/mix-work/outputs/videos/mix_0002.mp4",
        reason: "服务器未找到对应的已生成 MP4 成片"
      })
    ]);
  });
});

describe("shouldNotifyWorkflow", () => {
  it("只在云管家返回最终结果后发送成功提醒", () => {
    const unconfirmed = workflowRecord({ status: "success", stage: "completed" });
    expect(shouldNotifyWorkflow(unconfirmed)).toBe(false);
    expect(shouldNotifyWorkflow({ ...unconfirmed, cloudRequestId: "request-1" })).toBe(true);
  });

  it("上传失败、超时或中断仍会提醒", () => {
    expect(shouldNotifyWorkflow(workflowRecord({ status: "failed", stage: "failed" }))).toBe(true);
    expect(shouldNotifyWorkflow(workflowRecord({ status: "attention", stage: "attention" }))).toBe(true);
    expect(shouldNotifyWorkflow(workflowRecord({ status: "interrupted", stage: "interrupted" }))).toBe(true);
  });
});

function workflowRecord(overrides: Partial<WorkflowRecord>): WorkflowRecord {
  return {
    id: "wf-1",
    displayName: "测试任务",
    executionTarget: "server",
    exportTarget: "cloud",
    stage: "mixing",
    status: "active",
    progress: { current: 0, total: 1, percent: 0, unit: "videos", message: "处理中" },
    totalVideos: 1,
    succeededVideos: 0,
    failedVideos: 0,
    startedAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    timeline: [],
    videos: [],
    ...overrides
  };
}
