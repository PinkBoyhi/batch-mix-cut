import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { PersistedServerJob } from "./serverJobStore.js";
import { ServerJobStore } from "./serverJobStore.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "server-job-store-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

it("persists the latest snapshot and restores jobs in creation order", async () => {
  const store = new ServerJobStore(workspace);
  const later = record("srv_later", "2026-09-10T03:00:02.000Z", 0);
  const earlier = record("srv_earlier", "2026-09-10T03:00:01.000Z", 1);
  await Promise.all([store.save(later), store.save(earlier), store.save({ ...later, snapshot: { ...later.snapshot, completed: 2 } })]);
  await store.flush();
  const restored = await store.load();
  expect(restored.map((item) => item.id)).toEqual(["srv_earlier", "srv_later"]);
  expect(restored[1].snapshot.completed).toBe(2);
});

it("removes a terminal job after queued writes finish", async () => {
  const store = new ServerJobStore(workspace);
  const item = record("srv_done", "2026-09-10T03:00:00.000Z", 1);
  void store.save(item);
  await store.remove(item.id);
  await store.flush();
  expect(await store.load()).toEqual([]);
});

function record(id: string, createdAt: string, completed: number): PersistedServerJob {
  return {
    version: 1,
    id,
    createdAt,
    workflowId: `wf-${id}`,
    desktopTracked: true,
    snapshot: { id, status: "running", total: 2, completed, failed: 0, message: "处理中", failures: [] },
    config: {
      projectDir: path.join(workspace, "projects", id),
      outputDir: path.join(workspace, "projects", id, "outputs"),
      slots: [],
      bgmAssets: [],
      bgmRange: { fadeInSeconds: 0, fadeOutSeconds: 0 },
      bgmTracks: [],
      maxCombinations: 2,
      outputNamePattern: "mix",
      exportMode: "video",
      sourceVolume: 1,
      bgmVolume: 0,
      normalizeLoudness: false,
      videoProfile: { codec: "h264", audioCodec: "aac", preset: "veryfast", crf: 23, canvasMode: "original" },
      exportTarget: "local",
      draftSlots: []
    }
  };
}
