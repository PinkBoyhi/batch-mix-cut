import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import type { AssetInfo, MixCombination, MixCombinationBgmTrack, MixProjectConfig } from "../../src/shared/types.js";
import { describeMissingBinary, getFfmpegPath } from "./ffmpegBinaries.js";
import { probeAsset } from "./mediaProbe.js";
import { assertOutputAvailable, publishOutput } from "./outputFiles.js";

export interface ExportHandle {
  promise: Promise<void>;
  cancel: () => void;
}

interface VolumeStats {
  meanDb?: number;
  maxDb?: number;
}

interface FileCacheEntry<T> { fingerprint: string; value: T }
const loudnessCache = new Map<string, FileCacheEntry<VolumeStats>>();
const mediaMetadataCache = new Map<string, FileCacheEntry<Partial<AssetInfo>>>();
const TARGET_AUDIBLE_MEAN_DB = -23;
const TARGET_PEAK_DB = -1.5;
const MIN_GAIN_DB = -18;
const MAX_GAIN_DB = 60;
const SILENCE_PEAK_DB = -85;
const ffmpegThreadLimit = readPositiveInteger(process.env.MIX_FFMPEG_THREADS);

export function exportVideo(config: MixProjectConfig, combination: MixCombination): ExportHandle {
  const controller = new AbortController();
  const signal = controller.signal;
  const temporaryPath = `${combination.targetVideoPath}.${crypto.randomUUID()}.partial`;

  const promise = (async () => {
    await fs.mkdir(path.dirname(combination.targetVideoPath), { recursive: true });
    signal.throwIfAborted();
    await assertOutputAvailable(combination.targetVideoPath);
    const slots = [...config.slots].sort((a, b) => a.sortOrder - b.sortOrder);
    const videoAssets = await Promise.all(slots.map((slot) => ensureLocalAsset(combination.slotAssets[slot.name], config.outputDir, signal)));
    signal.throwIfAborted();
    const first = videoAssets[0];
    if (!first) throw new Error("没有可导出的视频素材");
    const { width, height } = resolveCanvasSize(config, first);
    const segmentDurations = videoAssets.map(resolveSegmentDuration);
    const totalDuration = segmentDurations.reduce((sum, duration) => sum + duration, 0);
    const normalizeLoudness = config.normalizeLoudness !== false;
    const sourceLoudness = normalizeLoudness ? await resolveSourceLoudness(videoAssets, signal) : [];
    // BGM can come from a cloud asset as well as from local disk. Resolve it through
    // the same cache path as video assets so the server never asks FFmpeg to mix an
    // unreachable remote URL directly.
    const bgmTracks = await Promise.all(
      resolveCombinationBgmTracks(config, combination).map(async (track) => ({
        ...track,
        asset: await ensureLocalAsset(track.asset, config.outputDir, signal)
      }))
    );
    const bgmTargetDb = resolveBgmTargetDb(sourceLoudness);
    const bgmLoudness = normalizeLoudness
      ? await resolveBgmLoudness(bgmTracks, bgmTargetDb, signal)
      : [];
    const hasEnabledSourceAudio = config.sourceVolume > 0 && videoAssets.some((asset) => asset.hasAudio);
    const hasEnabledBgm = config.bgmVolume > 0 && bgmTracks.length > 0;
    if (!hasEnabledSourceAudio && !hasEnabledBgm) {
      throw new Error(
        config.sourceVolume <= 0
          ? "本组合没有可输出的声音：原声音量为 0%，且没有启用可用的 BGM"
          : "本组合的源视频没有可解码音轨，且没有启用可用的 BGM；请检查提示的素材或重新导入"
      );
    }

    const args: string[] = ["-y"];
    if (ffmpegThreadLimit) {
      args.push("-filter_complex_threads", String(Math.max(1, Math.floor(ffmpegThreadLimit / 2))));
    }
    for (const asset of videoAssets) {
      args.push("-i", asset.path);
    }
    for (const track of bgmTracks) {
      args.push("-stream_loop", "-1", "-i", track.asset.path);
    }

    const videoFilters = videoAssets.map((_, index) => {
      const duration = segmentDurations[index].toFixed(6);
      return `[${index}:v]trim=start=0:duration=${duration},setpts=PTS-STARTPTS,fps=30,settb=AVTB,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${index}]`;
    });
    const audioFilters = videoAssets.map((asset, index) => {
      const duration = segmentDurations[index].toFixed(6);
      if (config.sourceVolume > 0 && asset.hasAudio) {
        const gainDb = sourceLoudness[index]?.gainDb ?? 0;
        const volumeFilters = [
          "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo",
          "aresample=async=1:first_pts=0",
          "apad",
          `atrim=start=0:duration=${duration}`,
          "asetpts=PTS-STARTPTS",
          `volume=${config.sourceVolume}`,
          gainDb !== 0 ? `volume=${gainDb.toFixed(2)}dB` : undefined
        ].filter(Boolean);
        return `[${index}:a]${volumeFilters.join(",")}[a${index}]`;
      }
      return `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`;
    });
    const concatInputs = videoAssets.map((_, index) => `[v${index}][a${index}]`).join("");
    const filters = [
      ...videoFilters,
      ...audioFilters,
      `${concatInputs}concat=n=${videoAssets.length}:v=1:a=1[vconcat][aconcat]`,
      `[vconcat]trim=start=0:duration=${totalDuration.toFixed(6)},setpts=PTS-STARTPTS[vout]`,
      `[aconcat]apad,atrim=start=0:duration=${totalDuration.toFixed(6)},asetpts=PTS-STARTPTS[asrc]`
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

    const finalAudioFilterChain = buildFinalAudioFilterChain(config.audioPipelineVersion);
    if (activeBgmLabels.length > 0) {
      filters.push(
        // amix defaults to normalize=1, which divides every input by the input
        // count. That silently turns a 100% source into 50% with one BGM and
        // 33% with two BGMs. User volume controls already define the gain, so
        // preserve those levels and let the final limiter handle summed peaks.
        `[asrc]${activeBgmLabels.join("")}amix=inputs=${activeBgmLabels.length + 1}:duration=first:dropout_transition=0:normalize=0[amixed]`
      );
      filters.push(`[amixed]${finalAudioFilterChain}[aout]`);
    } else {
      filters.push(`[asrc]${finalAudioFilterChain}[aout]`);
    }

    args.push("-filter_complex", filters.join(";"), "-map", "[vout]", "-map", "[aout]");

    args.push(
      "-c:v",
      "libx264",
      "-preset",
      config.videoProfile.preset,
      ...(ffmpegThreadLimit ? ["-threads", String(ffmpegThreadLimit)] : []),
      "-crf",
      String(config.videoProfile.crf),
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      "-f", "mp4", temporaryPath
    );

    await new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const child = spawn(getFfmpegPath(), args, { signal });
      let stderr = "";

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (stderr.length > 12000) {
          stderr = stderr.slice(-12000);
        }
      });

      child.on("error", (error) => { if (!signal.aborted) reject(describeMissingBinary("ffmpeg", error)); });
      child.on("close", (code) => {
        if (signal.aborted) {
          reject(new Error("任务已停止"));
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(summarizeFfmpegFailure(stderr, `FFmpeg 退出码 ${code}`)));
      });
    });

    signal.throwIfAborted();
    // User volume is the final gain. Never amplify the already mixed output.
    const outputVolume = await measureStableOutputVolume(temporaryPath, signal);
    const outputMetadata = await probeAsset({
      id: combination.id, path: temporaryPath, name: path.basename(combination.targetVideoPath), kind: "video"
    }, signal);
    assertOutputMediaIntegrity(outputMetadata, outputVolume, config, videoAssets, bgmTracks);
    signal.throwIfAborted();
    await publishOutput(temporaryPath, combination.targetVideoPath);
  })().catch((error) => {
    if (signal.aborted) throw new Error("任务已停止");
    throw error;
  }).finally(async () => {
    loudnessCache.delete(temporaryPath);
    await fs.unlink(temporaryPath).catch(() => undefined);
  });

  return { promise, cancel: () => controller.abort() };
}

function readPositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return Math.floor(parsed);
}

async function ensureLocalAsset(asset: AssetInfo, outputDir: string, signal: AbortSignal): Promise<AssetInfo> {
  if (!/^https?:\/\//i.test(asset.path)) {
    return shouldProbeAsset(asset) ? withProbedMetadata(asset, signal) : asset;
  }

  const cacheDir = path.join(outputDir, ".cloud-cache");
  await fs.mkdir(cacheDir, { recursive: true });
  const cachePath = path.join(cacheDir, `${crypto.createHash("sha1").update(asset.path).digest("hex")}${extensionFromUrl(asset.path)}`);
  if (!(await exists(cachePath))) {
    const downloadPath = `${cachePath}.${crypto.randomUUID()}.partial`;
    try {
      await downloadRemoteAsset(asset.path, downloadPath, signal);
      signal.throwIfAborted();
      // Only expose a complete download; simultaneous readers never see a prefix.
      if (!(await exists(cachePath))) await publishOutput(downloadPath, cachePath).catch(async (error) => {
        if (!(await exists(cachePath))) throw error;
      });
    } finally {
      await fs.unlink(downloadPath).catch(() => undefined);
    }
  }
  return {
    ...(await withProbedMetadata({ ...asset, path: cachePath }, signal))
  };
}

