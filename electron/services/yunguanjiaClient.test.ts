import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createYunguanjiaSign, YunguanjiaClient } from "./yunguanjiaClient.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("createYunguanjiaSign", () => {
  it("sorts params, excludes sign, appends company secret and uppercases md5", () => {
    const sign = createYunguanjiaSign(
      {
        sign: "ignored",
        timestamp: 213123123123,
        pageSize: 20,
        company_key: "aaa",
        access_token: "aaa",
        nonce: "aaaaaa",
        account_key: "aaa",
        pageNo: 1
      },
      "aaa"
    );

    expect(sign).toBe("CE8A75A60C38CB6F18B167D3C2E022AA");
  });

  it("uses uppercase URL encoding for non-ascii values", () => {
    const sign = createYunguanjiaSign({ name: "测试" }, "secret");

    expect(sign).toBe("17DE6B604A762828E8C10ADECC6A1475");
    expect(sign).not.toBe("238AA0F48A1C1796C91F9771E0BD3765");
  });
});

describe("YunguanjiaClient", () => {
  it("refreshes an expired token response once and retries the request", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yunguanjia-test-"));
    const client = new YunguanjiaClient(() => dir);
    await client.saveSettings({
      baseUrl: "https://api.example.com/",
      companyKey: "company",
      companySecret: "secret",
      accountKey: "account"
    });

    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      calls.push(target);
      if (target.endsWith("/openapi/auth/access_token")) {
        return jsonResponse({ code: 1, data: { accessToken: `token-${calls.length}` }, info: "ok", success: true });
      }
      if (calls.filter((item) => item.endsWith("/openapi/video/list")).length === 1) {
        return jsonResponse({ code: 20013, info: "accessToken已过期", success: false });
      }
      return jsonResponse({
        code: 1,
        data: { list: [], pageNo: 1, pageSize: 20, total: 0, totalPage: 0 },
        info: "ok",
        success: true
      });
    }) as typeof fetch;

    const result = await client.listVideos({ pageNo: 1, pageSize: 20, isInner: 0 });

    expect(result.total).toBe(0);
    expect(calls.filter((item) => item.endsWith("/openapi/auth/access_token"))).toHaveLength(2);
    expect(calls.filter((item) => item.endsWith("/openapi/video/list"))).toHaveLength(2);
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
