import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Eye,
  FileText,
  FolderOpen,
  ListPlus,
  LogIn,
  Music,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  Square,
  Trash2,
  UploadCloud,
  Video,
  X
} from "lucide-react";
import type {
  AssetInfo,
  BatchJobSnapshot,
  CloudImportJob,
  CloudImportResult,
  CloudImportVideo,
  CloudLocalUploadVideo,
  CloudSettingsView,
  CloudVideo,
  CloudVideoLabel,
  CloudVideoListQuery,
  CloudVideoRotation,
  CloudVideoType,
  ExportTarget,
  ExportMode,
  MixCombination,
  MixProjectConfig,
  SegmentSlot,
  UpdateReleaseNotes,
  UpdateSnapshot
} from "./shared/types";

const emptyJob: BatchJobSnapshot = {
  id: "idle",
  status: "idle",
  total: 0,
  completed: 0,
  failed: 0,
  message: "等待开始",
  failures: []
};

const emptyCloudSettings: CloudSettingsView = {
  baseUrl: "",
  companyKey: "",
  hasCompanySecret: false,
  accountKey: "",
  accountName: "",
  accountLogin: "",
  uploadBaseUrl: "",
  hasUploadToken: false
};

const emptyUpdate: UpdateSnapshot = {
  status: "idle",
  message: "等待检查更新",
  currentVersion: "0.0.0"
};

interface CloudImportRow {
  localPath: string;
  videoName: string;
  url: string;
  thirdId: string;
}

interface VideoPreviewState {
  src: string;
  title: string;
  subtitle?: string;
}

