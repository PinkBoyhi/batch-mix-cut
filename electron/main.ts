import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type WebContents
} from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scanProject } from "./services/projectScanner.js";
import { JobManager } from "./services/jobManager.js";
import { createCombinations } from "./services/combinator.js";
import { probeAsset } from "./services/mediaProbe.js";
import { YunguanjiaClient } from "./services/yunguanjiaClient.js";
import { CloudPublishProfileStore } from "./services/cloudPublishProfiles.js";
import { RemoteMixClient } from "./services/remoteMixClient.js";
import { WorkflowMonitorClient } from "./services/workflowMonitorClient.js";
import { monitorCloudImport } from "./services/cloudImportMonitor.js";
import { UpdateManager } from "./services/updateManager.js";
import { assetId, isVideoFile, naturalCompare } from "./utils/path.js";
import type {
  AssetKind,
  AssetInfo,
  CloudImportVideo,
  CloudImportJob,
  CloudLocalUploadVideo,
  CloudUploadProgress,
  CloudPublishProfileInput,
  CloudSettings,
  CloudVideoListQuery,
  MixProjectConfig,
  RemoteMixSettings,
  WorkflowVideoResult
} from "../src/shared/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cloudClient = new YunguanjiaClient(() => app.getPath("userData"));
const cloudPublishProfileStore = new CloudPublishProfileStore(() => app.getPath("userData"));
const updateManager = new UpdateManager(app.getVersion());
const DEFAULT_CLOUD_LOGIN_URL = "https://sucaiwang.zhishangsoft.com/#/classification";
const DEFAULT_CLOUD_UPLOAD_BASE_URL = "https://sucaiwang-api-elb.zhishangsoft.com";
const PREVIEW_PROTOCOL = "batchmix-preview";

let mainWindow: BrowserWindow | undefined;
interface TaskRuntime {
  jobManager: JobManager;
  remoteMixClient: RemoteMixClient;
  monitorClient: WorkflowMonitorClient;
  currentConfig?: MixProjectConfig;
}

const taskRuntimes = new Map<string, TaskRuntime>();

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

function createWindow(): BrowserWindow {
  // 开发版不能依赖 process.cwd()：macOS 用系统 open 启动时工作目录可能不是项目根目录。
  const appRoot = app.isPackaged ? app.getAppPath() : path.resolve(__dirname, "../..");
  const preloadPath = path.join(appRoot, "electron", "preload.cjs");
  const windowIconPath = app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.join(appRoot, "build", "icon.png");
  const window = new BrowserWindow({
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

  if (!mainWindow) {
    mainWindow = window;
  }
  if (process.env.VITE_DEV_SERVER_URL) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void window.loadFile(path.join(__dirname, "../../dist/index.html"));
  }

  window.once("ready-to-show", () => {
    window.show();
    window.focus();
    if (process.platform === "darwin") {
      app.focus({ steal: true });
    }
  });
  window.on("closed", () => {
    const runtimePrefix = `${window.webContents.id}:`;
    for (const runtimeKey of taskRuntimes.keys()) {
      if (runtimeKey.startsWith(runtimePrefix)) {
        taskRuntimes.delete(runtimeKey);
      }
    }
    if (mainWindow === window) {
      mainWindow = BrowserWindow.getAllWindows().find((candidate) => candidate !== window);
    }
  });
  return window;
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

updateManager.on("update", (snapshot) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send("update:status", snapshot);
    }
  }
});

function getRuntimeKey(webContents: WebContents, taskId: string): string {
  return `${webContents.id}:${taskId}`;
}

function createTaskRuntime(webContents: WebContents, taskId: string): TaskRuntime {
  const jobManager = new JobManager();
  const remoteMixClient = new RemoteMixClient(() => app.getPath("userData"));
  const monitorClient = new WorkflowMonitorClient(() => app.getPath("userData"));
  const runtime: TaskRuntime = { jobManager, remoteMixClient, monitorClient };
  taskRuntimes.set(getRuntimeKey(webContents, taskId), runtime);
  jobManager.on("update", (snapshot) => {
    if (!webContents.isDestroyed()) {
      webContents.send("job:update", { taskId, snapshot });
    }
    if (runtime.currentConfig) {
      void monitorClient.reportLocalJob(snapshot, runtime.currentConfig);
    }
  });
  remoteMixClient.on("update", (snapshot) => {
    if (!webContents.isDestroyed()) {
      webContents.send("job:update", { taskId, snapshot });
    }
  });
  return runtime;
}

function getTaskRuntime(event: IpcMainInvokeEvent, taskId: string): TaskRuntime {
  if (!taskId || !taskId.trim()) {
    throw new Error("任务标签无效，请新建任务标签后重试");
  }
  const runtimeKey = getRuntimeKey(event.sender, taskId);
  return taskRuntimes.get(runtimeKey) ?? createTaskRuntime(event.sender, taskId);
}

