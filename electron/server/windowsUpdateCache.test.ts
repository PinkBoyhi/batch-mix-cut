import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowsUpdateCache } from "./windowsUpdateCache.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("WindowsUpdateCache", () => {
  it("caches and verifies the Windows installer fetched from GitHub", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "windows-update-cache-"));
    temporaryDirectories.push(dir);
    const installer = Buffer.from("verified-installer");
    const sha512 = createHash("sha512").update(installer).digest("base64");
    const yml = updateYml(sha512, installer.length);
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith("latest.yml")
        ? new Response(yml, { status: 200 })
        : new Response(installer, { status: 200 })
    ) as typeof fetch;
    const cache = new WindowsUpdateCache(dir, "https://updates.example.com", fetchImpl);

    const metadataPath = await cache.resolve("latest.yml");
    const installerPath = await cache.resolve("YiboBioMixCut-0.1.67-x64.exe");

    expect(await fs.readFile(metadataPath, "utf8")).toBe(yml);
    expect(await fs.readFile(installerPath)).toEqual(installer);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(cache.resolve("other.exe")).rejects.toThrow("不存在");
  });

  it("serves cached metadata immediately while refreshing it in the background", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "windows-update-cache-"));
    temporaryDirectories.push(dir);
    const installer = Buffer.from("cached-installer");
    const sha512 = createHash("sha512").update(installer).digest("base64");
    const yml = updateYml(sha512, installer.length);
    await fs.writeFile(path.join(dir, "latest.yml"), yml);
    await fs.writeFile(path.join(dir, "YiboBioMixCut-0.1.67-x64.exe"), installer);
    let releaseFetch: (() => void) | undefined;
    const waitingFetch = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const fetchImpl = vi.fn(async () => {
      await waitingFetch;
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const cache = new WindowsUpdateCache(dir, "https://updates.example.com", fetchImpl);

    const metadataPath = await cache.resolve("latest.yml");
    expect(await fs.readFile(metadataPath, "utf8")).toBe(yml);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    releaseFetch?.();
  });
});

function updateYml(sha512: string, size: number): string {
  return `version: 0.1.67
files:
  - url: YiboBioMixCut-0.1.67-x64.exe
    sha512: ${sha512}
    size: ${size}
path: YiboBioMixCut-0.1.67-x64.exe
sha512: ${sha512}
`;
}
