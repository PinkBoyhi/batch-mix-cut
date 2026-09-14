import { spawn } from "node:child_process";
import type { AssetInfo } from "../../src/shared/types.js";
import { getFfprobePath } from "./ffmpegBinaries.js";

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  codec_tag_string?: string;
  duration?: string;
  width?: number;
  height?: number;
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
}

interface ProbeOutput {
  format?: {
    duration?: string;
  };
  streams?: ProbeStream[];
}

export async function probeAsset(asset: AssetInfo, signal?: AbortSignal): Promise<AssetInfo> {
  signal?.throwIfAborted();
  const probe = await runFfprobe(asset.path, signal);
  const videoStream = probe.streams?.find((stream) => stream.codec_type === "video");
  const audioStream = probe.streams?.find((stream) => stream.codec_type === "audio");
  const formatDurationSeconds = positiveNumber(probe.format?.duration);
  const videoDurationSeconds = positiveNumber(videoStream?.duration) ?? formatDurationSeconds;
  const audioDurationSeconds = positiveNumber(audioStream?.duration);
  const rotation = Number(videoStream?.side_data_list?.find((item) => item.rotation !== undefined)?.rotation ?? videoStream?.tags?.rotate ?? 0);
  const swapDimensions = Math.abs(Math.round(rotation / 90)) % 2 === 1;

  return {
    ...asset,
    durationSeconds: videoDurationSeconds,
    videoDurationSeconds,
    audioDurationSeconds,
    width: swapDimensions ? videoStream?.height : videoStream?.width,
    height: swapDimensions ? videoStream?.width : videoStream?.height,
    hasAudio: Boolean(audioStream && isDecodableAudioStream(audioStream))
  };
}

function positiveNumber(value: string | undefined): number | undefined {
  const number = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

export function isDecodableAudioStream(stream: ProbeStream): boolean {
  const codecName = stream.codec_name?.toLowerCase().trim();
  const codecTag = stream.codec_tag_string?.toLowerCase().trim();
  // Older ffprobe builds report modern ISO-BMFF PCM as codec "none" while a
  // current FFmpeg decodes the same ipcm stream correctly. The desktop ships a
  // current decoder, so the standardized tag is enough to keep the real audio.
  if (codecTag === "ipcm") {
    return true;
  }
  if (!codecName || ["none", "unknown", "bin_data"].includes(codecName)) {
    return false;
  }
  return true;
}

function runFfprobe(filePath: string, signal?: AbortSignal): Promise<ProbeOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(getFfprobePath(), [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath
    ], { signal });
    let stdout = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.on("error", () => { if (!signal?.aborted) resolve({}); });
    child.on("close", () => {
      if (signal?.aborted) { reject(signal.reason); return; }
      try {
        resolve(JSON.parse(stdout) as ProbeOutput);
      } catch {
        resolve({});
      }
    });
  });
}
