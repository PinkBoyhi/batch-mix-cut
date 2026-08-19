import path from "node:path";
import type { AssetInfo, BgmTrack, MixCombination, MixCombinationBgmTrack, SegmentSlot } from "../../src/shared/types.js";
import { safeName } from "../utils/path.js";

export function createCombinations(
  slots: SegmentSlot[],
  bgmAssets: AssetInfo[],
  outputDir: string,
  maxCombinations = Number.POSITIVE_INFINITY,
  outputNamePattern = "",
  bgmTracks: BgmTrack[] = []
): MixCombination[] {
  if (slots.length === 0 || slots.some((slot) => slot.assets.length === 0)) {
    return [];
  }

  const limit = Math.max(0, Math.floor(maxCombinations));
  const total = slots.reduce((product, slot) => product * slot.assets.length, 1);
  const count = Math.min(total, limit);
  const combinations: MixCombination[] = [];

  for (let index = 0; index < count; index += 1) {
    const slotAssets: Record<string, AssetInfo> = {};
    let cursor = index;

    for (let slotIndex = slots.length - 1; slotIndex >= 0; slotIndex -= 1) {
      const slot = slots[slotIndex];
      const assetIndex = cursor % slot.assets.length;
      cursor = Math.floor(cursor / slot.assets.length);
      slotAssets[slot.name] = slot.assets[assetIndex];
    }

    const id = `mix_${String(index + 1).padStart(4, "0")}`;
    const sequence = slots
      .map((slot) => safeName(path.parse(slotAssets[slot.name].name).name))
      .join("__");
    const customBase = buildOutputBaseName(outputNamePattern, index);
    const fileBase = customBase || `${id}__${sequence || "untitled"}`;
    const selectedBgmTracks = selectBgmTracks(bgmTracks, bgmAssets, index);

    combinations.push({
      id,
      index,
      slotAssets,
      bgm: selectedBgmTracks[0]?.asset,
      bgmTracks: selectedBgmTracks,
      targetVideoPath: path.join(outputDir, "videos", `${fileBase}.mp4`),
      targetDraftPath: path.join(outputDir, "jianying-drafts", fileBase)
    });
  }

  return combinations;
}

function selectBgmTracks(bgmTracks: BgmTrack[], legacyAssets: AssetInfo[], index: number): MixCombinationBgmTrack[] {
  const tracks = bgmTracks.length > 0 ? bgmTracks : legacyAssets.length > 0 ? [legacyTrack(legacyAssets)] : [];
  return tracks
    .filter((track) => track.assets.length > 0)
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((track) => ({
      id: track.id,
      name: track.name,
      asset: track.assets[index % track.assets.length],
      range: track.range
    }));
}

function legacyTrack(assets: AssetInfo[]): BgmTrack {
  return {
    id: "bgm_1",
    name: "BGM 1",
    assets,
    range: {
      fadeInSeconds: 0,
      fadeOutSeconds: 2
    },
    sortOrder: 0
  };
}

export function buildOutputBaseName(pattern: string | undefined, index: number): string {
  const base = safeName((pattern ?? "").trim());
  if (!base) {
    return "";
  }
  return `${base}_${String(index + 1).padStart(3, "0")}`;
}
