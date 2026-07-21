import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

type BinaryKind = "ffmpeg" | "ffprobe";

const binaryCache = new Map<BinaryKind, string>();

export function getFfmpegPath(): string {
  return getBinaryPath("ffmpeg");
}

export function getFfprobePath(): string {
  return getBinaryPath("ffprobe");
}

export function describeMissingBinary(kind: BinaryKind, cause: unknown): Error {
  const binaryName = process.platform === "win32" ? `${kind}.exe` : kind;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`找不到内置 ${binaryName}。请重新安装最新版安装包，或把 FFmpeg 加入系统 PATH。原始错误：${detail}`);
}

function getBinaryPath(kind: BinaryKind): string {
  const cached = binaryCache.get(kind);
  if (cached) {
    return cached;
  }

  const resolved = resolveBundledBinary(kind);
  binaryCache.set(kind, resolved);
  return resolved;
}

function resolveBundledBinary(kind: BinaryKind): string {
  const binaryName = process.platform === "win32" ? `${kind}.exe` : kind;

  try {
    const directPackage = kind === "ffmpeg" ? "@ffmpeg-installer/win32-x64" : "@ffprobe-installer/win32-x64";
    if (process.platform === "win32" && process.arch === "x64") {
      return unpackAsarPath(require.resolve(`${directPackage}/${binaryName}`));
    }
  } catch {
    // Fall through to the platform-aware installer package.
  }

  try {
    const installerPackage = kind === "ffmpeg" ? "@ffmpeg-installer/ffmpeg" : "@ffprobe-installer/ffprobe";
    const installer = require(installerPackage) as { path?: string };
    if (installer.path) {
      return unpackAsarPath(installer.path);
    }
  } catch {
    // Fall through to PATH lookup.
  }

  return binaryName;
}

function unpackAsarPath(binaryPath: string): string {
  return binaryPath.includes("app.asar")
    ? binaryPath.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
    : binaryPath;
}
