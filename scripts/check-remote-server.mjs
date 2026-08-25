import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const settingsPaths = [
  process.env.MIX_SERVER_SETTINGS_FILE,
  path.join(os.homedir(), "Library", "Application Support", "batch-mix-cut", "remote-mix-server.json"),
  path.join(os.homedir(), "Library", "Application Support", "Electron", "remote-mix-server.json")
].filter(Boolean);

const settingsPath = await findSettings(settingsPaths);
if (!settingsPath) {
  throw new Error("未找到服务器连接配置，无法执行发布前服务器检查");
}

const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
const serverUrl = String(settings.serverUrl ?? "").trim().replace(/\/+$/, "");
const token = String(settings.token ?? "").trim();
if (!serverUrl || !token) {
  throw new Error("服务器地址或 Token 缺失，无法执行发布前服务器检查");
}

const health = await requestJson(`${serverUrl}/health`);
if (!health.ok || !health.workspaceRoot) {
  throw new Error("服务器健康检查未通过");
}
if (Number(health.audioPipelineVersion ?? 0) < 2) {
  throw new Error("服务器混剪引擎版本过旧，未通过发布前检查");
}

const authorization = await requestJson(`${serverUrl}/api/auth/check`, { "x-mix-token": token });
if (!authorization.ok) {
  throw new Error("服务器 Token 认证未通过");
}

console.log(`服务器发布前检查通过：${serverUrl}`);

async function findSettings(paths) {
  for (const candidate of paths) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next configured location.
    }
  }
  return undefined;
}

async function requestJson(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) {
    throw new Error(`服务器请求失败：HTTP ${response.status}`);
  }
  return response.json();
}
