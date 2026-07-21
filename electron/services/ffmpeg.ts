import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { AssetInfo, MixCombination, MixProjectConfig } from "../../src/shared/types.js";

export interface ExportHandle {
  promise: Promise<void>;
  cancel: () => void;
}

const loudnessCache = new Map<string, Promise<number | undefined>>();

export function exportVideo(config: MixProjectConfig, combination: MixCombination): ExportHandle {
  let child: ChildProcessWithoutNullStreams | undefined;
  let cancelled = false;

  const promise = (async () => {
    await fs.mkdir(path.dirname(combination.targetVideoPath), { recursive: true });
    const slots = [...config.slots].sort((a, b) => a.sortOrder - b.sortOrder);
    const videoAssets = slots.map((slot) => combination.slotAssets[slot.name]);
    const first = videoAssets[0];
    const { width, height } = resolveCanvasSize(config, first);
    const sourceLoudness = await resolveSourceLoudness(videoAssets);
    const bgmLoudness = combination.bgm ? await resolveBgmLoudness(config.bgmAssets, combination.bgm) : undefined;

    const args: string[] = ["-y"];
    for (const asset of videoAssets) {
      args.push("-i", asset.path);
    }
    if (combination.bgm) {
      args.push("-stream_loop", "-1", "-i", combination.bgm.path);
    }

    const videoFilters = videoAssets.map((_, index) => {
      return `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${index}]`;
    });
    const audioFilters = videoAssets.map((asset, index) => {
      if (config.sourceVolume > 0 && asset.hasAudio) {
        const gainDb = sourceLoudness[index]?.gainDb ?? 0;
        const volumeFilters = [
          "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo",
          `volume=${config.sourceVolume}`,
          gainDb !== 0 ? `volume=${gainDb.toFixed(2)}dB` : undefined
        ].filter(Boolean);
        return `[${index}:a]${volumeFilters.join(",")}[a${index}]`;
      }
      const duration = Math.max(0.1, asset.durationSeconds ?? 0.1);
      return `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS[a${index}]`;
    });
    const concatInputs = videoAssets.map((_, index) => `[v${index}][a${index}]`).join("");
    const filters = [
      ...videoFilters,
      ...audioFilters,
      `${concatInputs}concat=n=${videoAssets.length}:v=1:a=1[vout][asrc]`
    ];

    const bgmRange = combination.bgm ? resolveBgmRange(config, slots, videoAssets) : undefined;

    if (combination.bgm && bgmRange) {
      const bgmInputIndex = videoAssets.length;
      const fadeDuration = Math.min(config.bgmRange.fadeOutSeconds, bgmRange.durationSeconds);
      const fadeStart = Math.max(0, bgmRange.durationSeconds - fadeDuration);
      const delayMs = Math.max(0, Math.round(bgmRange.offsetSeconds * 1000));
      const bgmGainDb = bgmLoudness?.gainDb ?? 0;
      const bgmFilters = [
        `atrim=duration=${bgmRange.durationSeconds.toFixed(3)}`,
        "asetpts=PTS-STARTPTS",
        fadeDuration > 0 ? `afade=t=out:st=${fadeStart.toFixed(3)}:d=${fadeDuration.toFixed(3)}` : undefined,
        `volume=${config.bgmVolume}`,
        bgmGainDb !== 0 ? `volume=${bgmGainDb.toFixed(2)}dB` : undefined,
        `adelay=${delayMs}:all=1`
      ].filter(Boolean);
      filters.push(`[${bgmInputIndex}:a]${bgmFilters.join(",")}[abgm]`);
      filters.push("[asrc][abgm]amix=inputs=2:duration=first:dropout_transition=0[aout]");
    }

    args.push("-filter_complex", filters.join(";"), "-map", "[vout]", "-map", combination.bgm && bgmRange ? "[aout]" : "[asrc]");

    if (combination.bgm && bgmRange) {
      args.push("-shortest");
    }

    args.push(
      "-c:v",
      "libx264",
      "-preset",
      config.videoProfile.preset,
      "-crf",
      String(config.videoProfile.crf),
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      combination.targetVideoPath
    );

    await new Promise<void>((resolve, reject) => {
      child = spawn("ffmpeg", args);
      let stderr = "";

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (stderr.length > 12000) {
          stderr = stderr.slice(-12000);
        }
      });

      child.on("error", reject);
      child.on("close", (code) => {
        if (cancelled) {
          reject(new Error("任务已停止"));
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(stderr.trim() || `FFmpeg 退出码 ${code}`));
      });
    });
  })();

  return {
    promise,
    cancel: () => {
      cancelled = true;
      child?.kill("SIGTERM");
    }
  };
}

