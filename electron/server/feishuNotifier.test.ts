import { describe, expect, it, vi } from "vitest";
import type { WorkflowRecord } from "../../src/shared/types.js";
import { buildFeishuPayload, createFeishuSignature, FeishuNotifier } from "./feishuNotifier.js";

describe("FeishuNotifier", () => {
  it("生成带签名和看板链接的飞书卡片", () => {
    const payload = buildFeishuPayload(record(), "sign-secret", "http://10.0.0.133:8787");
    expect(payload.msg_type).toBe("interactive");
    expect(payload.sign).toBeTruthy();
    expect(JSON.stringify(payload)).toContain("/dashboard");
    expect(JSON.stringify(payload)).toContain("董伟峰");
    expect(createFeishuSignature(123, "secret")).toBe(createFeishuSignature(123, "secret"));
  });

  it("失败后重试并且成功返回", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("bad", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0 }), { status: 200 }));
    const notifier = new FeishuNotifier({ webhook: "https://example.test/hook", fetchImpl });
    await expect(notifier.notify(record())).resolves.toEqual({ status: "sent" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("未配置 Webhook 时安全跳过", async () => {
    await expect(new FeishuNotifier().notify(record())).resolves.toEqual({ status: "disabled" });
  });
});

function record(): WorkflowRecord {
  return {
    id: "wf-1",
    displayName: "八月视频批次",
    uploaderName: "董伟峰",
    uploaderLogin: "19858192256",
    executionTarget: "server",
    exportTarget: "cloud",
    stage: "completed",
    status: "success",
    progress: { current: 3, total: 3, percent: 100, unit: "videos", message: "完成" },
    totalVideos: 3,
    succeededVideos: 3,
    failedVideos: 0,
    startedAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:01:00.000Z",
    finishedAt: "2026-08-25T00:01:00.000Z",
    timeline: [],
    videos: []
  };
}
