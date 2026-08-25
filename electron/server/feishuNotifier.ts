import crypto from "node:crypto";
import type { WorkflowRecord } from "../../src/shared/types.js";

export interface FeishuNotifierOptions {
  webhook?: string;
  secret?: string;
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
  private readonly dashboardUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FeishuNotifierOptions = {}) {
    this.webhook = options.webhook?.trim() ?? "";
    this.secret = options.secret?.trim() ?? "";
    this.dashboardUrl = options.dashboardUrl?.trim().replace(/\/+$/, "") ?? "";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  isEnabled(): boolean {
    return Boolean(this.webhook);
  }

  async notify(record: WorkflowRecord): Promise<FeishuNotifyResult> {
    if (!this.webhook) return { status: "disabled" };
    let lastError = "飞书机器人通知失败";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.fetchImpl(this.webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildFeishuPayload(record, this.secret, this.dashboardUrl)),
          signal: AbortSignal.timeout(10_000)
        });
        const text = await response.text();
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}${text ? `：${text.slice(0, 200)}` : ""}`);
        }
        const payload = safeJson(text) as { code?: number; StatusCode?: number; msg?: string; StatusMessage?: string } | undefined;
        const code = payload?.code ?? payload?.StatusCode ?? 0;
        if (code !== 0) {
          throw new Error(payload?.msg || payload?.StatusMessage || `飞书返回错误码 ${code}`);
        }
        return { status: "sent" };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < 2) await delay(500 * 2 ** attempt);
      }
    }
    return { status: "failed", error: lastError };
  }
}

export function buildFeishuPayload(record: WorkflowRecord, secret = "", dashboardUrl = ""): Record<string, unknown> {
  const timestamp = Math.floor(Date.now() / 1000);
  const duration = formatDuration(Date.parse(record.finishedAt ?? record.updatedAt) - Date.parse(record.startedAt));
  const resultText = resultLabel(record);
  const color = record.status === "success" ? "green" : record.status === "partial" || record.status === "attention" ? "orange" : "red";
  const fields = [
    `**任务：** ${escapeText(record.displayName)}`,
    `**上传人：** ${escapeText(formatUploader(record))}`,
    `**结果：** ${resultText}`,
    `**视频：** 成功 ${record.succeededVideos} / 失败 ${record.failedVideos} / 共 ${record.totalVideos}`,
    `**耗时：** ${duration}`
  ];
  if (record.error) fields.push(`**说明：** ${escapeText(record.error)}`);
  if (dashboardUrl) fields.push(`[打开进度看板](${dashboardUrl}/dashboard)`);
  const payload: Record<string, unknown> = {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: { template: color, title: { tag: "plain_text", content: `混剪任务${resultText}` } },
      elements: [{ tag: "div", text: { tag: "lark_md", content: fields.join("\n") } }]
    }
  };
  if (secret) {
    payload.timestamp = String(timestamp);
    payload.sign = createFeishuSignature(timestamp, secret);
  }
  return payload;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
