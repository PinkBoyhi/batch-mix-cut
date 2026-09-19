import path from "node:path";
import type { AssetInfo, BgmTrack, MixCombination, MixCombinationBgmTrack, SegmentSlot } from "../../src/shared/types.js";
import { safeName } from "../utils/path.js";

export const CURRENT_COMBINATION_ALGORITHM_VERSION = 4;

export function createCombinations(
  slots: SegmentSlot[],
  bgmAssets: AssetInfo[],
  outputDir: string,
  maxCombinations = Number.POSITIVE_INFINITY,
  outputNamePattern = "",
  bgmTracks: BgmTrack[] = [],
  algorithmVersion = CURRENT_COMBINATION_ALGORITHM_VERSION
): MixCombination[] {
  if (slots.length === 0 || slots.some((slot) => slot.assets.length === 0)) {
    return [];
  }

  const sortedSlots = [...slots].sort((left, right) => left.sortOrder - right.sortOrder);
  const limit = Math.max(0, Math.floor(maxCombinations));
  const total = sortedSlots.reduce((product, slot) => product * slot.assets.length, 1);
  const count = Math.min(total, limit);
  const combinations: MixCombination[] = [];

  for (let index = 0; index < count; index += 1) {
    const slotAssets: Record<string, AssetInfo> = {};
    let lowerSlotCombinations = 1;

    // Preserve a complete cartesian product, but rotate every later slot by the
    // lower-slot combination index. Taking only the first N results therefore
    // still covers assets from the ending slots instead of keeping them fixed
    // until every earlier combination has been exhausted. This triangular
    // remapping is bijective, so a complete run still contains no duplicates.
    for (const slot of sortedSlots) {
      const baseAssetIndex = Math.floor(index / lowerSlotCombinations) % slot.assets.length;
      const lowerCombinationIndex = algorithmVersion >= 4 ? index % lowerSlotCombinations : 0;
      const assetIndex = (baseAssetIndex + lowerCombinationIndex) % slot.assets.length;
      slotAssets[slot.name] = slot.assets[assetIndex];
      lowerSlotCombinations *= slot.assets.length;
    }

    const id = `mix_${String(index + 1).padStart(4, "0")}`;
    const sequence = sortedSlots
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