export default function App() {
  const api = window.batchMix;
  const [config, setConfig] = useState<MixProjectConfig | undefined>();
  const [combinations, setCombinations] = useState<MixCombination[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [job, setJob] = useState<BatchJobSnapshot>(emptyJob);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [cloudSettings, setCloudSettings] = useState<CloudSettingsView>(emptyCloudSettings);
  const [cloudPhone, setCloudPhone] = useState("");
  const [cloudStatus, setCloudStatus] = useState<string | undefined>();
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudVideos, setCloudVideos] = useState<CloudVideo[]>([]);
  const [cloudVideoTotal, setCloudVideoTotal] = useState(0);
  const [cloudVideoTypes, setCloudVideoTypes] = useState<CloudVideoType[]>([]);
  const [cloudVideoLabels, setCloudVideoLabels] = useState<CloudVideoLabel[]>([]);
  const [cloudQuery, setCloudQuery] = useState<CloudVideoListQuery>({
    pageNo: 1,
    pageSize: 20,
    isInner: 0,
    videoType: 0
  });
  const [cloudTargetSlot, setCloudTargetSlot] = useState("A");
  const [cloudImportRows, setCloudImportRows] = useState<CloudImportRow[]>([]);
  const [cloudPublicUrlPrefix, setCloudPublicUrlPrefix] = useState("");
  const [cloudUrlBatch, setCloudUrlBatch] = useState("");
  const [autoCloudImportJobId, setAutoCloudImportJobId] = useState<string | undefined>();
  const [cloudSyncEnabled, setCloudSyncEnabled] = useState(true);
  const [cloudRotation, setCloudRotation] = useState<CloudVideoRotation>("none");
  const [cloudPublishMode, setCloudPublishMode] = useState<"single" | "collection">("single");
  const [cloudNameMode, setCloudNameMode] = useState<"file" | "custom" | "prefix">("file");
  const [cloudCustomName, setCloudCustomName] = useState("");
  const [cloudNamePrefix, setCloudNamePrefix] = useState("");
  const [cloudImportMeta, setCloudImportMeta] = useState({
    videoType: 0,
    oneLevelTypeId: "",
    twoLevelTypeId: "",
    labelIds: "",
    videoRight: 0
  });
  const [cloudImportRequestId, setCloudImportRequestId] = useState("");
  const [cloudImportResults, setCloudImportResults] = useState<CloudImportResult[]>([]);
  const [updateSnapshot, setUpdateSnapshot] = useState<UpdateSnapshot>(emptyUpdate);
  const [releaseNotes, setReleaseNotes] = useState<UpdateReleaseNotes | undefined>();
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const [releaseNotesLoading, setReleaseNotesLoading] = useState(false);
  const [releaseNotesError, setReleaseNotesError] = useState<string | undefined>();
  const [videoPreview, setVideoPreview] = useState<VideoPreviewState | undefined>();
  const [videoPreviewError, setVideoPreviewError] = useState<string | undefined>();
  const cloudUserReady = Boolean(cloudSettings.accountKey);

  useEffect(() => {
    if (!api) return;
    return api.onJobUpdate(setJob);
  }, [api]);

  useEffect(() => {
    if (!api) return;
    void api.getUpdateStatus().then(setUpdateSnapshot).catch(() => undefined);
    return api.onUpdateStatus(setUpdateSnapshot);
  }, [api]);

  useEffect(() => {
    if (!api) return;
    void api
      .getCloudSettings()
      .then(setCloudSettings)
      .catch((err) => setCloudStatus(toMessage(err)));
  }, [api]);

  useEffect(() => {
    if (!config?.slots.some((slot) => slot.name === cloudTargetSlot)) {
      setCloudTargetSlot(config?.slots[0]?.name ?? "A");
    }
  }, [cloudTargetSlot, config?.slots]);

  useEffect(() => {
    if (!config || job.status !== "completed") {
      return;
    }
    const rows = buildCloudImportRows(combinations, cloudPublicUrlPrefix);
    setCloudImportRows(rows);
    if (config.exportTarget === "local") {
      setCloudStatus("混剪已完成；可在发布页选择上传云管家，或点击本地下载打开成片目录。");
      return;
    }
    if (autoCloudImportJobId === job.id) {
      return;
    }
    if (!cloudUserReady) {
      setCloudStatus("混剪已完成；请先验证手机号匹配云管家身份，再上传到云管家。");
      return;
    }
    if (!Number(cloudImportMeta.twoLevelTypeId)) {
      setCloudStatus("混剪已完成；请先选择云管家二级分类，再上传到云管家。");
      return;
    }
    if (!cloudSyncEnabled) {
      setCloudStatus("混剪已完成；当前关闭了同步到云端，待你打开后再发布。");
      return;
    }
    if (cloudSettings.hasUploadToken) {
      setAutoCloudImportJobId(job.id);
      void uploadCloudLocalVideos(rows, true);
      return;
    }
    if (cloudPublicUrlPrefix.trim() && rows.length > 0 && rows.every((row) => row.url.trim())) {
      setAutoCloudImportJobId(job.id);
      void submitCloudImport(rows, true);
      return;
    }
    setCloudStatus("混剪已完成；未获取上传授权，不能直传本地 mp4。可点击自动获取上传授权，或填写公网 URL 后提交导入。");
  }, [
    autoCloudImportJobId,
    cloudImportMeta.labelIds,
    cloudImportMeta.twoLevelTypeId,
    cloudImportMeta.videoRight,
    cloudImportMeta.videoType,
    cloudPublicUrlPrefix,
    cloudSettings.hasUploadToken,
    cloudSyncEnabled,
    cloudUserReady,
    combinations,
    config,
    job.id,
    job.status
  ]);

  const progress = job.total > 0 ? Math.round(((job.completed + job.failed) / job.total) * 100) : 0;
  const canStart = !!config && combinations.length > 0 && job.status !== "running" && job.status !== "paused";
  const slotSummary = useMemo(() => {
    if (!config) return "未创建项目";
    if (config.slots.length === 0) return "还没有段落";
    return config.slots.map((slot) => `${slot.name}:${slot.assets.length}`).join("  ");
  }, [config]);
  const updateMessage = updateSnapshot.status === "error" || updateSnapshot.error ? "版本号获取失败" : updateSnapshot.message;
  const selectedCloudAccount = cloudSettings.accountKey
    ? `${cloudSettings.accountName || cloudSettings.accountLogin || "已登录用户"} · ${cloudSettings.accountLogin || cloudSettings.accountKey}`
    : "未登录云管家";
  const oneLevelTypes = useMemo(() => cloudVideoTypes.filter((item) => item.level === 1), [cloudVideoTypes]);
  const selectedOneLevelType = oneLevelTypes.find((item) => String(item.id) === cloudImportMeta.oneLevelTypeId);
  const twoLevelTypes = selectedOneLevelType?.children ?? cloudVideoTypes.filter((item) => item.level === 2);
  const flattenedLabels = useMemo(() => flattenSelectableCloudLabels(cloudVideoLabels), [cloudVideoLabels]);

  async function createProject() {
    if (!api) {
      setError("当前页面没有连接到 Electron 本地能力。请使用桌面窗口操作。");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const outputDir = await api.selectDirectory();
      if (!outputDir) return;
      const result = await api.createManualProject(outputDir);
      setConfig(result.config);
      setCombinations(result.combinations);
      setWarnings(result.warnings);
      setJob(await api.getJob());
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function applyConfig(nextConfig: MixProjectConfig) {
    const normalizedConfig = normalizeBgmRange(nextConfig);
    setConfig(normalizedConfig);
    if (!api) {
      setCombinations([]);
      return;
    }
    setCombinations(await api.buildCombinations(normalizedConfig));
  }

  async function setSegmentCount(count: number) {
    if (!config) return;
    const safeCount = Math.max(1, Math.min(12, count));
    const nextSlots: SegmentSlot[] = Array.from({ length: safeCount }, (_, index) => {
      return config.slots[index] ?? { name: indexToSlotName(index), assets: [], sortOrder: index };
    }).map((slot, index) => ({
      ...slot,
      name: indexToSlotName(index),
      sortOrder: index
    }));
    await applyConfig({ ...config, slots: nextSlots });
  }

  async function addSegment() {
    if (!config) return;
    await setSegmentCount(config.slots.length + 1);
  }

  async function removeSegment(slotName: string) {
    if (!config) return;
    const nextSlots = config.slots
      .filter((slot) => slot.name !== slotName)
      .map((slot, index) => ({ ...slot, name: indexToSlotName(index), sortOrder: index }));
    await applyConfig({ ...config, slots: nextSlots });
  }

  async function addVideoAssets(slotName: string) {
    if (!api || !config) return;
    setBusy(true);
    setError(undefined);
    try {
      const files = await api.selectFiles("video");
      if (files.length === 0) return;
      const assets = await api.probeFiles(files, "video");
      const nextSlots = config.slots.map((slot) =>
        slot.name === slotName ? { ...slot, assets: mergeAssets(slot.assets, assets) } : slot
      );
      await applyConfig({ ...config, slots: nextSlots });
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function addBgmAssets() {
    if (!api || !config) return;
    setBusy(true);
    setError(undefined);
    try {
      const files = await api.selectFiles("audio");
      if (files.length === 0) return;
      const assets = await api.probeFiles(files, "audio");
      await applyConfig({ ...config, bgmAssets: mergeAssets(config.bgmAssets, assets) });
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeAsset(slotName: string, assetId: string) {
    if (!config) return;
    const nextSlots = config.slots.map((slot) =>
      slot.name === slotName ? { ...slot, assets: slot.assets.filter((asset) => asset.id !== assetId) } : slot
    );
    await applyConfig({ ...config, slots: nextSlots });
  }

  async function removeBgm(assetId: string) {
    if (!config) return;
    await applyConfig({ ...config, bgmAssets: config.bgmAssets.filter((asset) => asset.id !== assetId) });
  }

  async function startJob() {
    if (!config || !api) return;
    setError(undefined);
    try {
      setCloudImportRows([]);
      setCloudImportRequestId("");
      setCloudImportResults([]);
      setAutoCloudImportJobId(undefined);
      setJob(await api.startJob(config));
    } catch (err) {
      setError(toMessage(err));
    }
  }

  async function runAction(action: () => Promise<BatchJobSnapshot>) {
    setError(undefined);
    try {
      setJob(await action());
    } catch (err) {
      setError(toMessage(err));
    }
  }

  async function checkForUpdates() {
    if (!api) return;
    try {
      setUpdateSnapshot(await api.checkForUpdates());
    } catch (err) {
      setUpdateSnapshot((current) => ({
        ...current,
        status: "error",
        message: "更新检查失败",
        error: toMessage(err)
      }));
    }
  }

  async function installUpdate() {
    if (!api) return;
    await api.installUpdate();
  }

  async function openLatestReleasePage() {
    if (!api) return;
    try {
      await api.openExternal("https://github.com/PinkBoyhi/batch-mix-cut/releases/latest");
    } catch (err) {
      setError(toMessage(err));
    }
  }

  async function openReleaseNotes() {
    if (!api) return;
    setReleaseNotesOpen(true);
    setReleaseNotesLoading(true);
    setReleaseNotesError(undefined);
    try {
      setReleaseNotes(await api.getUpdateReleaseNotes());
    } catch (err) {
      setReleaseNotesError(toMessage(err));
    } finally {
      setReleaseNotesLoading(false);
    }
  }

  async function openReleasePage() {
    if (!api || !releaseNotes?.url) return;
    try {
      await api.openExternal(releaseNotes.url);
    } catch (err) {
      setReleaseNotesError(toMessage(err));
    }
  }

  function updateConfig(patch: Partial<MixProjectConfig>) {
    if (!config) return;
    void applyConfig({ ...config, ...patch });
  }

  async function testCloudConnection() {
    if (!api) return;
    setCloudBusy(true);
    setCloudStatus(undefined);
    try {
      setCloudSettings(await persistCloudSettings());
      await api.testCloudConnection();
      setCloudStatus("连接成功；请输入手机号验证云管家身份");
    } catch (err) {
      setCloudStatus(toMessage(err));
    } finally {
      setCloudBusy(false);
    }
  }

  async function captureCloudUploadToken() {
    if (!api) return;
    setCloudBusy(true);
    setCloudStatus("正在打开云管家登录窗口；登录后进入视频上传页，软件会自动获取上传授权。");
    try {
      setCloudSettings(await persistCloudSettings());
      const next = await api.captureCloudUploadToken();
      setCloudSettings(next);
      setCloudStatus("已自动获取并保存上传授权，可以直接发布本地成片。");
    } catch (err) {
      setCloudStatus(toMessage(err));
    } finally {
      setCloudBusy(false);
    }
  }

  async function verifyCloudPhone() {
    if (!api) return;
    setCloudBusy(true);
    setCloudStatus(undefined);
    try {
      setCloudSettings(await persistCloudSettings());
      const next = await api.verifyCloudPhone(cloudPhone);
      setCloudSettings(next);
      setCloudPhone(next.accountLogin || cloudPhone);
      setCloudStatus(`手机号验证成功：${next.accountName || next.accountLogin || next.accountKey}`);
    } catch (err) {
      setCloudStatus(toMessage(err));
    } finally {
      setCloudBusy(false);
    }
  }

  async function persistCloudSettings(): Promise<CloudSettingsView> {
    if (!api) {
      throw new Error("当前页面没有连接到 Electron 本地能力。");
    }
    const next = await api.saveCloudSettings({
      baseUrl: "",
      companyKey: "",
      accountKey: cloudSettings.accountKey,
      accountName: cloudSettings.accountName,
      accountLogin: cloudSettings.accountLogin,
      uploadBaseUrl: ""
    });
    return next;
  }

  async function loadCloudTaxonomy(videoType = cloudImportMeta.videoType) {
    if (!api) return;
    setCloudBusy(true);
    setCloudStatus(undefined);
    try {
      const [types, labels] = await Promise.all([
        api.listCloudVideoTypes(videoType),
        api.listCloudVideoLabels({ videoType })
      ]);
      setCloudVideoTypes(types);
      setCloudVideoLabels(labels);
      setCloudStatus("已加载云管家分类和标签");
    } catch (err) {
      setCloudStatus(toMessage(err));
    } finally {
      setCloudBusy(false);
    }
  }

  async function loadCloudLabelsForSelection(videoType: number, oneLevelTypeId: string, twoLevelTypeId: string) {
    if (!api || !twoLevelTypeId) return;
    try {
      const labels = await api.listCloudVideoLabels({
        videoType,
        oneLevelTypeId: oneLevelTypeId ? Number(oneLevelTypeId) : undefined,
        twoLevelTypeIds: twoLevelTypeId
      });
      setCloudVideoLabels(labels);
    } catch (err) {
      setCloudStatus(toMessage(err));
    }
  }

  async function searchCloudVideos(nextQuery: CloudVideoListQuery = cloudQuery) {
    if (!api) return;
    if (!cloudUserReady) {
      setCloudStatus("请先在云管家登录面板验证手机号");
      return;
    }
    setCloudBusy(true);
    setCloudStatus(undefined);
    try {
      const result = await api.listCloudVideos(nextQuery);
      setCloudVideos(result.list);
      setCloudVideoTotal(result.total);
      setCloudQuery({ ...nextQuery, pageNo: result.pageNo, pageSize: result.pageSize });
      setCloudStatus(`找到 ${result.total} 个云端视频`);
    } catch (err) {
      setCloudStatus(toMessage(err));
    } finally {
      setCloudBusy(false);
    }
  }

  async function addCloudVideoToSlot(video: CloudVideo, useRawUrl: boolean) {
    if (!config || !api) return;
    if (!cloudUserReady) {
      setCloudStatus("请先在云管家登录面板验证手机号");
      return;
    }
    setCloudBusy(true);
    setCloudStatus(undefined);
    try {
      let sourceUrl = useRawUrl ? await api.getCloudRawUrl(video.id, cloudQuery.isInner) : video.videoUrl;
      if (!sourceUrl) {
        throw new Error("该云端视频没有可用的视频 URL");
      }
      let probedAsset = await probeCloudVideoSource(sourceUrl, video.name || `cloud-${video.id}.mp4`);
      let switchedToRaw = false;
      if (!useRawUrl && probedAsset?.hasAudio === false) {
        const rawUrl = await api.getCloudRawUrl(video.id, cloudQuery.isInner);
        if (rawUrl && rawUrl !== sourceUrl) {
          sourceUrl = rawUrl;
          probedAsset = await probeCloudVideoSource(sourceUrl, video.name || `cloud-${video.id}.mp4`);
          switchedToRaw = true;
        }
      }
      const asset: AssetInfo = {
        id: `cloud_${video.id}_${useRawUrl ? "raw" : "video"}`,
        path: sourceUrl,
        name: video.name || `cloud-${video.id}.mp4`,
        kind: "video",
        durationSeconds: probedAsset?.durationSeconds ?? video.duration,
        width: probedAsset?.width,
        height: probedAsset?.height,
        hasAudio: probedAsset?.hasAudio
      };
      const nextSlots = config.slots.map((slot) =>
        slot.name === cloudTargetSlot ? { ...slot, assets: mergeAssets(slot.assets, [asset]) } : slot
      );
      await applyConfig({ ...config, slots: nextSlots });
      setCloudStatus(switchedToRaw ? `已加入段落 ${cloudTargetSlot}；普通地址无音轨，已自动改用原片地址` : `已加入段落 ${cloudTargetSlot}`);
    } catch (err) {
      setCloudStatus(toMessage(err));
    } finally {
      setCloudBusy(false);
    }
  }

  async function probeCloudVideoSource(sourceUrl: string, name: string): Promise<AssetInfo | undefined> {
    if (!api) return undefined;
    try {
      const [asset] = await api.probeFiles([sourceUrl], "video");
      return asset ? { ...asset, id: sourceUrl, path: sourceUrl, name, kind: "video" } : undefined;
    } catch {
      return undefined;
    }
  }

  async function selectCloudUploadVideos() {
    if (!api) return;
    setCloudBusy(true);
    setCloudStatus(undefined);
    try {
      const files = await api.selectFiles("video");
      appendCloudUploadFiles(files);
    } catch (err) {
      setCloudStatus(toMessage(err));
    } finally {
      setCloudBusy(false);
    }
  }

  async function selectCloudUploadFolder() {
    if (!api) return;
    setCloudBusy(true);
    setCloudStatus(undefined);
    try {
      const files = await api.selectVideoFolderFiles();
      appendCloudUploadFiles(files);
    } catch (err) {
      setCloudStatus(toMessage(err));
    } finally {
      setCloudBusy(false);
    }
  }

  function appendCloudUploadFiles(files: string[]) {
    if (files.length === 0) {
      setCloudStatus("没有选择视频");
      return;
    }
    setCloudImportRows((rows) => mergeCloudImportRows(rows, buildCloudImportRowsFromPaths(files, cloudPublicUrlPrefix)));
    setCloudStatus(`已加入 ${files.length} 个待上传视频`);
  }

  async function uploadCloudLocalVideos(rows: CloudImportRow[], automatic: boolean) {
    if (!api) return;
    const twoLevelTypeId = Number(cloudImportMeta.twoLevelTypeId);
    if (!Number.isFinite(twoLevelTypeId) || twoLevelTypeId <= 0) {
      setCloudStatus("请先选择云管家二级分类");
      return;
    }
    if (!cloudImportMeta.labelIds.trim()) {
      setCloudStatus("请先选择云管家标签，当前接口要求标签必填");
      return;
    }
    if (!isValidCloudLabelSelection(cloudImportMeta.labelIds, flattenedLabels)) {
      setCloudStatus("请选择当前分类下的二级标签");
      return;
    }
    if (!cloudUserReady) {
      setCloudStatus("请先验证手机号匹配云管家身份");
      return;
    }
    if (rows.length === 0) {
      setCloudStatus("没有待上传的本地成片");
      return;
    }
    if (!cloudSyncEnabled) {
      setCloudStatus("请先打开“是否同步到云端”");
      return;
    }
    if (!cloudSettings.hasUploadToken) {
      setCloudStatus("发布需要云管家上传授权；当前未获取授权，不能把本地 mp4 直传云管家。可以先自动获取上传授权，或填写每条公网 URL 后用“公网 URL 导入”。");
      return;
    }
    const videos: CloudLocalUploadVideo[] = rows.map((row, index) => ({
      localPath: row.localPath,
      videoName: resolveCloudVideoName(row, index),
      videoType: cloudImportMeta.videoType,
      twoLevelTypeId,
      labelIds: cloudImportMeta.labelIds,
      videoRight: cloudImportMeta.videoRight,
      rotation: cloudRotation
    }));
    setCloudBusy(true);
    setCloudStatus(automatic ? "混剪已完成，正在上传本地成片到云管家..." : "正在上传本地成片到云管家...");
    try {
      const result = await api.uploadCloudLocalVideos(videos);
      setCloudImportRequestId(result.importJob.requestId);
      setCloudImportRows((currentRows) =>
        currentRows.map((row) => {
          const uploaded = result.uploaded.find((item) => item.localPath === row.localPath);
          return uploaded ? { ...row, url: uploaded.url } : row;
        })
      );
      setCloudStatus(
        result.importJob.errorList.length > 0
          ? `已上传 ${result.uploaded.length} 个本地成片，提交导入后有 ${result.importJob.errorList.length} 条校验错误：${formatImportErrors(result.importJob.errorList)}`
          : `已上传 ${result.uploaded.length} 个本地成片，并提交云管家导入`
      );
    } catch (err) {
      setCloudStatus(toMessage(err));
    } finally {
      setCloudBusy(false);
    }
  }

  async function importCloudVideos() {
    await submitCloudImport(cloudImportRows, false);
  }

  async function publishVideos(keepConfigForNext = false) {
    const target = config?.exportTarget ?? "cloud";
    if (target === "local") {
      await openLocalExports();
      return;
    }
    if (!cloudSettings.hasUploadToken) {
      const hasAllPublicUrls = cloudImportRows.length > 0 && cloudImportRows.every((row) => row.url.trim());
      if (hasAllPublicUrls) {
        await submitCloudImport(cloudImportRows, false);
        return;
      }
      setCloudStatus("发布失败：缺少云管家上传授权，无法直传本地 mp4。请在云管家登录里点击自动获取上传授权，或给每条视频填公网 URL 后导入。");
      return;
    }
    await uploadCloudLocalVideos(cloudImportRows, false);
    if (keepConfigForNext) {
      setCloudStatus((current) => `${current ?? "发布已提交"}；可继续选择下一批视频。`);
    }
  }

  async function openLocalExports() {
    if (!api) return;
    const firstPath = cloudImportRows[0]?.localPath;
    const targetPath = firstPath ? dirname(firstPath) : config ? `${config.outputDir.replace(/[\\/]+$/, "")}/videos` : "";
    if (!targetPath) {
      setCloudStatus("请先混剪生成成片，或先选择待发布视频");
      return;
    }
    try {
      await api.revealPath(targetPath);
      setCloudStatus("已打开本地成片目录");
    } catch (err) {
      setCloudStatus(toMessage(err));
    }
  }

  function openVideoPreview(title: string, source: string, subtitle?: string) {
    const src = buildVideoPreviewUrl(source);
    if (!src) {
      setCloudStatus("没有可预览的视频地址");
      return;
    }
    setVideoPreview({ src, title, subtitle });
    setVideoPreviewError(undefined);
  }

  async function submitCloudImport(rows: CloudImportRow[], automatic: boolean) {
    if (!api) return;
    const twoLevelTypeId = Number(cloudImportMeta.twoLevelTypeId);
    if (!Number.isFinite(twoLevelTypeId) || twoLevelTypeId <= 0) {
      setCloudStatus("请先选择云管家二级分类");
      return;
    }
    if (!cloudImportMeta.labelIds.trim()) {
      setCloudStatus("请先选择云管家标签，当前接口要求标签必填");
      return;
    }
    if (!isValidCloudLabelSelection(cloudImportMeta.labelIds, flattenedLabels)) {
      setCloudStatus("请选择当前分类下的二级标签");
      return;
    }
    if (!cloudUserReady) {
      setCloudStatus("请先验证手机号匹配云管家身份");
      return;
    }
    if (rows.length === 0) {
      setCloudStatus("没有待导入的视频");
      return;
    }
    const missingUrl = rows.findIndex((row) => !row.url.trim());
    if (missingUrl >= 0) {
      setCloudStatus(`第 ${missingUrl + 1} 个视频缺少公网 URL，无法${automatic ? "自动" : ""}导入云管家`);
      return;
    }
    const videos: CloudImportVideo[] = rows.map((row, index) => ({
      localPath: row.localPath,
      videoName: resolveCloudVideoName(row, index),
      videoType: cloudImportMeta.videoType,
      twoLevelTypeId,
      labelIds: cloudImportMeta.labelIds,
      videoRight: cloudImportMeta.videoRight,
      url: row.url,
      thirdId: row.thirdId || undefined
    }));
    setCloudBusy(true);
    setCloudStatus(undefined);
    try {
      const result = await api.importCloudVideos(videos);
      setCloudImportRequestId(result.requestId);
      setCloudStatus(
        result.errorList.length > 0
          ? `已提交，${result.errorList.length} 条校验错误：${formatImportErrors(result.errorList)}`
          : "已提交云管家导入"
      );
    } catch (err) {
      setCloudStatus(toMessage(err));
    } finally {
      setCloudBusy(false);
    }
  }

  async function queryCloudImportResult() {
    if (!api || !cloudImportRequestId) return;
    setCloudBusy(true);
    setCloudStatus(undefined);
    try {
      const result = await api.queryCloudImportResult(cloudImportRequestId, 1, 50);
      setCloudImportResults(result.list);
      setCloudStatus(`已查询 ${result.list.length} 条导入结果`);
    } catch (err) {
      setCloudStatus(toMessage(err));
    } finally {
      setCloudBusy(false);
    }
  }

  function patchCloudImportRow(index: number, patch: Partial<CloudImportRow>) {
    setCloudImportRows((rows) => rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  }

  function fillCloudUrlsFromPrefix() {
    setCloudImportRows((rows) => buildCloudImportRowsFromRows(rows, cloudPublicUrlPrefix));
    setCloudStatus(cloudPublicUrlPrefix.trim() ? "已按前缀生成备用公网导入 URL" : "请先填写备用 URL 前缀");
  }

  function applyCloudUrlBatch() {
    const urls = cloudUrlBatch
      .split(/[\n,，]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (urls.length === 0) {
      setCloudStatus("请先粘贴公网 URL");
      return;
    }
    setCloudImportRows((rows) => rows.map((row, index) => ({ ...row, url: urls[index] ?? row.url })));
    setCloudStatus(`已填入 ${Math.min(urls.length, cloudImportRows.length)} 个公网 URL`);
  }

  function resolveCloudVideoName(row: CloudImportRow, index: number): string {
    if (cloudNameMode === "custom") {
      const base = cloudCustomName.trim() || "成片";
      return `${base}_${String(index + 1).padStart(3, "0")}`;
    }
    if (cloudNameMode === "prefix") {
      const prefix = cloudNamePrefix.trim();
      return `${prefix}${prefix ? "_" : ""}${row.videoName}`;
    }
    return row.videoName;
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <img src="./logo.png" alt="医博生物" />
          </div>
          <div>
            <h1>医博生物混剪工具</h1>
            <p>{slotSummary}</p>
          </div>
        </div>

        <button className="primary-action" type="button" onClick={createProject} disabled={busy}>
          <FolderOpen size={18} />
          <span>{busy ? "处理中" : "选择输出目录"}</span>
        </button>

        {config && (
          <section className="panel">
            <h2>段落设置</h2>
            <label className="field">
              <span>段落数</span>
              <input
                type="number"
                min="1"
                max="12"
                value={Math.max(1, config.slots.length)}
                onChange={(event) => void setSegmentCount(Number(event.target.value))}
              />
            </label>
            <button className="inline-command" type="button" onClick={addSegment}>
              <ListPlus size={16} />
              <span>添加段落</span>
            </button>
          </section>
        )}

        {config && (
          <section className="panel">
            <h2>导出设置</h2>
            <label className="field">
              <span>输出模式</span>
              <select
                value={config.exportMode}
                onChange={(event) => updateConfig({ exportMode: event.target.value as ExportMode })}
              >
                <option value="video">只导出视频</option>
              </select>
            </label>

            <label className="field">
              <span>目标</span>
              <select
                value={config.exportTarget ?? "local"}
                onChange={(event) => updateConfig({ exportTarget: event.target.value as ExportTarget })}
              >
                <option value="local">导出到本地</option>
                <option value="cloud">导出到云管家</option>
                <option value="both">本地 + 云管家</option>
              </select>
            </label>

            <label className="field">
              <span>尺寸</span>
              <select
                value={config.videoProfile.canvasMode}
                onChange={(event) =>
                  updateConfig({
                    videoProfile: {
                      ...config.videoProfile,
                      canvasMode: event.target.value as MixProjectConfig["videoProfile"]["canvasMode"]
                    }
                  })
                }
              >
                <option value="original">原来尺寸</option>
                <option value="vertical_9_16">9:16 竖屏</option>
                <option value="horizontal_16_9">16:9 横屏</option>
              </select>
            </label>

            <label className="field">
              <span>最大数</span>
              <input
                type="number"
                min="1"
                max="100000"
                step="1"
                value={config.maxCombinations}
                onChange={(event) =>
                  updateConfig({
                    maxCombinations: Math.max(1, Math.floor(Number(event.target.value) || 1))
                  })
                }
              />
            </label>

            <label className="field">
              <span>名称</span>
              <input
                value={config.outputNamePattern ?? ""}
                placeholder="成品"
                onChange={(event) => updateConfig({ outputNamePattern: event.target.value })}
              />
            </label>

            <label className="field">
              <span>原声</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={config.sourceVolume}
                onChange={(event) => updateConfig({ sourceVolume: Number(event.target.value) })}
              />
              <strong>{Math.round(config.sourceVolume * 100)}%</strong>
            </label>

            <label className="field">
              <span>BGM</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={config.bgmVolume}
                onChange={(event) => updateConfig({ bgmVolume: Number(event.target.value) })}
              />
              <strong>{Math.round(config.bgmVolume * 100)}%</strong>
            </label>

            <div className="path-line">
              <span>输出</span>
              <button type="button" onClick={() => void api?.revealPath(config.outputDir)} disabled={!api}>
                {config.outputDir}
              </button>
            </div>
          </section>
        )}

        <section className="panel">
          <h2>任务</h2>
          <div className="progress-meta">
            <span>{job.message}</span>
            <strong>{progress}%</strong>
          </div>
          <div className="progress-bar">
            <div style={{ width: `${progress}%` }} />
          </div>
          <div className="stats-grid">
            <Stat label="组合" value={combinations.length} />
            <Stat label="完成" value={job.completed} />
            <Stat label="失败" value={job.failed} />
          </div>
          <div className="toolbar">
            <button type="button" onClick={startJob} disabled={!canStart} title="开始">
              <Play size={17} />
            </button>
            <button
              type="button"
              onClick={() => void (api ? runAction(() => api.pauseJob()) : undefined)}
              disabled={job.status !== "running"}
              title="暂停"
            >
              <Pause size={17} />
            </button>
            <button
              type="button"
              onClick={() => void (api ? runAction(() => api.resumeJob()) : undefined)}
              disabled={job.status !== "paused"}
              title="继续"
            >
              <RotateCcw size={17} />
            </button>
            <button
              type="button"
              onClick={() => void (api ? runAction(() => api.stopJob()) : undefined)}
              disabled={job.status !== "running" && job.status !== "paused"}
              title="停止"
            >
              <Square size={17} />
            </button>
            <button
              type="button"
              onClick={() => void (api ? runAction(() => api.retryFailures()) : undefined)}
              disabled={job.failures.length === 0 || job.status === "running"}
              title="重试失败"
            >
              <RotateCcw size={17} />
            </button>
          </div>
        </section>

        <section className="panel">
          <h2>更新</h2>
          <div className="update-box">
            <span>当前版本 {updateSnapshot.currentVersion}</span>
            <strong>{updateMessage}</strong>
            {typeof updateSnapshot.progressPercent === "number" && (
              <div className="progress-bar">
                <div style={{ width: `${Math.round(updateSnapshot.progressPercent)}%` }} />
              </div>
            )}
          </div>
          <div className="update-actions">
            <button
              className="secondary-inline"
              type="button"
              onClick={checkForUpdates}
              disabled={!api || updateSnapshot.status === "checking" || updateSnapshot.status === "downloading"}
            >
              检查更新
            </button>
            <button
              className="inline-command"
              type="button"
              onClick={openLatestReleasePage}
              disabled={!api || updateSnapshot.status !== "available"}
            >
              下载新版
            </button>
            <button className="secondary-inline" type="button" onClick={openReleaseNotes} disabled={!api || releaseNotesLoading}>
              <FileText size={15} />
              更新日志
            </button>
          </div>
        </section>
      </aside>

      <section className="workspace">
        {!api && (
          <div className="notice">
            <AlertTriangle size={18} />
            <span>当前是普通浏览器预览，只能看界面。请使用 Electron 桌面窗口来读取本地素材和导出视频。</span>
          </div>
        )}

        {error && (
          <div className="notice error">
            <AlertTriangle size={18} />
            <span>{error}</span>
          </div>
        )}

        {warnings.map((warning) => (
          <div className="notice" key={warning}>
            <AlertTriangle size={18} />
            <span>{warning}</span>
          </div>
        ))}

        <section className="overview-band">
          <div>
            <h2>手动段落混剪</h2>
            <p>{config ? config.outputDir : "先选择输出目录，然后创建段落并添加素材"}</p>
          </div>
          <div className="count-pill">
            <Video size={18} />
            <span>{combinations.length} 个组合</span>
          </div>
        </section>

        {config ? (
          <div className="content-grid">
            <section className="panel full">
              <h2>段落素材</h2>
              <div className="manual-slot-list">
                {config.slots.map((slot) => (
                  <div className="manual-slot" key={slot.name}>
                    <div className="slot-head">
                      <div>
                        <strong>段落 {slot.name}</strong>
                        <span>{slot.assets.length} 个候选素材</span>
                      </div>
                      <div className="row-actions">
                        <button type="button" onClick={() => void addVideoAssets(slot.name)} title="添加视频">
                          <Plus size={16} />
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeSegment(slot.name)}
                          disabled={config.slots.length <= 1}
                          title="删除段落"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                    <AssetChips
                      assets={slot.assets}
                      onPreview={(asset) => openVideoPreview(asset.name, asset.path, `段落 ${slot.name}`)}
                      onRemove={(assetId) => void removeAsset(slot.name, assetId)}
                    />
                  </div>
                ))}
              </div>
            </section>

            <section className="panel wide">
              <h2>BGM 素材</h2>
              <button className="inline-command" type="button" onClick={addBgmAssets}>
                <Music size={16} />
                <span>添加 BGM</span>
              </button>
              <AssetChips assets={config.bgmAssets} onRemove={(assetId) => void removeBgm(assetId)} />
              <BgmRangeControls config={config} onChange={updateConfig} />
            </section>

            <section className="panel full">
              <h2>云管家登录</h2>
              <div className="cloud-login-summary">
                <div>
                  <CheckCircle2 size={18} />
                  <strong>云管家服务已就绪</strong>
                  <span>验证手机号后即可使用云素材和发布功能。</span>
                </div>
                <div>
                  <Cloud size={18} />
                  <strong>{cloudSettings.hasUploadToken ? "发布功能已可用" : "发布功能待授权"}</strong>
                  <span>
                    {cloudSettings.hasUploadToken
                      ? "可直接把本地成片发布到云管家。"
                      : "需要发布本地成片时，点击授权并完成网页登录。"}
                  </span>
                </div>
              </div>
              <div className="cloud-form cloud-login-form">
                <label>
                  <span>手机号</span>
                  <input
                    value={cloudPhone}
                    placeholder="输入手机号匹配云管家身份"
                    onChange={(event) => setCloudPhone(event.target.value)}
                  />
                </label>
                <label>
                  <span>登录用户</span>
                  <input value={selectedCloudAccount} readOnly />
                </label>
              </div>
              <div className="cloud-actions">
                <button className="secondary-inline" type="button" onClick={testCloudConnection} disabled={cloudBusy || !api}>
                  测试连接
                </button>
                <button className="secondary-inline" type="button" onClick={() => void captureCloudUploadToken()} disabled={cloudBusy || !api}>
                  自动获取上传授权
                </button>
                <button className="inline-command" type="button" onClick={verifyCloudPhone} disabled={cloudBusy || !api}>
                  <LogIn size={16} />
                  <span>验证手机号</span>
                </button>
              </div>
              {cloudStatus && <p className="cloud-status">{cloudStatus}</p>}
            </section>

            <section className="panel full">
              <h2>云素材选择器</h2>
              <div className="cloud-search">
                <label>
                  <span>关键词</span>
                  <input
                    value={cloudQuery.name ?? ""}
                    placeholder="视频名称或描述"
                    onChange={(event) => setCloudQuery({ ...cloudQuery, name: event.target.value || undefined, pageNo: 1 })}
                  />
                </label>
                <label>
                  <span>视频类型</span>
                  <select
                    value={cloudQuery.videoType ?? ""}
                    onChange={(event) =>
                      setCloudQuery({
                        ...cloudQuery,
                        videoType: event.target.value === "" ? undefined : Number(event.target.value),
                        pageNo: 1
                      })
                    }
                  >
                    <option value="">全部</option>
                    <option value="0">成片</option>
                    <option value="1">素材</option>
                    <option value="2">第三方</option>
                    <option value="3">图片</option>
                    <option value="4">文案</option>
                  </select>
                </label>
                <label>
                  <span>二级分类</span>
                  <input
                    value={cloudQuery.twoLevelTypeIds ?? ""}
                    placeholder="多个用英文逗号"
                    onChange={(event) =>
                      setCloudQuery({ ...cloudQuery, twoLevelTypeIds: event.target.value || undefined, pageNo: 1 })
                    }
                  />
                </label>
                <label>
                  <span>标签</span>
                  <input
                    value={cloudQuery.includeLabelIds ?? ""}
                    placeholder="多个用英文逗号"
                    onChange={(event) =>
                      setCloudQuery({ ...cloudQuery, includeLabelIds: event.target.value || undefined, pageNo: 1 })
                    }
                  />
                </label>
                <label>
                  <span>加入段落</span>
                  <select value={cloudTargetSlot} onChange={(event) => setCloudTargetSlot(event.target.value)}>
                    {config.slots.map((slot) => (
                      <option value={slot.name} key={slot.name}>
                        {slot.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="inline-command"
                  type="button"
                  onClick={() => void searchCloudVideos({ ...cloudQuery, pageNo: 1 })}
                  disabled={cloudBusy || !api}
                >
                  <Search size={16} />
                  <span>查询</span>
                </button>
              </div>
              <CloudVideoTable
                videos={cloudVideos}
                total={cloudVideoTotal}
                onPreview={(video) => openVideoPreview(video.name || `云素材 ${video.id}`, video.videoUrl ?? "", "云管家素材")}
                onAdd={(video) => void addCloudVideoToSlot(video, false)}
                onAddRaw={(video) => void addCloudVideoToSlot(video, true)}
                disabled={cloudBusy}
              />
            </section>

            <section className="panel full">
              <h2>组合预览</h2>
              <CombinationTable
                combinations={combinations}
                onPreview={(combination) => openVideoPreview(combination.id, combination.targetVideoPath, basename(combination.targetVideoPath))}
              />
            </section>

            {job.failures.length > 0 && (
              <section className="panel full">
                <h2>失败日志</h2>
                <div className="failure-list">
                  {job.failures.map((failure) => (
                    <div key={`${failure.combinationId}-${failure.message}`}>
                      <AlertTriangle size={16} />
                      <span>{failure.combinationId}</span>
                      <p>{failure.message}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {config && (
              <section className="panel full cloud-publish-shell">
                <aside className="cloud-publish-nav">
                  <span>页面导航</span>
                  <a href="#cloud-upload-block">视频上传</a>
                  <a href="#cloud-info-block">视频信息</a>
                  <a href="#cloud-permission-block">权限设置</a>
                </aside>
                <div className="cloud-publish-main">
                  <section className="cloud-publish-card" id="cloud-upload-block">
                    <div className="cloud-publish-title">
                      <UploadCloud size={18} />
                      <h2>视频上传</h2>
                      <span>支持选择混剪成片、单个视频或整个文件夹，最多 50 个视频。</span>
                    </div>
                    <div className="cloud-drop-zone">
                      <div className="cloud-drop-head">
                        <Plus size={22} />
                        <strong>粘贴或拖拽至此，或点击上传按钮上传</strong>
                      </div>
                      <div className="cloud-upload-choices">
                        <button type="button" onClick={() => void selectCloudUploadVideos()} disabled={cloudBusy || !api}>
                          <Video size={22} />
                          <strong>选择视频</strong>
                          <span>支持单个或多个文件上传</span>
                        </button>
                        <button type="button" onClick={() => void selectCloudUploadFolder()} disabled={cloudBusy || !api}>
                          <FolderOpen size={22} />
                          <strong>选择文件夹</strong>
                          <span>自动扫描文件夹，仅将视频格式加入上传队列</span>
                        </button>
                      </div>
                    </div>
                    <div className="cloud-process-block">
                      <h3>视频处理</h3>
                      <label className="switch-row">
                        <span>是否同步到云端</span>
                        <input
                          type="checkbox"
                          checked={cloudSyncEnabled}
                          onChange={(event) => setCloudSyncEnabled(event.target.checked)}
                        />
                      </label>
                      <div className="radio-row">
                        <span>旋转视频</span>
                        {[
                          ["none", "不旋转"],
                          ["clockwise90", "顺时针旋转90°"],
                          ["counterClockwise90", "逆时针旋转90°"],
                          ["rotate180", "旋转180°"]
                        ].map(([value, label]) => (
                          <label key={value}>
                            <input
                              type="radio"
                              checked={cloudRotation === value}
                              onChange={() => setCloudRotation(value as CloudVideoRotation)}
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                    </div>
                  </section>

                  <section className="cloud-publish-card" id="cloud-info-block">
                    <div className="cloud-publish-title">
                      <FileText size={18} />
                      <h2>视频信息</h2>
                      <span>填写视频分区、分类、发布方式、命名</span>
                    </div>
                    <div className="cloud-info-form">
                      <div className="form-line">
                        <span className="required">视频分区</span>
                        <div className="segmented-row">
                          {[
                            [0, "成片"],
                            [1, "素材"],
                            [2, "第三方"]
                          ].map(([value, label]) => (
                            <button
                              type="button"
                              className={cloudImportMeta.videoType === value ? "selected" : ""}
                              key={value}
                              onClick={() => {
                                const videoType = Number(value);
                                setCloudImportMeta({
                                  ...cloudImportMeta,
                                  videoType,
                                  oneLevelTypeId: "",
                                  twoLevelTypeId: "",
                                  labelIds: ""
                                });
                                void loadCloudTaxonomy(videoType);
                              }}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="form-line">
                        <span className="required">视频分类</span>
                        <div className="classification-box">
                          <select
                            value={cloudImportMeta.oneLevelTypeId}
                            onChange={(event) =>
                              setCloudImportMeta({
                                ...cloudImportMeta,
                                oneLevelTypeId: event.target.value,
                                twoLevelTypeId: "",
                                labelIds: ""
                              })
                            }
                          >
                            <option value="">请选择一级分类</option>
                            {oneLevelTypes.map((type) => (
                              <option value={type.id} key={type.id}>
                                {type.name}
                              </option>
                            ))}
                          </select>
                          <select
                            value={cloudImportMeta.twoLevelTypeId}
                            onChange={(event) => {
                              const twoLevelTypeId = event.target.value;
                              setCloudImportMeta({ ...cloudImportMeta, twoLevelTypeId, labelIds: "" });
                              void loadCloudLabelsForSelection(cloudImportMeta.videoType, cloudImportMeta.oneLevelTypeId, twoLevelTypeId);
                            }}
                          >
                            <option value="">请选择二级分类</option>
                            {twoLevelTypes.map((type) => (
                              <option value={type.id} key={type.id}>
                                {type.name}
                              </option>
                            ))}
                          </select>
                          <div className="category-chip-board">
                            <span>主类目</span>
                            {oneLevelTypes.slice(0, 8).map((type) => (
                              <button
                                type="button"
                                className={cloudImportMeta.oneLevelTypeId === String(type.id) ? "selected" : ""}
                                key={type.id}
                                onClick={() =>
                                  setCloudImportMeta({
                                    ...cloudImportMeta,
                                    oneLevelTypeId: String(type.id),
                                    twoLevelTypeId: "",
                                    labelIds: ""
                                  })
                                }
                              >
                                {type.name}
                              </button>
                            ))}
                            <span>二级分类</span>
                            {twoLevelTypes.slice(0, 10).map((type) => (
                              <button
                                type="button"
                                className={cloudImportMeta.twoLevelTypeId === String(type.id) ? "selected" : ""}
                                key={type.id}
                                onClick={() => {
                                  const twoLevelTypeId = String(type.id);
                                  setCloudImportMeta({ ...cloudImportMeta, twoLevelTypeId, labelIds: "" });
                                  void loadCloudLabelsForSelection(cloudImportMeta.videoType, cloudImportMeta.oneLevelTypeId, twoLevelTypeId);
                                }}
                              >
                                {type.name}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className="form-line">
                        <span className="required">标签</span>
                        <select
                          value={cloudImportMeta.labelIds}
                          onChange={(event) => setCloudImportMeta({ ...cloudImportMeta, labelIds: event.target.value })}
                        >
                          <option value="">请选择当前分类下的二级标签</option>
                          {flattenedLabels.map((label) => (
                            <option value={label.id} key={label.id}>
                              {label.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="form-line">
                        <span className="required">发布形式</span>
                        <div className="segmented-row wide">
                          <button
                            type="button"
                            className={cloudPublishMode === "single" ? "selected" : ""}
                            onClick={() => setCloudPublishMode("single")}
                          >
                            单个视频
                          </button>
                          <button
                            type="button"
                            className={cloudPublishMode === "collection" ? "selected" : ""}
                            onClick={() => setCloudPublishMode("collection")}
                          >
                            视频合集
                          </button>
                        </div>
                      </div>
                      <div className="form-line">
                        <span className="required">视频名称</span>
                        <div className="name-mode-grid">
                          <label>
                            <input
                              type="radio"
                              checked={cloudNameMode === "file"}
                              onChange={() => setCloudNameMode("file")}
                            />
                            使用文件名称
                          </label>
                          <label>
                            <input
                              type="radio"
                              checked={cloudNameMode === "custom"}
                              onChange={() => setCloudNameMode("custom")}
                            />
                            自定义
                          </label>
                          <label>
                            <input
                              type="radio"
                              checked={cloudNameMode === "prefix"}
                              onChange={() => setCloudNameMode("prefix")}
                            />
                            前缀+文件名称
                          </label>
                          {cloudNameMode === "custom" && (
                            <input value={cloudCustomName} placeholder="例如：医博成片" onChange={(event) => setCloudCustomName(event.target.value)} />
                          )}
                          {cloudNameMode === "prefix" && (
                            <input value={cloudNamePrefix} placeholder="例如：医博生物" onChange={(event) => setCloudNamePrefix(event.target.value)} />
                          )}
                        </div>
                      </div>
                      <div className="form-line">
                        <span>备用公网 URL</span>
                        <div className="cloud-url-tools compact-url">
                          <input
                            value={cloudPublicUrlPrefix}
                            placeholder="已有 CDN 地址时可填前缀，作为备用导入方式"
                            onChange={(event) => setCloudPublicUrlPrefix(event.target.value)}
                          />
                          <textarea
                            value={cloudUrlBatch}
                            placeholder="每行一个公网视频 URL；顺序对应下方成片清单"
                            onChange={(event) => setCloudUrlBatch(event.target.value)}
                          />
                          <div className="cloud-actions compact">
                            <button className="secondary-inline" type="button" onClick={fillCloudUrlsFromPrefix} disabled={cloudBusy}>
                              按前缀生成 URL
                            </button>
                            <button className="secondary-inline" type="button" onClick={applyCloudUrlBatch} disabled={cloudBusy}>
                              批量填入 URL
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </section>

                  <section className="cloud-publish-card" id="cloud-permission-block">
                    <div className="cloud-publish-title">
                      <Cloud size={18} />
                      <h2>权限设置</h2>
                      <span>上传前确认视频分类和可见范围</span>
                    </div>
                    <div className="cloud-info-form">
                      <div className="form-line">
                        <span>可见性</span>
                        <select
                          value={cloudImportMeta.videoRight}
                          onChange={(event) => setCloudImportMeta({ ...cloudImportMeta, videoRight: Number(event.target.value) })}
                        >
                          <option value={0}>公开</option>
                          <option value={1}>团队成员</option>
                          <option value={2}>小组成员</option>
                          <option value={3}>公共资源</option>
                        </select>
                      </div>
                      <div className="cloud-actions">
                        <button
                          className="secondary-inline"
                          type="button"
                          onClick={() => void loadCloudTaxonomy()}
                          disabled={cloudBusy || !api || !cloudUserReady}
                        >
                          获取分类
                        </button>
                        <span className="cloud-inline-note">
                          {cloudSettings.hasUploadToken
                            ? "已获取上传授权，可直传本地视频。"
                            : "未获取上传授权，不能直传本地 mp4；可用公网 URL 导入备用。"}
                        </span>
                      </div>
                    </div>
                  </section>

                  <CloudImportTable
                    rows={cloudImportRows}
                    onPatch={patchCloudImportRow}
                    onPreview={(row) => openVideoPreview(row.videoName, row.localPath, "待发布本地视频")}
                    resolveName={resolveCloudVideoName}
                  />
                  <div className="cloud-publish-footer">
                    <label className="delivery-select">
                      <span>成片去向</span>
                      <select
                        value={config.exportTarget ?? "local"}
                        onChange={(event) => updateConfig({ exportTarget: event.target.value as ExportTarget })}
                      >
                        <option value="local">本地下载</option>
                        <option value="cloud">上传云管家</option>
                        <option value="both">本地 + 云管家</option>
                      </select>
                    </label>
                    <button className="secondary-inline" type="button" onClick={() => void openLocalExports()} disabled={!api}>
                      本地下载
                    </button>
                    <button
                      className="secondary-inline"
                      type="button"
                      onClick={() => void publishVideos(true)}
                      disabled={cloudBusy || !api}
                    >
                      发布后，相同配置继续上传
                    </button>
                    <button className="secondary-inline" type="button" onClick={importCloudVideos} disabled={cloudBusy || !api}>
                      公网 URL 导入
                    </button>
                    <input
                      className="request-input"
                      value={cloudImportRequestId}
                      placeholder="导入 requestId"
                      onChange={(event) => setCloudImportRequestId(event.target.value)}
                    />
                    <button
                      className="secondary-inline"
                      type="button"
                      onClick={queryCloudImportResult}
                      disabled={cloudBusy || !api || !cloudImportRequestId}
                    >
                      查询结果
                    </button>
                    <button
                      className="publish-button"
                      type="button"
                      onClick={() => void publishVideos(false)}
                      disabled={cloudBusy || !api}
                    >
                      发布
                    </button>
                    {cloudStatus && <p className="publish-feedback">{cloudStatus}</p>}
                  </div>
                  {cloudImportResults.length > 0 && <CloudImportResultTable results={cloudImportResults} />}
                </div>
              </section>
            )}
          </div>
        ) : (
          <>
            <div className="empty-state">
              <CheckCircle2 size={40} />
              <h2>先选择输出目录</h2>
              <p>之后你可以自己添加段落，并给每个段落放入候选视频素材；也可以直接使用下方云管家上传页发布视频。</p>
            </div>
            <section className="panel full cloud-publish-shell">
              <aside className="cloud-publish-nav">
                <span>页面导航</span>
                <a href="#cloud-upload-standalone">视频上传</a>
                <a href="#cloud-info-standalone">视频信息</a>
                <a href="#cloud-permission-standalone">权限设置</a>
              </aside>
              <div className="cloud-publish-main">
                <section className="cloud-publish-card" id="cloud-upload-standalone">
                  <div className="cloud-publish-title">
                    <UploadCloud size={18} />
                    <h2>视频上传</h2>
                    <span>支持拖拽页同款流程：选择视频、选择文件夹、加入待发布列表。</span>
                  </div>
                  <div className="cloud-drop-zone">
                    <div className="cloud-drop-head">
                      <Plus size={22} />
                      <strong>粘贴或拖拽至此，或点击上传按钮上传</strong>
                    </div>
                    <div className="cloud-upload-choices">
                      <button type="button" onClick={() => void selectCloudUploadVideos()} disabled={cloudBusy || !api}>
                        <Video size={22} />
                        <strong>选择视频</strong>
                        <span>支持单个或多个文件上传</span>
                      </button>
                      <button type="button" onClick={() => void selectCloudUploadFolder()} disabled={cloudBusy || !api}>
                        <FolderOpen size={22} />
                        <strong>选择文件夹</strong>
                        <span>自动扫描文件夹，仅将视频格式加入上传队列</span>
                      </button>
                    </div>
                  </div>
                  <div className="cloud-process-block">
                    <h3>视频处理</h3>
                    <label className="switch-row">
                      <span>是否同步到云端</span>
                      <input type="checkbox" checked={cloudSyncEnabled} onChange={(event) => setCloudSyncEnabled(event.target.checked)} />
                    </label>
                    <div className="radio-row">
                      <span>旋转视频</span>
                      {[
                        ["none", "不旋转"],
                        ["clockwise90", "顺时针旋转90°"],
                        ["counterClockwise90", "逆时针旋转90°"],
                        ["rotate180", "旋转180°"]
                      ].map(([value, label]) => (
                        <label key={value}>
                          <input
                            type="radio"
                            checked={cloudRotation === value}
                            onChange={() => setCloudRotation(value as CloudVideoRotation)}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </div>
                </section>
                <section className="cloud-publish-card" id="cloud-info-standalone">
                  <div className="cloud-publish-title">
                    <FileText size={18} />
                    <h2>视频信息</h2>
                    <span>填写视频分区、分类、发布方式、命名。</span>
                  </div>
                  <div className="cloud-info-form">
                    <div className="form-line">
                      <span className="required">视频分区</span>
                      <div className="segmented-row">
                        {[
                          [0, "成片"],
                          [1, "素材"],
                          [2, "第三方"]
                        ].map(([value, label]) => (
                          <button
                            type="button"
                            className={cloudImportMeta.videoType === value ? "selected" : ""}
                            key={value}
                            onClick={() => {
                              const videoType = Number(value);
                              setCloudImportMeta({ ...cloudImportMeta, videoType, oneLevelTypeId: "", twoLevelTypeId: "", labelIds: "" });
                              void loadCloudTaxonomy(videoType);
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="form-line">
                      <span className="required">视频分类</span>
                      <div className="classification-box">
                        <select
                          value={cloudImportMeta.oneLevelTypeId}
                          onChange={(event) =>
                            setCloudImportMeta({ ...cloudImportMeta, oneLevelTypeId: event.target.value, twoLevelTypeId: "", labelIds: "" })
                          }
                        >
                          <option value="">请选择一级分类</option>
                          {oneLevelTypes.map((type) => (
                            <option value={type.id} key={type.id}>
                              {type.name}
                            </option>
                          ))}
                        </select>
                        <select
                          value={cloudImportMeta.twoLevelTypeId}
                          onChange={(event) => {
                            const twoLevelTypeId = event.target.value;
                            setCloudImportMeta({ ...cloudImportMeta, twoLevelTypeId, labelIds: "" });
                            void loadCloudLabelsForSelection(cloudImportMeta.videoType, cloudImportMeta.oneLevelTypeId, twoLevelTypeId);
                          }}
                        >
                          <option value="">请选择二级分类</option>
                          {twoLevelTypes.map((type) => (
                            <option value={type.id} key={type.id}>
                              {type.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className="form-line">
                      <span className="required">发布形式</span>
                      <div className="segmented-row wide">
                        <button type="button" className={cloudPublishMode === "single" ? "selected" : ""} onClick={() => setCloudPublishMode("single")}>
                          单个视频
                        </button>
                        <button
                          type="button"
                          className={cloudPublishMode === "collection" ? "selected" : ""}
                          onClick={() => setCloudPublishMode("collection")}
                        >
                          视频合集
                        </button>
                      </div>
                    </div>
                    <div className="form-line">
                      <span className="required">标签</span>
                      <select
                        value={cloudImportMeta.labelIds}
                        onChange={(event) => setCloudImportMeta({ ...cloudImportMeta, labelIds: event.target.value })}
                      >
                        <option value="">请选择当前分类下的二级标签</option>
                        {flattenedLabels.map((label) => (
                          <option value={label.id} key={label.id}>
                            {label.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="form-line">
                      <span className="required">视频名称</span>
                      <div className="name-mode-grid">
                        <label>
                          <input type="radio" checked={cloudNameMode === "file"} onChange={() => setCloudNameMode("file")} />
                          使用文件名称
                        </label>
                        <label>
                          <input type="radio" checked={cloudNameMode === "custom"} onChange={() => setCloudNameMode("custom")} />
                          自定义
                        </label>
                        <label>
                          <input type="radio" checked={cloudNameMode === "prefix"} onChange={() => setCloudNameMode("prefix")} />
                          前缀+文件名称
                        </label>
                      </div>
                    </div>
                  </div>
                </section>
                <section className="cloud-publish-card" id="cloud-permission-standalone">
                  <div className="cloud-publish-title">
                    <Cloud size={18} />
                    <h2>权限设置</h2>
                    <span>发布前确认视频分类和可见范围。</span>
                  </div>
                  <div className="cloud-info-form">
                    <div className="form-line">
                      <span>可见性</span>
                      <select
                        value={cloudImportMeta.videoRight}
                        onChange={(event) => setCloudImportMeta({ ...cloudImportMeta, videoRight: Number(event.target.value) })}
                      >
                        <option value={0}>公开</option>
                        <option value={1}>团队成员</option>
                        <option value={2}>小组成员</option>
                        <option value={3}>公共资源</option>
                      </select>
                    </div>
                    <div className="cloud-actions">
                      <button className="secondary-inline" type="button" onClick={() => void loadCloudTaxonomy()} disabled={cloudBusy || !api || !cloudUserReady}>
                        获取分类
                      </button>
                      <span className="cloud-inline-note">
                        {cloudSettings.hasUploadToken ? "已获取上传授权，可直传本地视频。" : "未获取上传授权，不能直传本地 mp4。"}
                      </span>
                    </div>
                  </div>
                </section>
                <CloudImportTable
                  rows={cloudImportRows}
                  onPatch={patchCloudImportRow}
                  onPreview={(row) => openVideoPreview(row.videoName, row.localPath, "待发布本地视频")}
                  resolveName={resolveCloudVideoName}
                />
                <div className="cloud-publish-footer">
                  <button className="secondary-inline" type="button" onClick={() => void openLocalExports()} disabled={!api}>
                    本地下载
                  </button>
                  <button className="secondary-inline" type="button" onClick={importCloudVideos} disabled={cloudBusy || !api}>
                    公网 URL 导入
                  </button>
                  <button className="publish-button" type="button" onClick={() => void publishVideos(false)} disabled={cloudBusy || !api}>
                    发布
                  </button>
                  {cloudStatus && <p className="publish-feedback">{cloudStatus}</p>}
                </div>
              </div>
            </section>
          </>
        )}
      </section>
      {releaseNotesOpen && (
        <div className="modal-backdrop" onClick={() => setReleaseNotesOpen(false)}>
          <section
            className="release-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="release-notes-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="release-modal-head">
              <div>
                <span>更新日志</span>
                <h2 id="release-notes-title">{releaseNotes?.name ?? "正在获取最新版本"}</h2>
              </div>
              <button type="button" onClick={() => setReleaseNotesOpen(false)} title="关闭">
                <X size={18} />
              </button>
            </header>
            <div className="release-meta">
              <span>当前版本 {updateSnapshot.currentVersion}</span>
              {releaseNotes && <span>最新版本 {releaseNotes.version}</span>}
              {releaseNotes?.publishedAt && <span>{formatDateTime(releaseNotes.publishedAt)}</span>}
            </div>
            <div className="release-body">
              {releaseNotesLoading && <p className="muted">正在读取 GitHub 更新日志...</p>}
              {releaseNotesError && (
                <div className="notice error">
                  <AlertTriangle size={18} />
                  <span>{releaseNotesError}</span>
                </div>
              )}
              {!releaseNotesLoading && !releaseNotesError && <pre>{releaseNotes?.body ?? "暂时没有更新日志。"}</pre>}
            </div>
            <footer className="release-modal-actions">
              <button className="secondary-inline" type="button" onClick={openReleaseNotes} disabled={!api || releaseNotesLoading}>
                刷新日志
              </button>
              <button className="inline-command" type="button" onClick={openReleasePage} disabled={!api || !releaseNotes?.url}>
                打开发布页
              </button>
            </footer>
          </section>
        </div>
      )}
      {videoPreview && (
        <VideoPreviewWindow
          preview={videoPreview}
          error={videoPreviewError}
          onError={() => setVideoPreviewError("预览失败：请确认视频文件已生成，或视频地址可以访问。")}
          onClose={() => {
            setVideoPreview(undefined);
            setVideoPreviewError(undefined);
          }}
        />
      )}
    </main>
  );
}

function VideoPreviewWindow({
  preview,
  error,
  onError,
  onClose
}: {
  preview: VideoPreviewState;
  error?: string;
  onError: () => void;
  onClose: () => void;
}) {
  return (
    <section className="video-preview-window" aria-label="视频预览">
      <header>
        <div>
          <strong>{preview.title}</strong>
          {preview.subtitle && <span>{preview.subtitle}</span>}
        </div>
        <button type="button" onClick={onClose} title="关闭预览">
          <X size={16} />
        </button>
      </header>
      <video key={preview.src} src={preview.src} controls playsInline onError={onError} />
      {error && <p>{error}</p>}
    </section>
  );
}

function AssetChips({
  assets,
  onPreview,
  onRemove
}: {
  assets: AssetInfo[];
  onPreview?: (asset: AssetInfo) => void;
  onRemove: (assetId: string) => void;
}) {
  if (assets.length === 0) {
    return <p className="empty-line">还没有添加素材</p>;
  }

  return (
    <div className="asset-chip-list">
      {assets.map((asset) => (
        <span className="asset-chip" key={asset.id}>
          <span>{asset.name}</span>
          {asset.kind === "video" && onPreview && (
            <button type="button" onClick={() => onPreview(asset)} title="预览">
              <Eye size={14} />
            </button>
          )}
          <button type="button" onClick={() => onRemove(asset.id)} title="移除">
            <X size={14} />
          </button>
        </span>
      ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CombinationTable({
  combinations,
  onPreview
}: {
  combinations: MixCombination[];
  onPreview: (combination: MixCombination) => void;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>片段</th>
            <th>BGM</th>
            <th>视频输出</th>
          </tr>
        </thead>
        <tbody>
          {combinations.slice(0, 200).map((combination) => (
            <tr key={combination.id}>
              <td>{combination.id}</td>
              <td>
                {Object.entries(combination.slotAssets)
                  .map(([slot, asset]) => `${slot}:${asset.name}`)
                  .join("  ")}
              </td>
              <td>{combination.bgm?.name ?? "无"}</td>
              <td>
                <div className="table-action-cell">
                  <span>{basename(combination.targetVideoPath)}</span>
                  <button type="button" onClick={() => onPreview(combination)} title="预览成片">
                    <Eye size={14} />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {combinations.length > 200 && <p className="table-note">仅显示前 200 个组合。</p>}
    </div>
  );
}

function CloudVideoTable({
  videos,
  total,
  onPreview,
  onAdd,
  onAddRaw,
  disabled
}: {
  videos: CloudVideo[];
  total: number;
  onPreview: (video: CloudVideo) => void;
  onAdd: (video: CloudVideo) => void;
  onAddRaw: (video: CloudVideo) => void;
  disabled: boolean;
}) {
  if (videos.length === 0) {
    return <p className="empty-line">还没有查询云端素材</p>;
  }

  return (
    <div className="table-wrap cloud-table">
      <table>
        <thead>
          <tr>
            <th>视频</th>
            <th>作者</th>
            <th>分类</th>
            <th>时长</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {videos.map((video) => (
            <tr key={video.id}>
              <td>
                <strong>{video.name}</strong>
                <span>{video.id}</span>
              </td>
              <td>{video.accountName ?? video.accountKey ?? "-"}</td>
              <td>{video.twoLevelVideoType?.name ?? video.oneLevelVideoType?.name ?? "-"}</td>
              <td>{video.duration ? `${video.duration}s` : "-"}</td>
              <td>
                <div className="mini-actions">
                  <button className="preview-mini" type="button" onClick={() => onPreview(video)} disabled={disabled || !video.videoUrl} title="预览">
                    预览
                  </button>
                  <button type="button" onClick={() => onAdd(video)} disabled={disabled || !video.videoUrl}>
                    加入
                  </button>
                  <button type="button" onClick={() => onAddRaw(video)} disabled={disabled}>
                    原片
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="table-note">共 {total} 个云端视频；“原片”会增加云管家下载次数。</p>
    </div>
  );
}

function CloudImportTable({
  rows,
  onPatch,
  onPreview,
  resolveName
}: {
  rows: CloudImportRow[];
  onPatch: (index: number, patch: Partial<CloudImportRow>) => void;
  onPreview: (row: CloudImportRow) => void;
  resolveName: (row: CloudImportRow, index: number) => string;
}) {
  if (rows.length === 0) {
    return <p className="empty-line">混剪任务完成、选择视频或选择文件夹后，会在这里列出待发布的视频。</p>;
  }

  return (
    <div className="table-wrap cloud-table">
      <table>
        <thead>
          <tr>
            <th>本地视频</th>
            <th>队列名称</th>
            <th>最终发布名称</th>
            <th>上传/导入 URL</th>
            <th>第三方 ID</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.localPath}>
              <td>
                <div className="table-action-cell">
                  <span>{basename(row.localPath)}</span>
                  <button type="button" onClick={() => onPreview(row)} title="预览">
                    <Eye size={14} />
                  </button>
                </div>
              </td>
              <td>
                <input value={row.videoName} onChange={(event) => onPatch(index, { videoName: event.target.value })} />
              </td>
              <td>{resolveName(row, index)}</td>
              <td>
                <input
                  value={row.url}
                  placeholder="直传成功后自动填入；或手动填公网 URL"
                  onChange={(event) => onPatch(index, { url: event.target.value })}
                />
              </td>
              <td>
                <input value={row.thirdId} onChange={(event) => onPatch(index, { thirdId: event.target.value })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="table-note">“上传本地成片”会先直传本地 mp4，再自动提交导入；“公网 URL 导入”只适合已有可访问视频 URL 的情况。</p>
    </div>
  );
}

function CloudImportResultTable({ results }: { results: CloudImportResult[] }) {
  return (
    <div className="table-wrap cloud-table">
      <table>
        <thead>
          <tr>
            <th>视频</th>
            <th>状态</th>
            <th>消息</th>
          </tr>
        </thead>
        <tbody>
          {results.map((result, index) => (
            <tr key={`${result.videoId ?? index}-${result.videoName}`}>
              <td>{result.videoName}</td>
              <td>{cloudImportStatus(result.status)}</td>
              <td>{result.msg ?? "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function mergeAssets(current: AssetInfo[], next: AssetInfo[]): AssetInfo[] {
  const byPath = new Map(current.map((asset) => [asset.path, asset]));
  for (const asset of next) {
    byPath.set(asset.path, asset);
  }
  return [...byPath.values()];
}

function BgmRangeControls({
  config,
  onChange
}: {
  config: MixProjectConfig;
  onChange: (patch: Partial<MixProjectConfig>) => void;
}) {
  const slotOptions = config.slots.map((slot) => slot.name);
  const startSlotName = config.bgmRange.startSlotName ?? slotOptions[0] ?? "";
  const endSlotName = config.bgmRange.endSlotName ?? slotOptions.at(-1) ?? "";

  if (slotOptions.length === 0) {
    return null;
  }

  return (
    <div className="bgm-range">
      <label>
        <span>开始段落</span>
        <select
          value={startSlotName}
          onChange={(event) =>
            onChange({
              bgmRange: normalizeRangeValue(config, {
                ...config.bgmRange,
                startSlotName: event.target.value
              })
            })
          }
        >
          {slotOptions.map((slotName) => (
            <option value={slotName} key={slotName}>
              {slotName}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>结束段落</span>
        <select
          value={endSlotName}
          onChange={(event) =>
            onChange({
              bgmRange: normalizeRangeValue(config, {
                ...config.bgmRange,
                endSlotName: event.target.value
              })
            })
          }
        >
          {slotOptions.map((slotName) => (
            <option value={slotName} key={slotName}>
              {slotName}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>缓出秒数</span>
        <input
          type="number"
          min="0"
          max="10"
          step="0.5"
          value={config.bgmRange.fadeOutSeconds}
          onChange={(event) =>
            onChange({
              bgmRange: {
                ...config.bgmRange,
                fadeOutSeconds: Math.max(0, Number(event.target.value))
              }
            })
          }
        />
      </label>
    </div>
  );
}

function normalizeBgmRange(config: MixProjectConfig): MixProjectConfig {
  return {
    ...config,
    bgmRange: normalizeRangeValue(config, config.bgmRange)
  };
}

function normalizeRangeValue(config: MixProjectConfig, range: MixProjectConfig["bgmRange"]): MixProjectConfig["bgmRange"] {
  const slotNames = config.slots.map((slot) => slot.name);
  if (slotNames.length === 0) {
    return { fadeOutSeconds: Math.max(0, range.fadeOutSeconds ?? 2) };
  }

  const startSlotName = slotNames.includes(range.startSlotName ?? "") ? range.startSlotName : slotNames[0];
  let endSlotName = slotNames.includes(range.endSlotName ?? "") ? range.endSlotName : slotNames.at(-1);
  const startIndex = slotNames.indexOf(startSlotName ?? slotNames[0]);
  const endIndex = slotNames.indexOf(endSlotName ?? slotNames.at(-1)!);
  if (endIndex < startIndex) {
    endSlotName = startSlotName;
  }

  return {
    startSlotName,
    endSlotName,
    fadeOutSeconds: Math.max(0, range.fadeOutSeconds ?? 2)
  };
}

function indexToSlotName(index: number): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return index < letters.length ? letters[index] : `S${index + 1}`;
}

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

function dirname(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return index > 0 ? normalized.slice(0, index) : normalized;
}

function buildVideoPreviewUrl(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) return "";
  if (/^(https?:|blob:|data:|batchmix-preview:)/i.test(trimmed)) {
    return trimmed;
  }
  return `batchmix-preview://local/video?path=${encodeURIComponent(trimmed)}`;
}

function buildCloudImportRows(combinations: MixCombination[], publicUrlPrefix: string): CloudImportRow[] {
  return combinations.map((combination) => buildCloudImportRow(combination.targetVideoPath, publicUrlPrefix));
}

function buildCloudImportRowsFromPaths(filePaths: string[], publicUrlPrefix: string): CloudImportRow[] {
  return filePaths.map((filePath) => buildCloudImportRow(filePath, publicUrlPrefix));
}

function buildCloudImportRow(filePath: string, publicUrlPrefix: string): CloudImportRow {
  const fileName = basename(filePath);
  return {
    localPath: filePath,
    videoName: fileName.replace(/\.[^.]+$/, ""),
    url: publicUrlPrefix.trim() ? joinPublicUrl(publicUrlPrefix, fileName) : "",
    thirdId: ""
  };
}

function mergeCloudImportRows(currentRows: CloudImportRow[], incomingRows: CloudImportRow[]): CloudImportRow[] {
  const existing = new Set(currentRows.map((row) => row.localPath));
  return [...currentRows, ...incomingRows.filter((row) => !existing.has(row.localPath))];
}

function buildCloudImportRowsFromRows(rows: CloudImportRow[], publicUrlPrefix: string): CloudImportRow[] {
  return rows.map((row) => ({
    ...row,
    url: publicUrlPrefix.trim() ? joinPublicUrl(publicUrlPrefix, basename(row.localPath)) : row.url
  }));
}

function joinPublicUrl(prefix: string, fileName: string): string {
  const trimmedPrefix = prefix.trim().replace(/\/+$/, "");
  return `${trimmedPrefix}/${encodeURIComponent(fileName)}`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function cloudImportStatus(status: number): string {
  switch (status) {
    case 0:
      return "待处理";
    case 3:
      return "文件下载中";
    case 10:
      return "成功";
    case 20:
      return "失败";
    default:
      return String(status);
  }
}

function flattenSelectableCloudLabels(labels: CloudVideoLabel[]): CloudVideoLabel[] {
  return labels.flatMap((label) => {
    const children = label.children ? flattenSelectableCloudLabels(label.children) : [];
    return label.level === 2 ? [label, ...children] : children;
  });
}

function isValidCloudLabelSelection(labelIds: string, labels: CloudVideoLabel[]): boolean {
  const allowedIds = new Set(labels.map((label) => String(label.id)));
  return labelIds
    .split(",")
    .map((labelId) => labelId.trim())
    .filter(Boolean)
    .every((labelId) => allowedIds.has(labelId));
}

function formatImportErrors(errorList: CloudImportJob["errorList"]): string {
  return errorList
    .slice(0, 3)
    .map((item, index) => {
      const rowIndex = Number.isFinite(item.index) ? item.index + 1 : index + 1;
      const errors = item.errors?.map((error) => error.message).filter(Boolean).join("、");
      return `第 ${rowIndex} 条${item.videoName ? ` ${item.videoName}` : ""}${errors ? `：${errors}` : ""}`;
    })
    .join("；");
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
