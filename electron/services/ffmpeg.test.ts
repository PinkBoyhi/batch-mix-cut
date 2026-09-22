import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AssetInfo, MixCombination, MixProjectConfig } from "../../src/shared/types.js";
import { exportVideo, mergeAssetMetadata, resolveBgmTargetDb, shouldPreserveLegacyLoudness } from "./ffmpeg.js";
import { getFfmpegPath } from "./ffmpegBinaries.js";
import { probeAsset } from "./mediaProbe.js";

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
    expect(
      mergeAssetMetadata({ ...asset, durationSeconds: 5, width: 1080, height: 1920 }, { hasAudio: false })
    ).toEqual(expect.objectContaining({ hasAudio: true, durationSeconds: 5, width: 1080, height: 1920 }));
  });

  it("keeps the legacy v9 loudness calculation only for unfinished old tasks", () => {
    expect(resolveBgmTargetDb([{ meanDb: -11.1, gainDb: -1.5 }])).toBeCloseTo(-18.6);
    expect(resolveBgmTargetDb([{ meanDb: -30, gainDb: 0 }])).toBe(-23);
    expect(resolveBgmTargetDb([])).toBe(-23);
    expect(shouldPreserveLegacyLoudness({})).toBe(false);
    expect(shouldPreserveLegacyLoudness({ audioPipelineVersion: 10 })).toBe(false);
    expect(shouldPreserveLegacyLoudness({ audioPipelineVersion: 9, normalizeLoudness: true } as { audioPipelineVersion: number })).toBe(true);
    expect(shouldPreserveLegacyLoudness({ audioPipelineVersion: 9, normalizeLoudness: false } as { audioPipelineVersion: number })).toBe(false);
  });

  it(
    "aligns segment transitions to video duration when source audio is longer or shorter",
    async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yibo-mix-av-sync-"));
      tempDirs.push(tempDir);

      const firstPath = path.join(tempDir, "long-audio.mp4");
      const secondPath = path.join(tempDir, "short-audio.mp4");
      const outputPath = path.join(tempDir, "mixed-output.mp4");
      await createMismatchedDurationVideo(firstPath, "red", 24, 1, 1.6, 440);
      await createMismatchedDurationVideo(secondPath, "blue", 60, 1, 0.4, 880);

      const first: AssetInfo = {
        id: "long-audio",
        kind: "video",
        name: "long-audio.mp4",
        path: firstPath,
        durationSeconds: 1.6,
        width: 320,
        height: 568,
        hasAudio: true
      };
      const second: AssetInfo = {
        id: "short-audio",
        kind: "video",
        name: "short-audio.mp4",
        path: secondPath,
        durationSeconds: 1,
        width: 320,
        height: 568,
        hasAudio: true
      };
      const probedFirst = await probeAsset(first);
      expect(probedFirst.videoDurationSeconds).toBeCloseTo(1, 2);
      expect(probedFirst.audioDurationSeconds).toBeGreaterThan(1.5);
      expect(probedFirst.durationSeconds).toBeCloseTo(1, 2);

      const config: MixProjectConfig = {
        projectDir: tempDir,
        outputDir: tempDir,
        slots: [
          { name: "A", assets: [first], sortOrder: 0 },
          { name: "B", assets: [second], sortOrder: 1 }
        ],
        bgmAssets: [],
        bgmRange: { fadeInSeconds: 0, fadeOutSeconds: 0 },
        bgmTracks: [],
        maxCombinations: 1,
        outputNamePattern: "mixed",
        exportMode: "video",
        sourceVolume: 1,
        bgmVolume: 1,
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
        slotAssets: { A: first, B: second },
        targetVideoPath: outputPath,
        targetDraftPath: path.join(tempDir, "draft")
      };

      await exportVideo(config, combination).promise;

      const output = await probeAsset({ id: "output", path: outputPath, name: "output.mp4", kind: "video" });
      expect(output.videoDurationSeconds).toBeCloseTo(2, 1);
      expect(output.audioDurationSeconds).toBeCloseTo(2, 1);
      expect(Math.abs((output.videoDurationSeconds ?? 0) - (output.audioDurationSeconds ?? 0))).toBeLessThan(0.1);
      const chroma = await measureFrameChroma(outputPath, 1.2);
      expect(chroma.uAverage).toBeGreaterThan(chroma.vAverage);
    },
    30000
  );

  it(
    "keeps audio from high-frame-rate camera footage with a PCM track",
    async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yibo-mix-camera-audio-"));
      tempDirs.push(tempDir);

      const inputPath = path.join(tempDir, "camera-source.mov");
      const outputPath = path.join(tempDir, "mixed-output.mp4");
      await runFfmpeg([
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x568:rate=120000/1001:duration=0.8",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=660:sample_rate=48000:duration=0.8",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "pcm_s16be",
        inputPath
      ]);

      const asset: AssetInfo = {
        id: "camera-source",
        kind: "video",
        name: "camera-source.mov",
        path: inputPath,
        durationSeconds: 0.8,
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

      const output = await probeAsset({ id: "output", path: outputPath, name: "output.mp4", kind: "video" });
      expect(output.hasAudio).toBe(true);
      expect(output.videoDurationSeconds).toBeCloseTo(0.8, 1);
      expect(output.audioDurationSeconds).toBeCloseTo(0.8, 1);
      await expect(measureMeanVolume(outputPath)).resolves.toBeGreaterThan(-35);
    },
    30000
  );

  it(
    "keeps ipcm audio from current phone and camera MP4 files",
    async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yibo-mix-ipcm-audio-"));
      tempDirs.push(tempDir);

      const inputPath = fileURLToPath(new URL("./fixtures/ipcm-phone-sample.mp4", import.meta.url));
      const outputPath = path.join(tempDir, "mixed-output.mp4");

      const asset = await probeAsset({
        id: "phone-ipcm",
        kind: "video",
        name: "phone-ipcm.mp4",
        path: inputPath
      });
      expect(asset.hasAudio).toBe(true);
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

      const output = await probeAsset({ id: "output", path: outputPath, name: "output.mp4", kind: "video" });
      expect(output.hasAudio).toBe(true);
      await expect(measureMeanVolume(outputPath)).resolves.toBeGreaterThan(-35);
    },
    30000
  );

  it("rejects a silent combination instead of publishing it as completed", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yibo-mix-no-audio-"));
    tempDirs.push(tempDir);
    const inputPath = path.join(tempDir, "video-only.mp4");
    await runFfmpeg([
      "-y", "-f", "lavfi", "-i", "testsrc2=size=160x284:rate=30:duration=0.4",
      "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", inputPath
    ]);
    const asset = await probeAsset({ id: "video-only", path: inputPath, name: "video-only.mp4", kind: "video" });
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
      videoProfile: { codec: "h264", audioCodec: "aac", preset: "veryfast", crf: 28, canvasMode: "original" },
      exportTarget: "local",
      draftSlots: []
    };

    await expect(exportVideo(config, {
      id: "mix_0001",
      index: 1,
      slotAssets: { A: asset },
      targetVideoPath: path.join(tempDir, "mixed-output.mp4"),
      targetDraftPath: path.join(tempDir, "draft")
    }).promise).rejects.toThrow("没有可解码音轨");
  }, 30000);

  it(
    "does not automatically raise a very quiet source",
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

      const inputMeanVolume = await measureMeanVolume(inputPath);
      await exportVideo(config, combination).promise;

      const meanVolume = await measureMeanVolume(outputPath);
      expect(meanVolume - inputMeanVolume).toBeLessThan(2);
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

async function createMismatchedDurationVideo(
  targetPath: string,
  color: string,
  frameRate: number,
  videoDuration: number,
  audioDuration: number,
  frequency: number
): Promise<void> {
  await runFfmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:size=320x568:rate=${frameRate}:duration=${videoDuration}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${frequency}:sample_rate=44100:duration=${audioDuration}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    targetPath
  ]);
}

async function measureFrameChroma(filePath: string, timestamp: number): Promise<{ uAverage: number; vAverage: number }> {
  const stderr = await collectFfmpegStderr([
    "-hide_banner",
    "-loglevel",
    "info",
    "-ss",
    String(timestamp),
    "-i",
    filePath,
    "-frames:v",
    "1",
    "-vf",
    "signalstats,metadata=mode=print",
    "-f",
    "null",
    "-"
  ]);
  const uAverage = Number(stderr.match(/lavfi\.signalstats\.UAVG=([\d.]+)/)?.[1]);
  const vAverage = Number(stderr.match(/lavfi\.signalstats\.VAVG=([\d.]+)/)?.[1]);
  if (!Number.isFinite(uAverage) || !Number.isFinite(vAverage)) {
    throw new Error("无法读取测试成片的画面颜色");
  }
  return { uAverage, vAverage };
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