function getEventWindow(event: IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
}

function registerIpc(): void {
  ipcMain.handle("dialog:select-directory", async (event) => {
    const owner = getEventWindow(event);
    const result = owner ? await dialog.showOpenDialog(owner, {
      properties: ["openDirectory", "createDirectory"]
    }) : await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? undefined : result.filePaths[0];
  });

  ipcMain.handle("dialog:select-files", async (event, kind: AssetKind) => {
    const options: OpenDialogOptions = {
      properties: ["openFile", "multiSelections"],
      filters:
        kind === "audio"
          ? [{ name: "音频素材", extensions: ["mp3", "m4a", "aac", "wav", "flac", "ogg"] }]
          : [{ name: "视频素材", extensions: ["mp4", "mov", "m4v", "mkv", "avi", "webm"] }]
    };
    const owner = getEventWindow(event);
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle("dialog:select-video-folder-files", async (event) => {
    const options: OpenDialogOptions = {
      properties: ["openDirectory"]
    };
    const owner = getEventWindow(event);
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
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
        fadeInSeconds: 0,
        fadeOutSeconds: 2
      },
      bgmTracks: [
        {
          id: "bgm_1",
          name: "BGM 1",
          assets: [],
          range: {
            fadeInSeconds: 0,
            fadeOutSeconds: 2
          },
          sortOrder: 0
        }
      ],
      maxCombinations: 100,
      outputNamePattern: "成品",
      exportMode: "video",
      sourceVolume: 1,
      bgmVolume: 1,
      normalizeLoudness: true,
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
      config.outputNamePattern,
      config.bgmTracks
    );
  });

  ipcMain.handle("project:scan", async (_event, projectDir: string, templateDraftPath?: string) => {
    return scanProject(projectDir, templateDraftPath);
  });

  ipcMain.handle("job:start", async (event, taskId: string, config: MixProjectConfig) => {
    const runtime = getTaskRuntime(event, taskId);
    runtime.currentConfig = config;
    const monitorStart = getCurrentWorkflowUploader().then((uploader) => runtime.monitorClient.start(taskId, config, "local", uploader));
    const snapshot = await runtime.jobManager.start(config);
    void monitorStart.then(() => runtime.monitorClient.reportLocalJob(runtime.jobManager.getSnapshot(), config));
    return snapshot;
  });

  ipcMain.handle("remote:get-settings", async (event, taskId: string) => getTaskRuntime(event, taskId).remoteMixClient.getSettingsView());
  ipcMain.handle("remote:save-settings", async (event, taskId: string, settings: RemoteMixSettings) => getTaskRuntime(event, taskId).remoteMixClient.saveSettings(settings));
  ipcMain.handle("remote:test-server", async (event, taskId: string) => getTaskRuntime(event, taskId).remoteMixClient.testConnection());
  ipcMain.handle("remote:start", async (event, taskId: string, config: MixProjectConfig) => {
    const runtime = getTaskRuntime(event, taskId);
    runtime.currentConfig = config;
    await runtime.monitorClient.start(taskId, config, "server", await getCurrentWorkflowUploader());
    try {
      return await runtime.remoteMixClient.start(config, runtime.monitorClient);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await runtime.monitorClient.update({
        stage: "failed",
        status: "failed",
        error: message,
        progress: { message },
        finishedAt: new Date().toISOString()
      });
      throw error;
    }
  });
  ipcMain.handle("remote:pause", async (event, taskId: string) => getTaskRuntime(event, taskId).remoteMixClient.pause());
  ipcMain.handle("remote:resume", async (event, taskId: string) => getTaskRuntime(event, taskId).remoteMixClient.resume());
  ipcMain.handle("remote:stop", async (event, taskId: string) => getTaskRuntime(event, taskId).remoteMixClient.stop());
  ipcMain.handle("remote:get", async (event, taskId: string) => getTaskRuntime(event, taskId).remoteMixClient.getSnapshot());
  ipcMain.handle("job:pause", async (event, taskId: string) => getTaskRuntime(event, taskId).jobManager.pause());
  ipcMain.handle("job:resume", async (event, taskId: string) => getTaskRuntime(event, taskId).jobManager.resume());
  ipcMain.handle("job:stop", async (event, taskId: string) => getTaskRuntime(event, taskId).jobManager.stop());
  ipcMain.handle("job:retry-failures", async (event, taskId: string) => getTaskRuntime(event, taskId).jobManager.retryFailures());
  ipcMain.handle("job:get", async (event, taskId: string) => getTaskRuntime(event, taskId).jobManager.getSnapshot());

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
  ipcMain.handle("update:get-status", async () => updateManager.getSnapshot());
  ipcMain.handle("update:get-release-notes", async () => updateManager.getReleaseNotes());

  ipcMain.handle("cloud:get-settings", async () => cloudClient.getSettingsView());
  ipcMain.handle("cloud:save-settings", async (_event, settings: CloudSettings) => cloudClient.saveSettings(settings));
  ipcMain.handle("cloud:publish-profiles", async () => cloudPublishProfileStore.list());
  ipcMain.handle("cloud:save-publish-profile", async (_event, profile: CloudPublishProfileInput) => cloudPublishProfileStore.save(profile));
  ipcMain.handle("cloud:delete-publish-profile", async (_event, profileId: string) => cloudPublishProfileStore.delete(profileId));
  ipcMain.handle("cloud:test-connection", async () => cloudClient.testConnection());
  ipcMain.handle("cloud:capture-upload-token", async (event, loginUrl?: string) => captureCloudUploadToken(loginUrl, getEventWindow(event)));
  ipcMain.handle("cloud:verify-phone", async (_event, phone: string) => cloudClient.verifyPhone(phone));
  ipcMain.handle("cloud:list-videos", async (_event, query: CloudVideoListQuery) => cloudClient.listVideos(query));
  ipcMain.handle("cloud:list-video-types", async (_event, videoType?: number) => cloudClient.listVideoTypes(videoType));
  ipcMain.handle("cloud:list-video-labels", async (_event, query?: { oneLevelTypeId?: number; twoLevelTypeIds?: string; videoType?: number }) => {
    return cloudClient.listVideoLabels(query);
  });
  ipcMain.handle("cloud:get-raw-url", async (_event, videoId: number, isInner: 0 | 1) => {
    return cloudClient.getRawUrl(videoId, isInner);
  });
  ipcMain.handle("cloud:import-videos", async (event, taskId: string, videos: CloudImportVideo[]) => {
    const runtime = getTaskRuntime(event, taskId);
    await ensureCloudWorkflow(runtime, taskId, videos.map((video) => video.videoName));
    await runtime.monitorClient.update({
      stage: "cloud_processing",
      status: "active",
      totalVideos: videos.length,
      progress: { current: 0, total: videos.length, percent: 0, unit: "videos", message: "正在提交云管家处理" }
    });
    try {
      const importJob = await cloudClient.importVideos(videos);
      startCloudResultMonitor(event.sender, taskId, runtime, videos.map((video) => video.videoName), importJob);
      return importJob;
    } catch (error) {
      await reportCloudFailure(event.sender, taskId, runtime, error);
      throw error;
    }
  });
  ipcMain.handle("cloud:upload-local-videos", async (event, taskId: string, videos: CloudLocalUploadVideo[]) => {
    const runtime = getTaskRuntime(event, taskId);
    const videoNames = videos.map((video) => video.videoName);
    await ensureCloudWorkflow(runtime, taskId, videoNames);
    const videoStates: WorkflowVideoResult[] = videoNames.map((videoName) => ({ videoName, status: "pending" }));
    try {
      const result = await cloudClient.uploadLocalVideos(videos, (progress) => {
        const currentVideo = videoStates[progress.index];
        if (currentVideo) {
          currentVideo.status = progress.phase === "uploaded" ? "processing" : "uploading";
          currentVideo.message = progress.phase === "preparing" ? "正在准备上传" : progress.phase === "uploaded" ? "上传完成，等待提交" : "正在上传";
          currentVideo.bytesUploaded = progress.bytesUploaded;
          currentVideo.bytesTotal = progress.bytesTotal;
        }
        const completed = progress.phase === "uploaded" ? progress.index + 1 : progress.index;
        const update: CloudUploadProgress = {
          taskId,
          stage: progress.phase === "submitting" ? "processing" : "uploading",
          current: completed,
          total: progress.total,
          message: progress.phase === "submitting"
            ? "成片上传完成，正在提交云管家处理"
            : `正在上传 ${progress.index + 1}/${progress.total}：${progress.videoName}`,
          bytesUploaded: progress.bytesUploaded,
          bytesTotal: progress.bytesTotal,
          videos: structuredClone(videoStates)
        };
        if (!event.sender.isDestroyed()) event.sender.send("cloud:progress", update);
        void runtime.monitorClient.update({
          stage: progress.phase === "submitting" ? "cloud_processing" : "cloud_upload",
          status: "active",
          totalVideos: progress.total,
          progress: progress.bytesTotal
            ? { current: progress.bytesUploaded ?? 0, total: progress.bytesTotal, unit: "bytes", message: update.message }
            : { current: completed, total: progress.total, unit: "videos", message: update.message },
          videos: structuredClone(videoStates)
        }, progress.phase === "uploading");
      });
      startCloudResultMonitor(event.sender, taskId, runtime, videoNames, result.importJob);
      return result;
    } catch (error) {
      await reportCloudFailure(event.sender, taskId, runtime, error, videoStates);
      throw error;
    }
  });
  ipcMain.handle("cloud:query-import-result", async (_event, requestId: string, pageNo = 1, pageSize = 20) => {
    return cloudClient.queryImportResult(requestId, pageNo, pageSize);
  });
}

