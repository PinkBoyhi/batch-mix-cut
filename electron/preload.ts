import { contextBridge, ipcRenderer } from "electron";
import type {
  AppApi,
  BatchJobSnapshot,
  CloudImportVideo,
  CloudSettings,
  CloudVideoListQuery,
  MixProjectConfig,
  UpdateSnapshot
} from "../src/shared/types.js";

const api: AppApi = {
  selectDirectory: () => ipcRenderer.invoke("dialog:select-directory"),
  selectFiles: (kind) => ipcRenderer.invoke("dialog:select-files", kind),
  probeFiles: (filePaths, kind) => ipcRenderer.invoke("assets:probe-files", filePaths, kind),
  createManualProject: (outputDir) => ipcRenderer.invoke("project:create-manual", outputDir),
  buildCombinations: (config) => ipcRenderer.invoke("project:build-combinations", config),
  scanProject: (projectDir: string, templateDraftPath?: string) => ipcRenderer.invoke("project:scan", projectDir, templateDraftPath),
  startJob: (config: MixProjectConfig) => ipcRenderer.invoke("job:start", config),
  pauseJob: () => ipcRenderer.invoke("job:pause"),
  resumeJob: () => ipcRenderer.invoke("job:resume"),
  stopJob: () => ipcRenderer.invoke("job:stop"),
  retryFailures: () => ipcRenderer.invoke("job:retry-failures"),
  getJob: () => ipcRenderer.invoke("job:get"),
  revealPath: (targetPath: string) => ipcRenderer.invoke("shell:reveal-path", targetPath),
  openExternal: (url: string) => ipcRenderer.invoke("shell:open-external", url),
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  getUpdateStatus: () => ipcRenderer.invoke("update:get-status"),
  getUpdateReleaseNotes: () => ipcRenderer.invoke("update:get-release-notes"),
  onUpdateStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: UpdateSnapshot) => callback(snapshot);
    ipcRenderer.on("update:status", listener);
    return () => ipcRenderer.removeListener("update:status", listener);
  },
  getCloudSettings: () => ipcRenderer.invoke("cloud:get-settings"),
  saveCloudSettings: (settings: CloudSettings) => ipcRenderer.invoke("cloud:save-settings", settings),
  testCloudConnection: () => ipcRenderer.invoke("cloud:test-connection"),
  listCloudAccounts: (pageNo?: number, pageSize?: number) => ipcRenderer.invoke("cloud:list-accounts", pageNo, pageSize),
  listCloudVideos: (query: CloudVideoListQuery) => ipcRenderer.invoke("cloud:list-videos", query),
  listCloudVideoTypes: (videoType?: number) => ipcRenderer.invoke("cloud:list-video-types", videoType),
  listCloudVideoLabels: (query?: { oneLevelTypeId?: number; twoLevelTypeIds?: string; videoType?: number }) =>
    ipcRenderer.invoke("cloud:list-video-labels", query),
  getCloudRawUrl: (videoId: number, isInner: 0 | 1) => ipcRenderer.invoke("cloud:get-raw-url", videoId, isInner),
  importCloudVideos: (videos: CloudImportVideo[]) => ipcRenderer.invoke("cloud:import-videos", videos),
  queryCloudImportResult: (requestId: string, pageNo?: number, pageSize?: number) =>
    ipcRenderer.invoke("cloud:query-import-result", requestId, pageNo, pageSize),
  onJobUpdate: (callback: (snapshot: BatchJobSnapshot) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: BatchJobSnapshot) => callback(snapshot);
    ipcRenderer.on("job:update", listener);
    return () => ipcRenderer.removeListener("job:update", listener);
  }
};

contextBridge.exposeInMainWorld("batchMix", api);
