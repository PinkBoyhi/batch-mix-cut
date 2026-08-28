import { contextBridge, ipcRenderer } from "electron";
import type {
  AppApi,
  CloudImportVideo,
  CloudLocalUploadVideo,
  CloudUploadProgress,
  CloudPublishProfileInput,
  CloudSettings,
  CloudVideoListQuery,
  MixProjectConfig,
  TaskJobUpdate,
  UpdateSnapshot
} from "../src/shared/types.js";

const api: AppApi = {
  selectDirectory: () => ipcRenderer.invoke("dialog:select-directory"),
  selectFiles: (kind) => ipcRenderer.invoke("dialog:select-files", kind),
  selectVideoFolderFiles: () => ipcRenderer.invoke("dialog:select-video-folder-files"),
  probeFiles: (filePaths, kind) => ipcRenderer.invoke("assets:probe-files", filePaths, kind),
  createManualProject: (outputDir) => ipcRenderer.invoke("project:create-manual", outputDir),
  buildCombinations: (config) => ipcRenderer.invoke("project:build-combinations", config),
  scanProject: (projectDir: string, templateDraftPath?: string) => ipcRenderer.invoke("project:scan", projectDir, templateDraftPath),
  startJob: (taskId: string, config: MixProjectConfig) => ipcRenderer.invoke("job:start", taskId, config),
  startRemoteJob: (taskId: string, config: MixProjectConfig) => ipcRenderer.invoke("remote:start", taskId, config),
  pauseRemoteJob: (taskId: string) => ipcRenderer.invoke("remote:pause", taskId),
  resumeRemoteJob: (taskId: string) => ipcRenderer.invoke("remote:resume", taskId),
  stopRemoteJob: (taskId: string) => ipcRenderer.invoke("remote:stop", taskId),
  retryRemoteFailures: (taskId: string) => ipcRenderer.invoke("remote:retry", taskId),
  getRemoteJob: (taskId: string) => ipcRenderer.invoke("remote:get", taskId),
  getRemoteMixSettings: (taskId: string) => ipcRenderer.invoke("remote:get-settings", taskId),
  saveRemoteMixSettings: (taskId, settings) => ipcRenderer.invoke("remote:save-settings", taskId, settings),
  testRemoteMixServer: (taskId: string) => ipcRenderer.invoke("remote:test-server", taskId),
  pauseJob: (taskId: string) => ipcRenderer.invoke("job:pause", taskId),
  resumeJob: (taskId: string) => ipcRenderer.invoke("job:resume", taskId),
  stopJob: (taskId: string) => ipcRenderer.invoke("job:stop", taskId),
  retryFailures: (taskId: string) => ipcRenderer.invoke("job:retry-failures", taskId),
  getJob: (taskId: string) => ipcRenderer.invoke("job:get", taskId),
  revealPath: (targetPath: string) => ipcRenderer.invoke("shell:reveal-path", targetPath),
  openExternal: (url: string) => ipcRenderer.invoke("shell:open-external", url),
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  getUpdateStatus: () => ipcRenderer.invoke("update:get-status"),
  getUpdateReleaseNotes: () => ipcRenderer.invoke("update:get-release-notes"),
  onUpdateStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: UpdateSnapshot) => callback(snapshot);
    ipcRenderer.on("update:status", listener);
    return () => ipcRenderer.removeListener("update:status", listener);
  },
  getCloudSettings: () => ipcRenderer.invoke("cloud:get-settings"),
  saveCloudSettings: (settings: CloudSettings) => ipcRenderer.invoke("cloud:save-settings", settings),
  getCloudPublishProfiles: () => ipcRenderer.invoke("cloud:publish-profiles"),
  saveCloudPublishProfile: (profile: CloudPublishProfileInput) => ipcRenderer.invoke("cloud:save-publish-profile", profile),
  deleteCloudPublishProfile: (profileId: string) => ipcRenderer.invoke("cloud:delete-publish-profile", profileId),
  testCloudConnection: () => ipcRenderer.invoke("cloud:test-connection"),
  captureCloudUploadToken: (loginUrl?: string) => ipcRenderer.invoke("cloud:capture-upload-token", loginUrl),
  verifyCloudPhone: (phone: string) => ipcRenderer.invoke("cloud:verify-phone", phone),
  listCloudVideos: (query: CloudVideoListQuery) => ipcRenderer.invoke("cloud:list-videos", query),
  listCloudVideoTypes: (videoType?: number) => ipcRenderer.invoke("cloud:list-video-types", videoType),
  listCloudVideoLabels: (query?: { oneLevelTypeId?: number; twoLevelTypeIds?: string; videoType?: number }) =>
    ipcRenderer.invoke("cloud:list-video-labels", query),
  getCloudRawUrl: (videoId: number, isInner: 0 | 1) => ipcRenderer.invoke("cloud:get-raw-url", videoId, isInner),
  importCloudVideos: (taskId: string, videos: CloudImportVideo[]) => ipcRenderer.invoke("cloud:import-videos", taskId, videos),
  uploadCloudLocalVideos: (taskId: string, videos: CloudLocalUploadVideo[]) => ipcRenderer.invoke("cloud:upload-local-videos", taskId, videos),
  queryCloudImportResult: (requestId: string, pageNo?: number, pageSize?: number) =>
    ipcRenderer.invoke("cloud:query-import-result", requestId, pageNo, pageSize),
  onJobUpdate: (callback: (update: TaskJobUpdate) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, update: TaskJobUpdate) => callback(update);
    ipcRenderer.on("job:update", listener);
    return () => ipcRenderer.removeListener("job:update", listener);
  },
  onCloudProgress: (callback: (update: CloudUploadProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, update: CloudUploadProgress) => callback(update);
    ipcRenderer.on("cloud:progress", listener);
    return () => ipcRenderer.removeListener("cloud:progress", listener);
  }
};

contextBridge.exposeInMainWorld("batchMix", api);
