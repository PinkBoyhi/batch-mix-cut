import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  CloudAccount,
  CloudImportJob,
  CloudImportResult,
  CloudImportVideo,
  CloudPage,
  CloudSettings,
  CloudSettingsView,
  CloudVideo,
  CloudVideoLabel,
  CloudVideoListQuery,
  CloudVideoType
} from "../../src/shared/types.js";

const CONFIG_FILE = "yunguanjia-cloud.json";
const TOKEN_REFRESH_SKEW_MS = 10 * 60 * 1000;

interface StoredCloudSettings extends CloudSettings {
  accessToken?: string;
  accessTokenExpiresAt?: number;
}

interface CloudResponse<T> {
  code: number;
  data?: T;
  info: string;
  requestId?: string;
  success: boolean;
}

export class YunguanjiaClient {
  constructor(private readonly getUserDataDir: () => string) {}

  async getSettingsView(): Promise<CloudSettingsView> {
    return toSettingsView(await this.readSettings());
  }

  async saveSettings(settings: CloudSettings): Promise<CloudSettingsView> {
    const current = await this.readSettings();
    const next: StoredCloudSettings = {
      baseUrl: normalizeBaseUrl(settings.baseUrl),
      companyKey: settings.companyKey.trim(),
      companySecret: settings.companySecret?.trim() || current.companySecret || "",
      accountKey: settings.accountKey.trim()
    };
    await this.writeSettings(next);
    return toSettingsView(next);
  }

  async testConnection(): Promise<{ ok: true }> {
    const settings = await this.ensureReadySettings(false);
    await this.writeSettings({ ...settings, accessToken: undefined, accessTokenExpiresAt: undefined });
    await this.getAccessToken({ ...settings, accessToken: undefined, accessTokenExpiresAt: undefined });
    return { ok: true };
  }

  async listAccounts(pageNo = 1, pageSize = 100): Promise<CloudPage<CloudAccount>> {
    return this.request<CloudPage<CloudAccount>>("/openapi/account/list", { pageNo, pageSize }, { requireAccountKey: false });
  }

  async listVideos(query: CloudVideoListQuery): Promise<CloudPage<CloudVideo>> {
    return this.request<CloudPage<CloudVideo>>("/openapi/video/list", { ...query });
  }

  async listVideoTypes(videoType?: number): Promise<CloudVideoType[]> {
    return this.request<CloudVideoType[]>("/openapi/video/type/list", videoType === undefined ? {} : { videoType });
  }

  async listVideoLabels(query: { oneLevelTypeId?: number; twoLevelTypeIds?: string; videoType?: number } = {}): Promise<CloudVideoLabel[]> {
    return this.request<CloudVideoLabel[]>("/openapi/video/label/list", query);
  }

  async getRawUrl(videoId: number, isInner: 0 | 1): Promise<string> {
    const data = await this.request<{ rawUrl?: string }>("/openapi/video/query/raw", { videoId, isInner });
    if (!data.rawUrl) {
      throw new Error("云管家没有返回原片地址");
    }
    return data.rawUrl;
  }

  async importVideos(videos: CloudImportVideo[]): Promise<CloudImportJob> {
    if (videos.length === 0) {
      throw new Error("请选择要导入云管家的视频");
    }
    if (videos.length > 50) {
      throw new Error("云管家一次最多导入 50 个视频");
    }
    for (const [index, video] of videos.entries()) {
      if (!video.url.trim()) {
        throw new Error(`第 ${index + 1} 个视频缺少公网 URL`);
      }
      if (!video.videoName.trim()) {
        throw new Error(`第 ${index + 1} 个视频缺少视频名称`);
      }
      if (!Number.isFinite(video.twoLevelTypeId) || video.twoLevelTypeId <= 0) {
        throw new Error(`第 ${index + 1} 个视频缺少二级分类 ID`);
      }
    }

    const payload = videos.map((video) => ({
      videoName: video.videoName.trim(),
      videoType: video.videoType,
      twoLevelTypeId: video.twoLevelTypeId,
      labelIds: video.labelIds.trim(),
      videoRight: video.videoRight,
      url: video.url.trim(),
      thirdId: video.thirdId?.trim() || undefined
    }));
    const data = await this.request<{ errorList?: CloudImportJob["errorList"]; requestId?: string }>("/openapi/video/import", {
      videoJSON: JSON.stringify(payload)
    });

    if (!data.requestId) {
      throw new Error("云管家没有返回导入 requestId");
    }

    return {
      requestId: data.requestId,
      errorList: data.errorList ?? []
    };
  }

  async queryImportResult(requestId: string, pageNo = 1, pageSize = 20): Promise<CloudPage<CloudImportResult>> {
    if (!requestId.trim()) {
      throw new Error("缺少导入 requestId");
    }
    return this.request<CloudPage<CloudImportResult>>("/openapi/video/import/query", {
      requestId: requestId.trim(),
      pageNo,
      pageSize
    });
  }

