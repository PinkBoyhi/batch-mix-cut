import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { parseUpdateMetadata, UpdateManager } from "./updateManager.js";

const metadata = `version: 0.1.67
files:
  - url: YiboBioMixCut-0.1.67-x64.exe
    sha512: trusted-hash
    size: 123
path: YiboBioMixCut-0.1.67-x64.exe
sha512: trusted-hash
`;

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  disableDifferentialDownload = false;
  requestHeaders: Record<string, string> | null = null;
  feed?: { provider: "generic"; url: string };
  installed = false;

  setFeedURL(options: { provider: "generic"; url: string }) { this.feed = options; }
  async checkForUpdates() {
    return { updateInfo: { version: "0.1.67", files: [{ url: "YiboBioMixCut-0.1.67-x64.exe", sha512: "trusted-hash" }] } };
  }
  async downloadUpdate() {
    this.emit("download-progress", { percent: 62.5 });
    return ["update.exe"];
  }
  quitAndInstall() { this.installed = true; }
}

describe("UpdateManager", () => {
  it("uses a matching intranet mirror, reports progress, and starts silent installation", async () => {
    const updater = new FakeUpdater();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("api.github.com")) {
        return jsonResponse({ tag_name: "v0.1.67", html_url: "https://github.com/release" });
      }
      return new Response(metadata, { status: 200 });
    });
    const fetchImpl = fetchMock as typeof fetch;
    const manager = new UpdateManager("0.1.66", {
      platform: "win32",
      isPackaged: true,
      updater,
      fetchImpl,
      scheduleInstall: (callback) => callback()
    });

    await expect(manager.check({ serverUrl: "http://10.0.0.133:8787", token: "secret" })).resolves.toMatchObject({
      status: "available",
      canAutoUpdate: true,
      message: expect.stringContaining("内网")
    });
    const result = await manager.downloadAndInstall({ serverUrl: "http://10.0.0.133:8787", token: "secret" });

    const metadataRequests = fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.endsWith("/latest.yml"));
    expect(metadataRequests).toEqual([
      "http://10.0.0.133:8787/api/updates/windows/latest.yml",
      "http://10.0.0.133:8787/api/updates/windows/latest.yml"
    ]);
    expect(updater.feed?.url).toBe("http://10.0.0.133:8787/api/updates/windows");
    expect(updater.requestHeaders).toEqual({ "x-mix-token": "secret" });
    expect(updater.installed).toBe(true);
    expect(result).toMatchObject({ status: "installing", progressPercent: 100, downloadSource: "intranet" });
  });

  it("falls back to GitHub when mirror metadata does not match", async () => {
    const updater = new FakeUpdater();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("api.github.com")) return jsonResponse({ tag_name: "v0.1.67" });
      if (url.startsWith("http://10.0.0.133")) return new Response(metadata.replaceAll("trusted-hash", "other-hash"), { status: 200 });
      return new Response(metadata, { status: 200 });
    }) as typeof fetch;
    const manager = new UpdateManager("0.1.66", {
      platform: "win32",
      isPackaged: true,
      updater,
      fetchImpl,
      scheduleInstall: (callback) => callback()
    });

    await manager.check();
    await manager.downloadAndInstall({ serverUrl: "http://10.0.0.133:8787", token: "secret" });

    expect(updater.feed?.url).toBe("https://github.com/PinkBoyhi/batch-mix-cut/releases/latest/download");
    expect(updater.requestHeaders).toBeNull();
  });

  it("checks the intranet source without a Token when GitHub is unreachable", async () => {
    const updater = new FakeUpdater();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("http://10.0.0.133")) return new Response(metadata, { status: 200 });
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const manager = new UpdateManager("0.1.66", {
      platform: "win32",
      isPackaged: true,
      updater,
      fetchImpl
    });

    await expect(manager.check({ serverUrl: "http://10.0.0.133:8787", token: "" })).resolves.toMatchObject({
      status: "available",
      availableVersion: "0.1.67"
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://10.0.0.133:8787/api/updates/windows/latest.yml",
      expect.objectContaining({ headers: expect.not.objectContaining({ "x-mix-token": expect.anything() }) })
    );
  });

  it("reports both sources when neither update source is reachable", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    const manager = new UpdateManager("0.1.66", { fetchImpl });

    await expect(manager.check({ serverUrl: "http://10.0.0.133:8787", token: "" })).rejects.toThrow(
      /内网更新源连接失败.*GitHub 更新源连接失败/
    );
  });

  it("rejects malformed update metadata", () => {
    expect(() => parseUpdateMetadata("version: 0.1.67\npath: unexpected.exe\nsha512: x")).toThrow("格式无效");
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}
