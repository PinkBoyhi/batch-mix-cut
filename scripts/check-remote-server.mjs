import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const runLocalWorkflow = process.argv.includes("--local") || process.argv.includes("--e2e");
const runRemoteWorkflow = process.argv.includes("--e2e");

if (runLocalWorkflow) {
  await runLocalMixWorkflowSmokeTest();
}

if (runRemoteWorkflow || !runLocalWorkflow) {
  const { serverUrl, token } = await readRemoteSettings();
  const health = await requestJson(`${serverUrl}/health`);
  if (!health.ok || !health.workspaceRoot) {
    throw new Error("服务器健康检查未通过");
  }
  if (Number(health.audioPipelineVersion ?? 0) < 2) {
    throw new Error("服务器混剪引擎版本过旧，未通过发布前检查");
  }
  if (Number(health.combinationPipelineVersion ?? 0) < 3) {
    throw new Error("服务器组合引擎版本过旧，无法保证开头素材轮换");
  }

  const authorization = await requestJson(`${serverUrl}/api/auth/check`, { "x-mix-token": token });
  if (!authorization.ok) {
    throw new Error("服务器 Token 认证未通过");
  }

  console.log(`服务器发布前检查通过：${serverUrl}`);

  if (runRemoteWorkflow) {
    await runRemoteMixSmokeTest({ serverUrl, token });
  }
}

