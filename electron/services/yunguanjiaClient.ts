import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import type {
  CloudAccount,
  CloudImportJob,
  CloudImportResult,
  CloudImportVideo,
  CloudLocalUploadJob,
  CloudLocalUploadVideo,
  CloudVideoRotation,
  CloudPage,
  CloudSettings,
  CloudSettingsView,
  CloudVideo,
  CloudVideoLabel,
  CloudVideoListQuery,
  CloudVideoType
} from "../../src/shared/types.js";
import { describeMissingBinary, getFfmpegPath } from "./ffmpegBinaries.js";

const CONFIG_FILE = "yunguanjia-cloud.json";
const TOKEN_REFRESH_SKEW_MS = 10 * 60 * 1000;
const DEFAULT_OPEN_API_BASE_URL = decodeDefault([104, 116, 116, 112, 115, 58, 47, 47, 115, 117, 99, 97, 105, 119, 97, 110, 103, 45, 111, 112, 101, 110, 45, 97, 112, 105, 46, 115, 117, 99, 97, 105, 99, 108, 111, 117, 100, 46, 99, 111, 109]);
const DEFAULT_COMPANY_KEY = decodeDefault([102, 49, 51, 98, 56, 50, 97, 53, 102, 101, 50, 98, 53, 53, 53, 102, 57, 56, 57, 101, 97, 57, 54, 50, 50, 48, 49, 49, 55, 49, 55, 57]);
const DEFAULT_COMPANY_SECRET = decodeDefault([71, 79, 67, 115, 100, 103, 99, 52, 66, 48, 97, 54, 97, 79, 84, 108, 49, 97, 89, 66, 86, 107, 83, 119, 56, 73, 90, 106, 105, 100, 76, 75, 99, 55, 76, 104, 53, 49, 107, 111]);
const DEFAULT_UPLOAD_BASE_URL = decodeDefault([104, 116, 116, 112, 115, 58, 47, 47, 115, 117, 99, 97, 105, 119, 97, 110, 103, 45, 97, 112, 105, 45, 116, 120, 46, 115, 117, 99, 97, 105, 99, 108, 111, 117, 100, 46, 99, 111, 109]);
const TX_UPLOAD_API_BASE_URL = DEFAULT_UPLOAD_BASE_URL;
const WEB_SIGN_SECRET_INDEXES = [2, 4, 5, 7, 11, 14, 15, 18, 22, 23, 26, 28, 31, 33, 35, 36];

