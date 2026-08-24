import { describe, expect, it } from "vitest";
import type { AssetInfo } from "../../src/shared/types.js";
import { toRemoteAsset } from "./remoteMixClient.js";

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
});
