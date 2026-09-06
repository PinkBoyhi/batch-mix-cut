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
}

interface ProbeOutput {
  format?: {
    duration?: string;
  };
  streams?: ProbeStream[];
}

export async function probeAsset(asset: AssetInfo): Promise<AssetInfo> {
  const probe = await runFfprobe(asset.path);
  const videoStream = probe.streams?.find((stream) => stream.codec_type === "video");
  const audioStream = probe.streams?.find((stream) => stream.codec_type === "audio");
  const formatDurationSeconds = positiveNumber(probe.format?.duration);
  const videoDurationSeconds = positiveNumber(videoStream?.duration) ?? formatDurationSeconds;
  const audioDurationSeconds = positiveNumber(audioStream?.duration);

  return {
    ...asset,
    durationSeconds: videoDurationSeconds,
    videoDurationSeconds,
    audioDurationSeconds,
    width: videoStream?.width,
    height: videoStream?.height,
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
  if (!codecName || ["none", "unknown", "bin_data"].includes(codecName)) {
    return false;
  }
  if (codecTag === "ipcm") {
    return false;
  }
  return true;
}

function runFfprobe(filePath: string): Promise<ProbeOutput> {
  return new Promise((resolve) => {
    const child = spawn(getFfprobePath(), [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath
    ]);
    let stdout = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.on("error", () => resolve({}));
    child.on("close", () => {
      try {
        resolve(JSON.parse(stdout) as ProbeOutput);
      } catch {
        resolve({});
      }
    });
  });
}
