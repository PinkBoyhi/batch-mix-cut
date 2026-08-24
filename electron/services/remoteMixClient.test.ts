import { describe, expect, it } from "vitest";
import type { AssetInfo } from "../../src/shared/types.js";
import { getRemoteCompletionError, toRemoteAsset } from "./remoteMixClient.js";

describe("toRemoteAsset", () => {
  const videoWithAudio: AssetInfo = {
    id: "video",
    kind: "video",
    name: "video.mp4",
    path: "/local/video.mp4",
    hasAudio: true,
    width: 1080,
    height: 1920,
    durationSeconds: 3
  };

  it("skips the broken re-probe path on legacy servers for a desktop-confirmed audio stream", () => {
    expect(toRemoteAsset(videoWithAudio, "/server/video.mp4", true)).toEqual(
      expect.objectContaining({ path: "/server/video.mp4", kind: "audio", hasAudio: true })
    );
  });

  it("keeps normal video metadata when the server supports the fixed audio pipeline", () => {
    expect(toRemoteAsset(videoWithAudio, "/server/video.mp4", false)).toEqual(
      expect.objectContaining({ path: "/server/video.mp4", kind: "video", hasAudio: true })
    );
  });

  it("reports the server-side cause when a completed job produced no video", () => {
    expect(
      getRemoteCompletionError({
        id: "server-job",
        status: "completed",
        total: 1,
        completed: 0,
        failed: 1,
        message: "批量任务已完成",
        failures: [{ combinationId: "mix_0001", phase: "video", message: "FFmpeg 输出失败" }]
      })
    ).toBe("服务器未生成成片：FFmpeg 输出失败");
  });

  it("allows download when the server produced at least one video", () => {
    expect(
      getRemoteCompletionError({
        id: "server-job",
        status: "completed",
        total: 2,
        completed: 1,
        failed: 1,
        message: "批量任务已完成",
        failures: [{ combinationId: "mix_0002", phase: "video", message: "FFmpeg 输出失败" }]
      })
    ).toBeUndefined();
  });
});
