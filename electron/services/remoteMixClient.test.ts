import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { AssetInfo, BatchJobSnapshot, MixProjectConfig } from "../../src/shared/types.js";
import {
  describeOutputDownloadFailure,
  getRemoteCompletionError,
  getRequiredLocalDownloadBytes,
  RemoteMixClient,
  toRemoteAsset
} from "./remoteMixClient.js";

describe("toRemoteAsset", () => {
  const videoWithAudio: AssetInfo = {
    id: "video",
    kind: "video",
    name: "video.mp4",
    path: "/local/video.mp4",
    hasAudio: true,
    width: 1080,
    height: 1920,
    durationSeconds: 3
  };

  it("skips the broken re-probe path on legacy servers for a desktop-confirmed audio stream", () => {
    expect(toRemoteAsset(videoWithAudio, "/server/video.mp4", true)).toEqual(
      expect.objectContaining({ path: "/server/video.mp4", kind: "audio", hasAudio: true })
    );
  });

  it("keeps normal video metadata when the server supports the fixed audio pipeline", () => {
    expect(toRemoteAsset(videoWithAudio, "/server/video.mp4", false)).toEqual(
      expect.objectContaining({ path: "/server/video.mp4", kind: "video", hasAudio: true })
    );
  });

  it("reports the server-side cause when a completed job produced no video", () => {
    expect(
      getRemoteCompletionError({
        id: "server-job",
        status: "completed",
        total: 1,
        completed: 0,
        failed: 1,
        message: "批量任务已完成",
        failures: [{ combinationId: "mix_0001", phase: "video", message: "FFmpeg 输出失败" }]
      })
    ).toBe("服务器未生成成片：FFmpeg 输出失败");
  });

  it("allows download when the server produced at least one video", () => {
    expect(
      getRemoteCompletionError({
        id: "server-job",
        status: "completed",
        total: 2,
        completed: 1,
        failed: 1,
        message: "批量任务已完成",
        failures: [{ combinationId: "mix_0002", phase: "video", message: "FFmpeg 输出失败" }]
      })
    ).toBeUndefined();
  });

  it("turns ENOSPC into an actionable local disk message", () => {
    const error = Object.assign(new Error("no space left on device, write"), { code: "ENOSPC" });
    expect(describeOutputDownloadFailure(error, "D:\\成片")).toContain("本地输出磁盘空间不足");
    expect(describeOutputDownloadFailure(error, "D:\\成片")).toContain("继续下载");
    expect(describeOutputDownloadFailure(error, "D:\\成片")).not.toContain("服务器成片下载失败");
  });

  it("reserves ten percent or one GiB before downloading outputs", () => {
    expect(getRequiredLocalDownloadBytes(500 * 1024 ** 2)).toBe(500 * 1024 ** 2 + 1024 ** 3);
    expect(getRequiredLocalDownloadBytes(20 * 1024 ** 3)).toBe(22 * 1024 ** 3);
  });

  it("continues an interrupted output download without requesting complete local files again", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-mix-resume-"));
    const outputDir = path.join(tempDir, "output");
    const videosDir = path.join(outputDir, "videos");
    await fs.mkdir(videosDir, { recursive: true });
    await fs.writeFile(path.join(videosDir, "complete.mp4"), "complete-video");
    const requested: string[] = [];
    const missingContent = Buffer.from("missing-video");
    const server = http.createServer((request, response) => {
      requested.push(request.url ?? "");
      if (request.url === "/api/jobs/job-1/outputs") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          ok: true,
          files: [
            { name: "complete.mp4", size: Buffer.byteLength("complete-video"), url: "/complete" },
            { name: "missing.mp4", size: missingContent.length, url: "/missing" }
          ]
        }));
        return;
      }
      if (request.url === "/api/jobs/job-1/outputs/missing.mp4") {
        response.writeHead(200, { "content-length": String(missingContent.length) });
        response.end(missingContent);
        return;
      }
      response.writeHead(500);
      response.end("unexpected request");
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      const client = new RemoteMixClient(() => tempDir);
      Object.assign(client, { currentJobId: "job-1" });
      const config: MixProjectConfig = {
        projectDir: tempDir,
        outputDir,
        slots: [],
        bgmAssets: [],
        bgmRange: { fadeInSeconds: 0, fadeOutSeconds: 0 },
        bgmTracks: [],
        maxCombinations: 2,
        outputNamePattern: "result",
        exportMode: "video",
        sourceVolume: 1,
        bgmVolume: 1,
        normalizeLoudness: false,
        videoProfile: { codec: "h264", audioCodec: "aac", preset: "veryfast", crf: 23, canvasMode: "original" },
        exportTarget: "local",
        draftSlots: []
      };
      const completed: BatchJobSnapshot = {
        id: "job-1",
        status: "completed",
        total: 2,
        completed: 2,
        failed: 0,
        message: "批量任务已完成",
        failures: []
      };
      const internals = client as unknown as {
        downloadOutputs: (
          settings: { serverUrl: string; token: string },
          config: MixProjectConfig,
          snapshot: BatchJobSnapshot
        ) => Promise<void>;
      };
      await internals.downloadOutputs({ serverUrl: `http://127.0.0.1:${port}`, token: "test-token" }, config, completed);

      await expect(fs.readFile(path.join(videosDir, "missing.mp4"), "utf8")).resolves.toBe("missing-video");
      expect(requested).not.toContain("/api/jobs/job-1/outputs/complete.mp4");
      expect(client.getSnapshot()).toMatchObject({ status: "completed", completed: 2 });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("checks a real server health endpoint and saved Token", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-mix-client-"));
    const server = http.createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, workspaceRoot: "/tmp/mix-work", audioPipelineVersion: 9, combinationPipelineVersion: 4 }));
        return;
      }
      if (request.url === "/api/auth/check" && request.headers["x-mix-token"] === "test-token") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false }));
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      await fs.writeFile(path.join(tempDir, "remote-mix-server.json"), JSON.stringify({ serverUrl: `http://127.0.0.1:${port}`, token: "test-token" }));

      const client = new RemoteMixClient(() => tempDir);
      await expect(client.testConnection()).resolves.toMatchObject({ ok: true, hasToken: true });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("stores server settings independently for each task tab", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-mix-client-"));
    const server = http.createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, workspaceRoot: "/tmp/mix-work", audioPipelineVersion: 9, combinationPipelineVersion: 4 }));
        return;
      }
      if (request.url === "/api/auth/check" && request.headers["x-mix-token"] === "task-a-token") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false }));
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      const taskA = new RemoteMixClient(() => tempDir, "task-a");
      const taskB = new RemoteMixClient(() => tempDir, "task-b");

      await expect(taskA.saveSettings({ serverUrl: `http://127.0.0.1:${port}`, token: "task-a-token" })).resolves.toMatchObject({ ok: true });
      await expect(taskA.getSettingsView()).resolves.toMatchObject({ serverUrl: `http://127.0.0.1:${port}`, hasToken: true });
      await expect(taskB.getSettingsView()).resolves.toMatchObject({ serverUrl: "http://10.0.0.133:8787", hasToken: false });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects a server that cannot guarantee opening clip rotation", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-mix-client-"));
    const server = http.createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, workspaceRoot: "/tmp/mix-work", audioPipelineVersion: 9, combinationPipelineVersion: 3 }));
        return;
      }
      if (request.url === "/api/auth/check" && request.headers["x-mix-token"] === "test-token") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false }));
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      await fs.writeFile(path.join(tempDir, "remote-mix-server.json"), JSON.stringify({ serverUrl: `http://127.0.0.1:${port}`, token: "test-token" }));

      const client = new RemoteMixClient(() => tempDir);
      await expect(client.testConnection()).resolves.toMatchObject({ ok: false, message: expect.stringContaining("开头素材轮换") });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects a v8 server that still applies automatic final gain", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-mix-client-"));
    const server = http.createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, workspaceRoot: "/tmp/mix-work", audioPipelineVersion: 8, combinationPipelineVersion: 4 }));
        return;
      }
      if (request.url === "/api/auth/check" && request.headers["x-mix-token"] === "test-token") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false }));
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      await fs.writeFile(path.join(tempDir, "remote-mix-server.json"), JSON.stringify({ serverUrl: `http://127.0.0.1:${port}`, token: "test-token" }));

      const client = new RemoteMixClient(() => tempDir);
      await expect(client.testConnection()).resolves.toMatchObject({ ok: false, message: expect.stringContaining("音画同步") });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