  private async request<T>(
    endpoint: string,
    body: Record<string, unknown>,
    options: { retried?: boolean; requireAccountKey?: boolean } = {}
  ): Promise<T> {
    const settings = await this.ensureReadySettings(options.requireAccountKey ?? true);
    const accessToken = await this.getAccessToken(settings);
    const headers = this.createHeaders(settings, accessToken, body);
    const url = `${settings.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers
      },
      body: JSON.stringify(body)
    });
    const payload = await parseCloudResponse<T>(response, url);

    if (payload.code === 20013 || payload.code === 20014) {
      if (options.retried) {
        throw new Error(payload.info || "云管家 access_token 无效");
      }
      await this.writeSettings({ ...settings, accessToken: undefined, accessTokenExpiresAt: undefined });
      return this.request<T>(endpoint, body, { ...options, retried: true });
    }

    if (!payload.success || payload.code !== 1) {
      throw new Error(payload.info || `云管家接口调用失败：${payload.code}`);
    }

    return (payload.data ?? {}) as T;
  }

  private async getAccessToken(settings: StoredCloudSettings): Promise<string> {
    if (settings.accessToken && settings.accessTokenExpiresAt && settings.accessTokenExpiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS) {
      return settings.accessToken;
    }

    const authHeaders = this.createHeaders(settings, undefined, {});
    const url = `${settings.baseUrl}/openapi/auth/access_token`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders
      },
      body: JSON.stringify({})
    });
    const payload = await parseCloudResponse<{ accessToken?: string }>(response, url);
    if (!payload.success || payload.code !== 1 || !payload.data?.accessToken) {
      throw new Error(payload.info || "获取云管家 access_token 失败");
    }

    const next: StoredCloudSettings = {
      ...settings,
      accessToken: payload.data.accessToken,
      accessTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000
    };
    await this.writeSettings(next);
    return payload.data.accessToken;
  }

  private createHeaders(settings: StoredCloudSettings, accessToken: string | undefined, body: Record<string, unknown>): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(8).toString("hex");
    const headers: Record<string, string | number> = {
      company_key: settings.companyKey,
      timestamp,
      nonce
    };
    if (accessToken) {
      headers.access_token = accessToken;
      headers.account_key = settings.accountKey;
    }
    const sign = createYunguanjiaSign({ ...headers, ...body }, settings.companySecret ?? "");
    return Object.fromEntries(Object.entries({ ...headers, sign }).map(([key, value]) => [key, String(value)]));
  }

  private async ensureReadySettings(requireAccountKey: boolean): Promise<StoredCloudSettings> {
    const settings = await this.readSettings();
    if (!settings.baseUrl) {
      throw new Error("请先填写云管家请求域名");
    }
    if (!settings.companyKey || !settings.companySecret) {
      throw new Error("请先填写云管家 companyKey 和 companySecret");
    }
    if (requireAccountKey && !settings.accountKey) {
      throw new Error("请先选择或填写云管家 accountKey");
    }
    return settings;
  }

  private async readSettings(): Promise<StoredCloudSettings> {
    try {
      const raw = await fs.readFile(this.configPath(), "utf8");
      const parsed = JSON.parse(raw) as StoredCloudSettings;
      return {
        baseUrl: normalizeBaseUrl(parsed.baseUrl ?? ""),
        companyKey: parsed.companyKey ?? "",
        companySecret: parsed.companySecret ?? "",
        accountKey: parsed.accountKey ?? "",
        accessToken: parsed.accessToken,
        accessTokenExpiresAt: parsed.accessTokenExpiresAt
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptySettings();
      }
      throw error;
    }
  }

  private async writeSettings(settings: StoredCloudSettings): Promise<void> {
    const filePath = this.configPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }

  private configPath(): string {
    return path.join(this.getUserDataDir(), CONFIG_FILE);
  }
}

export function createYunguanjiaSign(params: Record<string, unknown>, companySecret: string): string {
  const pairs = Object.entries(params)
    .filter(([key, value]) => key !== "sign" && value !== undefined && value !== null)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`);
  pairs.push(`company_secret=${encodeURIComponent(companySecret)}`);
  return crypto.createHash("md5").update(pairs.join("&")).digest("hex").toUpperCase();
}

function normalizeBaseUrl(baseUrl: string): string {
  const value = baseUrl.trim();
  if (!value) {
    return "";
  }
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    const openapiIndex = url.pathname.indexOf("/openapi");
    if (openapiIndex >= 0) {
      url.pathname = url.pathname.slice(0, openapiIndex) || "/";
    }
    return `${url.origin}${url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return value.split("#")[0].split("?")[0].replace(/\/+$/, "");
  }
}

function toSettingsView(settings: StoredCloudSettings): CloudSettingsView {
  return {
    baseUrl: settings.baseUrl,
    companyKey: settings.companyKey,
    hasCompanySecret: Boolean(settings.companySecret),
    accountKey: settings.accountKey
  };
}

function emptySettings(): StoredCloudSettings {
  return {
    baseUrl: "",
    companyKey: "",
    companySecret: "",
    accountKey: ""
  };
}

async function parseCloudResponse<T>(response: Response, url: string): Promise<CloudResponse<T>> {
  const text = await response.text();
  let payload: CloudResponse<T>;
  try {
    payload = JSON.parse(text) as CloudResponse<T>;
  } catch {
    const preview = text.trim().slice(0, 80);
    throw new Error(`云管家返回了非 JSON 响应：HTTP ${response.status}，请确认请求域名是否为 API 域名。请求：${url}${preview ? `，响应：${preview}` : ""}`);
  }
  if (!response.ok) {
    throw new Error(payload.info || `云管家 HTTP 请求失败：${response.status}，请求：${url}`);
  }
  return payload;
}
