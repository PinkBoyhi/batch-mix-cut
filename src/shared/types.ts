export type ExportMode = "video" | "draft" | "both";

export type ExportTarget = "local" | "cloud" | "both";

export type MixExecutionTarget = "local" | "server";

export type CloudVideoRotation = "none" | "clockwise90" | "counterClockwise90" | "rotate180";

export type JobStatus = "idle" | "queued" | "running" | "paused" | "stopping" | "completed" | "failed";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "error";

export type AssetKind = "video" | "audio";

export interface AssetInfo {
  id: string;
  path: string;
  name: string;
  kind: AssetKind;
  durationSeconds?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
}

export interface SegmentSlot {
  name: string;
  assets: AssetInfo[];
  sortOrder: number;
  draftSlot?: JianyingDraftSlot;
}

export interface JianyingDraftSlot {
  id: string;
  slotName: string;
  index: number;
  trackId?: string;
  segmentId?: string;
  materialId?: string;
  sourcePath?: string;
  sourceName?: string;
  targetStartUs?: number;
  targetDurationUs?: number;
}

export interface VideoProfile {
  codec: "h264";
  audioCodec: "aac";
  preset: "veryfast" | "fast" | "medium" | "slow";
  crf: number;
  canvasMode: "original" | "vertical_9_16" | "horizontal_16_9";
}

export interface BgmSegmentRange {
  startSlotName?: string;
  endSlotName?: string;
  fadeInSeconds: number;
  fadeOutSeconds: number;
}

export interface BgmTrack {
  id: string;
  name: string;
  assets: AssetInfo[];
  range: BgmSegmentRange;
  sortOrder: number;
}

export interface MixProjectConfig {
  projectDir: string;
  outputDir: string;
  workflowTitle?: string;
  slots: SegmentSlot[];
  bgmAssets: AssetInfo[];
  bgmRange: BgmSegmentRange;
  bgmTracks: BgmTrack[];
  maxCombinations: number;
  outputNamePattern: string;
  exportMode: ExportMode;
  sourceVolume: number;
  bgmVolume: number;
  normalizeLoudness: boolean;
  videoProfile: VideoProfile;
  exportTarget: ExportTarget;
  templateDraftPath?: string;
  draftSlots: JianyingDraftSlot[];
}

export interface MixCombination {
  id: string;
  index: number;
  slotAssets: Record<string, AssetInfo>;
  bgm?: AssetInfo;
  bgmTracks?: MixCombinationBgmTrack[];
  targetVideoPath: string;
  targetDraftPath: string;
}

export interface MixCombinationBgmTrack {
  id: string;
  name: string;
  asset: AssetInfo;
  range: BgmSegmentRange;
}

export interface JobFailure {
  combinationId: string;
  message: string;
  phase: "video" | "draft" | "scan";
}

export interface BatchJobSnapshot {
  id: string;
  status: JobStatus;
  total: number;
  completed: number;
  failed: number;
  currentCombinationId?: string;
  message: string;
  failures: JobFailure[];
  startedAt?: string;
  finishedAt?: string;
}

export type WorkflowStage =
  | "asset_transfer"
  | "queued"
  | "mixing"
  | "output_download"
  | "cloud_upload"
  | "cloud_processing"
  | "completed"
  | "failed"
  | "stopped"
  | "interrupted"
  | "attention";

export type WorkflowStatus = "active" | "success" | "partial" | "failed" | "stopped" | "interrupted" | "attention";

export interface WorkflowProgress {
  current: number;
  total: number;
  percent: number;
  unit: "items" | "bytes" | "videos";
  message: string;
}

export interface WorkflowVideoResult {
  videoName: string;
  status: "pending" | "uploading" | "processing" | "success" | "failed";
  message?: string;
  bytesUploaded?: number;
  bytesTotal?: number;
  videoId?: string | number;
}

export interface WorkflowTimelineEntry {
  stage: WorkflowStage;
  status: WorkflowStatus;
  message: string;
  at: string;
}

export interface WorkflowRecord {
  id: string;
  displayName: string;
  uploaderName?: string;
  uploaderLogin?: string;
  taskId?: string;
  executionTarget: MixExecutionTarget;
  exportTarget: ExportTarget;
  stage: WorkflowStage;
  status: WorkflowStatus;
  progress: WorkflowProgress;
  totalVideos: number;
  succeededVideos: number;
  failedVideos: number;
  cloudRequestId?: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  notificationStatus?: "pending" | "sent" | "failed" | "disabled";
  notificationError?: string;
  timeline: WorkflowTimelineEntry[];
  videos: WorkflowVideoResult[];
}

export interface WorkflowCreateInput {
  id?: string;
  displayName: string;
  uploaderName?: string;
  uploaderLogin?: string;
  taskId?: string;
  executionTarget: MixExecutionTarget;
  exportTarget: ExportTarget;
  totalVideos?: number;
}