function shouldProbeAsset(asset: AssetInfo): boolean {
  return asset.kind === "video";
}

async function withProbedMetadata(asset: AssetInfo, signal: AbortSignal): Promise<AssetInfo> {
  const metadata = await getMediaMetadata(asset, signal);
  return mergeAssetMetadata(asset, metadata);
}

// The desktop has already probed local assets before uploading them to a server.
// A missing server-side ffprobe must not turn that known audio stream into silence.
export function mergeAssetMetadata(asset: AssetInfo, metadata: Partial<AssetInfo>): AssetInfo {
  return {
    ...asset,
    ...metadata,
    // When a server-side probe is unavailable, keep the dimensions and duration
    // already measured on the desktop. Losing duration makes a BGM range collapse
    // to the 0.1 second fallback for every segment.
    durationSeconds: metadata.durationSeconds ?? asset.durationSeconds,
    videoDurationSeconds: metadata.videoDurationSeconds ?? asset.videoDurationSeconds,
    audioDurationSeconds: metadata.audioDurationSeconds ?? asset.audioDurationSeconds,
    width: metadata.width ?? asset.width,
    height: metadata.height ?? asset.height,
    hasAudio: asset.hasAudio === true || metadata.hasAudio === true
  };
}

async function cachedFileValue<T>(cache: Map<string, FileCacheEntry<T>>, filePath: string, compute: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const stat = await fs.stat(filePath);
  const fingerprint = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
  const cached = cache.get(filePath);
  if (cached?.fingerprint === fingerprint) return cached.value;
  // Cache completed values only: cancelling one task cannot abort another task's probe.
  const value = await compute();
  signal.throwIfAborted();
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  cache.set(filePath, { fingerprint, value });
  return value;
}

function getMediaMetadata(asset: AssetInfo, signal: AbortSignal): Promise<Partial<AssetInfo>> {
  return cachedFileValue(mediaMetadataCache, asset.path, async () => {
    const probed = await probeAsset(asset, signal);
    return {
      durationSeconds: probed.durationSeconds, videoDurationSeconds: probed.videoDurationSeconds,
      audioDurationSeconds: probed.audioDurationSeconds, width: probed.width, height: probed.height,
      hasAudio: probed.hasAudio
    };
  }, signal);
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

async function downloadRemoteAsset(urlString: string, targetPath: string, signal: AbortSignal, redirects = 0): Promise<void> {
  if (redirects > 5) {
    throw new Error(`云端素材重定向次数过多：${urlString}`);
  }

  await new Promise<void>((resolve, reject) => {
    let streaming = false;
    const url = new URL(urlString);
    const request = (url.protocol === "https:" ? https : http).get(
      url,
      {
        headers: {
          "User-Agent": "YiboBioMixCut/1.0"
        },
        timeout: 30000, signal
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          const nextUrl = new URL(location, url).toString();
          downloadRemoteAsset(nextUrl, targetPath, signal, redirects + 1).then(resolve, reject);
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          reject(new Error(`云端素材下载失败：HTTP ${status}，${urlString}`));
          return;
        }

        streaming = true;
        const file = createWriteStream(targetPath);
        pipeline(response, file, { signal }).then(() => resolve(), reject);
      }
    );
    request.on("timeout", () => request.destroy(new Error(`云端素材下载超时：${urlString}`)));
    request.on("error", (error) => { if (!streaming) reject(new Error(`云端素材下载失败：${error.message}，${urlString}`)); });
  }).catch(async (error) => {
    await fs.unlink(targetPath).catch(() => undefined);
    throw error;
  });
}

