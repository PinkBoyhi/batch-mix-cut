import path from "node:path";

export function getTaskScopedConfigPath(userDataDir: string, taskId: string, fileName: string): string {
  const safeTaskDirectory = Buffer.from(taskId || "default", "utf8").toString("base64url");
  return path.join(userDataDir, "task-settings", safeTaskDirectory, fileName);
}

export function getLegacyConfigPath(userDataDir: string, fileName: string): string {
  return path.join(userDataDir, fileName);
}
