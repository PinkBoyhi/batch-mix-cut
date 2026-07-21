export type ExportMode = "video" | "draft" | "both";

export type ExportTarget = "local" | "cloud" | "both";

export type JobStatus = "idle" | "running" | "paused" | "stopping" | "completed" | "failed";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
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
  preset: "fast" | "medium" | "slow";
  crf: number;
  canvasMode: "original" | "vertical_9_16" | "horizontal_16_9";
}

export interface BgmSegmentRange {
  startSlotName?: string;
  endSlotName?: string;
  fadeOutSeconds: number;
}

export interface MixProjectConfig {
  projectDir: string;
  outputDir: string;
  slots: SegmentSlot[];
  bgmAssets: AssetInfo[];
  bgmRange: BgmSegmentRange;
  maxCombinations: number;
  exportMode: ExportMode;
  sourceVolume: number;
  bgmVolume: number;
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
  targetVideoPath: string;
  targetDraftPath: string;
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

export interface UpdateSnapshot {
  status: UpdateStatus;
  message: string;
  currentVersion: string;
  availableVersion?: string;
  progressPercent?: number;
  error?: string;
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
}

export interface CloudSettingsView {
  baseUrl: string;
  companyKey: string;
  hasCompanySecret: boolean;
  accountKey: string;
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

export interface CloudImportJob {
  requestId: string;
  errorList: Array<{
    index: number;
    videoName?: string;
    errors?: Array<{ field: string; message: string }>;
  }>;
}

export interface CloudImportResult {
  videoId?: string | number;
  videoName: string;
  status: number;
  msg?: string;
}

export interface AppApi {
  selectDirectory: () => Promise<string | undefined>;
  selectFiles: (kind: AssetKind) => Promise<string[]>;
  probeFiles: (filePaths: string[], kind: AssetKind) => Promise<AssetInfo[]>;
  createManualProject: (outputDir: string) => Promise<ScanResult>;
  buildCombinations: (config: MixProjectConfig) => Promise<MixCombination[]>;
  scanProject: (projectDir: string, templateDraftPath?: string) => Promise<ScanResult>;
  startJob: (config: MixProjectConfig) => Promise<BatchJobSnapshot>;
  pauseJob: () => Promise<BatchJobSnapshot>;
  resumeJob: () => Promise<BatchJobSnapshot>;
  stopJob: () => Promise<BatchJobSnapshot>;
  retryFailures: () => Promise<BatchJobSnapshot>;
  getJob: () => Promise<BatchJobSnapshot>;
  revealPath: (targetPath: string) => Promise<void>;
  checkForUpdates: () => Promise<UpdateSnapshot>;
  installUpdate: () => Promise<void>;
  getUpdateStatus: () => Promise<UpdateSnapshot>;
  onUpdateStatus: (callback: (snapshot: UpdateSnapshot) => void) => () => void;
  getCloudSettings: () => Promise<CloudSettingsView>;
  saveCloudSettings: (settings: CloudSettings) => Promise<CloudSettingsView>;
  testCloudConnection: () => Promise<{ ok: true }>;
  listCloudAccounts: (pageNo?: number, pageSize?: number) => Promise<CloudPage<CloudAccount>>;
  listCloudVideos: (query: CloudVideoListQuery) => Promise<CloudPage<CloudVideo>>;
  listCloudVideoTypes: (videoType?: number) => Promise<CloudVideoType[]>;
  listCloudVideoLabels: (query?: {
    oneLevelTypeId?: number;
    twoLevelTypeIds?: string;
    videoType?: number;
  }) => Promise<CloudVideoLabel[]>;
  getCloudRawUrl: (videoId: number, isInner: 0 | 1) => Promise<string>;
  importCloudVideos: (videos: CloudImportVideo[]) => Promise<CloudImportJob>;
  queryCloudImportResult: (
    requestId: string,
    pageNo?: number,
    pageSize?: number
  ) => Promise<CloudPage<CloudImportResult>>;
  onJobUpdate: (callback: (snapshot: BatchJobSnapshot) => void) => () => void;
}