async function resolveSourceLoudness(videoAssets: AssetInfo[], signal: AbortSignal): Promise<Array<{ meanDb?: number; gainDb: number }>> {
  const measured: Array<VolumeStats & { gainDb: number }> = [];
  let referenceDb: number | undefined;

  for (const asset of videoAssets) {
    const stats = asset.hasAudio ? await measureVolume(asset.path, signal) : {};
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

async function resolveBgmLoudness(
  tracks: MixCombinationBgmTrack[],
  minimumTargetDb: number,
  signal: AbortSignal
): Promise<Array<{ meanDb?: number; gainDb: number }>> {
  const measured: Array<VolumeStats & { gainDb: number }> = [];
  let referenceDb: number | undefined;

  for (const track of tracks) {
    const stats = track.asset.hasAudio === false ? {} : await measureVolume(track.asset.path, signal);
    if (referenceDb === undefined && stats.meanDb !== undefined && !isProbablySilent(stats)) {
      referenceDb = stats.meanDb;
    }
    measured.push({ ...stats, gainDb: 0 });
  }

  // The first BGM still defines the reference between BGM tracks. When source
  // footage is much louder, lift that reference enough for the music to remain
  // audible as background instead of disappearing beneath speech.
  const targetDb = Math.max(resolveReferenceTargetDb(referenceDb), minimumTargetDb);
  return measured.map((item) => ({
    meanDb: item.meanDb,
    gainDb: computeLoudnessGain(item, targetDb)
  }));
}

export function resolveBgmTargetDb(sourceLoudness: Array<{ meanDb?: number; gainDb: number }>): number {
  const effectiveMeans = sourceLoudness
    .map((item) => (typeof item.meanDb === "number" && Number.isFinite(item.meanDb) ? item.meanDb + item.gainDb : undefined))
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (effectiveMeans.length === 0) {
    return TARGET_AUDIBLE_MEAN_DB;
  }
  // Keep music about 6 dB below the loudest normalized source: clearly audible
  // while still leaving speech in front.
  return Math.max(TARGET_AUDIBLE_MEAN_DB, Math.max(...effectiveMeans) - 6);
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

function measureVolume(filePath: string, signal: AbortSignal): Promise<VolumeStats> {
  return cachedFileValue(loudnessCache, filePath, () => new Promise<VolumeStats>((resolve, reject) => {
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
    ], { signal });
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 12000) {
        stderr = stderr.slice(-12000);
      }
    });

    child.on("error", () => { if (!signal.aborted) resolve({}); });
    child.on("close", () => {
      if (signal.aborted) { reject(signal.reason); return; }
      const meanMatch = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
      const maxMatch = stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
      resolve({
        meanDb: meanMatch ? Number(meanMatch[1]) : undefined,
        maxDb: maxMatch ? Number(maxMatch[1]) : undefined
      });
    });
  }), signal);
}

async function measureStableOutputVolume(filePath: string, signal: AbortSignal): Promise<VolumeStats> {
  let stats: VolumeStats = {};
  // Large MP4 files can still be settling on a local or network disk just after
  // FFmpeg exits. Re-probe before reporting a false "silent" failure.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    loudnessCache.delete(filePath);
    stats = await measureVolume(filePath, signal);
    if (!isProbablySilent(stats) || attempt === 2) {
      return stats;
    }
    await wait(300);
    signal.throwIfAborted();
  }
  return stats;
}