async function readRemoteSettings() {
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
  return { serverUrl, token };
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
    const appDataDir = path.join(tempDir, "app-data");
    await fs.mkdir(appDataDir, { recursive: true });
    await fs.writeFile(path.join(appDataDir, "remote-mix-server.json"), JSON.stringify({ serverUrl, token }));
    const fixture = await createWorkflowFixture(tempDir, "remote");

    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const { RemoteMixClient } = await import(pathToFileURL(path.join(projectRoot, "dist-electron/electron/services/remoteMixClient.js")).href);
    const client = new RemoteMixClient(() => appDataDir);
    const completion = waitForTerminalSnapshot(client, "服务器完整混剪测试", 180_000);
    await client.start(fixture.config);
    const snapshot = await completion;
    assertCompletedSnapshot(snapshot, "服务器完整混剪测试", fixture.expectedCount);
    const files = await assertWorkflowOutputs(fixture.config.outputDir, fixture.expectedCount, "服务器回传成片");
    assertCartesianCombinationOrder(files, "服务器回传成片");
    console.log("服务器完整混剪测试通过：8 个严格排列组合已混剪、回传并校验音视频流");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function runLocalMixWorkflowSmokeTest() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yibo-release-local-mix-"));
  try {
    const fixture = await createWorkflowFixture(tempDir, "local");
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const { JobManager } = await import(pathToFileURL(path.join(projectRoot, "dist-electron/electron/services/jobManager.js")).href);
    const manager = new JobManager();
    const completion = waitForTerminalSnapshot(manager, "本地完整混剪测试", 180_000);
    await manager.start(fixture.config);
    const snapshot = await completion;
    assertCompletedSnapshot(snapshot, "本地完整混剪测试", fixture.expectedCount);
    const files = await assertWorkflowOutputs(fixture.config.outputDir, fixture.expectedCount, "本地成片");
    assertCartesianCombinationOrder(files, "本地成片");
    console.log("本地完整混剪测试通过：A=2、B=2、C=2 的 8 个严格排列组合、BGM轮换、声音和 MP4 输出均已校验");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function createWorkflowFixture(rootDir, mode) {
  const sourcesDir = path.join(rootDir, "sources");
  const outputDir = path.join(rootDir, "outputs");
  await fs.mkdir(sourcesDir, { recursive: true });

  const a1 = path.join(sourcesDir, "A-01.mp4");
  const a2 = path.join(sourcesDir, "A-02.mp4");
  const b1 = path.join(sourcesDir, "B-01.mp4");
  const b2 = path.join(sourcesDir, "B-02.mp4");
  const c1 = path.join(sourcesDir, "C-01.mp4");
  const c2 = path.join(sourcesDir, "C-02.mp4");
  const bgm1 = path.join(sourcesDir, "BGM-01.m4a");
  const bgm2 = path.join(sourcesDir, "BGM-02.m4a");
  await Promise.all([
    createTestVideo(a1, { size: "320x568", rate: 30, duration: 0.8, frequency: 430 }),
    createTestVideo(a2, { size: "568x320", rate: 24, duration: 0.7, frequency: 510 }),
    createTestVideo(b1, { size: "240x320", rate: 25, duration: 0.7, frequency: 620 }),
    createTestVideo(b2, { size: "320x240", rate: 60, duration: 0.8, frequency: 710 }),
    createTestVideo(c1, { size: "320x568", rate: 30, duration: 0.6, frequency: 820 }),
    createTestVideo(c2, { size: "568x320", rate: 24, duration: 0.6, frequency: 910 }),
    createTestAudio(bgm1, 800),
    createTestAudio(bgm2, 920)
  ]);

  const assets = {
    a1: videoAsset(a1, "A-01.mp4", 320, 568, 0.8),
    a2: videoAsset(a2, "A-02.mp4", 568, 320, 0.7),
    b1: videoAsset(b1, "B-01.mp4", 240, 320, 0.7),
    b2: videoAsset(b2, "B-02.mp4", 320, 240, 0.8),
    c1: videoAsset(c1, "C-01.mp4", 320, 568, 0.6),
    c2: videoAsset(c2, "C-02.mp4", 568, 320, 0.6),
    bgm1: audioAsset(bgm1, "BGM-01.m4a"),
    bgm2: audioAsset(bgm2, "BGM-02.m4a")
  };
  const config = {
    projectDir: rootDir,
    outputDir,
    slots: [
      { name: "A", sortOrder: 0, assets: [assets.a1, assets.a2] },
      { name: "B", sortOrder: 1, assets: [assets.b1, assets.b2] },
      { name: "C", sortOrder: 2, assets: [assets.c1, assets.c2] }
    ],
    bgmAssets: [assets.bgm1, assets.bgm2],
    bgmRange: { startSlotName: "B", endSlotName: "B", fadeInSeconds: 0.1, fadeOutSeconds: 0.2 },
    bgmTracks: [
      {
        id: "bgm_smoke",
        name: "BGM 测试轨",
        sortOrder: 0,
        assets: [assets.bgm1, assets.bgm2],
        range: { startSlotName: "B", endSlotName: "B", fadeInSeconds: 0.1, fadeOutSeconds: 0.2 }
      }
    ],
    maxCombinations: 8,
    outputNamePattern: "",
    exportMode: "video",
    sourceVolume: 1,
    bgmVolume: 0.35,
    normalizeLoudness: true,
    videoProfile: { codec: "h264", audioCodec: "aac", preset: "ultrafast", crf: 30, canvasMode: "original" },
    exportTarget: mode === "remote" ? "server" : "local",
    draftSlots: []
  };

  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { createCombinations } = await import(pathToFileURL(path.join(projectRoot, "dist-electron/electron/services/combinator.js")).href);
  const combinations = createCombinations(config.slots, config.bgmAssets, config.outputDir, config.maxCombinations, config.outputNamePattern, config.bgmTracks);
  if (combinations.length !== 8) {
    throw new Error(`组合测试失败：预期 8 条，实际 ${combinations.length} 条`);
  }
  const bgmNames = combinations.map((combination) => combination.bgmTracks?.[0]?.asset.name);
  const expectedBgms = Array.from({ length: 8 }, (_, index) => `BGM-0${(index % 2) + 1}.m4a`);
  if (bgmNames.join(",") !== expectedBgms.join(",")) {
    throw new Error(`BGM 轮换测试失败：${bgmNames.join(",")}`);
  }
  return { config, expectedCount: 8 };
}

function videoAsset(filePath, name, width, height, durationSeconds) {
  return { id: `smoke-${name}`, path: filePath, name, kind: "video", hasAudio: true, width, height, durationSeconds };
}

function audioAsset(filePath, name) {
  return { id: `smoke-${name}`, path: filePath, name, kind: "audio", hasAudio: true, durationSeconds: 0.35 };
}

function waitForTerminalSnapshot(emitter, label, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`${label}超时`));
    }, timeoutMs);
    const onUpdate = (snapshot) => {
      if (snapshot.status === "completed") {
        cleanup();
        resolve(snapshot);
      } else if (snapshot.status === "failed") {
        cleanup();
        reject(new Error(`${label}失败：${snapshot.message}`));
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      emitter.off("update", onUpdate);
    };
    emitter.on("update", onUpdate);
  });
}

