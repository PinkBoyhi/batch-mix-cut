import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AssetInfo, MixCombination, MixProjectConfig } from "../../src/shared/types.js";
import { exportVideo, mergeAssetMetadata } from "./ffmpeg.js";
import { getFfmpegPath } from "./ffmpegBinaries.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("exportVideo audio output", () => {
  it("keeps a desktop-confirmed audio stream when a server-side re-probe has no audio result", () => {
    const asset: AssetInfo = {
      id: "known-audio",
      kind: "video",
      name: "known-audio.mp4",
      path: "/remote/source.mp4",
      hasAudio: true
    };

    expect(mergeAssetMetadata(asset, { hasAudio: false, durationSeconds: 2 })).toEqual(
      expect.objectContaining({ hasAudio: true, durationSeconds: 2 })
    );
  });

  it(
    "repairs very quiet exported audio even when loudness normalization is disabled",
    async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yibo-mix-audio-"));
      tempDirs.push(tempDir);

      const inputPath = path.join(tempDir, "quiet-source.mp4");
      const outputPath = path.join(tempDir, "mixed-output.mp4");
      await runFfmpeg([
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x568:rate=30:duration=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=44100:duration=1",
        "-filter:a",
        "volume=0.001",
        "-shortest",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        inputPath
      ]);

      const asset: AssetInfo = {
        id: "quiet-source",
        kind: "video",
        name: "quiet-source.mp4",
        path: inputPath,
        durationSeconds: 1,
        width: 320,
        height: 568,
        hasAudio: true
      };
      const config: MixProjectConfig = {
        projectDir: tempDir,
        outputDir: tempDir,
        slots: [{ name: "A", assets: [asset], sortOrder: 0 }],
        bgmAssets: [],
        bgmRange: { fadeInSeconds: 0, fadeOutSeconds: 0 },
        bgmTracks: [],
        maxCombinations: 1,
        outputNamePattern: "mixed",
        exportMode: "video",
        sourceVolume: 1,
        bgmVolume: 1,
        normalizeLoudness: false,
        videoProfile: {
          codec: "h264",
          audioCodec: "aac",
          preset: "veryfast",
          crf: 28,
          canvasMode: "original"
        },
        exportTarget: "local",
        draftSlots: []
      };
      const combination: MixCombination = {
        id: "mix_0001",
        index: 1,
        slotAssets: { A: asset },
        targetVideoPath: outputPath,
        targetDraftPath: path.join(tempDir, "draft")
      };

      await exportVideo(config, combination).promise;

      const meanVolume = await measureMeanVolume(outputPath);
      expect(meanVolume).toBeGreaterThan(-35);
    },
    30000
  );

  it(
    "keeps background music audible when original video sound is disabled",
    async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yibo-mix-bgm-"));
      tempDirs.push(tempDir);

      const inputPath = path.join(tempDir, "silent-source.mp4");
      const bgmPath = path.join(tempDir, "background.m4a");
      const outputPath = path.join(tempDir, "mixed-output.mp4");
      await runFfmpeg([
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x568:rate=30:duration=1",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        inputPath
      ]);
      await runFfmpeg([
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:sample_rate=44100:duration=1",
        "-c:a",
        "aac",
        bgmPath
      ]);

      const videoAsset: AssetInfo = {
        id: "silent-source",
        kind: "video",
        name: "silent-source.mp4",
        path: inputPath,
        durationSeconds: 1,
        width: 320,
        height: 568,
        hasAudio: false
      };
      const bgmAsset: AssetInfo = {
        id: "background",
        kind: "audio",
        name: "background.m4a",
        path: bgmPath,
        durationSeconds: 1,
        hasAudio: true
      };
      const config: MixProjectConfig = {
        projectDir: tempDir,
        outputDir: tempDir,
        slots: [{ name: "A", assets: [videoAsset], sortOrder: 0 }],
        bgmAssets: [bgmAsset],
        bgmRange: { startSlotName: "A", endSlotName: "A", fadeInSeconds: 0, fadeOutSeconds: 0 },
        bgmTracks: [],
        maxCombinations: 1,
        outputNamePattern: "mixed",
        exportMode: "video",
        sourceVolume: 0,
        bgmVolume: 1,
        normalizeLoudness: false,
        videoProfile: {
          codec: "h264",
          audioCodec: "aac",
          preset: "veryfast",
          crf: 28,
          canvasMode: "original"
        },
        exportTarget: "local",
        draftSlots: []
      };
      const combination: MixCombination = {
        id: "mix_0001",
        index: 1,
        slotAssets: { A: videoAsset },
        bgm: bgmAsset,
        targetVideoPath: outputPath,
        targetDraftPath: path.join(tempDir, "draft")
      };

      await exportVideo(config, combination).promise;

      await expect(measureMeanVolume(outputPath)).resolves.toBeGreaterThan(-35);
    },
    30000
  );
});

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(getFfmpegPath(), args);
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `FFmpeg 退出码 ${code}`));
    });
  });
}

async function measureMeanVolume(filePath: string): Promise<number> {
  const stderr = await collectFfmpegStderr([
    "-hide_banner",
    "-nostats",
    "-i",
    filePath,
    "-vn",
    "-sn",
    "-dn",
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-"
  ]);
  const match = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
  return match ? Number(match[1]) : Number.NEGATIVE_INFINITY;
}

function collectFfmpegStderr(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(getFfmpegPath(), args);
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stderr);
        return;
      }
      reject(new Error(stderr.trim() || `FFmpeg 退出码 ${code}`));
    });
  });
}
