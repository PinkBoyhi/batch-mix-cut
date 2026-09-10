import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const serverEntry = process.argv[2] || path.join(process.cwd(), "dist-electron/electron/server/mixServer.js");
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "yibo-server-recovery-"));
const token = `recovery-${randomUUID()}`;
const port = 18788;
let server;

try {
  const config = await createProject();
  server = startServer();
  await waitForHealth();
  const created = await api("/api/jobs", { method: "POST", body: JSON.stringify({ config }) });
  const jobId = created.jobId;
  let completedBeforeCrash = 0;
  await waitFor(async () => {
    const snapshot = await readJob(jobId);
    completedBeforeCrash = snapshot.completed;
    return snapshot.status === "running" && completedBeforeCrash > 0 && completedBeforeCrash < snapshot.total;
  }, 20_000, "任务未在崩溃前完成至少一条成片");

  process.kill(-server.pid, "SIGKILL");
  await waitForExit(server);
  server = startServer();
  await waitForHealth();

  const recovered = await readJob(jobId);
  assert(["queued", "running", "completed"].includes(recovered.status), `原任务 ID 未恢复：${recovered.status}`);
  assert(recovered.completed >= completedBeforeCrash, `恢复时没有识别已有成片：${recovered.completed}/${completedBeforeCrash}`);
  await waitFor(async () => (await readJob(jobId)).status === "completed", 60_000, "恢复任务未在 60 秒内完成");
  const completed = await readJob(jobId);
  const videosDir = path.join(config.outputDir, "videos");
  const files = await fs.readdir(videosDir);
  assert(completed.completed === config.maxCombinations, `恢复后完成数错误：${completed.completed}`);
  assert(files.filter((name) => name.endsWith(".mp4")).length === config.maxCombinations, "恢复后成片数量不完整");
  assert(files.every((name) => !name.includes(".partial")), "恢复后仍残留临时成片");

  process.kill(-server.pid, "SIGKILL");
  await waitForExit(server);
  server = startServer();
  await waitForHealth();
  const completedAfterSecondRestart = await readJob(jobId);
  const outputsAfterSecondRestart = await api(`/api/jobs/${jobId}/outputs`);
  assert(completedAfterSecondRestart.status === "completed", "已完成任务在第二次重启后丢失");
  assert(outputsAfterSecondRestart.files.length === config.maxCombinations, "已完成任务重启后无法回传全部成片");
  console.log(`服务器重启恢复验收通过：保留崩溃前 ${completedBeforeCrash} 条，原任务 ${jobId} 已续跑并完成 ${completed.completed} 条。`);
} finally {
  if (server && server.exitCode === null) process.kill(-server.pid, "SIGKILL");
  await fs.rm(workspace, { recursive: true, force: true });
}

function startServer() {
  return spawn(process.execPath, [serverEntry, "--", "--host", "127.0.0.1", "--port", String(port), "--workspace", workspace], {
    detached: true,
    env: {
      ...process.env,
      MIX_SERVER_TOKEN: token,
      MIX_SERVER_MAX_CONCURRENT_JOBS: "2",
      MIX_FFMPEG_THREADS: "1",
      MIX_SERVER_PROJECT_RETENTION_HOURS: "0"
    },
    stdio: "ignore"
  });
}

async function createProject() {
  const root = path.join(workspace, "projects", "recover-project");
  const sourceDir = path.join(root, "segments");
  await fs.mkdir(sourceDir, { recursive: true });
  const original = path.join(sourceDir, "source.mp4");
  await run("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=44100:duration=4",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", original
  ]);
  const assets = [];
  for (let index = 1; index <= 6; index += 1) {
    const target = path.join(sourceDir, `source-${index}.mp4`);
    await fs.link(original, target);
    assets.push({ id: `source-${index}`, path: target, name: path.basename(target), kind: "video", durationSeconds: 4, width: 640, height: 360, hasAudio: true });
  }
  return {
    projectDir: root,
    outputDir: path.join(root, "outputs"),
    workflowTitle: "服务器重启恢复验收",
    slots: [{ name: "开头", assets, sortOrder: 0 }],
    bgmAssets: [],
    bgmRange: { fadeInSeconds: 0, fadeOutSeconds: 0 },
    bgmTracks: [],
    maxCombinations: assets.length,
    outputNamePattern: "recover_{index}",
    exportMode: "video",
    sourceVolume: 1,
    bgmVolume: 0,
    normalizeLoudness: false,
    videoProfile: { codec: "h264", audioCodec: "aac", preset: "slow", crf: 23, canvasMode: "original" },
    exportTarget: "local",
    draftSlots: []
  };
}

async function readJob(jobId) {
  const result = await api(`/api/jobs/${jobId}`);
  return result.snapshot;
}

async function api(endpoint, init = {}) {
  return fetch(`http://127.0.0.1:${port}${endpoint}`, {
    ...init,
    headers: { "content-type": "application/json", "x-mix-token": token, ...(init.headers || {}) }
  }).then(readJson);
}

async function readJson(response) {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

async function waitForHealth() {
  await waitFor(async () => {
    try {
      return Boolean((await fetch(`http://127.0.0.1:${port}/health`).then(readJson)).ok);
    } catch {
      return false;
    }
  }, 10_000, "临时服务器启动超时");
}

async function waitFor(check, timeoutMs, errorMessage) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(errorMessage);
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `${command} 退出码 ${code}`)));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
