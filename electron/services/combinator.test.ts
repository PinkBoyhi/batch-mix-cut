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
    expect(combinations.map((item) => item.slotAssets.B.name)).toEqual(["b1.mp4", "b2.mp4", "b2.mp4", "b1.mp4"]);
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
    expect(countNames(combinations.map((item) => item.slotAssets.B.name))).toEqual(
      Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`body-${index + 1}.mp4`, 2]))
    );
  });

  it("spreads every segment through a limited batch without duplicate full combinations", () => {
    const slots: SegmentSlot[] = [
      { name: "A", sortOrder: 0, assets: [video("a1.mp4"), video("a2.mp4")] },
      { name: "B", sortOrder: 1, assets: [video("b1.mp4"), video("b2.mp4")] },
      { name: "C", sortOrder: 2, assets: [video("c1.mp4"), video("c2.mp4"), video("c3.mp4")] }
    ];

    const firstBatch = createCombinations(slots, [], "/tmp/out", 4);
    const completeBatch = createCombinations(slots, [], "/tmp/out");

    expect(firstBatch.map((item) => item.slotAssets.A.name)).toEqual(["a1.mp4", "a2.mp4", "a1.mp4", "a2.mp4"]);
    expect(firstBatch.map((item) => item.slotAssets.B.name)).toEqual(["b1.mp4", "b2.mp4", "b2.mp4", "b1.mp4"]);
    expect(firstBatch.map((item) => item.slotAssets.C.name)).toEqual(["c1.mp4", "c2.mp4", "c3.mp4", "c1.mp4"]);
    expect(new Set(completeBatch.map(combinationKey))).toHaveLength(12);
  });

  it("uses all three ending clips in the first 100 outputs of a large project", () => {
    const slots: SegmentSlot[] = [
      slot("A", 0, 10),
      slot("B", 1, 10),
      slot("C", 2, 10),
      slot("D", 3, 3)
    ];

    const combinations = createCombinations(slots, [], "/tmp/out", 100);

    expect(new Set(combinations.map(combinationKey))).toHaveLength(100);
    expect(countNames(combinations.map((item) => item.slotAssets.C.name))).toEqual(
      Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`C${index + 1}.mp4`, 10]))
    );
    expect(countNames(combinations.map((item) => item.slotAssets.D.name))).toEqual({
      "D1.mp4": 34,
      "D2.mp4": 33,
      "D3.mp4": 33
    });
  });

  it("keeps every full cartesian combination unique for uneven slot sizes", () => {
    for (const sizes of [[2, 3, 4], [3, 5, 2, 4], [4, 4, 3, 2]]) {
      const slots = sizes.map((assetCount, index) => slot(String.fromCharCode(65 + index), index, assetCount));
      const combinations = createCombinations(slots, [], "/tmp/out");
      const expectedTotal = sizes.reduce((product, size) => product * size, 1);

      expect(combinations).toHaveLength(expectedTotal);
      expect(new Set(combinations.map(combinationKey))).toHaveLength(expectedTotal);
    }
  });

  it("keeps the legacy strict order for tasks persisted before algorithm v4", () => {
    const slots: SegmentSlot[] = [
      { name: "A", sortOrder: 0, assets: [video("a1.mp4"), video("a2.mp4")] },
      { name: "B", sortOrder: 1, assets: [video("b1.mp4"), video("b2.mp4")] },
      { name: "C", sortOrder: 2, assets: [video("c1.mp4"), video("c2.mp4")] }
    ];

    const legacy = createCombinations(slots, [], "/tmp/out", 4, "", [], 3);

    expect(legacy.map(combinationKey)).toEqual([
      "a1.mp4|b1.mp4|c1.mp4",
      "a2.mp4|b1.mp4|c1.mp4",
      "a1.mp4|b2.mp4|c1.mp4",
      "a2.mp4|b2.mp4|c1.mp4"
    ]);
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
    for (const slotName of ["A", "B", "C"]) {
      expect(new Set(combinations.map((item) => item.slotAssets[slotName].name))).toHaveLength(3);
    }
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

function slot(name: string, sortOrder: number, assetCount: number): SegmentSlot {
  return {
    name,
    sortOrder,
    assets: Array.from({ length: assetCount }, (_, index) => video(`${name}${index + 1}.mp4`))
  };
}

function combinationKey(item: ReturnType<typeof createCombinations>[number]): string {
  return Object.values(item.slotAssets).map((asset) => asset.name).join("|");
}

function countNames(names: string[]): Record<string, number> {
  return names.reduce<Record<string, number>>((counts, name) => {
    counts[name] = (counts[name] ?? 0) + 1;
    return counts;
  }, {});
}
