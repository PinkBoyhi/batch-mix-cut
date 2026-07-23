import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scanProject } from "./services/projectScanner.js";
import { JobManager } from "./services/jobManager.js";
import { createCombinations } from "./services/combinator.js";
import { probeAsset } from "./services/mediaProbe.js";
import { YunguanjiaClient } from "./services/yunguanjiaClient.js";
import { UpdateManager } from "./services/updateManager.js";
import { assetId, isVideoFile, naturalCompare } from "./utils/path.js";
import type {
  AssetKind,
  AssetInfo,
  CloudImportVideo,
  CloudLocalUploadVideo,
  CloudSettings,
  CloudVideoListQuery,
  MixProjectConfig
} from "../src/shared/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const jobManager = new JobManager();
const cloudClient = new YunguanjiaClient(() => app.getPath("userData"));
const updateManager = new UpdateManager(app.getVersion(), app.isPackaged);
const DEFAULT_CLOUD_LOGIN_URL = "https://sucaiwang.zhishangsoft.com/#/classification";
const DEFAULT_CLOUD_UPLOAD_BASE_URL = "https://sucaiwang-api-elb.zhishangsoft.com";
const PREVIEW_PROTOCOL = "batchmix-preview";

let mainWindow: BrowserWindow | undefined;

protocol.registerSchemesAsPrivileged([
  {
    scheme: PREVIEW_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true
    }
  }
]);

function createWindow(): void {
  const preloadPath = path.join(app.isPackaged ? app.getAppPath() : process.cwd(), "electron", "preload.cjs");
  const windowIconPath = app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.join(process.cwd(), "build", "icon.png");

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 760,
    minHeight: 560,
    title: "医博生物混剪工具",
    backgroundColor: "#f5f9ff",
    icon: windowIconPath,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../../dist/index.html"));
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    mainWindow?.focus();
    if (process.platform === "darwin") {
      app.focus({ steal: true });
    }
  });
}

