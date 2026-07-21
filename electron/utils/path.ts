import path from "node:path";
import crypto from "node:crypto";

export const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm"]);
export const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg"]);

export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, "zh-CN", { numeric: true, sensitivity: "base" });
}

export function assetId(filePath: string): string {
  return crypto.createHash("sha1").update(filePath).digest("hex").slice(0, 12);
}

export function isVideoFile(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function isAudioFile(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function safeName(input: string): string {
  return input
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 120);
}
