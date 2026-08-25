import { describe, expect, it } from "vitest";
import type { MixProjectConfig } from "../../src/shared/types.js";
import { resolveWorkflowTitle } from "./workflowTitle.js";

describe("resolveWorkflowTitle", () => {
  it("优先使用手动填写的脚本标题", () => {
    expect(resolveWorkflowTitle(config({ workflowTitle: "术后护理脚本" }))).toBe("术后护理脚本");
  });

  it("旧项目自动使用项目文件夹名", () => {
    expect(resolveWorkflowTitle(config({ projectDir: "C:\\素材\\高血压科普" }))).toBe("高血压科普");
  });

  it("服务器临时目录不会再显示 desktop 任务 ID", () => {
    expect(resolveWorkflowTitle(config({ projectDir: "/mix/projects/desktop-1787650563294-a87e9c3a", outputNamePattern: "口播成片" }))).toBe("口播成片");
  });
});

function config(overrides: Partial<MixProjectConfig>): MixProjectConfig {
  return {
    projectDir: "/project",
    outputDir: "/project/outputs",
    slots: [],
    bgmAssets: [],
    bgmRange: { fadeInSeconds: 0, fadeOutSeconds: 0 },
    bgmTracks: [],
    maxCombinations: 1,
    outputNamePattern: "成品",
    exportMode: "video",
    sourceVolume: 1,
    bgmVolume: 1,
    normalizeLoudness: true,
    videoProfile: { codec: "h264", audioCodec: "aac", preset: "fast", crf: 20, canvasMode: "original" },
    exportTarget: "cloud",
    draftSlots: [],
    ...overrides
  };
}
