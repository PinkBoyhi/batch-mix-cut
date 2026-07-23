import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import type { AssetInfo, MixCombination, MixProjectConfig } from "../../src/shared/types.js";
import { describeMissingBinary, getFfmpegPath } from "./ffmpegBinaries.js";
import { probeAsset } from "./mediaProbe.js";

export interface ExportHandle {
  promise: Promise<void>;
  cancel: () => void;
}

const loudnessCache = new Map<string, Promise<number | undefined>>();
const mediaMetadataCache = new Map<string, Promise<Partial<AssetInfo>>>();

export function exportVideo(config: MixProjectConfig, combination: MixCombination): ExportHandle {
  let child: ChildProcessWithoutNullStreams | undefined;
  let cancelled = false;

  const promise = (async () => {
    await fs.mkdir(path.dirname(combination.targetVideoPath), { recursive: true });
    const slots = [...config.slots].sort((a, b) => a.sortOrder - b.sortOrder);
    const videoAssets = await Promise.all(slots.map((slot) => ensureLocalAsset(combination.slotAssets[slot.name], config.outputDir)));
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
        "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo",
        `atrim=duration=${bgmRange.durationSeconds.toFixed(3)}`,
        "asetpts=PTS-STARTPTS",
        fadeDuration > 0 ? `afade=t=out:st=${fadeStart.toFixed(3)}:d=${fadeDuration.toFixed(3)}` : undefined,
        `volume=${config.bgmVolume}`,
        bgmGainDb !== 0 ? `volume=${bgmGainDb.toFixed(2)}dB` : undefined,
        `adelay=${formatStereoDelay(delayMs)}`
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
      child = spawn(getFfmpegPath(), args);
      let stderr = "";

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (stderr.length > 12000) {
          stderr = stderr.slice(-12000);
        }
      });

      child.on("error", (error) => reject(describeMissingBinary("ffmpeg", error)));
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

async function ensureLocalAsset(asset: AssetInfo, outputDir: string): Promise<AssetInfo> {
  if (!/^https?:\/\//i.test(asset.path)) {
    return shouldProbeAsset(asset) ? withProbedMetadata(asset) : asset;
  }

  const cacheDir = path.join(outputDir, ".cloud-cache");
  await fs.mkdir(cacheDir, { recursive: true });
  const cachePath = path.join(cacheDir, `${crypto.createHash("sha1").update(asset.path).digest("hex")}${extensionFromUrl(asset.path)}`);
  if (!(await exists(cachePath))) {
    await downloadRemoteAsset(asset.path, cachePath);
  }
  return {
    ...(await withProbedMetadata({ ...asset, path: cachePath }))
  };
}

function shouldProbeAsset(asset: AssetInfo): boolean {
  return asset.kind === "video" && (asset.hasAudio === undefined || asset.durationSeconds === undefined || asset.width === undefined || asset.height === undefined);
}

async function withProbedMetadata(asset: AssetInfo): Promise<AssetInfo> {
  const metadata = await getMediaMetadata(asset);
  return { ...asset, ...metadata };
}

function getMediaMetadata(asset: AssetInfo): Promise<Partial<AssetInfo>> {
  const cached = mediaMetadataCache.get(asset.path);
  if (cached) {
    return cached;
  }
  const promise = probeAsset(asset).then((probed) => ({
    durationSeconds: probed.durationSeconds,
    width: probed.width,
    height: probed.height,
    hasAudio: probed.hasAudio
  }));
  mediaMetadataCache.set(asset.path, promise);
  return promise;
}

function extensionFromUrl(urlString: string): string {
  try {
    const ext = path.extname(new URL(urlString).pathname).toLowerCase();
    return ext || ".mp4";
  } catch {
    return ".mp4";
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function downloadRemoteAsset(urlString: string, targetPath: string, redirects = 0): Promise<void> {
  if (redirects > 5) {
    throw new Error(`云端素材重定向次数过多：${urlString}`);
  }

  await new Promise<void>((resolve, reject) => {
    const url = new URL(urlString);
    const request = (url.protocol === "https:" ? https : http).get(
      url,
      {
        headers: {
          "User-Agent": "YiboBioMixCut/1.0"
        },
        timeout: 30000
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          const nextUrl = new URL(location, url).toString();
          downloadRemoteAsset(nextUrl, targetPath, redirects + 1).then(resolve, reject);
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          reject(new Error(`云端素材下载失败：HTTP ${status}，${urlString}`));
          return;
        }

        const file = createWriteStream(targetPath);
        response.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
        file.on("error", reject);
      }
    );
    request.on("timeout", () => request.destroy(new Error(`云端素材下载超时：${urlString}`)));
    request.on("error", (error) => reject(new Error(`云端素材下载失败：${error.message}，${urlString}`)));
  }).catch(async (error) => {
    await fs.unlink(targetPath).catch(() => undefined);
    throw error;
  });
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
    const child = spawn(getFfmpegPath(), ["-hide_banner", "-nostats", "-i", filePath, "-af", "volumedetect", "-f", "null", "-"]);
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

function formatStereoDelay(delayMs: number): string {
  const safeDelay = Math.max(0, Math.round(delayMs));
  return `${safeDelay}|${safeDelay}`;
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
