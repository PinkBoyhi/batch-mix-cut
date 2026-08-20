const { contextBridge, ipcRenderer } = require("electron");

const api = {
  selectDirectory: () => ipcRenderer.invoke("dialog:select-directory"),
  selectFiles: (kind) => ipcRenderer.invoke("dialog:select-files", kind),
  selectVideoFolderFiles: () => ipcRenderer.invoke("dialog:select-video-folder-files"),
  probeFiles: (filePaths, kind) => ipcRenderer.invoke("assets:probe-files", filePaths, kind),
  createManualProject: (outputDir) => ipcRenderer.invoke("project:create-manual", outputDir),
  buildCombinations: (config) => ipcRenderer.invoke("project:build-combinations", config),
  scanProject: (projectDir, templateDraftPath) => ipcRenderer.invoke("project:scan", projectDir, templateDraftPath),
  startJob: (taskId, config) => ipcRenderer.invoke("job:start", taskId, config),
  startRemoteJob: (taskId, config) => ipcRenderer.invoke("remote:start", taskId, config),
  pauseRemoteJob: (taskId) => ipcRenderer.invoke("remote:pause", taskId),
  resumeRemoteJob: (taskId) => ipcRenderer.invoke("remote:resume", taskId),
  stopRemoteJob: (taskId) => ipcRenderer.invoke("remote:stop", taskId),
  getRemoteJob: (taskId) => ipcRenderer.invoke("remote:get", taskId),
  getRemoteMixSettings: (taskId) => ipcRenderer.invoke("remote:get-settings", taskId),
  saveRemoteMixSettings: (taskId, settings) => ipcRenderer.invoke("remote:save-settings", taskId, settings),
  testRemoteMixServer: (taskId) => ipcRenderer.invoke("remote:test-server", taskId),
  pauseJob: (taskId) => ipcRenderer.invoke("job:pause", taskId),
  resumeJob: (taskId) => ipcRenderer.invoke("job:resume", taskId),
  stopJob: (taskId) => ipcRenderer.invoke("job:stop", taskId),
  retryFailures: (taskId) => ipcRenderer.invoke("job:retry-failures", taskId),
  getJob: (taskId) => ipcRenderer.invoke("job:get", taskId),
  revealPath: (targetPath) => ipcRenderer.invoke("shell:reveal-path", targetPath),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  getUpdateStatus: () => ipcRenderer.invoke("update:get-status"),
  getUpdateReleaseNotes: () => ipcRenderer.invoke("update:get-release-notes"),
  onUpdateStatus: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("update:status", listener);
    return () => ipcRenderer.removeListener("update:status", listener);
  },
  getCloudSettings: () => ipcRenderer.invoke("cloud:get-settings"),
  saveCloudSettings: (settings) => ipcRenderer.invoke("cloud:save-settings", settings),
  testCloudConnection: () => ipcRenderer.invoke("cloud:test-connection"),
  captureCloudUploadToken: (loginUrl) => ipcRenderer.invoke("cloud:capture-upload-token", loginUrl),
  verifyCloudPhone: (phone) => ipcRenderer.invoke("cloud:verify-phone", phone),
  listCloudVideos: (query) => ipcRenderer.invoke("cloud:list-videos", query),
  listCloudVideoTypes: (videoType) => ipcRenderer.invoke("cloud:list-video-types", videoType),
  listCloudVideoLabels: (query) => ipcRenderer.invoke("cloud:list-video-labels", query),
  getCloudRawUrl: (videoId, isInner) => ipcRenderer.invoke("cloud:get-raw-url", videoId, isInner),
  importCloudVideos: (videos) => ipcRenderer.invoke("cloud:import-videos", videos),
  uploadCloudLocalVideos: (videos) => ipcRenderer.invoke("cloud:upload-local-videos", videos),
  uploadRemoteCloudVideos: (taskId, videos) => ipcRenderer.invoke("remote:upload-cloud-videos", taskId, videos),
  queryCloudImportResult: (requestId, pageNo, pageSize) =>
    ipcRenderer.invoke("cloud:query-import-result", requestId, pageNo, pageSize),
  onJobUpdate: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("job:update", listener);
    return () => ipcRenderer.removeListener("job:update", listener);
  }
};

contextBridge.exposeInMainWorld("batchMix", api);