async function ensureCloudWorkflow(runtime: TaskRuntime, taskId: string, videoNames: string[]): Promise<void> {
  const uploader = await getCurrentWorkflowUploader();
  if (!runtime.monitorClient.id) {
    const displayName = runtime.currentConfig
      ? path.basename(runtime.currentConfig.outputDir) || "云管家发布任务"
      : `云管家上传 ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
    await runtime.monitorClient.startCloudOnly(taskId, displayName, videoNames.length, uploader);
    return;
  }
  await runtime.monitorClient.update(uploader);
}

async function getCurrentWorkflowUploader(): Promise<{ uploaderName?: string; uploaderLogin?: string }> {
  const settings = await cloudClient.getSettingsView().catch(() => undefined);
  return {
    uploaderName: settings?.accountName || undefined,
    uploaderLogin: settings?.accountLogin || undefined
  };
}

function startCloudResultMonitor(
  webContents: WebContents,
  taskId: string,
  runtime: TaskRuntime,
  videoNames: string[],
  importJob: CloudImportJob
): void {
  void runtime.monitorClient.update({
    stage: "cloud_processing",
    status: "active",
    cloudRequestId: importJob.requestId,
    totalVideos: videoNames.length,
    progress: { current: 0, total: videoNames.length, percent: 0, unit: "videos", message: "云管家正在处理成片" }
  });
  void monitorCloudImport({
    requestId: importJob.requestId,
    videoNames,
    importJob,
    query: (requestId, pageNo, pageSize) => cloudClient.queryImportResult(requestId, pageNo, pageSize),
    onUpdate: async (update) => {
      const terminal = update.status !== "processing";
      const workflowStatus = update.status === "processing" ? "active" : update.status;
      const workflowStage = update.status === "processing"
        ? "cloud_processing"
        : update.status === "attention"
          ? "attention"
          : update.status === "failed"
            ? "failed"
            : "completed";
      await runtime.monitorClient.update({
        stage: workflowStage,
        status: workflowStatus,
        cloudRequestId: importJob.requestId,
        progress: {
          current: update.succeeded + update.failed,
          total: videoNames.length,
          percent: terminal ? 100 : undefined,
          unit: "videos",
          message: update.message
        },
        totalVideos: videoNames.length,
        succeededVideos: update.succeeded,
        failedVideos: update.failed,
        error: ["failed", "attention"].includes(update.status) ? update.message : undefined,
        finishedAt: terminal ? new Date().toISOString() : undefined,
        videos: update.videos
      });
      if (!webContents.isDestroyed()) {
        webContents.send("cloud:progress", {
          taskId,
          stage: update.status === "processing" ? "processing" : update.status === "attention" ? "attention" : update.status === "failed" ? "failed" : "completed",
          current: update.succeeded + update.failed,
          total: videoNames.length,
          message: update.message,
          videos: update.videos
        } satisfies CloudUploadProgress);
      }
      if (terminal) runtime.monitorClient.reset();
    }
  }).catch((error) => reportCloudFailure(webContents, taskId, runtime, error));
}

async function reportCloudFailure(
  webContents: WebContents,
  taskId: string,
  runtime: TaskRuntime,
  error: unknown,
  videos?: WorkflowVideoResult[]
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await runtime.monitorClient.update({
    stage: "failed",
    status: "failed",
    error: message,
    progress: { message },
    finishedAt: new Date().toISOString(),
    videos
  });
  if (!webContents.isDestroyed()) {
    webContents.send("cloud:progress", {
      taskId,
      stage: "failed",
      current: 0,
      total: videos?.length ?? 0,
      message,
      videos
    } satisfies CloudUploadProgress);
  }
  runtime.monitorClient.reset();
}

async function captureCloudUploadToken(loginUrl?: string, parentWindow?: BrowserWindow) {
  const settings = await cloudClient.getSettingsView();
  const startUrl = normalizeLoginUrl(loginUrl || DEFAULT_CLOUD_LOGIN_URL);

  return new Promise((resolve, reject) => {
    const captureWindow = new BrowserWindow({
      width: 1180,
      height: 820,
      title: "登录云管家以自动获取上传授权",
      parent: parentWindow ?? mainWindow,
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