function decodeDefault(codes: number[]): string {
  return String.fromCharCode(...codes);
}

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
      baseUrl: normalizeBaseUrl(settings.baseUrl || current.baseUrl || DEFAULT_OPEN_API_BASE_URL),
      companyKey: settings.companyKey.trim() || current.companyKey || DEFAULT_COMPANY_KEY,
      companySecret: settings.companySecret?.trim() || current.companySecret || DEFAULT_COMPANY_SECRET,
      accountKey: settings.accountKey.trim(),
      accountName: settings.accountName?.trim(),
      accountLogin: settings.accountLogin?.trim(),
      uploadBaseUrl: normalizeUploadBaseUrl(settings.uploadBaseUrl || current.uploadBaseUrl),
      uploadToken: settings.uploadToken?.trim() || current.uploadToken || ""
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

  async verifyPhone(phoneInput: string): Promise<CloudSettingsView> {
    const phone = normalizePhone(phoneInput);
    const settings = await this.ensureReadySettings(false);
    const matchedAccount = await this.findOpenApiAccountByPhone(phone);
    if (!matchedAccount) {
      throw new Error("没有匹配到该手机号对应的云管家账号，请确认手机号是否在当前 companyKey 下。");
    }
    const next: StoredCloudSettings = {
      ...settings,
      accountKey: matchedAccount.accountKey,
      accountName: matchedAccount.name || phone,
      accountLogin: matchedAccount.account || phone
    };
    await this.writeSettings(next);
    return toSettingsView(next);
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
      if (!video.labelIds.trim()) {
        throw new Error(`第 ${index + 1} 个视频缺少标签 ID`);
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

  async uploadLocalVideos(videos: CloudLocalUploadVideo[]): Promise<CloudLocalUploadJob> {
    if (videos.length === 0) {
      throw new Error("没有待上传的本地成片");
    }
    if (videos.length > 50) {
      throw new Error("云管家一次最多导入 50 个视频");
    }

    const settings = await this.ensureReadySettings(true);
    if (!settings.uploadToken?.trim()) {
      throw new Error("本地成片直传需要云管家上传授权。当前 OpenAPI accessToken 只能导入公网 URL，不能上传本地 mp4。");
    }

    const uploaded: CloudLocalUploadJob["uploaded"] = [];
    for (const [index, video] of videos.entries()) {
      if (!video.localPath.trim()) {
        throw new Error(`第 ${index + 1} 个视频缺少本地文件路径`);
      }
      if (!video.videoName.trim()) {
        throw new Error(`第 ${index + 1} 个视频缺少视频名称`);
      }
      if (!Number.isFinite(video.twoLevelTypeId) || video.twoLevelTypeId <= 0) {
        throw new Error(`第 ${index + 1} 个视频缺少二级分类 ID`);
      }
      if (!video.labelIds.trim()) {
        throw new Error(`第 ${index + 1} 个视频缺少标签 ID`);
      }
      const uploadPath = await this.prepareUploadFile(video);
      try {
        const url = await this.uploadLocalFileByWebApi(settings, uploadPath);
        uploaded.push({
          localPath: video.localPath,
          videoName: video.videoName,
          url
        });
      } finally {
        if (uploadPath !== video.localPath) {
          await fs.unlink(uploadPath).catch(() => undefined);
        }
      }
    }

    const importJob = await this.importVideos(
      videos.map((video, index) => ({
        localPath: video.localPath,
        videoName: video.videoName,
        videoType: video.videoType,
        twoLevelTypeId: video.twoLevelTypeId,
        labelIds: video.labelIds,
        videoRight: video.videoRight,
        url: uploaded[index]?.url ?? ""
      }))
    );

    return { uploaded, importJob };
  }

  private async prepareUploadFile(video: CloudLocalUploadVideo): Promise<string> {
    const rotation = video.rotation ?? "none";
    if (rotation === "none") {
      return video.localPath;
    }
    const filter = rotationFilter(rotation);
    if (!filter) {
      return video.localPath;
    }
    const tempDir = path.join(this.getUserDataDir(), "cloud-upload-temp");
    await fs.mkdir(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${path.basename(video.localPath)}`);
    await runFfmpegRotate(video.localPath, tempPath, filter);
    return tempPath;
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

  private async uploadLocalFileByWebApi(settings: StoredCloudSettings, localPath: string): Promise<string> {
    const stat = await fs.stat(localPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw new Error(`本地视频不存在：${localPath}`);
      }
      throw error;
    });
    if (!stat.isFile()) {
      throw new Error(`不是可上传的视频文件：${localPath}`);
    }

    const fileSuffix = path.extname(localPath).replace(/^\./, "") || "mp4";
    const configuredBaseUrl = normalizeUploadBaseUrl(settings.uploadBaseUrl);
    const resolvedBaseUrl = await this.resolveWebUploadBaseUrl(settings, configuredBaseUrl);
    const uploadBaseUrls = [...new Set([resolvedBaseUrl, configuredBaseUrl, DEFAULT_UPLOAD_BASE_URL])];
    let lastError: unknown;

    for (const candidateBaseUrl of uploadBaseUrls) {
      const url = `${candidateBaseUrl}/api/minio/upload`;
      try {
        const response = await postMultipartFile(url, createWebApiHeaders(settings.uploadToken ?? ""), {
          fileSuffix
        }, localPath, stat.size);
        const payload = parseUploadResponse(response, url);
        if (!payload.success || (typeof payload.code === "number" && payload.code !== 1)) {
          throw new Error(payload.info || "云管家本地文件上传失败");
        }
        const uploadedUrl = extractUploadedUrl(payload.data, candidateBaseUrl);
        if (!uploadedUrl) {
          throw new Error("云管家上传成功但没有返回可导入的视频 URL");
        }
        return uploadedUrl;
      } catch (error) {
        lastError = error;
        const canFallback = candidateBaseUrl !== DEFAULT_UPLOAD_BASE_URL && String((error as Error).message ?? error).includes("404");
        if (!canFallback) {
          throw error;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error("云管家本地文件上传失败");
  }

  private async resolveWebUploadBaseUrl(settings: StoredCloudSettings, configuredBaseUrl: string): Promise<string> {
    const candidateApiBaseUrls = [...new Set([configuredBaseUrl, TX_UPLOAD_API_BASE_URL, DEFAULT_UPLOAD_BASE_URL].filter(Boolean))];
    let lastError: unknown;

    for (const apiBaseUrl of candidateApiBaseUrls) {
      const url = `${apiBaseUrl}/api/company/get-sts-url`;
      try {
        const uploadBaseUrl = await postWebApi<string>(url, settings.uploadToken ?? "", {});
        const normalized = typeof uploadBaseUrl === "string" ? normalizeBaseUrl(uploadBaseUrl) : "";
        if (normalized) {
          return normalized;
        }
        lastError = new Error("云管家没有返回真实上传域名");
      } catch (error) {
        lastError = error;
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError ?? "");
    if (message.includes("登录状态已失效") || message.includes("网页上传 Token 已失效")) {
      throw new Error("上传授权已失效，请重新点击“自动获取上传授权”后再发布。");
    }
    throw lastError instanceof Error ? lastError : new Error("云管家没有返回真实上传域名，请重新获取上传授权后再试。");
  }

  private async request<T>(
    endpoint: string,
    body: Record<string, unknown>,
    options: { retried?: boolean; requireAccountKey?: boolean } = {}
  ): Promise<T> {
    const settings = await this.ensureReadySettings(options.requireAccountKey ?? true);
    const accessToken = await this.getAccessToken(settings);
    const headers = this.createHeaders(settings, accessToken, body, options.requireAccountKey ?? true);
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

  private async findOpenApiAccountByPhone(phone: string): Promise<CloudAccount | undefined> {
    let pageNo = 1;
    do {
      const page = await this.listAccounts(pageNo, 100);
      const matched = page.list.find((account) => account.account === phone);
      if (matched) {
        return matched;
      }
      if (pageNo >= page.totalPage) {
        return undefined;
      }
      pageNo += 1;
    } while (pageNo <= 100);
    return undefined;
  }

  private createHeaders(
    settings: StoredCloudSettings,
    accessToken: string | undefined,
    body: Record<string, unknown>,
    includeAccountKey = false
  ): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(8).toString("hex");
    const headers: Record<string, string | number> = {
      company_key: settings.companyKey,
      timestamp,
      nonce
    };
    if (accessToken) {
      headers.access_token = accessToken;
    }
    if (accessToken && includeAccountKey) {
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
        baseUrl: normalizeBaseUrl(parsed.baseUrl || DEFAULT_OPEN_API_BASE_URL),
        companyKey: parsed.companyKey || DEFAULT_COMPANY_KEY,
        companySecret: parsed.companySecret || DEFAULT_COMPANY_SECRET,
        accountKey: parsed.accountKey ?? "",
        accountName: parsed.accountName,
        accountLogin: parsed.accountLogin,
        uploadBaseUrl: normalizeUploadBaseUrl(parsed.uploadBaseUrl),
        uploadToken: parsed.uploadToken ?? "",
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

function normalizeUploadBaseUrl(baseUrl: string | undefined): string {
  const normalized = normalizeBaseUrl(baseUrl || DEFAULT_UPLOAD_BASE_URL);
  if (!normalized) {
    return DEFAULT_UPLOAD_BASE_URL;
  }
  return normalized;
}

function normalizePhone(phone: string): string {
  const normalizedPhone = phone.trim();
  if (!/^1[3-9]\d{9}$/.test(normalizedPhone)) {
    throw new Error("请输入正确的 11 位手机号");
  }
  return normalizedPhone;
}

function toSettingsView(settings: StoredCloudSettings): CloudSettingsView {
  return {
    baseUrl: "",
    companyKey: "",
    hasCompanySecret: Boolean(settings.companySecret),
    accountKey: settings.accountKey,
    accountName: settings.accountName,
    accountLogin: settings.accountLogin,
    uploadBaseUrl: "",
    hasUploadToken: Boolean(settings.uploadToken)
  };
}

function emptySettings(): StoredCloudSettings {
  return {
    baseUrl: DEFAULT_OPEN_API_BASE_URL,
    companyKey: DEFAULT_COMPANY_KEY,
    companySecret: DEFAULT_COMPANY_SECRET,
    accountKey: "",
    accountName: "",
    accountLogin: "",
    uploadBaseUrl: DEFAULT_UPLOAD_BASE_URL,
    uploadToken: ""
  };
}

function parseUploadResponse(response: { status: number; text: string }, url: string): CloudResponse<Record<string, unknown>> {
  let payload: CloudResponse<Record<string, unknown>>;
  try {
    payload = JSON.parse(response.text) as CloudResponse<Record<string, unknown>>;
  } catch {
    const preview = response.text.trim().slice(0, 80);
    throw new Error(`云管家上传接口返回了非 JSON 响应：HTTP ${response.status}，请求：${url}${preview ? `，响应：${preview}` : ""}`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(payload.info || `云管家上传 HTTP 请求失败：${response.status}，请求：${url}`);
  }
  return payload;
}

function extractUploadedUrl(data: Record<string, unknown> | undefined, uploadBaseUrl: string): string | undefined {
  if (!data) return undefined;
  const directUrl = firstString(data, ["publicUrl", "url", "videoUrl", "fileUrl", "Location", "location"]);
  if (directUrl) return directUrl;
  const fileName = firstString(data, ["fileName", "name"]);
  return fileName ? `${uploadBaseUrl}/sucaiwang/${encodeURI(fileName)}` : undefined;
}

function firstString(data: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function rotationFilter(rotation: CloudVideoRotation): string | undefined {
  switch (rotation) {
    case "clockwise90":
      return "transpose=1";
    case "counterClockwise90":
      return "transpose=2";
    case "rotate180":
      return "hflip,vflip";
    default:
      return undefined;
  }
}

async function runFfmpegRotate(inputPath: string, outputPath: string, filter: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(getFfmpegPath(), [
      "-y",
      "-i",
      inputPath,
      "-vf",
      filter,
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "20",
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      outputPath
    ]);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 12000) {
        stderr = stderr.slice(-12000);
      }
    });
    child.on("error", (error) => reject(describeMissingBinary("ffmpeg", error)));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `FFmpeg 旋转处理失败：${code}`));
    });
  });
}

async function postMultipartFile(
  urlString: string,
  requestHeaders: Record<string, string>,
  fields: Record<string, string>,
  filePath: string,
  fileSize: number
): Promise<{ status: number; text: string }> {
  const url = new URL(urlString);
  const boundary = `----batch-mix-${crypto.randomBytes(12).toString("hex")}`;
  const fileName = path.basename(filePath).replace(/"/g, "%22");
  const fieldBuffers = Object.entries(fields).map(([key, value]) =>
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`)
  );
  const fileHeader = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: video/mp4\r\n\r\n`
  );
  const trailer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const contentLength = fieldBuffers.reduce((sum, buffer) => sum + buffer.length, 0) + fileHeader.length + fileSize + trailer.length;

  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(contentLength),
          ...requestHeaders
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );
    request.on("error", reject);
    for (const buffer of fieldBuffers) {
      request.write(buffer);
    }
    request.write(fileHeader);
    const stream = createReadStream(filePath);
    stream.on("error", (error) => request.destroy(error));
    stream.on("end", () => request.end(trailer));
    stream.pipe(request, { end: false });
  });
}

async function postWebApi<T>(url: string, token: string, body: Record<string, string | number | boolean>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...createWebApiHeaders(token)
    },
    body: encodeFormBody(body)
  });
  const payload = await parseWebResponse<T>(response, url);
  if (payload.code === 0 && ["系统检测到您的网络环境变更，请重新登录", "登录状态已失效，请重新登录"].includes(payload.info)) {
    throw new Error("上传授权已失效，请重新点击“自动获取上传授权”后再发布。");
  }
  if (payload.code !== 1 && !payload.success) {
    throw new Error(payload.info || "云管家网页接口请求失败");
  }
  return payload.data as T;
}

function createWebApiHeaders(token: string): Record<string, string> {
  const requestId = crypto.randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const tokenSecret = token.split(".")[1] ?? "";
  const signSecret = WEB_SIGN_SECRET_INDEXES.map((index) => tokenSecret.charAt(index)).join("");
  const signSource = `requestId=${requestId}&timestamp=${timestamp}&${signSecret}`;
  return {
    token,
    isInner: "0",
    "Access-Control-Allow-Private-Network": "true",
    "api-version": "2.0.0",
    requestId,
    timestamp,
    sign: crypto.createHash("md5").update(signSource).digest("hex")
  };
}

function encodeFormBody(body: Record<string, string | number | boolean>): string {
  return Object.entries(body)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

async function parseWebResponse<T>(response: Response, url: string): Promise<CloudResponse<T>> {
  const text = await response.text();
  let payload: CloudResponse<T>;
  try {
    payload = JSON.parse(text) as CloudResponse<T>;
  } catch {
    const preview = text.trim().slice(0, 80);
    throw new Error(`云管家网页接口返回了非 JSON 响应：HTTP ${response.status}，请求：${url}${preview ? `，响应：${preview}` : ""}`);
  }
  if (!response.ok) {
    throw new Error(payload.info || `云管家网页 HTTP 请求失败：${response.status}，请求：${url}`);
  }
  return payload;
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
