import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import type { AssetInfo, MixCombination, MixCombinationBgmTrack, MixProjectConfig } from "../../src/shared/types.js";
import { describeMissingBinary, getFfmpegPath } from "./ffmpegBinaries.js";
import { probeAsset } from "./mediaProbe.js";

export interface ExportHandle {
  promise: Promise<void>;
  cancel: () => void;
}

interface VolumeStats {
  meanDb?: number;
  maxDb?: number;
}

const loudnessCache = new Map<string, Promise<VolumeStats>>();
const mediaMetadataCache = new Map<string, Promise<Partial<AssetInfo>>>();
const TARGET_AUDIBLE_MEAN_DB = -23;
const TARGET_PEAK_DB = -1.5;
const MIN_GAIN_DB = -18;
const MAX_GAIN_DB = 60;
const SILENCE_PEAK_DB = -85;

export function exportVideo(config: MixProjectConfig, combination: MixCombination): ExportHandle {
  let child: ChildProcessWithoutNullStreams | undefined;
  let cancelled = false;

  const promise = (async () => {
    await fs.mkdir(path.dirname(combination.targetVideoPath), { recursive: true });
    const slots = [...config.slots].sort((a, b) => a.sortOrder - b.sortOrder);
    const videoAssets = await Promise.all(slots.map((slot) => ensureLocalAsset(combination.slotAssets[slot.name], config.outputDir)));
    const first = videoAssets[0];
    const { width, height } = resolveCanvasSize(config, first);
    const normalizeLoudness = config.normalizeLoudness !== false;
    const sourceLoudness = normalizeLoudness ? await resolveSourceLoudness(videoAssets) : [];
    const bgmTracks = resolveCombinationBgmTracks(config, combination);
    const bgmLoudness = normalizeLoudness ? await resolveBgmLoudness(bgmTracks) : [];

    const args: string[] = ["-y"];
    for (const asset of videoAssets) {
      args.push("-i", asset.path);
    }
    for (const track of bgmTracks) {
      args.push("-stream_loop", "-1", "-i", track.asset.path);
    }

    const videoFilters = videoAssets.map((_, index) => {
      return `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=PTS-STARTPTS,fps=30,format=yuv420p[v${index}]`;
    });
    const audioFilters = videoAssets.map((asset, index) => {
      if (config.sourceVolume > 0 && asset.hasAudio) {
        const gainDb = sourceLoudness[index]?.gainDb ?? 0;
        const volumeFilters = [
          "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo",
          "aresample=async=1:first_pts=0",
          "asetpts=PTS-STARTPTS",
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

    const activeBgmLabels: string[] = [];
    bgmTracks.forEach((track, trackIndex) => {
      const bgmRange = resolveBgmRange(track.range, slots, videoAssets);
      if (!bgmRange) {
        return;
      }
      const bgmInputIndex = videoAssets.length + trackIndex;
      const fadeInDuration = Math.min(track.range.fadeInSeconds ?? 0, bgmRange.durationSeconds);
      const fadeOutDuration = Math.min(track.range.fadeOutSeconds ?? 0, Math.max(0, bgmRange.durationSeconds - fadeInDuration));
      const fadeOutStart = Math.max(0, bgmRange.durationSeconds - fadeOutDuration);
      const delayMs = Math.max(0, Math.round(bgmRange.offsetSeconds * 1000));
      const bgmGainDb = bgmLoudness[trackIndex]?.gainDb ?? 0;
      const label = `abgm${trackIndex}`;
      const bgmFilters = [
        "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo",
        "aresample=async=1:first_pts=0",
        `atrim=duration=${bgmRange.durationSeconds.toFixed(3)}`,
        "asetpts=PTS-STARTPTS",
        fadeInDuration > 0 ? `afade=t=in:st=0:d=${fadeInDuration.toFixed(3)}` : undefined,
        fadeOutDuration > 0 ? `afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOutDuration.toFixed(3)}` : undefined,
        `volume=${config.bgmVolume}`,
        bgmGainDb !== 0 ? `volume=${bgmGainDb.toFixed(2)}dB` : undefined,
        `adelay=${formatStereoDelay(delayMs)}`
      ].filter(Boolean);
      filters.push(`[${bgmInputIndex}:a]${bgmFilters.join(",")}[${label}]`);
      activeBgmLabels.push(`[${label}]`);
    });

    const finalAudioFilterChain = buildFinalAudioFilterChain();
    if (activeBgmLabels.length > 0) {
      filters.push(
        `[asrc]${activeBgmLabels.join("")}amix=inputs=${activeBgmLabels.length + 1}:duration=first:dropout_transition=0[amixed]`
      );
      filters.push(`[amixed]${finalAudioFilterChain}[aout]`);
    } else {
      filters.push(`[asrc]${finalAudioFilterChain}[aout]`);
    }

    args.push("-filter_complex", filters.join(";"), "-map", "[vout]", "-map", "[aout]");

    if (activeBgmLabels.length > 0) {
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

    if (!cancelled) {
      const outputVolume = await repairQuietAudioIfNeeded(combination.targetVideoPath);
      assertExpectedAudioIsAudible(outputVolume, config, videoAssets, bgmTracks);
    }
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
  return asset.kind === "video";
}

async function withProbedMetadata(asset: AssetInfo): Promise<AssetInfo> {
  const metadata = await getMediaMetadata(asset);
  return mergeAssetMetadata(asset, metadata);
}

// The desktop has already probed local assets before uploading them to a server.
// A missing server-side ffprobe must not turn that known audio stream into silence.
export function mergeAssetMetadata(asset: AssetInfo, metadata: Partial<AssetInfo>): AssetInfo {
  return {
    ...asset,
    ...metadata,
    hasAudio: asset.hasAudio === true || metadata.hasAudio === true
  };
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
  const measured: Array<VolumeStats & { gainDb: number }> = [];
  let referenceDb: number | undefined;

  for (const asset of videoAssets) {
    const stats = asset.hasAudio ? await measureVolume(asset.path) : {};
    if (referenceDb === undefined && stats.meanDb !== undefined && !isProbablySilent(stats)) {
      referenceDb = stats.meanDb;
    }
    measured.push({ ...stats, gainDb: 0 });
  }

  const targetDb = resolveReferenceTargetDb(referenceDb);
  return measured.map((item) => ({
    meanDb: item.meanDb,
    gainDb: computeLoudnessGain(item, targetDb)
  }));
}

async function resolveBgmLoudness(tracks: MixCombinationBgmTrack[]): Promise<Array<{ meanDb?: number; gainDb: number }>> {
  const measured: Array<VolumeStats & { gainDb: number }> = [];
  let referenceDb: number | undefined;

  for (const track of tracks) {
    const stats = track.asset.hasAudio === false ? {} : await measureVolume(track.asset.path);
    if (referenceDb === undefined && stats.meanDb !== undefined && !isProbablySilent(stats)) {
      referenceDb = stats.meanDb;
    }
    measured.push({ ...stats, gainDb: 0 });
  }

  const targetDb = resolveReferenceTargetDb(referenceDb);
  return measured.map((item) => ({
    meanDb: item.meanDb,
    gainDb: computeLoudnessGain(item, targetDb)
  }));
}

function resolveCombinationBgmTracks(config: MixProjectConfig, combination: MixCombination): MixCombinationBgmTrack[] {
  if (combination.bgmTracks && combination.bgmTracks.length > 0) {
    return combination.bgmTracks;
  }
  if (!combination.bgm) {
    return [];
  }
  return [
    {
      id: "bgm_1",
      name: "BGM 1",
      asset: combination.bgm,
      range: config.bgmRange
    }
  ];
}

function measureVolume(filePath: string): Promise<VolumeStats> {
  const cached = loudnessCache.get(filePath);
  if (cached) {
    return cached;
  }

  const promise = new Promise<VolumeStats>((resolve) => {
    const child = spawn(getFfmpegPath(), [
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
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 12000) {
        stderr = stderr.slice(-12000);
      }
    });

    child.on("error", () => resolve({}));
    child.on("close", () => {
      const meanMatch = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
      const maxMatch = stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
      resolve({
        meanDb: meanMatch ? Number(meanMatch[1]) : undefined,
        maxDb: maxMatch ? Number(maxMatch[1]) : undefined
      });
    });
  });

  loudnessCache.set(filePath, promise);
  return promise;
}

async function repairQuietAudioIfNeeded(filePath: string): Promise<VolumeStats> {
  loudnessCache.delete(filePath);
  const stats = await measureVolume(filePath);
  if (!shouldRepairQuietAudio(stats)) {
    return stats;
  }

  const gainDb = computeLoudnessGain(stats, TARGET_AUDIBLE_MEAN_DB);
  if (gainDb <= 0.5) {
    return stats;
  }

  const tempPath = `${filePath}.audiofix-${process.pid}-${Date.now()}.mp4`;
  try {
    await runAudioRepair(filePath, tempPath, gainDb);
    await fs.rename(tempPath, filePath);
    loudnessCache.delete(filePath);
    return measureVolume(filePath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function assertExpectedAudioIsAudible(
  stats: VolumeStats,
  config: MixProjectConfig,
  videoAssets: AssetInfo[],
  bgmTracks: MixCombinationBgmTrack[]
): void {
  const expectsSourceAudio = config.sourceVolume > 0 && videoAssets.some((asset) => asset.hasAudio === true);
  const expectsBgmAudio = config.bgmVolume > 0 && bgmTracks.length > 0;
  if (!expectsSourceAudio && !expectsBgmAudio) {
    return;
  }
  if (isProbablySilent(stats)) {
    throw new Error("成片音轨检测为静音。请检查服务器是否已更新到支持音频探测的最新版，再重试该组合。");
  }
}

function shouldRepairQuietAudio(stats: VolumeStats): boolean {
  if (stats.meanDb === undefined || isProbablySilent(stats)) {
    return false;
  }
  return stats.meanDb < -45 || (stats.maxDb !== undefined && stats.maxDb < -25);
}

function runAudioRepair(inputPath: string, outputPath: string, gainDb: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(getFfmpegPath(), [
      "-y",
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-c:v",
      "copy",
      "-af",
      `volume=${gainDb.toFixed(2)}dB,${buildFinalAudioFilterChain()}`,
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      outputPath
    ]);
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 12000) {
        stderr = stderr.slice(-12000);
      }
    });

    child.on("error", (error) => reject(describeMissingBinary("ffmpeg", error)));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `FFmpeg 音频修复退出码 ${code}`));
    });
  });
}