export interface WorkflowPatchInput {
  uploaderName?: string;
  uploaderLogin?: string;
  stage?: WorkflowStage;
  status?: WorkflowStatus;
  progress?: Partial<WorkflowProgress>;
  totalVideos?: number;
  succeededVideos?: number;
  failedVideos?: number;
  cloudRequestId?: string;
  error?: string;
  finishedAt?: string;
  videos?: WorkflowVideoResult[];
}

export interface TaskJobUpdate {
  taskId: string;
  executionTarget: MixExecutionTarget;
  snapshot: BatchJobSnapshot;
}

export interface UpdateSnapshot {
  status: UpdateStatus;
  message: string;
  currentVersion: string;
  availableVersion?: string;
  progressPercent?: number;
  error?: string;
  url?: string;
}

export interface UpdateReleaseNotes {
  version: string;
  name: string;
  publishedAt?: string;
  body: string;
  url: string;
}

export interface JianyingTemplateMapping {
  templatePath: string;
  slotNames: string[];
  mainTrackAssetIds: string[];
  slots: JianyingDraftSlot[];
}

export interface ScanResult {
  config: MixProjectConfig;
  combinations: MixCombination[];
  warnings: string[];
}

export interface CloudSettings {
  baseUrl: string;
  companyKey: string;
  companySecret?: string;
  accountKey: string;
  accountName?: string;
  accountLogin?: string;
  uploadBaseUrl?: string;
  uploadToken?: string;
}

export interface CloudSettingsView {
  baseUrl: string;
  companyKey: string;
  hasCompanySecret: boolean;
  accountKey: string;
  accountName?: string;
  accountLogin?: string;
  uploadBaseUrl: string;
  hasUploadToken: boolean;
}

export interface CloudAccount {
  account: string;
  accountKey: string;
  name: string;
  groupName?: string;
  teamName?: string;
  roleName?: string;
  state?: number;
}

export interface CloudVideoType {
  id: number;
  name: string;
  level: number;
  videoType?: number;
  parentTypeId?: number;
  children?: CloudVideoType[];
}

export interface CloudVideoLabel {
  id: number;
  name: string;
  level: number;
  parentLabelId?: number;
  state?: number;
  children?: CloudVideoLabel[];
}

export interface CloudVideo {
  id: number;
  name: string;
  videoUrl?: string;
  coverUrl?: string;
  duration?: number;
  fileSize?: number;
  accountKey?: string;
  accountName?: string;
  videoType?: number;
  state?: number;
  oneLevelVideoType?: CloudVideoType;
  twoLevelVideoType?: CloudVideoType;
  videoLabels?: CloudVideoLabel[];
}

export interface CloudVideoListQuery {
  pageNo: number;
  pageSize: number;
  isInner: 0 | 1;
  includeLabelIds?: string;
  excludeLabelIds?: string;
  oneLevelTypeId?: number;
  twoLevelTypeIds?: string;
  videoIds?: string;
  accountKeys?: string;
  name?: string;
  videoType?: number;
}

export interface CloudPage<T> {
  list: T[];
  pageNo: number;
  pageSize: number;
  total: number;
  totalPage: number;
}

export interface CloudImportVideo {
  localPath?: string;
  videoName: string;
  videoType: number;
  twoLevelTypeId: number;
  labelIds: string;
  videoRight: number;
  url: string;
  thirdId?: string;
}

export interface CloudLocalUploadVideo {
  localPath: string;
  videoName: string;
  videoType: number;
  twoLevelTypeId: number;
  labelIds: string;
  videoRight: number;
  rotation?: CloudVideoRotation;
  thirdId?: string;
}

export interface CloudImportJob {
  requestId: string;
  errorList: Array<{
    index: number;
    videoName?: string;
    errors?: Array<{ field: string; message: string }>;
  }>;
}

export interface CloudLocalUploadJob {
  uploaded: Array<{
    localPath: string;
    videoName: string;
    url: string;
  }>;
  skipped?: Array<{
    localPath: string;
    videoName: string;
    reason: string;
  }>;
  importJob?: CloudImportJob;
  submissionError?: string;
}

export interface CloudUploadProgress {
  taskId: string;
  stage: "uploading" | "processing" | "completed" | "failed" | "attention";
  current: number;
  total: number;
  message: string;
  bytesUploaded?: number;
  bytesTotal?: number;
  requestId?: string;
  videos?: WorkflowVideoResult[];
}

export interface CloudImportResult {
  videoId?: string | number;
  videoName: string;
  status: number;
  msg?: string;
}

export type CloudPublishMode = "single" | "collection";

export type CloudNameMode = "file" | "custom" | "prefix";

