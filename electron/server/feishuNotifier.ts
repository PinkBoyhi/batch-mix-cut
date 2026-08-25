import crypto from "node:crypto";
import type { WorkflowRecord } from "../../src/shared/types.js";

export interface FeishuNotifierOptions {
  webhook?: string;
  secret?: string;
  appId?: string;
  appSecret?: string;
  chatId?: string;
  dashboardUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface FeishuNotifyResult {
  status: "sent" | "failed" | "disabled";
  error?: string;
}

export class FeishuNotifier {
  private readonly webhook: string;
  private readonly secret: string;
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly chatId: string;
  private readonly dashboardUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FeishuNotifierOptions = {}) {
    this.webhook = options.webhook?.trim() ?? "";
    this.secret = options.secret?.trim() ?? "";
    this.appId = options.appId?.trim() ?? "";
    this.appSecret = options.appSecret?.trim() ?? "";
    this.chatId = options.chatId?.trim() ?? "";
    this.dashboardUrl = options.dashboardUrl?.trim().replace(/\/+$/, "") ?? "";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  isEnabled(): boolean {
    return Boolean(this.webhook || (this.appId && this.appSecret && this.chatId));
  }

  async notify(record: WorkflowRecord): Promise<FeishuNotifyResult> {
    if (!this.isEnabled()) return { status: "disabled" };
    let lastError = "飞书机器人通知失败";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (this.webhook) await this.sendWebhook(record);
        else await this.sendAsApp(record);
        return { status: "sent" };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < 2) await delay(500 * 2 ** attempt);
      }
    }
    return { status: "failed", error: lastError };
  }

  private async sendWebhook(record: WorkflowRecord): Promise<void> {
    const response = await this.fetchImpl(this.webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildFeishuPayload(record, this.secret, this.dashboardUrl)),
      signal: AbortSignal.timeout(10_000)
    });
    await assertFeishuResponse(response);
  }

  private async sendAsApp(record: WorkflowRecord): Promise<void> {
    const tokenResponse = await this.fetchImpl("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
      signal: AbortSignal.timeout(10_000)
    });
    const tokenPayload = await parseFeishuResponse<{ tenant_access_token?: string }>(tokenResponse);
    if (!tokenPayload.tenant_access_token) throw new Error("飞书未返回 tenant_access_token");

    const messageResponse = await this.fetchImpl("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenPayload.tenant_access_token}`
      },
      body: JSON.stringify({
        receive_id: this.chatId,
        msg_type: "interactive",
        content: JSON.stringify(buildFeishuCard(record, this.dashboardUrl))
      }),
      signal: AbortSignal.timeout(10_000)
    });
    await assertFeishuResponse(messageResponse);
  }
}

export function buildFeishuPayload(record: WorkflowRecord, secret = "", dashboardUrl = ""): Record<string, unknown> {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    msg_type: "interactive",
    card: buildFeishuCard(record, dashboardUrl)
  };
  if (secret) {
    payload.timestamp = String(timestamp);
    payload.sign = createFeishuSignature(timestamp, secret);
  }
  return payload;
}

export function buildFeishuCard(record: WorkflowRecord, dashboardUrl = ""): Record<string, unknown> {
  const duration = formatDuration(Date.parse(record.finishedAt ?? record.updatedAt) - Date.parse(record.startedAt));
  const resultText = resultLabel(record);
  const color = record.status === "success" ? "green" : record.status === "partial" || record.status === "attention" ? "orange" : "red";
  const fields = [
    `**任务：** ${escapeText(record.displayName)}`,
    `**上传人：** ${escapeText(formatUploader(record))}`,
    `**云管家结果：** ${resultText}`,
    `**视频：** 成功 ${record.succeededVideos} / 失败 ${record.failedVideos} / 共 ${record.totalVideos}`,
    `**耗时：** ${duration}`
  ];
  if (record.error) fields.push(`**说明：** ${escapeText(record.error)}`);
  if (dashboardUrl) fields.push(`[打开进度看板](${dashboardUrl}/dashboard)`);
  return {
    config: { wide_screen_mode: true },
    header: { template: color, title: { tag: "plain_text", content: `云管家上传${resultText}` } },
    elements: [{ tag: "div", text: { tag: "lark_md", content: fields.join("\n") } }]
  };
}

function formatUploader(record: WorkflowRecord): string {
  if (record.uploaderName && record.uploaderLogin && record.uploaderName !== record.uploaderLogin) {
    return `${record.uploaderName} · ${record.uploaderLogin}`;
  }
  return record.uploaderName || record.uploaderLogin || "未识别云管家账号";
}

export function createFeishuSignature(timestamp: number, secret: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}\n${secret}`).digest("base64");
}

function resultLabel(record: WorkflowRecord): string {
  if (record.status === "success") return "成功";
  if (record.status === "partial") return "部分失败";
  if (record.status === "attention") return "需要关注";
  if (record.status === "stopped") return "已停止";
  if (record.status === "interrupted") return "意外中断";
  return "失败";
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours ? `${hours}小时` : "", minutes ? `${minutes}分` : "", `${seconds}秒`].filter(Boolean).join("");
}

function escapeText(value: string): string {
  return value.replace(/[<>]/g, "");
}

function safeJson(value: string): unknown {
  try {
    return value ? JSON.parse(value) : undefined;
  } catch {
    return undefined;
  }
}

interface FeishuResponsePayload {
  code?: number;
  StatusCode?: number;
  msg?: string;
  StatusMessage?: string;
}

async function assertFeishuResponse(response: Response): Promise<void> {
  await parseFeishuResponse(response);
}

async function parseFeishuResponse<T extends object = Record<string, never>>(response: Response): Promise<T & FeishuResponsePayload> {
  const text = await response.text();
  const payload = (safeJson(text) ?? {}) as T & FeishuResponsePayload;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}${payload.msg ? `：${payload.msg}` : ""}`);
  }
  const code = payload.code ?? payload.StatusCode ?? 0;
  if (code !== 0) {
    throw new Error(payload.msg || payload.StatusMessage || `飞书返回错误码 ${code}`);
  }
  return payload;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
