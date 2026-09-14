import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import type { BatchJobSnapshot, MixProjectConfig } from "../../src/shared/types.js";
import { RemoteMixClient } from "./remoteMixClient.js";

let dir: string;
let server: http.Server;
let mode: "upload-fail" | "upload-slow" | "running" | "download-slow";
let jobs: number, stops: number, polls: number;
let uploaded!: () => void;
let uploadStarted: Promise<void>;
let client: RemoteMixClient;
let config: MixProjectConfig;
const snapshot = (status: BatchJobSnapshot["status"]): BatchJobSnapshot => ({ id: "test-job", status, total: 1, completed: status === "completed" ? 1 : 0, failed: 0, message: status, failures: [] });
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-lifecycle-"));
  await fs.writeFile(path.join(dir, "source.mp4"), "test-source");
  jobs = stops = polls = 0; mode = "running";
  uploadStarted = new Promise((r) => { uploaded = r; });
  server = http.createServer((request, response) => {
    const json = (data: unknown, code = 200) => { response.writeHead(code, { "content-type": "application/json" }); response.end(JSON.stringify(data)); };
    request.resume();
    if (request.url === "/health") return json({ ok: true, workspaceRoot: "/server", audioPipelineVersion: 7, combinationPipelineVersion: 3 });
    if (request.url?.startsWith("/api/files/upload")) {
      uploaded();
      if (mode === "upload-slow") return;
      return json({ ok: mode !== "upload-fail" }, mode === "upload-fail" ? 500 : 200);
    }
    if (request.url === "/api/jobs") { jobs++; return json({ ok: true, jobId: "test-job", snapshot: snapshot("running") }); }
    if (request.url === "/api/jobs/test-job/stop") { stops++; return json({ ok: true, snapshot: snapshot("stopping") }); }
    if (request.url === "/api/jobs/test-job/outputs") return json({ ok: true, files: [{ name: "result_001.mp4", size: 100, url: "" }] });
    if (request.url?.includes("/outputs/")) { response.writeHead(200, { "content-length": 100 }); response.write("prefix"); uploaded(); return; }
    if (request.url === "/api/jobs/test-job") {
      polls++;
      return json({ ok: true, snapshot: snapshot(mode === "download-slow" ? "completed" : stops > 0 && polls > 1 ? "idle" : "stopping") });
    }
    json({ ok: true });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  await fs.writeFile(path.join(dir, "remote-mix-server.json"), JSON.stringify({ serverUrl: `http://127.0.0.1:${port}`, token: "test" }));
  client = new RemoteMixClient(() => dir);
  config = { projectDir: dir, outputDir: dir, slots: [{ name: "A", sortOrder: 0, assets: [{ id: "a", kind: "video", name: "source.mp4", path: path.join(dir, "source.mp4") }] }],
    bgmAssets: [], bgmTracks: [], bgmRange: { fadeInSeconds: 0, fadeOutSeconds: 0 }, maxCombinations: 1, outputNamePattern: "result", exportMode: "video", exportTarget: "local",
    sourceVolume: 1, bgmVolume: 0, normalizeLoudness: false, videoProfile: { codec: "h264", audioCodec: "aac", preset: "fast", crf: 20, canvasMode: "original" }, draftSlots: [] };
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await fs.rm(dir, { recursive: true, force: true }); });
async function eventually(condition: () => boolean) {
  const until = Date.now() + 6000;
  while (!condition()) { if (Date.now() > until) throw new Error("Timed out waiting for terminal state"); await new Promise((r) => setTimeout(r, 25)); }
  // Allow the polling promise's finalizer to release its lifecycle lock.
  await new Promise((r) => setTimeout(r, 0));
}
function useCloudAsset() { config.slots[0].assets[0].path = "https://example.invalid/source.mp4"; }

describe("remote lifecycle recovery", () => {
  it("releases the running state after upload retries fail", async () => {
    mode = "upload-fail";
    await expect(client.start(config)).rejects.toThrow("上传素材");
    expect(client.getSnapshot().status).toBe("failed");
    mode = "running";
    await client.start(config); await client.stop();
    await eventually(() => client.getSnapshot().status === "idle");
    expect(jobs).toBe(1);
  }, 10000);
  it("stops an upload before it can create a server job", async () => {
    mode = "upload-slow";
    const starting = client.start(config); await uploadStarted; await client.stop(); await starting;
    expect(client.getSnapshot().status).toBe("idle"); expect(jobs).toBe(0); expect(stops).toBe(0);
  });
  it("rejects duplicate starts and waits for confirmed remote stop", async () => {
    useCloudAsset();
    const starting = client.start(config);
    await expect(client.start(config)).rejects.toThrow("正在运行");
    await starting; await client.stop();
    expect(client.getSnapshot().status).toBe("stopping");
    await eventually(() => client.getSnapshot().status === "idle");
    expect(polls).toBeGreaterThanOrEqual(2); expect(stops).toBe(1);
  }, 10000);
  it("aborts an in-progress output download and removes its temporary file", async () => {
    mode = "download-slow"; useCloudAsset();
    await client.start(config); await uploadStarted; await client.stop();
    await eventually(() => client.getSnapshot().status === "idle");
    expect(await fs.readdir(path.join(dir, "videos"))).toEqual([]);
  }, 10000);
  it("refuses existing local outputs before uploading or creating a job", async () => {
    await fs.mkdir(path.join(dir, "videos")); await fs.writeFile(path.join(dir, "videos/result_001.mp4"), "old");
    await expect(client.start(config)).rejects.toThrow("不会覆盖"); expect(jobs).toBe(0);
    expect(await fs.readFile(path.join(dir, "videos/result_001.mp4"), "utf8")).toBe("old");
  });
});