function resolveReferenceTargetDb(referenceDb: number | undefined): number {
  if (typeof referenceDb !== "number" || !Number.isFinite(referenceDb)) {
    return TARGET_AUDIBLE_MEAN_DB;
  }
  return Math.max(referenceDb, TARGET_AUDIBLE_MEAN_DB);
}

function computeLoudnessGain(stats: VolumeStats, targetDb: number): number {
  if (stats.meanDb === undefined || isProbablySilent(stats)) {
    return 0;
  }
  const gainToTarget = targetDb - stats.meanDb;
  const gainToPeak = stats.maxDb === undefined ? MAX_GAIN_DB : TARGET_PEAK_DB - stats.maxDb;
  return clampGain(Math.min(gainToTarget, gainToPeak));
}

function isProbablySilent(stats: VolumeStats): boolean {
  return stats.maxDb !== undefined && stats.maxDb <= SILENCE_PEAK_DB;
}

function clampGain(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, value));
}

function buildFinalAudioFilterChain(): string {
  const filters = [
    "aresample=async=1:first_pts=0",
    "alimiter=limit=0.95",
    "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo"
  ].filter(Boolean);
  return filters.join(",");
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
  range: MixProjectConfig["bgmRange"],
  slots: MixProjectConfig["slots"],
  videoAssets: AssetInfo[]
): { offsetSeconds: number; durationSeconds: number } | undefined {
  const startName = range.startSlotName ?? slots[0]?.name;
  const endName = range.endSlotName ?? slots.at(-1)?.name;
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
