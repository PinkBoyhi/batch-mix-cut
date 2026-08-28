import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { AssetInfo } from "../../src/shared/types.js";
import { getRemoteCompletionError, RemoteMixClient, toRemoteAsset } from "./remoteMixClient.js";

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

  it("checks a real server health endpoint and saved Token", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-mix-client-"));
    const server = http.createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, workspaceRoot: "/tmp/mix-work", audioPipelineVersion: 4, combinationPipelineVersion: 3 }));
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

  it("rejects a server that cannot guarantee opening clip rotation", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-mix-client-"));
    const server = http.createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, workspaceRoot: "/tmp/mix-work", audioPipelineVersion: 4, combinationPipelineVersion: 2 }));
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
});
