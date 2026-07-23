import { describe, expect, it } from "vitest";
import type { AssetInfo, SegmentSlot } from "../../src/shared/types.js";
import { buildOutputBaseName, createCombinations } from "./combinator.js";

describe("createCombinations", () => {
  it("creates cartesian products and rotates bgm by index", () => {
    const slots: SegmentSlot[] = [
      {
        name: "A",
        sortOrder: 0,
        assets: [video("a1.mp4"), video("a2.mp4")]
      },
      {
        name: "B",
        sortOrder: 1,
        assets: [video("b1.mp4"), video("b2.mp4")]
      }
    ];
    const bgmAssets = [audio("m1.mp3"), audio("m2.mp3")];

    const combinations = createCombinations(slots, bgmAssets, "/tmp/out");

    expect(combinations).toHaveLength(4);
    expect(combinations.map((item) => item.slotAssets.A.name)).toEqual(["a1.mp4", "a1.mp4", "a2.mp4", "a2.mp4"]);
    expect(combinations.map((item) => item.slotAssets.B.name)).toEqual(["b1.mp4", "b2.mp4", "b1.mp4", "b2.mp4"]);
    expect(combinations.map((item) => item.bgm?.name)).toEqual(["m1.mp3", "m2.mp3", "m1.mp3", "m2.mp3"]);
  });

  it("limits generated combinations before expanding large batches", () => {
    const slots: SegmentSlot[] = [
      { name: "A", sortOrder: 0, assets: [video("a1.mp4"), video("a2.mp4"), video("a3.mp4")] },
      { name: "B", sortOrder: 1, assets: [video("b1.mp4"), video("b2.mp4"), video("b3.mp4")] },
      { name: "C", sortOrder: 2, assets: [video("c1.mp4"), video("c2.mp4"), video("c3.mp4")] }
    ];

    const combinations = createCombinations(slots, [], "/tmp/out", 5);

    expect(combinations).toHaveLength(5);
    expect(combinations.at(-1)?.slotAssets).toMatchObject({
      A: expect.objectContaining({ name: "a1.mp4" }),
      B: expect.objectContaining({ name: "b2.mp4" }),
      C: expect.objectContaining({ name: "c2.mp4" })
    });
  });

  it("uses custom output names with padded sequence numbers", () => {
    const slots: SegmentSlot[] = [{ name: "A", sortOrder: 0, assets: [video("a1.mp4"), video("a2.mp4")] }];

    const combinations = createCombinations(slots, [], "/tmp/out", 2, "成品 视频");

    expect(combinations.map((item) => item.targetVideoPath)).toEqual([
      "/tmp/out/videos/成品_视频_001.mp4",
      "/tmp/out/videos/成品_视频_002.mp4"
    ]);
    expect(buildOutputBaseName("", 0)).toBe("");
  });
});

function video(name: string): AssetInfo {
  return {
    id: name,
    path: `/tmp/${name}`,
    name,
    kind: "video",
    width: 1080,
    height: 1920
  };
}

function audio(name: string): AssetInfo {
  return {
    id: name,
    path: `/tmp/${name}`,
    name,
    kind: "audio"
  };
}