export interface CloudPublishProfileInput {
  id?: string;
  name: string;
  videoType: number;
  oneLevelTypeId: string;
  twoLevelTypeId: string;
  labelIds: string;
  videoRight: number;
  syncEnabled: boolean;
  rotation: CloudVideoRotation;
  publishMode: CloudPublishMode;
  nameMode: CloudNameMode;
  customName: string;
  namePrefix: string;
}

export interface CloudPublishProfile extends CloudPublishProfileInput {
  id: string;
  updatedAt: string;
}

export interface RemoteMixSettings {
  serverUrl: string;
  token?: string;
}

export interface RemoteMixSettingsView {
  serverUrl: string;
  hasToken: boolean;
  ok?: boolean;
  message?: string;
}

export interface AppApi {
  selectDirectory: () => Promise<string | undefined>;
  selectFiles: (kind: AssetKind) => Promise<string[]>;
  selectVideoFolderFiles: () => Promise<string[]>;
  probeFiles: (filePaths: string[], kind: AssetKind) => Promise<AssetInfo[]>;
  createManualProject: (outputDir: string) => Promise<ScanResult>;
  buildCombinations: (config: MixProjectConfig) => Promise<MixCombination[]>;
  scanProject: (projectDir: string, templateDraftPath?: string) => Promise<ScanResult>;
  startJob: (taskId: string, config: MixProjectConfig) => Promise<BatchJobSnapshot>;
  startRemoteJob: (taskId: string, config: MixProjectConfig) => Promise<BatchJobSnapshot>;
  pauseRemoteJob: (taskId: string) => Promise<BatchJobSnapshot>;
  resumeRemoteJob: (taskId: string) => Promise<BatchJobSnapshot>;
  stopRemoteJob: (taskId: string) => Promise<BatchJobSnapshot>;
  retryRemoteFailures: (taskId: string) => Promise<BatchJobSnapshot>;
  getRemoteJob: (taskId: string) => Promise<BatchJobSnapshot>;
  getRemoteMixSettings: (taskId: string) => Promise<RemoteMixSettingsView>;
  saveRemoteMixSettings: (taskId: string, settings: RemoteMixSettings) => Promise<RemoteMixSettingsView>;
  testRemoteMixServer: (taskId: string) => Promise<RemoteMixSettingsView>;
  pauseJob: (taskId: string) => Promise<BatchJobSnapshot>;
  resumeJob: (taskId: string) => Promise<BatchJobSnapshot>;
  stopJob: (taskId: string) => Promise<BatchJobSnapshot>;
  retryFailures: (taskId: string) => Promise<BatchJobSnapshot>;
  getJob: (taskId: string) => Promise<BatchJobSnapshot>;
  disposeTask: (taskId: string) => Promise<void>;
  revealPath: (targetPath: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  checkForUpdates: () => Promise<UpdateSnapshot>;
  getUpdateStatus: () => Promise<UpdateSnapshot>;
  getUpdateReleaseNotes: () => Promise<UpdateReleaseNotes>;
  onUpdateStatus: (callback: (snapshot: UpdateSnapshot) => void) => () => void;
  getCloudSettings: () => Promise<CloudSettingsView>;
  saveCloudSettings: (settings: CloudSettings) => Promise<CloudSettingsView>;
  getCloudPublishProfiles: () => Promise<CloudPublishProfile[]>;
  saveCloudPublishProfile: (profile: CloudPublishProfileInput) => Promise<CloudPublishProfile>;
  deleteCloudPublishProfile: (profileId: string) => Promise<void>;
  testCloudConnection: () => Promise<{ ok: true }>;
  captureCloudUploadToken: (loginUrl?: string) => Promise<CloudSettingsView>;
  verifyCloudPhone: (phone: string) => Promise<CloudSettingsView>;
  listCloudVideos: (query: CloudVideoListQuery) => Promise<CloudPage<CloudVideo>>;
  listCloudVideoTypes: (videoType?: number) => Promise<CloudVideoType[]>;
  listCloudVideoLabels: (query?: {
    oneLevelTypeId?: number;
    twoLevelTypeIds?: string;
    videoType?: number;
  }) => Promise<CloudVideoLabel[]>;
  getCloudRawUrl: (videoId: number, isInner: 0 | 1) => Promise<string>;
  importCloudVideos: (taskId: string, videos: CloudImportVideo[]) => Promise<CloudImportJob>;
  uploadCloudLocalVideos: (taskId: string, videos: CloudLocalUploadVideo[]) => Promise<CloudLocalUploadJob>;
  queryCloudImportResult: (
    requestId: string,
    pageNo?: number,
    pageSize?: number
  ) => Promise<CloudPage<CloudImportResult>>;
  onJobUpdate: (callback: (update: TaskJobUpdate) => void) => () => void;
  onCloudProgress: (callback: (update: CloudUploadProgress) => void) => () => void;
}
