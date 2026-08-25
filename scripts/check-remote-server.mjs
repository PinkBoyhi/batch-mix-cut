import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const settingsPaths = [
  process.env.MIX_SERVER_SETTINGS_FILE,
  path.join(os.homedir(), "Library", "Application Support", "batch-mix-cut", "remote-mix-server.json"),
  path.join(os.homedir(), "Library", "Application Support", "Electron", "remote-mix-server.json")
].filter(Boolean);

const settingsPath = await findSettings(settingsPaths);
if (!settingsPath) {
  throw new Error("未找到服务器连接配置，无法执行发布前服务器检查");
}

const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
const serverUrl = String(settings.serverUrl ?? "").trim().replace(/\/+$/, "");
const token = String(settings.token ?? "").trim();
if (!serverUrl || !token) {
  throw new Error("服务器地址或 Token 缺失，无法执行发布前服务器检查");
}

const health = await requestJson(`${serverUrl}/health`);
if (!health.ok || !health.workspaceRoot) {
  throw new Error("服务器健康检查未通过");
}
if (Number(health.audioPipelineVersion ?? 0) < 2) {
  throw new Error("服务器混剪引擎版本过旧，未通过发布前检查");
}

const authorization = await requestJson(`${serverUrl}/api/auth/check`, { "x-mix-token": token });
if (!authorization.ok) {
  throw new Error("服务器 Token 认证未通过");
}

console.log(`服务器发布前检查通过：${serverUrl}`);

if (process.argv.includes("--e2e")) {
  await runRemoteMixSmokeTest({ serverUrl, token });
}

async function findSettings(paths) {
  for (const candidate of paths) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next configured location.
    }
  }
  return undefined;
}

async function requestJson(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) {
    throw new Error(`服务器请求失败：HTTP ${response.status}`);
  }
  return response.json();
}

async function runRemoteMixSmokeTest({ serverUrl, token }) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yibo-release-remote-mix-"));
  try {
    const sourcePath = path.join(tempDir, "release-smoke-source.mp4");
    const appDataDir = path.join(tempDir, "app-data");
    const outputDir = path.join(tempDir, "outputs");
    await fs.mkdir(appDataDir, { recursive: true });
    await fs.writeFile(path.join(appDataDir, "remote-mix-server.json"), JSON.stringify({ serverUrl, token }));
    await createTestVideo(sourcePath);

    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const { RemoteMixClient } = await import(pathToFileURL(path.join(projectRoot, "dist-electron/electron/services/remoteMixClient.js")).href);
    const client = new RemoteMixClient(() => appDataDir);
    const completion = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("服务器混剪冒烟测试超时")), 120_000);
      client.on("update", (snapshot) => {
        if (snapshot.status === "completed") {
          clearTimeout(timeout);
          resolve(snapshot);
        }
        if (snapshot.status === "failed") {
          clearTimeout(timeout);
          reject(new Error(snapshot.message));
        }
      });
    });

    await client.start({
      projectDir: tempDir,
      outputDir,
      slots: [
        {
          name: "A",
          sortOrder: 0,
          assets: [
            {
              id: "release-smoke-video",
              path: sourcePath,
              name: "release-smoke-source.mp4",
              kind: "video",
              hasAudio: true,
              width: 320,
              height: 240,
              durationSeconds: 1
            }
          ]
        }
      ],
      bgmAssets: [],
      bgmRange: { fadeInSeconds: 0, fadeOutSeconds: 0 },
      bgmTracks: [],
      maxCombinations: 1,
      outputNamePattern: "release_smoke",
      exportMode: "video",
      sourceVolume: 1,
      bgmVolume: 1,
      normalizeLoudness: false,
      videoProfile: { codec: "h264", audioCodec: "aac", preset: "veryfast", crf: 30, canvasMode: "original" },
      exportTarget: "local",
      draftSlots: []
    });
    await completion;
    const files = await fs.readdir(path.join(outputDir, "videos"));
    if (!files.some((file) => file.toLowerCase().endsWith(".mp4"))) {
      throw new Error("服务器混剪冒烟测试没有回传 MP4");
    }
    console.log("服务器混剪冒烟测试通过：已生成并回传 MP4");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function createTestVideo(targetPath) {
  const require = createRequire(import.meta.url);
  const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
  await new Promise((resolve, reject) => {
    const process = spawn(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x240:rate=25",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000:sample_rate=48000",
      "-t",
      "1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-y",
      targetPath
    ]);
    process.on("error", reject);
    process.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`测试视频生成失败：FFmpeg ${code}`))));
  });
}
