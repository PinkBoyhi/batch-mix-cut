import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowStore } from "./workflowStore.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("WorkflowStore", () => {
  it("持久化任务并在重启时标记未结束任务为中断", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-store-"));
    tempDirs.push(root);
    const store = new WorkflowStore(root);
    await store.initialize();
    const record = store.create({
      displayName: "测试任务",
      uploaderName: "董伟峰",
      uploaderLogin: "19858192256",
      taskId: "task-1",
      executionTarget: "server",
      exportTarget: "cloud",
      totalVideos: 4
    });
    store.update(record.id, {
      stage: "mixing",
      status: "active",
      progress: { current: 2, total: 4, unit: "videos", message: "正在混剪" }
    });
    await store.flush();

    const restarted = new WorkflowStore(root);
    await restarted.initialize();
    const restored = restarted.get(record.id);
    expect(restored).toMatchObject({
      stage: "interrupted",
      status: "interrupted",
      displayName: "测试任务",
      uploaderName: "董伟峰",
      uploaderLogin: "19858192256"
    });
    expect(restored?.finishedAt).toBeTruthy();
  });

  it("只在首次进入终态时发送 terminal 事件", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-terminal-"));
    tempDirs.push(root);
    const store = new WorkflowStore(root);
    await store.initialize();
    const record = store.create({ displayName: "通知任务", executionTarget: "local", exportTarget: "local" });
    const terminal: string[] = [];
    store.on("terminal", (item) => terminal.push(item.id));
    store.update(record.id, { stage: "completed", status: "success", progress: { message: "完成" } });
    store.update(record.id, { stage: "completed", status: "success", progress: { message: "完成" } });
    await store.flush();
    expect(terminal).toEqual([record.id]);
  });

  it("不会把任意额外字段写入任务记录", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-sanitize-"));
    tempDirs.push(root);
    const store = new WorkflowStore(root);
    await store.initialize();
    const record = store.create({
      displayName: "安全任务",
      executionTarget: "local",
      exportTarget: "cloud",
      unexpectedSecret: "secret"
    } as never);
    await store.flush();
    const raw = await fs.readFile(path.join(root, "dashboard", "workflows.json"), "utf8");
    expect(raw).not.toContain("unexpectedSecret");
    expect(raw).not.toContain("secret");
    expect(record.displayName).toBe("安全任务");
  });
});
