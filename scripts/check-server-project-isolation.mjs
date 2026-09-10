import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const projectRoot = process.cwd();
const serverEntry = process.argv[2] || path.join(projectRoot, "dist-electron/electron/server/mixServer.js");
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "yibo-server-isolation-"));
const token = `e2e-${randomUUID()}`;
const port = 18787;
let server;

try {
  const projectA = await createProject("project-a");
  const projectB = await createProject("project-b");
  server = spawn(process.execPath, [serverEntry, "--", "--host", "127.0.0.1", "--port", String(port), "--workspace", workspace], {
    env: {
      ...process.env,
      MIX_SERVER_TOKEN: token,
      MIX_SERVER_MAX_CONCURRENT_JOBS: "2",
      MIX_FFMPEG_THREADS: "1",
      MIX_SERVER_PROJECT_RETENTION_HOURS: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverLog = "";
  server.stdout.on("data", (chunk) => { serverLog += chunk.toString(); });
  server.stderr.on("data", (chunk) => { serverLog += chunk.toString(); });
  await waitForServer();

  const jobA1 = await startJob(makeConfig(projectA, "outputs-a1", "A1"));
  await api(`/api/jobs/${jobA1.jobId}/pause`, { method: "POST" });
  const jobA2 = await startJob(makeConfig(projectA, "outputs-a2", "A2"));
  const jobB = await startJob(makeConfig(projectB, "outputs-b", "B"));
  await api(`/api/jobs/${jobB.jobId}/pause`, { method: "POST" });

  const [snapshotA1, snapshotA2, snapshotB, health] = await Promise.all([
    readJob(jobA1.jobId),
    readJob(jobA2.jobId),
    readJob(jobB.jobId),
    fetch(`http://127.0.0.1:${port}/health`).then(assertJson)
  ]);
  assert(snapshotA1.status === "paused", `项目 A 第一个任务应占用槽位，实际 ${snapshotA1.status}`);
  assert(snapshotA2.status === "queued", `同项目 A 第二个任务必须排队，实际 ${snapshotA2.status}`);
  assert(snapshotB.status === "paused", `不同项目 B 应占用第二个槽位，实际 ${snapshotB.status}`);
  assert(health.activeJobs === 2 && health.queuedJobs === 1, `应为 2 个运行、1 个排队，实际 ${health.activeJobs}/${health.queuedJobs}`);
  assert(snapshotA2.message.includes("排队第 1/1 位"), `排队位置不正确：${snapshotA2.message}`);

  await Promise.all([jobA1.jobId, jobA2.jobId, jobB.jobId].map((jobId) => api(`/api/jobs/${jobId}/stop`, { method: "POST" })));
  console.log("服务器项目隔离验收通过：运行槽位为 project-a + project-b，同项目重复任务保持排队。");
} finally {
  server?.kill("SIGTERM");
  await fs.rm(workspace, { recursive: true, force: true });
}

async function createProject(name) {
  const root = path.join(workspace, "projects", name);
  const sourceDir = path.join(root, "segments");
  await fs.mkdir(sourceDir, { recursive: true });
  const source = path.join(sourceDir, "source.mp4");
  await run("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc2=size=320x568:rate=30:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=44100:duration=2",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", source
  ]);
  const assets = [];
  for (let index = 1; index <= 8; index += 1) {
    const target = path.join(sourceDir, `source-${index}.mp4`);
    await fs.link(source, target);
    assets.push({ id: `${name}-${index}`, path: target, name: path.basename(target), kind: "video", durationSeconds: 2, width: 320, height: 568, hasAudio: true });
  }
  return { root, assets };
}

function makeConfig(project, outputFolder, title) {
  return {
    projectDir: project.root,
    outputDir: path.join(project.root, outputFolder),
    workflowTitle: `隔离验收-${title}`,
    slots: [{ name: "开头", assets: project.assets, sortOrder: 0 }],
    bgmAssets: [],
    bgmRange: { fadeInSeconds: 0, fadeOutSeconds: 0 },
    bgmTracks: [],
    maxCombinations: 8,
    outputNamePattern: `${title}_{index}`,
    exportMode: "video",
    sourceVolume: 1,
    bgmVolume: 0,
    normalizeLoudness: false,
    videoProfile: { codec: "h264", audioCodec: "aac", preset: "slow", crf: 23, canvasMode: "original" },
    exportTarget: "local",
    draftSlots: []
  };
}

async function startJob(config) {
  return api("/api/jobs", { method: "POST", body: JSON.stringify({ config }) });
}

async function readJob(jobId) {
  const result = await api(`/api/jobs/${jobId}`);
  return result.snapshot;
}

async function api(endpoint, init = {}) {
  return fetch(`http://127.0.0.1:${port}${endpoint}`, {
    ...init,
    headers: { "content-type": "application/json", "x-mix-token": token, ...(init.headers || {}) }
  }).then(assertJson);
}

async function assertJson(response) {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`).then(assertJson);
      if (health.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("临时验收服务器启动超时");
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
