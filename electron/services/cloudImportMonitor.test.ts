import { describe, expect, it, vi } from "vitest";
import { monitorCloudImport, summarizeResults } from "./cloudImportMonitor.js";

describe("cloudImportMonitor", () => {
  it("识别待处理、下载中、成功和失败状态", () => {
    const summary = summarizeResults(["a.mp4", "b.mp4", "c.mp4"], [
      { videoName: "a.mp4", status: 10, videoId: 1 },
      { videoName: "b.mp4", status: 20, msg: "格式错误" },
      { videoName: "c.mp4", status: 3 }
    ]);
    expect(summary.status).toBe("processing");
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.videos[2].status).toBe("processing");
  });

  it("轮询直到全部视频进入终态", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ list: [{ videoName: "a.mp4", status: 3 }], pageNo: 1, pageSize: 50, total: 1, totalPage: 1 })
      .mockResolvedValueOnce({ list: [{ videoName: "a.mp4", status: 10 }], pageNo: 1, pageSize: 50, total: 1, totalPage: 1 });
    const updates: string[] = [];
    const result = await monitorCloudImport({
      requestId: "request-1",
      videoNames: ["a.mp4"],
      importJob: { requestId: "request-1", errorList: [] },
      query,
      intervalMs: 0,
      timeoutMs: 1000,
      sleep: async () => undefined,
      onUpdate: (update) => { updates.push(update.status); }
    });
    expect(result.status).toBe("success");
    expect(updates).toEqual(["processing", "success"]);
  });

  it("即时拒绝项会计入最终失败", () => {
    const result = summarizeResults(
      ["a.mp4", "b.mp4"],
      [{ videoName: "a.mp4", status: 10 }],
      new Map([["b.mp4", "标签无效"]])
    );
    expect(result.status).toBe("partial");
    expect(result.failed).toBe(1);
  });
});
