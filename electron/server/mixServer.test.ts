import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MixProjectConfig, WorkflowRecord } from "../../src/shared/types.js";
import { cleanupExpiredProjects, describeQueuePosition, findRunnableProjectIndex, resolveCloudUploadVideos, resolveRestoredAudioPipelineVersion, shouldNotifyWorkflow, validateProjectIsolation } from "./mixServer.js";

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

describe("cleanupExpiredProjects", () => {
  it("只清理过期且不在执行中的服务器项目", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mix-server-cleanup-"));
    temporaryDirectories.push(workspace);
    const projectsDir = path.join(workspace, "projects");
    const expired = path.join(projectsDir, "expired");
    const active = path.join(projectsDir, "active");
    const recent = path.join(projectsDir, "recent");
    await Promise.all([expired, active, recent].map((directory) => fs.mkdir(directory, { recursive: true })));
    const now = Date.now();
    const oldTime = new Date(now - 25 * 60 * 60 * 1000);
    await Promise.all([
      fs.utimes(expired, oldTime, oldTime),
      fs.utimes(active, oldTime, oldTime)
    ]);

    const removed = await cleanupExpiredProjects(projectsDir, 24 * 60 * 60 * 1000, new Set([active]), now);

    expect(removed).toBe(1);
    await expect(fs.stat(expired)).rejects.toThrow();
    await expect(fs.stat(active)).resolves.toBeDefined();
    await expect(fs.stat(recent)).resolves.toBeDefined();
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

describe("服务器并发项目隔离", () => {
  it("显示稳定且明确的排队位置", () => {
    expect(describeQueuePosition(2, 5, 2)).toBe("服务器繁忙，当前排队第 2/5 位；最多同时处理 2 个不同项目");
  });

  it("跳过与运行槽位相同的项目，选择另一个项目", () => {
    expect(findRunnableProjectIndex(["project-a", "project-b"], new Set(["project-a"]))).toBe(1);
    expect(findRunnableProjectIndex(["project-a", "project-a"], new Set(["project-a"]))).toBe(-1);
  });

  it("允许素材和输出都位于当前项目目录", () => {
    const projectsRoot = path.join(os.tmpdir(), "mix-work", "projects");
    const projectRoot = path.join(projectsRoot, "project-a");
    expect(() => validateProjectIsolation(projectConfig(projectRoot), projectsRoot)).not.toThrow();
  });

  it("拒绝读取其他项目的素材", () => {
    const projectsRoot = path.join(os.tmpdir(), "mix-work", "projects");
    const projectRoot = path.join(projectsRoot, "project-a");
    const config = projectConfig(projectRoot);
    config.slots[0].assets[0].path = path.join(projectsRoot, "project-b", "source.mp4");
    expect(() => validateProjectIsolation(config, projectsRoot)).toThrow("不属于当前服务器项目");
  });

  it("拒绝把成片写入其他项目", () => {
    const projectsRoot = path.join(os.tmpdir(), "mix-work", "projects");
    const projectRoot = path.join(projectsRoot, "project-a");
    const config = projectConfig(projectRoot);
    config.outputDir = path.join(projectsRoot, "project-b", "outputs");
    expect(() => validateProjectIsolation(config, projectsRoot)).toThrow("输出目录不属于当前服务器项目");
  });
});

describe("服务器任务音频管线恢复", () => {
  it("把升级前没有版本号的任务固定为 v8", () => {
    expect(resolveRestoredAudioPipelineVersion({})).toBe(8);
  });

  it("保留新任务已经保存的音频管线版本", () => {
    expect(resolveRestoredAudioPipelineVersion({ audioPipelineVersion: 9 })).toBe(9);
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

function projectConfig(projectRoot: string): MixProjectConfig {
  const source = {
    id: "source-1",
    path: path.join(projectRoot, "segments", "source.mp4"),
    name: "source.mp4",
    kind: "video" as const
  };
  return {
    projectDir: projectRoot,
    outputDir: path.join(projectRoot, "outputs"),
    slots: [{ name: "开头", assets: [source], sortOrder: 0 }],
    bgmAssets: [],
    bgmRange: { fadeInSeconds: 0, fadeOutSeconds: 0 },
    bgmTracks: [],
    maxCombinations: 20,
    outputNamePattern: "mix_{index}",
    exportMode: "video",
    sourceVolume: 1,
    bgmVolume: 0.7,
    normalizeLoudness: true,
    videoProfile: { codec: "h264", audioCodec: "aac", preset: "veryfast", crf: 23, canvasMode: "vertical_9_16" },
    exportTarget: "local",
    draftSlots: []
  };
}
