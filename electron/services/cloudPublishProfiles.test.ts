import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudPublishProfileStore } from "./cloudPublishProfiles.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("CloudPublishProfileStore", () => {
  it("saves multiple profiles, updates a selected profile, and deletes it", async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-publish-profiles-"));
    temporaryDirectories.push(userDataDir);
    const store = new CloudPublishProfileStore(() => userDataDir);

    const first = await store.save(createInput("清水成片"));
    const second = await store.save(createInput("品牌素材"));
    expect((await store.list()).map((profile) => profile.name).sort()).toEqual(["品牌素材", "清水成片"]);

    const updated = await store.save({ ...createInput("清水成片-更新"), id: first.id, videoType: 2 });
    expect(updated.id).toBe(first.id);
    expect((await store.list()).find((profile) => profile.id === first.id)).toEqual(
      expect.objectContaining({ name: "清水成片-更新", videoType: 2 })
    );

    await store.delete(second.id);
    expect(await store.list()).toHaveLength(1);
  });
});

function createInput(name: string) {
  return {
    name,
    videoType: 0,
    oneLevelTypeId: "1",
    twoLevelTypeId: "2",
    labelIds: "3,4",
    videoRight: 0,
    syncEnabled: true,
    rotation: "none" as const,
    publishMode: "single" as const,
    nameMode: "prefix" as const,
    customName: "",
    namePrefix: "医博"
  };
}
