import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AssetInfo, BgmTrack, SegmentSlot } from "../../src/shared/types.js";
import { buildOutputBaseName, createCombinations } from "./combinator.js";

describe("createCombinations", () => {
  it("creates cartesian products while rotating the opening segment first", () => {
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
    expect(combinations.map((item) => item.slotAssets.A.name)).toEqual(["a1.mp4", "a2.mp4", "a1.mp4", "a2.mp4"]);
    expect(combinations.map((item) => item.slotAssets.B.name)).toEqual(["b1.mp4", "b1.mp4", "b2.mp4", "b2.mp4"]);
    expect(combinations.map((item) => item.bgm?.name)).toEqual(["m1.mp3", "m2.mp3", "m1.mp3", "m2.mp3"]);
  });

  it("alternates two opening assets across a 40-video batch even when later slots have many assets", () => {
    const slots: SegmentSlot[] = [
      { name: "A", sortOrder: 0, assets: [video("opening-1.mp4"), video("opening-2.mp4")] },
      {
        name: "B",
        sortOrder: 1,
        assets: Array.from({ length: 20 }, (_, index) => video(`body-${index + 1}.mp4`))
      }
    ];

    const combinations = createCombinations(slots, [], "/tmp/out", 40);

    expect(combinations).toHaveLength(40);
    expect(combinations.map((item) => item.slotAssets.A.name)).toEqual(
      Array.from({ length: 40 }, (_, index) => `opening-${(index % 2) + 1}.mp4`)
    );
    expect(combinations.map((item) => item.slotAssets.B.name)).toEqual(
      Array.from({ length: 20 }, (_, index) => `body-${index + 1}.mp4`).flatMap((name) => [name, name])
    );
  });

  it("spreads later segments through the first batch without repeating combinations", () => {
    const slots: SegmentSlot[] = [
      { name: "A", sortOrder: 0, assets: [video("a1.mp4"), video("a2.mp4")] },
      { name: "B", sortOrder: 1, assets: [video("b1.mp4"), video("b2.mp4")] },
      { name: "C", sortOrder: 2, assets: [video("c1.mp4"), video("c2.mp4"), video("c3.mp4")] }
    ];

    const firstBatch = createCombinations(slots, [], "/tmp/out", 4);
    const completeBatch = createCombinations(slots, [], "/tmp/out");

    expect(firstBatch.map((item) => item.slotAssets.C.name)).toEqual(["c1.mp4", "c2.mp4", "c3.mp4", "c1.mp4"]);
    expect(new Set(completeBatch.map((item) => Object.values(item.slotAssets).map((asset) => asset.name).join("|"))).size).toBe(12);
  });

  it("selects one candidate from every bgm track", () => {
    const slots: SegmentSlot[] = [{ name: "A", sortOrder: 0, assets: [video("a1.mp4"), video("a2.mp4")] }];
    const bgmTracks: BgmTrack[] = [
      bgmTrack("bgm_1", 0, [audio("m1.mp3"), audio("m2.mp3")]),
      bgmTrack("bgm_2", 1, [audio("n1.mp3"), audio("n2.mp3")])
    ];

    const combinations = createCombinations(slots, [], "/tmp/out", 2, "", bgmTracks);

    expect(combinations.map((item) => item.bgmTracks?.map((track) => track.asset.name))).toEqual([
      ["m1.mp3", "n1.mp3"],
      ["m2.mp3", "n2.mp3"]
    ]);
    expect(combinations.map((item) => item.bgm?.name)).toEqual(["m1.mp3", "m2.mp3"]);
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
      A: expect.objectContaining({ name: "a2.mp4" }),
      B: expect.objectContaining({ name: "b2.mp4" }),
      C: expect.objectContaining({ name: "c2.mp4" })
    });
  });

  it("uses custom output names with padded sequence numbers", () => {
    const slots: SegmentSlot[] = [{ name: "A", sortOrder: 0, assets: [video("a1.mp4"), video("a2.mp4")] }];

    const combinations = createCombinations(slots, [], "/tmp/out", 2, "成品 视频");

    expect(combinations.map((item) => item.targetVideoPath)).toEqual([
      path.join("/tmp/out", "videos", "成品_视频_001.mp4"),
      path.join("/tmp/out", "videos", "成品_视频_002.mp4")
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

function bgmTrack(id: string, sortOrder: number, assets: AssetInfo[]): BgmTrack {
  return {
    id,
    name: `BGM ${sortOrder + 1}`,
    assets,
    range: {
      fadeInSeconds: 1,
      fadeOutSeconds: 2
    },
    sortOrder
  };
}
