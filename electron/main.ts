import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanProject } from "./services/projectScanner.js";
import { JobManager } from "./services/jobManager.js";
import { createCombinations } from "./services/combinator.js";
import { probeAsset } from "./services/mediaProbe.js";
import { YunguanjiaClient } from "./services/yunguanjiaClient.js";
import { UpdateManager } from "./services/updateManager.js";
import { assetId } from "./utils/path.js";
import type {
  AssetKind,
  AssetInfo,
  CloudImportVideo,
  CloudSettings,
  CloudVideoListQuery,
  MixProjectConfig
} from "../src/shared/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const jobManager = new JobManager();
const cloudClient = new YunguanjiaClient(() => app.getPath("userData"));
const updateManager = new UpdateManager(app.getVersion(), app.isPackaged);

let mainWindow: BrowserWindow | undefined;

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
    if (app.isPackaged) {
      void updateManager.check();
    }
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

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
    return createCombinations(config.slots, config.bgmAssets, config.outputDir, config.maxCombinations ?? 100);
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

  ipcMain.handle("update:check", async () => updateManager.check());
  ipcMain.handle("update:install", async () => updateManager.quitAndInstall());
  ipcMain.handle("update:get-status", async () => updateManager.getSnapshot());

  ipcMain.handle("cloud:get-settings", async () => cloudClient.getSettingsView());
  ipcMain.handle("cloud:save-settings", async (_event, settings: CloudSettings) => cloudClient.saveSettings(settings));
  ipcMain.handle("cloud:test-connection", async () => cloudClient.testConnection());
  ipcMain.handle("cloud:list-accounts", async (_event, pageNo = 1, pageSize = 100) => {
    return cloudClient.listAccounts(pageNo, pageSize);
  });
  ipcMain.handle("cloud:list-videos", async (_event, query: CloudVideoListQuery) => cloudClient.listVideos(query));
  ipcMain.handle("cloud:list-video-types", async (_event, videoType?: number) => cloudClient.listVideoTypes(videoType));
  ipcMain.handle("cloud:list-video-labels", async (_event, query?: { oneLevelTypeId?: number; twoLevelTypeIds?: string; videoType?: number }) => {
    return cloudClient.listVideoLabels(query);
  });
  ipcMain.handle("cloud:get-raw-url", async (_event, videoId: number, isInner: 0 | 1) => {
    return cloudClient.getRawUrl(videoId, isInner);
  });
  ipcMain.handle("cloud:import-videos", async (_event, videos: CloudImportVideo[]) => cloudClient.importVideos(videos));
  ipcMain.handle("cloud:query-import-result", async (_event, requestId: string, pageNo = 1, pageSize = 20) => {
    return cloudClient.queryImportResult(requestId, pageNo, pageSize);
  });
}