app.whenReady().then(() => {
  registerPreviewProtocol();
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

function registerPreviewProtocol(): void {
  protocol.handle(PREVIEW_PROTOCOL, async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "local") {
      return new Response("Not found", { status: 404 });
    }
    const targetPath = url.searchParams.get("path") ?? "";
    if (!path.isAbsolute(targetPath)) {
      return new Response("Invalid path", { status: 400 });
    }
    const stat = await fs.stat(targetPath).catch(() => undefined);
    if (!stat?.isFile()) {
      return new Response("Video not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(targetPath).toString());
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

jobManager.on("update", (snapshot) => {
  mainWindow?.webContents.send("job:update", snapshot);
});

updateManager.on("update", (snapshot) => {
  mainWindow?.webContents.send("update:status", snapshot);
});

function registerIpc(): void {
  ipcMain.handle("dialog:select-directory", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openDirectory", "createDirectory"]
    });
    return result.canceled ? undefined : result.filePaths[0];
  });

  ipcMain.handle("dialog:select-files", async (_event, kind: AssetKind) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openFile", "multiSelections"],
      filters:
        kind === "audio"
          ? [{ name: "音频素材", extensions: ["mp3", "m4a", "aac", "wav", "flac", "ogg"] }]
          : [{ name: "视频素材", extensions: ["mp4", "mov", "m4v", "mkv", "avi", "webm"] }]
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle("dialog:select-video-folder-files", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) {
      return [];
    }
    return scanVideoFiles(result.filePaths[0]);
  });

  ipcMain.handle("assets:probe-files", async (_event, filePaths: string[], kind: AssetKind) => {
    const assets: AssetInfo[] = filePaths.map((filePath) => ({
      id: assetId(filePath),
      path: filePath,
      name: path.basename(filePath),
      kind
    }));
    return Promise.all(assets.map(probeAsset));
  });

  ipcMain.handle("project:create-manual", async (_event, outputDir: string) => {
    const config: MixProjectConfig = {
      projectDir: outputDir,
      outputDir,
      slots: [],
      bgmAssets: [],
      bgmRange: {
        fadeOutSeconds: 2
      },
      maxCombinations: 100,
      outputNamePattern: "成品",
      exportMode: "video",
      sourceVolume: 1,
      bgmVolume: 1,
      videoProfile: {
        codec: "h264",
        audioCodec: "aac",
        preset: "fast",
        crf: 20,
        canvasMode: "original"
      },
      exportTarget: "local",
      draftSlots: []
    };
    return { config, combinations: [], warnings: [] };
  });

  ipcMain.handle("project:build-combinations", async (_event, config: MixProjectConfig) => {
    return createCombinations(
      config.slots,
      config.bgmAssets,
      config.outputDir,
      config.maxCombinations ?? 100,
      config.outputNamePattern
    );
  });

  ipcMain.handle("project:scan", async (_event, projectDir: string, templateDraftPath?: string) => {
    return scanProject(projectDir, templateDraftPath);
  });

  ipcMain.handle("job:start", async (_event, config: MixProjectConfig) => {
    return jobManager.start(config);
  });

  ipcMain.handle("job:pause", async () => jobManager.pause());
  ipcMain.handle("job:resume", async () => jobManager.resume());
  ipcMain.handle("job:stop", async () => jobManager.stop());
  ipcMain.handle("job:retry-failures", async () => jobManager.retryFailures());
  ipcMain.handle("job:get", async () => jobManager.getSnapshot());

  ipcMain.handle("shell:reveal-path", async (_event, targetPath: string) => {
    await shell.openPath(targetPath);
  });

  ipcMain.handle("shell:open-external", async (_event, url: string) => {
    if (!/^https:\/\/github\.com\/PinkBoyhi\/batch-mix-cut\/releases\/?/i.test(url)) {
      throw new Error("只允许打开本项目的 GitHub 发布页面");
    }
    await shell.openExternal(url);
  });

  ipcMain.handle("update:check", async () => updateManager.check());
  ipcMain.handle("update:install", async () => updateManager.quitAndInstall());
  ipcMain.handle("update:get-status", async () => updateManager.getSnapshot());
  ipcMain.handle("update:get-release-notes", async () => updateManager.getReleaseNotes());

  ipcMain.handle("cloud:get-settings", async () => cloudClient.getSettingsView());
  ipcMain.handle("cloud:save-settings", async (_event, settings: CloudSettings) => cloudClient.saveSettings(settings));
  ipcMain.handle("cloud:test-connection", async () => cloudClient.testConnection());
  ipcMain.handle("cloud:capture-upload-token", async (_event, loginUrl?: string) => captureCloudUploadToken(loginUrl));
  ipcMain.handle("cloud:verify-phone", async (_event, phone: string) => cloudClient.verifyPhone(phone));
  ipcMain.handle("cloud:list-videos", async (_event, query: CloudVideoListQuery) => cloudClient.listVideos(query));
  ipcMain.handle("cloud:list-video-types", async (_event, videoType?: number) => cloudClient.listVideoTypes(videoType));
  ipcMain.handle("cloud:list-video-labels", async (_event, query?: { oneLevelTypeId?: number; twoLevelTypeIds?: string; videoType?: number }) => {
    return cloudClient.listVideoLabels(query);
  });
  ipcMain.handle("cloud:get-raw-url", async (_event, videoId: number, isInner: 0 | 1) => {
    return cloudClient.getRawUrl(videoId, isInner);
  });
  ipcMain.handle("cloud:import-videos", async (_event, videos: CloudImportVideo[]) => cloudClient.importVideos(videos));
  ipcMain.handle("cloud:upload-local-videos", async (_event, videos: CloudLocalUploadVideo[]) => cloudClient.uploadLocalVideos(videos));
  ipcMain.handle("cloud:query-import-result", async (_event, requestId: string, pageNo = 1, pageSize = 20) => {
    return cloudClient.queryImportResult(requestId, pageNo, pageSize);
  });
}

async function captureCloudUploadToken(loginUrl?: string) {
  const settings = await cloudClient.getSettingsView();
  const startUrl = normalizeLoginUrl(loginUrl || DEFAULT_CLOUD_LOGIN_URL);

  return new Promise((resolve, reject) => {
    const captureWindow = new BrowserWindow({
      width: 1180,
      height: 820,
      title: "登录云管家以自动获取上传授权",
      parent: mainWindow,
      modal: false,
      show: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: `persist:yunguanjia-token-${Date.now()}`
      }
    });

    let settled = false;
    const session = captureWindow.webContents.session;
    const timeout = setTimeout(() => {
      finish(undefined, new Error("自动获取上传授权超时：请在弹出的云管家窗口登录后进入视频上传页。"));
    }, 5 * 60 * 1000);

    const finish = (token?: string, error?: Error, requestUrl?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      session.webRequest.onBeforeSendHeaders(null);
      if (!captureWindow.isDestroyed()) {
        captureWindow.close();
      }
      if (error) {
        reject(error);
        return;
      }
      const uploadBaseUrl = requestUrl ? new URL(requestUrl).origin : settings.uploadBaseUrl || DEFAULT_CLOUD_UPLOAD_BASE_URL;
      cloudClient
        .saveSettings({
          baseUrl: settings.baseUrl,
          companyKey: settings.companyKey,
          accountKey: settings.accountKey,
          accountName: settings.accountName,
          accountLogin: settings.accountLogin,
          uploadBaseUrl,
          uploadToken: token
        })
        .then(resolve, reject);
    };

    session.webRequest.onBeforeSendHeaders(
      {
        urls: ["https://*.sucaicloud.com/*", "https://*.zhishangsoft.com/*"]
      },
      (details, callback) => {
        const token = findHeader(details.requestHeaders, "token");
        if (token && token.length > 10 && isUsefulCloudRequest(details.url)) {
          finish(token, undefined, details.url);
        }
        callback({ requestHeaders: details.requestHeaders });
      }
    );

    captureWindow.on("closed", () => {
      finish(undefined, new Error("已关闭云管家登录窗口，未获取到上传授权。"));
    });
    void captureWindow.loadURL(startUrl).catch((error) => finish(undefined, error));
  });
}

function findHeader(headers: Record<string, string | string[] | undefined>, headerName: string): string | undefined {
  const matchedKey = Object.keys(headers).find((key) => key.toLowerCase() === headerName.toLowerCase());
  const value = matchedKey ? headers[matchedKey] : undefined;
  return Array.isArray(value) ? value[0] : value;
}

function isUsefulCloudRequest(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return (
      /sucaicloud\.com$/i.test(url.hostname) ||
      /zhishangsoft\.com$/i.test(url.hostname)
    ) && !url.pathname.includes("/openapi/");
  } catch {
    return false;
  }
}

function normalizeLoginUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_CLOUD_LOGIN_URL;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

async function scanVideoFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => naturalCompare(left.name, right.name))) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await scanVideoFiles(filePath)));
    } else if (entry.isFile() && isVideoFile(filePath)) {
      files.push(filePath);
    }
  }
  return files;
}
