import fs from "node:fs/promises";
import path from "node:path";
import type {
  AssetInfo,
  JianyingDraftSlot,
  JianyingTemplateMapping,
  MixCombination,
  MixProjectConfig
} from "../../src/shared/types.js";

const DRAFT_JSON_NAMES = ["draft_content.json", "draft_info.json", "draft_meta_info.json"];
const VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm"];

interface DraftReplacement {
  slot: JianyingDraftSlot;
  replacement: AssetInfo;
}

interface DraftParseContext {
  root: unknown;
  materialById: Map<string, Record<string, unknown>>;
}

export async function parseJianyingDraft(draftPath: string): Promise<JianyingTemplateMapping> {
  const contentPath = await findDraftContentPath(draftPath);
  const raw = await fs.readFile(contentPath, "utf8");
  const root = JSON.parse(raw) as unknown;
  const context = buildParseContext(root);
  const slots = extractMainVideoSlots(context);

  return {
    templatePath: draftPath,
    slotNames: slots.map((slot) => slot.slotName),
    mainTrackAssetIds: slots.map((slot) => slot.sourcePath ?? slot.materialId ?? slot.id),
    slots
  };
}

export async function generateJianyingDraft(
  config: MixProjectConfig,
  combination: MixCombination
): Promise<JianyingTemplateMapping> {
  if (!config.templateDraftPath) {
    throw new Error("没有配置剪映模板草稿路径");
  }

  await fs.rm(combination.targetDraftPath, { recursive: true, force: true });
  await fs.mkdir(path.dirname(combination.targetDraftPath), { recursive: true });
  await fs.cp(config.templateDraftPath, combination.targetDraftPath, { recursive: true });

  const mapping = await parseJianyingDraft(combination.targetDraftPath);
  const slots = config.draftSlots.length > 0 ? config.draftSlots : mapping.slots;
  const replacements: DraftReplacement[] = slots.map((slot) => {
    const replacement = combination.slotAssets[slot.slotName];
    if (!replacement) {
      throw new Error(`草稿槽位 ${slot.slotName} 没有对应替换素材`);
    }
    if (slot.targetDurationUs && replacement.durationSeconds && replacement.durationSeconds * 1_000_000 < slot.targetDurationUs) {
      throw new Error(`素材 ${replacement.name} 短于草稿槽位 ${slot.slotName} 的时长`);
    }
    return { slot, replacement };
  });

  await replaceDraftJson(combination.targetDraftPath, replacements);
  return mapping;
}

async function replaceDraftJson(draftPath: string, replacements: DraftReplacement[]): Promise<void> {
  const jsonFiles = await findDraftJsonFiles(draftPath);

  for (const jsonFile of jsonFiles) {
    const raw = await fs.readFile(jsonFile, "utf8");
    const json = JSON.parse(raw) as unknown;
    const next = replaceValues(json, replacements);
    await fs.writeFile(jsonFile, JSON.stringify(next, null, 2));
  }
}

function buildParseContext(root: unknown): DraftParseContext {
  const materialById = new Map<string, Record<string, unknown>>();

  if (isRecord(root)) {
    const materials = root.materials;
    if (isRecord(materials)) {
      for (const value of Object.values(materials)) {
        if (!Array.isArray(value)) continue;
        for (const item of value) {
          if (!isRecord(item)) continue;
          const id = stringValue(item.id);
          if (id) {
            materialById.set(id, item);
          }
        }
      }
    }
  }

  return { root, materialById };
}

function extractMainVideoSlots(context: DraftParseContext): JianyingDraftSlot[] {
  if (!isRecord(context.root) || !Array.isArray(context.root.tracks)) {
    return [];
  }

  const videoTracks = context.root.tracks
    .filter(isRecord)
    .filter((track) => isVideoTrack(track, context.materialById))
    .map((track) => ({
      track,
      segments: Array.isArray(track.segments) ? track.segments.filter(isRecord) : []
    }))
    .filter((track) => track.segments.length > 0);

  const mainTrack = videoTracks.sort((a, b) => scoreTrack(b) - scoreTrack(a))[0];
  if (!mainTrack) {
    return [];
  }

  return mainTrack.segments
    .slice()
    .sort((a, b) => timerangeStart(a) - timerangeStart(b))
    .map((segment, index) => {
      const materialId = stringValue(segment.material_id) ?? stringValue(segment.materialId);
      const material = materialId ? context.materialById.get(materialId) : undefined;
      const sourcePath = material ? findFirstVideoPath(material) : findFirstVideoPath(segment);
      const sourceName = material ? findName(material, sourcePath) : findName(segment, sourcePath);

      return {
        id: stringValue(segment.id) ?? materialId ?? `draft_slot_${index + 1}`,
        slotName: indexToSlotName(index),
        index,
        trackId: stringValue(mainTrack.track.id),
        segmentId: stringValue(segment.id),
        materialId,
        sourcePath,
        sourceName,
        targetStartUs: timerangeStart(segment),
        targetDurationUs: timerangeDuration(segment)
      };
    });
}

