import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import http from "node:http";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import type { AssetInfo, MixProjectConfig } from "../../src/shared/types.js";
import { exportVideo } from "./ffmpeg.js";
import { getFfmpegPath } from "./ffmpegBinaries.js";
import { probeAsset } from "./mediaProbe.js";
import { createCombinations } from "./combinator.js";

const exec = promisify(execFile);
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "mix-regression-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
const asset = (filePath: string): AssetInfo => ({ id: filePath, path: filePath, name: path.basename(filePath), kind: "video" });
async function makeVideo(filePath: string, duration = 1) {
  await exec(getFfmpegPath(), ["-y", "-f", "lavfi", "-i", `testsrc2=size=160x90:rate=30:duration=${duration}`,
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=44100:duration=${duration}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", filePath]);
}
function config(source: AssetInfo, name = "result"): MixProjectConfig {
  return { projectDir: dir, outputDir: dir, slots: [{ name: "A", assets: [source], sortOrder: 0 }], bgmAssets: [], bgmTracks: [],
    bgmRange: { fadeInSeconds: 0, fadeOutSeconds: 0 }, maxCombinations: 1, outputNamePattern: name, exportMode: "video", exportTarget: "local",
    sourceVolume: 1, bgmVolume: 0, normalizeLoudness: false, videoProfile: { codec: "h264", audioCodec: "aac", preset: "veryfast", crf: 28, canvasMode: "original" }, draftSlots: [] };
}
function combination(c: MixProjectConfig) { return createCombinations(c.slots, [], dir, 1, c.outputNamePattern)[0]; }
async function exportConfig(c: MixProjectConfig) { const out = combination(c); await exportVideo(c, out).promise; return out.targetVideoPath; }
async function volume(filePath: string) {
  const { stderr } = await exec(getFfmpegPath(), ["-i", filePath, "-vn", "-af", "volumedetect", "-f", "null", "-"]);
  return Number(stderr.match(/mean_volume:\s*(-?[\d.]+)/)?.[1]);
}

describe("export integrity and user controls", () => {
  it("re-probes a replaced source even if its path is unchanged", async () => {
    const source = path.join(dir, "same.mp4"); await makeVideo(source);
    await exportConfig(config(await probeAsset(asset(source)), "first"));
    await makeVideo(source, 3);
    const output = await exportConfig(config(await probeAsset(asset(source)), "second"));
    expect((await probeAsset(asset(output))).videoDurationSeconds).toBeCloseTo(3, 1);
  });
  it.each([false, true])("preserves 5 percent volume with normalization=%s", async (normalizeLoudness) => {
    const source = path.join(dir, "source.mp4"); await makeVideo(source);
    const c = { ...config(asset(source), "full"), normalizeLoudness };
    const full = await volume(await exportConfig(c));
    const quiet = await volume(await exportConfig({ ...c, sourceVolume: 0.05, outputNamePattern: "quiet" }));
    expect(full - quiet).toBeGreaterThan(24);
    expect(full - quiet).toBeLessThan(28);
  });
  it("keeps an existing output intact", async () => {
    const source = path.join(dir, "source.mp4"); await makeVideo(source);
    const c = config(asset(source)); const out = combination(c);
    await fs.mkdir(path.dirname(out.targetVideoPath), { recursive: true });
    await fs.writeFile(out.targetVideoPath, "original-content");
    await expect(exportVideo(c, out).promise).rejects.toThrow("不会覆盖");
    expect(await fs.readFile(out.targetVideoPath, "utf8")).toBe("original-content");
  });
  it("allows only one concurrent writer for a target", async () => {
    const source = path.join(dir, "source.mp4"); await makeVideo(source);
    const c = config(asset(source)); const out = combination(c);
    const results = await Promise.allSettled([exportVideo(c, out).promise, exportVideo(c, out).promise]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await probeAsset(asset(out.targetVideoPath))).videoDurationSeconds).toBeCloseTo(1, 1);
    expect((await fs.readdir(path.dirname(out.targetVideoPath))).filter((p) => p.includes("partial"))).toHaveLength(0);
  });
  it("cancels before preparation without creating an output", async () => {
    const source = path.join(dir, "source.mp4"); await makeVideo(source);
    const c = config(asset(source)); const out = combination(c); const handle = exportVideo(c, out); handle.cancel();
    await expect(handle.promise).rejects.toThrow("任务已停止");
    await expect(fs.stat(out.targetVideoPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("aborts a stalled cloud download and removes the partial cache", async () => {
    let received!: () => void; const started = new Promise<void>((r) => { received = r; });
    const server = http.createServer((_request, response) => { response.writeHead(200); response.write("prefix"); received(); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const address = server.address() as { port: number };
      const c = config(asset(`http://127.0.0.1:${address.port}/cloud.mp4`)); const handle = exportVideo(c, combination(c));
      const result = expect(handle.promise).rejects.toThrow("任务已停止");
      await started; handle.cancel(); await result;
      expect(await fs.readdir(path.join(dir, ".cloud-cache"))).toEqual([]);
    } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
  });
  it("uses display dimensions for rotated portrait footage", async () => {
    const source = path.join(dir, "landscape.mp4"), rotated = path.join(dir, "portrait.mp4"); await makeVideo(source);
    await exec(getFfmpegPath(), ["-y", "-i", source, "-c", "copy", "-metadata:s:v:0", "rotate=90", rotated]);
    const info = await probeAsset(asset(rotated)); expect([info.width, info.height]).toEqual([90, 160]);
    const output = await probeAsset(asset(await exportConfig(config(info))));
    expect([output.width, output.height]).toEqual([90, 160]);
  });
});