async function resolveSourceLoudness(videoAssets: AssetInfo[]): Promise<Array<{ meanDb?: number; gainDb: number }>> {
  const measured = await Promise.all(videoAssets.map((asset) => (asset.hasAudio ? measureMeanVolume(asset.path) : undefined)));
  const reference = measured[0];

  return measured.map((meanDb) => ({
    meanDb,
    gainDb: reference !== undefined && meanDb !== undefined ? clampGain(reference - meanDb) : 0
  }));
}

async function resolveBgmLoudness(
  bgmAssets: AssetInfo[],
  currentBgm: AssetInfo
): Promise<{ referenceDb?: number; meanDb?: number; gainDb: number } | undefined> {
  const referenceAsset = bgmAssets[0] ?? currentBgm;
  const [referenceDb, meanDb] = await Promise.all([measureMeanVolume(referenceAsset.path), measureMeanVolume(currentBgm.path)]);
  if (referenceDb === undefined || meanDb === undefined) {
    return { referenceDb, meanDb, gainDb: 0 };
  }
  return {
    referenceDb,
    meanDb,
    gainDb: clampGain(referenceDb - meanDb)
  };
}

function measureMeanVolume(filePath: string): Promise<number | undefined> {
  const cached = loudnessCache.get(filePath);
  if (cached) {
    return cached;
  }

  const promise = new Promise<number | undefined>((resolve) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-nostats", "-i", filePath, "-af", "volumedetect", "-f", "null", "-"]);
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 12000) {
        stderr = stderr.slice(-12000);
      }
    });

    child.on("error", () => resolve(undefined));
    child.on("close", () => {
      const match = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
      resolve(match ? Number(match[1]) : undefined);
    });
  });

  loudnessCache.set(filePath, promise);
  return promise;
}

function clampGain(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(-18, Math.min(18, value));
}

function evenDimension(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function resolveCanvasSize(config: MixProjectConfig, first: AssetInfo): { width: number; height: number } {
  const canvasMode = config.videoProfile.canvasMode ?? "original";

  if (canvasMode === "vertical_9_16") {
    return { width: 1080, height: 1920 };
  }

  if (canvasMode === "horizontal_16_9") {
    return { width: 1920, height: 1080 };
  }

  return {
    width: evenDimension(first.width ?? 1080),
    height: evenDimension(first.height ?? 1920)
  };
}

function resolveBgmRange(
  config: MixProjectConfig,
  slots: MixProjectConfig["slots"],
  videoAssets: AssetInfo[]
): { offsetSeconds: number; durationSeconds: number } | undefined {
  const startName = config.bgmRange.startSlotName ?? slots[0]?.name;
  const endName = config.bgmRange.endSlotName ?? slots.at(-1)?.name;
  const startIndex = slots.findIndex((slot) => slot.name === startName);
  const endIndex = slots.findIndex((slot) => slot.name === endName);

  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
    return undefined;
  }

  const durations = videoAssets.map((asset) => Math.max(0.1, asset.durationSeconds ?? 0.1));
  const offsetSeconds = durations.slice(0, startIndex).reduce((sum, duration) => sum + duration, 0);
  const durationSeconds = durations.slice(startIndex, endIndex + 1).reduce((sum, duration) => sum + duration, 0);

  return durationSeconds > 0 ? { offsetSeconds, durationSeconds } : undefined;
}