function assertCompletedSnapshot(snapshot, label, expectedCount) {
  if (snapshot.total !== expectedCount || snapshot.completed !== expectedCount || snapshot.failed !== 0) {
    throw new Error(`${label}结果不符合预期：总数 ${snapshot.total}，完成 ${snapshot.completed}，失败 ${snapshot.failed}`);
  }
}

async function assertWorkflowOutputs(outputDir, expectedCount, label) {
  const videosDir = path.join(outputDir, "videos");
  const files = (await fs.readdir(videosDir)).filter((file) => file.toLowerCase().endsWith(".mp4")).sort();
  if (files.length !== expectedCount) {
    throw new Error(`${label}数量错误：预期 ${expectedCount}，实际 ${files.length}`);
  }
  await Promise.all(files.map(async (file) => {
    const filePath = path.join(videosDir, file);
    const stat = await fs.stat(filePath);
    if (stat.size < 1024) {
      throw new Error(`${label}文件过小：${file}`);
    }
    const streams = await probeStreams(filePath);
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");
    if (video?.codec_name !== "h264" || audio?.codec_name !== "aac") {
      throw new Error(`${label}音视频流校验失败：${file}`);
    }
    await assertVisibleVideoFrame(filePath, label, file);
    await assertAudibleAudio(filePath, label, file);
  }));
  return files;
}

function assertCartesianCombinationOrder(files, label) {
  const actual = files.map((file) => file.replace(/\.mp4$/i, "").split("__").slice(1).join("|"));
  const expected = [
    "A-01|B-01|C-01",
    "A-02|B-01|C-01",
    "A-01|B-02|C-01",
    "A-02|B-02|C-01",
    "A-01|B-01|C-02",
    "A-02|B-01|C-02",
    "A-01|B-02|C-02",
    "A-02|B-02|C-02"
  ];
  if (actual.join(",") !== expected.join(",")) {
    throw new Error(`${label}排列组合顺序错误：预期 ${expected.join("、")}，实际 ${actual.join("、")}`);
  }
}

async function probeStreams(filePath) {
  const require = createRequire(import.meta.url);
  const ffprobePath = require("@ffprobe-installer/ffprobe").path;
  const { stdout } = await collectProcessOutput(ffprobePath, ["-v", "error", "-print_format", "json", "-show_streams", filePath]);
  return JSON.parse(stdout).streams ?? [];
}

async function assertVisibleVideoFrame(filePath, label, fileName) {
  const require = createRequire(import.meta.url);
  const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
  const { stderr } = await collectProcessOutput(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "info",
    "-ss",
    "0.2",
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
  const match = stderr.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
  if (!match || Number(match[1]) <= 20) {
    throw new Error(`${label}画面疑似黑屏：${fileName}`);
  }
}

async function assertAudibleAudio(filePath, label, fileName) {
  const require = createRequire(import.meta.url);
  const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
  const { stderr } = await collectProcessOutput(ffmpegPath, [
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
  if (!match || Number(match[1]) <= -75) {
    throw new Error(`${label}音频疑似静音：${fileName}`);
  }
}

async function createTestVideo(targetPath, { size, rate, duration, frequency }) {
  const require = createRequire(import.meta.url);
  const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
  await runProcess(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i", `testsrc2=size=${size}:rate=${rate}`,
      "-f",
      "lavfi",
      "-i", `sine=frequency=${frequency}:sample_rate=48000`,
      "-t",
      String(duration),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-y",
      targetPath
    ]);
}

async function createTestAudio(targetPath, frequency) {
  const require = createRequire(import.meta.url);
  const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
  await runProcess(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=0.35`,
    "-c:a",
    "aac",
    "-y",
    targetPath
  ]);
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      code === 0 ? resolve() : reject(new Error(stderr.trim() || `${path.basename(command)} 退出码 ${code}`));
    });
  });
}

function collectProcessOutput(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr.trim() || `${path.basename(command)} 退出码 ${code}`));
    });
  });
}
