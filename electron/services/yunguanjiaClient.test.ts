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
  it("stores selected account display fields without exposing connection settings in the view", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yunguanjia-test-"));
    const client = new YunguanjiaClient(() => dir);

    const view = await client.saveSettings({
      baseUrl: "https://api.example.com/",
      companyKey: "company",
      companySecret: "secret",
      accountKey: "account-key",
      accountName: "张三",
      accountLogin: "13900000000"
    });

    expect(view).toMatchObject({
      baseUrl: "",
      companyKey: "",
      hasCompanySecret: true,
      accountKey: "account-key",
      accountName: "张三",
      accountLogin: "13900000000"
    });
  });

  it("does not pretend local videos can be uploaded with only an openapi token", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yunguanjia-test-"));
    const client = new YunguanjiaClient(() => dir);
    await client.saveSettings({
      baseUrl: "https://api.example.com/",
      companyKey: "company",
      companySecret: "secret",
      accountKey: "account-key"
    });

    await expect(
      client.uploadLocalVideos([
        {
          localPath: "/tmp/output.mp4",
          videoName: "成片_001",
          videoType: 0,
          twoLevelTypeId: 12,
          labelIds: "1",
          videoRight: 0
        }
      ])
    ).rejects.toThrow("本地成片直传需要云管家上传授权");
  });

  it("keeps the captured web api host internally without exposing it to the renderer", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yunguanjia-test-"));
    const configPath = path.join(dir, "yunguanjia-cloud.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        baseUrl: "https://api.example.com",
        companyKey: "company",
        companySecret: "secret",
        accountKey: "account",
        uploadBaseUrl: "https://sucaiwang-api-tx.sucaicloud.com"
      }),
      "utf8"
    );
    const client = new YunguanjiaClient(() => dir);

    const view = await client.getSettingsView();

    expect(view.uploadBaseUrl).toBe("");
  });

  it("reuses a cached token while it is safely valid", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yunguanjia-test-"));
    const client = new YunguanjiaClient(() => dir);
    await client.saveSettings({
      baseUrl: "https://api.example.com/",
      companyKey: "company",
      companySecret: "secret",
      accountKey: "account"
    });

    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      calls.push(target);
      if (target.endsWith("/openapi/auth/access_token")) {
        return jsonResponse({ code: 1, data: { accessToken: "token" }, info: "ok", success: true });
      }
      return jsonResponse({
        code: 1,
        data: { list: [], pageNo: 1, pageSize: 20, total: 0, totalPage: 0 },
        info: "ok",
        success: true
      });
    }) as typeof fetch;

    await client.listVideos({ pageNo: 1, pageSize: 20, isInner: 0 });
    await client.listVideos({ pageNo: 1, pageSize: 20, isInner: 0 });

    expect(calls.filter((item) => item.endsWith("/openapi/auth/access_token"))).toHaveLength(1);
  });

  it("refreshes a cached token before it expires", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yunguanjia-test-"));
    const configPath = path.join(dir, "yunguanjia-cloud.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        baseUrl: "https://api.example.com",
        companyKey: "company",
        companySecret: "secret",
        accountKey: "account",
        accessToken: "nearly-expired-token",
        accessTokenExpiresAt: Date.now() + 5 * 60 * 1000
      }),
      "utf8"
    );
    const client = new YunguanjiaClient(() => dir);
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      calls.push(target);
      if (target.endsWith("/openapi/auth/access_token")) {
        return jsonResponse({ code: 1, data: { accessToken: "fresh-token" }, info: "ok", success: true });
      }
      return jsonResponse({
        code: 1,
        data: { list: [], pageNo: 1, pageSize: 20, total: 0, totalPage: 0 },
        info: "ok",
        success: true
      });
    }) as typeof fetch;

    await client.listVideos({ pageNo: 1, pageSize: 20, isInner: 0 });

    expect(calls.filter((item) => item.endsWith("/openapi/auth/access_token"))).toHaveLength(1);
  });

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
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
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

  it("verifies a phone number and stores the matched openapi accountKey", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yunguanjia-test-"));
    const client = new YunguanjiaClient(() => dir);
    await client.saveSettings({
      baseUrl: "https://openapi.example.com/",
      companyKey: "company",
      companySecret: "secret",
      accountKey: ""
    });

    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/openapi/auth/access_token")) {
        return jsonResponse({ code: 1, data: { accessToken: "open-token" }, info: "ok", success: true });
      }
      if (target.endsWith("/openapi/account/list")) {
        return jsonResponse({
          code: 1,
          data: {
            list: [{ account: "13900000000", accountKey: "matched-key", name: "张三" }],
            pageNo: 1,
            pageSize: 100,
            total: 1,
            totalPage: 1
          },
          info: "ok",
          success: true
        });
      }
      throw new Error(`Unexpected request: ${target}`);
    }) as typeof fetch;

    const view = await client.verifyPhone("13900000000");
    const saved = await fs.readFile(path.join(dir, "yunguanjia-cloud.json"), "utf8");

    expect(view).toMatchObject({
      accountKey: "matched-key",
      accountName: "张三",
      accountLogin: "13900000000"
    });
    expect(saved).toContain("matched-key");
  });

  it("keeps scanning account pages until the phone is matched", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yunguanjia-test-"));
    const client = new YunguanjiaClient(() => dir);
    await client.saveSettings({
      baseUrl: "https://openapi.example.com/",
      companyKey: "company",
      companySecret: "secret",
      accountKey: ""
    });

    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/openapi/auth/access_token")) {
        return jsonResponse({ code: 1, data: { accessToken: "open-token" }, info: "ok", success: true });
      }
      if (target.endsWith("/openapi/account/list")) {
        const body = init?.body ? JSON.parse(String(init.body)) : { pageNo: 1 };
        const pageNo = typeof body.pageNo === "number" ? body.pageNo : 1;
        return jsonResponse({
          code: 1,
          data: {
            list: pageNo === 2 ? [{ account: "13900000000", accountKey: "phone-key", name: "李四" }] : [],
            pageNo,
            pageSize: 100,
            total: 1,
            totalPage: 2
          },
          info: "ok",
          success: true
        });
      }
      throw new Error(`Unexpected request: ${target}`);
    }) as typeof fetch;

    const view = await client.verifyPhone("13900000000");

    expect(view).toMatchObject({
      accountKey: "phone-key",
      accountName: "李四",
      accountLogin: "13900000000"
    });
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
