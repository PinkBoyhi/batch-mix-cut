import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCloudUploadVideos } from "./mixServer.js";

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
