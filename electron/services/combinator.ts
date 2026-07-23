import path from "node:path";
import type { AssetInfo, MixCombination, SegmentSlot } from "../../src/shared/types.js";
import { safeName } from "../utils/path.js";

export function createCombinations(
  slots: SegmentSlot[],
  bgmAssets: AssetInfo[],
  outputDir: string,
  maxCombinations = Number.POSITIVE_INFINITY,
  outputNamePattern = ""
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

    combinations.push({
      id,
      index,
      slotAssets,
      bgm: bgmAssets.length > 0 ? bgmAssets[index % bgmAssets.length] : undefined,
      targetVideoPath: path.join(outputDir, "videos", `${fileBase}.mp4`),
      targetDraftPath: path.join(outputDir, "jianying-drafts", fileBase)
    });
  }

  return combinations;
}

export function buildOutputBaseName(pattern: string | undefined, index: number): string {
  const base = safeName((pattern ?? "").trim());
  if (!base) {
    return "";
  }
  return `${base}_${String(index + 1).padStart(3, "0")}`;
}