function assertOutputMediaIntegrity(
  output: AssetInfo,
  stats: VolumeStats,
  config: MixProjectConfig,
  videoAssets: AssetInfo[],
  bgmTracks: MixCombinationBgmTrack[]
): void {
  const expectedDuration = videoAssets.reduce((sum, asset) => sum + resolveSegmentDuration(asset), 0);
  if (!output.videoDurationSeconds || Math.abs(output.videoDurationSeconds - expectedDuration) > Math.max(0.25, videoAssets.length / 30)) {
    throw new Error(`成片画面时长不完整：预期 ${expectedDuration.toFixed(2)} 秒，实际 ${(output.videoDurationSeconds ?? 0).toFixed(2)} 秒`);
  }
  const expectsSourceAudio = config.sourceVolume > 0 && videoAssets.some((asset) => asset.hasAudio === true);
  const expectsBgmAudio = config.bgmVolume > 0 && bgmTracks.length > 0;
  if (!expectsSourceAudio && !expectsBgmAudio) {
    throw new Error("成片没有可验证的声音来源，不会把静音文件标记为成功");
  }
  if (!output.hasAudio) {
    throw new Error("成片没有可播放的音轨，请重试该组合");
  }
  if (isProbablySilent(stats)) {
    throw new Error("成片音轨检测为空或静音，请检查原声、BGM 音量及素材音轨后重试该组合");
  }
  if (
    output.videoDurationSeconds !== undefined &&
    output.audioDurationSeconds !== undefined &&
    Math.abs(output.videoDurationSeconds - output.audioDurationSeconds) > 0.25
  ) {
    throw new Error(
      `成片音画时长不一致：画面 ${output.videoDurationSeconds.toFixed(2)} 秒，声音 ${output.audioDurationSeconds.toFixed(2)} 秒`
    );
  }
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
  return stats.maxDb === undefined || stats.maxDb <= SILENCE_PEAK_DB;
}

function clampGain(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, value));
}

export function buildFinalAudioFilterChain(audioPipelineVersion?: number): string {
  const preserveLegacyAutoLevel = audioPipelineVersion !== undefined && audioPipelineVersion < 9;
  const filters = [
    "aresample=async=1:first_pts=0",
    // FFmpeg enables alimiter's auto-level compensation by default. That
    // raises every signal by 1 / 0.95 even when loudness normalization is
    // disabled. New tasks keep peak protection without adding gain. Persisted
    // v8 tasks retain their original behavior so one batch stays consistent
    // if the server is upgraded while that task is paused.
    preserveLegacyAutoLevel ? "alimiter=limit=0.95" : "alimiter=limit=0.95:level=false",
    "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo"
  ].filter(Boolean);
  return filters.join(",");
}

function formatStereoDelay(delayMs: number): string {
  const safeDelay = Math.max(0, Math.round(delayMs));
  return `${safeDelay}|${safeDelay}`;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function summarizeFfmpegFailure(stderr: string, fallback: string): string {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const errors = lines.filter((line) =>
    /(error|failed|invalid|conversion failed|could not|unable to|no such file)/i.test(line) &&
    !/non-monotonous dts/i.test(line)
  );
  return errors.slice(-6).join("\n") || lines.slice(-8).join("\n") || fallback;
}

function evenDimension(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function resolveSegmentDuration(asset: AssetInfo): number {
  return Math.max(0.1, asset.videoDurationSeconds ?? asset.durationSeconds ?? 0.1);
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

  const durations = videoAssets.map(resolveSegmentDuration);
  const offsetSeconds = durations.slice(0, startIndex).reduce((sum, duration) => sum + duration, 0);
  const durationSeconds = durations.slice(startIndex, endIndex + 1).reduce((sum, duration) => sum + duration, 0);

  return durationSeconds > 0 ? { offsetSeconds, durationSeconds } : undefined;
}
