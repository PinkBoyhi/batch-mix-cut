import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CloudNameMode, CloudPublishMode, CloudPublishProfile, CloudPublishProfileInput, CloudVideoRotation } from "../../src/shared/types.js";

const FILE_NAME = "cloud-publish-profiles.json";
const MAX_PROFILES = 50;

export class CloudPublishProfileStore {
  constructor(private readonly getUserDataDir: () => string) {}

  async list(): Promise<CloudPublishProfile[]> {
    const profiles = await this.read();
    return profiles.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async save(input: CloudPublishProfileInput): Promise<CloudPublishProfile> {
    const name = input.name.trim();
    if (!name) {
      throw new Error("请填写配置名称");
    }
    const profiles = await this.read();
    const now = new Date().toISOString();
    const profile: CloudPublishProfile = {
      ...normalizeProfileInput(input),
      id: input.id && profiles.some((item) => item.id === input.id) ? input.id : crypto.randomUUID(),
      name,
      updatedAt: now
    };
    const next = [...profiles.filter((item) => item.id !== profile.id), profile]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_PROFILES);
    await this.write(next);
    return profile;
  }

  async delete(profileId: string): Promise<void> {
    const profiles = await this.read();
    const next = profiles.filter((item) => item.id !== profileId);
    if (next.length !== profiles.length) {
      await this.write(next);
    }
  }

  private async read(): Promise<CloudPublishProfile[]> {
    try {
      const raw = await fs.readFile(this.filePath(), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.flatMap((item) => normalizeStoredProfile(item));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      return [];
    }
  }

  private async write(profiles: CloudPublishProfile[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath()), { recursive: true });
    await fs.writeFile(this.filePath(), `${JSON.stringify(profiles, null, 2)}\n`, "utf8");
  }

  private filePath(): string {
    return path.join(this.getUserDataDir(), FILE_NAME);
  }
}

function normalizeStoredProfile(value: unknown): CloudPublishProfile[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as Partial<CloudPublishProfile>;
  if (typeof record.id !== "string" || typeof record.name !== "string" || typeof record.updatedAt !== "string") {
    return [];
  }
  return [{ ...normalizeProfileInput(record), id: record.id, name: record.name.trim(), updatedAt: record.updatedAt }];
}

function normalizeProfileInput(input: Partial<CloudPublishProfileInput>): Omit<CloudPublishProfileInput, "id" | "name"> & { name: string } {
  return {
    name: typeof input.name === "string" ? input.name.trim() : "",
    videoType: Number.isFinite(input.videoType) ? Number(input.videoType) : 0,
    oneLevelTypeId: stringValue(input.oneLevelTypeId),
    twoLevelTypeId: stringValue(input.twoLevelTypeId),
    labelIds: stringValue(input.labelIds),
    videoRight: Number.isFinite(input.videoRight) ? Number(input.videoRight) : 0,
    syncEnabled: input.syncEnabled !== false,
    rotation: isRotation(input.rotation) ? input.rotation : "none",
    publishMode: input.publishMode === "collection" ? "collection" : "single",
    nameMode: isNameMode(input.nameMode) ? input.nameMode : "file",
    customName: stringValue(input.customName),
    namePrefix: stringValue(input.namePrefix)
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRotation(value: unknown): value is CloudVideoRotation {
  return value === "none" || value === "clockwise90" || value === "counterClockwise90" || value === "rotate180";
}

function isNameMode(value: unknown): value is CloudNameMode {
  return value === "file" || value === "custom" || value === "prefix";
}
