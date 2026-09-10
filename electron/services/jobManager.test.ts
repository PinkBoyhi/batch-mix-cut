import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JobManager } from "./jobManager.js";
import { exportVideo } from "./ffmpeg.js";
import type { BatchJobSnapshot, MixProjectConfig } from "../../src/shared/types.js";
vi.mock("./ffmpeg.js", () => ({ exportVideo: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })) }));
let dir: string;
let config: MixProjectConfig;
beforeEach(async () => {
  vi.clearAllMocks(); dir = await fs.mkdtemp(path.join(os.tmpdir(), "job-manager-"));
  config = { projectDir: dir, outputDir: dir, slots: [{ name: "A", sortOrder: 0, assets: [{ id: "a", path: "a.mp4", name: "a.mp4", kind: "video" }, { id: "b", path: "b.mp4", name: "b.mp4", kind: "video" }] }],
    bgmAssets: [], bgmTracks: [], bgmRange: { fadeInSeconds: 0, fadeOutSeconds: 0 }, maxCombinations: 2, outputNamePattern: "result", exportMode: "video", exportTarget: "local",
    sourceVolume: 1, bgmVolume: 0, normalizeLoudness: false, videoProfile: { codec: "h264", audioCodec: "aac", preset: "fast", crf: 20, canvasMode: "original" }, draftSlots: [] };
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
function terminal(manager: JobManager) {
  return new Promise<BatchJobSnapshot>((resolve) => { manager.on("update", (s) => { if (["completed", "failed", "idle"].includes(s.status)) resolve(s); }); });
}
it("checks every target before encoding any part of a conflicting batch", async () => {
  await fs.mkdir(path.join(dir, "videos")); await fs.writeFile(path.join(dir, "videos/result_002.mp4"), "old");
  const manager = new JobManager(); const done = terminal(manager); await manager.start(config);
  expect((await done).status).toBe("failed"); expect(exportVideo).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(dir, "videos/result_002.mp4"), "utf8")).toBe("old");
});
it("freezes the configuration used by a running batch", async () => {
  const manager = new JobManager(); const done = terminal(manager); await manager.start(config);
  config.slots[0].assets.length = 0; config.sourceVolume = 0;
  expect((await done).completed).toBe(2);
  expect(vi.mocked(exportVideo).mock.calls[0][0].slots[0].assets).toHaveLength(2);
  expect(vi.mocked(exportVideo).mock.calls[0][0].sourceVolume).toBe(1);
});
it("resumes after a server restart without re-encoding published outputs", async () => {
  await fs.mkdir(path.join(dir, "videos"));
  await fs.writeFile(path.join(dir, "videos/result_001.mp4"), "published-video");
  await fs.writeFile(path.join(dir, "videos/result_002.mp4.crash.partial"), "incomplete-video");
  const manager = new JobManager(); const done = terminal(manager);
  const started = await manager.start(config, { resumeExistingOutputs: true });
  expect(started.completed).toBe(1);
  const result = await done;
  expect(result.status).toBe("completed");
  expect(result.completed).toBe(2);
  expect(exportVideo).toHaveBeenCalledTimes(1);
  await expect(fs.stat(path.join(dir, "videos/result_002.mp4.crash.partial"))).rejects.toThrow();
});
it("does not count user cancellation as an export failure", async () => {
  const manager = new JobManager(); const done = terminal(manager);
  await manager.start(config); await manager.stop();
  const result = await done; expect(result.status).toBe("idle"); expect(result.failed).toBe(0); expect(exportVideo).not.toHaveBeenCalled();
});
