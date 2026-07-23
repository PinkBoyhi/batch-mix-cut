import fs from "node:fs/promises";
import path from "node:path";
import type { AssetInfo, MixProjectConfig, ScanResult, SegmentSlot } from "../../src/shared/types.js";
import { assetId, isAudioFile, isVideoFile, naturalCompare } from "../utils/path.js";
import { createCombinations } from "./combinator.js";
import { parseJianyingDraft } from "./jianyingDraft.js";
import { probeAsset } from "./mediaProbe.js";

const IGNORED_DIRS = new Set(["BGM", "bgm", "outputs", "output", "template-draft", ".git"]);

export async function scanProject(projectDir: string, templateDraftOverride?: string): Promise<ScanResult> {
  const entries = await fs.readdir(projectDir, { withFileTypes: true });
  const warnings: string[] = [];
  const outputDir = path.join(projectDir, "outputs");
  const templateDraftPath = templateDraftOverride ?? path.join(projectDir, "template-draft");
  const hasTemplate = await exists(templateDraftPath);
  const draftMapping = hasTemplate ? await parseDraftOrWarn(templateDraftPath, warnings) : undefined;
  const draftSlots = draftMapping?.slots ?? [];
  const bgmDir = entries.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === "bgm");
  const bgmAssets = bgmDir ? await scanAssets(path.join(projectDir, bgmDir.name), "audio") : [];

  const slotDirs = entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !IGNORED_DIRS.has(entry.name))
    .sort((a, b) => naturalCompare(a.name, b.name));

  const slots: SegmentSlot[] = [];

  if (draftSlots.length > 0) {
    for (const draftSlot of draftSlots) {
      const slotDir = slotDirs.find((entry) => entry.name === draftSlot.slotName);
      const assets = slotDir ? await scanAssets(path.join(projectDir, slotDir.name), "video") : [];
      if (!slotDir) {
        warnings.push(`剪映草稿槽位 ${draftSlot.slotName} 缺少同名素材文件夹`);
      } else if (assets.length === 0) {
        warnings.push(`剪映草稿槽位 ${draftSlot.slotName} 的素材文件夹没有找到视频`);
      }
      slots.push({ name: draftSlot.slotName, assets, sortOrder: draftSlot.index, draftSlot });
    }
  } else {
    for (const [sortOrder, entry] of slotDirs.entries()) {
      const assets = await scanAssets(path.join(projectDir, entry.name), "video");
      if (assets.length === 0) {
        warnings.push(`片段槽位 ${entry.name} 没有找到视频素材`);
      }
      slots.push({ name: entry.name, assets, sortOrder });
    }
  }

  for (const entry of slotDirs) {
    if (slots.some((slot) => slot.name === entry.name)) {
      continue;
    }
    const assets = await scanAssets(path.join(projectDir, entry.name), "video");
    if (assets.length === 0) {
      continue;
    }
    warnings.push(`素材文件夹 ${entry.name} 不在剪映草稿主轨槽位中，本次不会参与排列组合`);
  }

  if (slots.length === 0) {
    warnings.push("没有找到片段槽位文件夹，请创建 A、B、C 等视频素材文件夹");
  }

  if (bgmAssets.length === 0) {
    warnings.push("没有找到 BGM 文件夹或音频素材，导出时会使用静音/原视频音频设置");
  }

  const config: MixProjectConfig = {
    projectDir,
    outputDir,
    slots,
    bgmAssets,
    bgmRange: {
      startSlotName: slots[0]?.name,
      endSlotName: slots.at(-1)?.name,
      fadeOutSeconds: 2
    },
    maxCombinations: 100,
    outputNamePattern: "成品",
    exportMode: hasTemplate ? "both" : "video",
    sourceVolume: 1,
    bgmVolume: 1,
    videoProfile: {
      codec: "h264",
      audioCodec: "aac",
      preset: "fast",
      crf: 20,
      canvasMode: "original"
    },
    exportTarget: "local",
    templateDraftPath: hasTemplate ? templateDraftPath : undefined,
    draftSlots
  };

  return {
    config,
    combinations: createCombinations(slots, bgmAssets, outputDir, config.maxCombinations, config.outputNamePattern),
    warnings
  };
}

async function parseDraftOrWarn(templateDraftPath: string, warnings: string[]) {
  try {
    const mapping = await parseJianyingDraft(templateDraftPath);
    if (mapping.slots.length === 0) {
      warnings.push("已找到 template-draft，但没有从剪映草稿主轨识别到视频片段");
    }
    return mapping;
  } catch (error) {
    warnings.push(`读取剪映草稿失败：${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function scanAssets(dir: string, kind: "video" | "audio"): Promise<AssetInfo[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dir, entry.name))
    .filter((filePath) => (kind === "video" ? isVideoFile(filePath) : isAudioFile(filePath)))
    .sort(naturalCompare);

  const assets = files.map((filePath) => ({
    id: assetId(filePath),
    path: filePath,
    name: path.basename(filePath),
    kind
  }));

  return Promise.all(assets.map(probeAsset));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