function replaceValues(value: unknown, replacements: DraftReplacement[], active?: DraftReplacement): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => replaceValues(item, replacements, active));
  }

  if (!isRecord(value)) {
    if (typeof value !== "string") return value;
    const replacement = findReplacementForString(value, replacements);
    return replacement ? replacement.replacement.path : value;
  }

  const replacement = findReplacementForObject(value, replacements) ?? active;
  const next: Record<string, unknown> = {};

  for (const [key, nested] of Object.entries(value)) {
    if (replacement && typeof nested === "string") {
      if (isPathLikeKey(key) && looksLikeVideoPath(nested)) {
        next[key] = replacement.replacement.path;
        continue;
      }
      if (isNameLikeKey(key)) {
        next[key] = replacement.replacement.name;
        continue;
      }
    }
    next[key] = replaceValues(nested, replacements, replacement);
  }

  return next;
}

function findReplacementForObject(
  value: Record<string, unknown>,
  replacements: DraftReplacement[]
): DraftReplacement | undefined {
  const id = stringValue(value.id);
  if (id) {
    const byMaterial = replacements.find((item) => item.slot.materialId === id);
    if (byMaterial) return byMaterial;
  }

  const materialId = stringValue(value.material_id) ?? stringValue(value.materialId);
  if (materialId) {
    const bySegment = replacements.find((item) => item.slot.materialId === materialId);
    if (bySegment) return bySegment;
  }

  return undefined;
}

function findReplacementForString(value: string, replacements: DraftReplacement[]): DraftReplacement | undefined {
  const normalized = normalizePath(value);
  return replacements.find((item) => item.slot.sourcePath && normalizePath(item.slot.sourcePath) === normalized);
}

async function findDraftContentPath(draftPath: string): Promise<string> {
  const candidate = path.join(draftPath, "draft_content.json");
  try {
    await fs.access(candidate);
    return candidate;
  } catch {
    const files = await findDraftJsonFiles(draftPath);
    const content = files.find((filePath) => path.basename(filePath) === "draft_content.json");
    if (!content) {
      throw new Error("没有找到剪映草稿的 draft_content.json");
    }
    return content;
  }
}

async function findDraftJsonFiles(draftPath: string): Promise<string[]> {
  const all = await walk(draftPath);
  const preferred = all.filter((filePath) => DRAFT_JSON_NAMES.includes(path.basename(filePath)));
  return preferred.length > 0 ? preferred : all.filter((filePath) => filePath.endsWith(".json"));
}

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(filePath)));
    } else if (entry.isFile()) {
      files.push(filePath);
    }
  }

  return files;
}

function isVideoTrack(track: Record<string, unknown>, materialById: Map<string, Record<string, unknown>>): boolean {
  const type = stringValue(track.type)?.toLowerCase();
  if (type?.includes("video")) return true;
  const segments = Array.isArray(track.segments) ? track.segments.filter(isRecord) : [];
  return segments.some((segment) => {
    const materialId = stringValue(segment.material_id) ?? stringValue(segment.materialId);
    const material = materialId ? materialById.get(materialId) : undefined;
    return Boolean(material && findFirstVideoPath(material));
  });
}

function scoreTrack(track: { track: Record<string, unknown>; segments: Record<string, unknown>[] }): number {
  const type = stringValue(track.track.type)?.toLowerCase() ?? "";
  const base = type.includes("video") ? 10_000 : 0;
  const totalDuration = track.segments.reduce((sum, segment) => sum + timerangeDuration(segment), 0);
  return base + track.segments.length * 100 + totalDuration / 1_000_000;
}

function timerangeStart(segment: Record<string, unknown>): number {
  const range = timerange(segment);
  return numberValue(range?.start) ?? numberValue(segment.start) ?? 0;
}

function timerangeDuration(segment: Record<string, unknown>): number {
  const range = timerange(segment);
  return numberValue(range?.duration) ?? numberValue(segment.duration) ?? 0;
}

function timerange(segment: Record<string, unknown>): Record<string, unknown> | undefined {
  const target = segment.target_timerange ?? segment.targetTimerange ?? segment.timerange;
  return isRecord(target) ? target : undefined;
}

function findFirstVideoPath(value: unknown): string | undefined {
  if (typeof value === "string") {
    return looksLikeVideoPath(value) ? value : undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstVideoPath(item);
      if (found) return found;
    }
    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === "string" && isPathLikeKey(key) && looksLikeVideoPath(nested)) {
      return nested;
    }
  }

  for (const nested of Object.values(value)) {
    const found = findFirstVideoPath(nested);
    if (found) return found;
  }

  return undefined;
}

function findName(value: Record<string, unknown>, fallbackPath?: string): string | undefined {
  const keys = ["name", "material_name", "materialName", "file_name", "fileName", "title"];
  for (const key of keys) {
    const name = stringValue(value[key]);
    if (name) return name;
  }
  return fallbackPath ? path.basename(fallbackPath) : undefined;
}

function indexToSlotName(index: number): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  if (index < letters.length) return letters[index];
  return `S${index + 1}`;
}

function looksLikeVideoPath(value: string): boolean {
  return VIDEO_EXTENSIONS.some((ext) => value.toLowerCase().includes(ext));
}

function isPathLikeKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.includes("path") || normalized.includes("file") || normalized.includes("local") || normalized.includes("material");
}

function isNameLikeKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized === "name" || normalized.includes("name") || normalized.includes("title");
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
