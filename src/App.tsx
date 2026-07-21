import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  FolderOpen,
  ListPlus,
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
  Wand2,
  X
} from "lucide-react";
import type {
  AssetInfo,
  BatchJobSnapshot,
  CloudAccount,
  CloudImportResult,
  CloudImportVideo,
  CloudSettingsView,
  CloudVideo,
  CloudVideoListQuery,
  ExportTarget,
  ExportMode,
  MixCombination,
  MixProjectConfig,
  SegmentSlot,
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
  accountKey: ""
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

export default function App() {
  const api = window.batchMix;
  const [config, setConfig] = useState<MixProjectConfig | undefined>();
  const [combinations, setCombinations] = useState<MixCombination[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [job, setJob] = useState<BatchJobSnapshot>(emptyJob);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [cloudSettings, setCloudSettings] = useState<CloudSettingsView>(emptyCloudSettings);
  const [cloudSecret, setCloudSecret] = useState("");
  const [cloudStatus, setCloudStatus] = useState<string | undefined>();
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudAccounts, setCloudAccounts] = useState<CloudAccount[]>([]);
  const [cloudVideos, setCloudVideos] = useState<CloudVideo[]>([]);
  const [cloudVideoTotal, setCloudVideoTotal] = useState(0);
  const [cloudQuery, setCloudQuery] = useState<CloudVideoListQuery>({
    pageNo: 1,
    pageSize: 20,
    isInner: 0,
    videoType: 0
  });
  const [cloudTargetSlot, setCloudTargetSlot] = useState("A");
  const [cloudImportRows, setCloudImportRows] = useState<CloudImportRow[]>([]);
  const [cloudImportMeta, setCloudImportMeta] = useState({
    videoType: 0,
    twoLevelTypeId: "",
    labelIds: "",
    videoRight: 0
  });
  const [cloudImportRequestId, setCloudImportRequestId] = useState("");
  const [cloudImportResults, setCloudImportResults] = useState<CloudImportResult[]>([]);
  const [updateSnapshot, setUpdateSnapshot] = useState<UpdateSnapshot>(emptyUpdate);

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
    if (!config || config.exportTarget === "local" || job.status !== "completed") {
      return;
    }
    setCloudImportRows(
      combinations.map((combination) => ({
        localPath: combination.targetVideoPath,
        videoName: basename(combination.targetVideoPath).replace(/\.[^.]+$/, ""),
        url: "",
        thirdId: combination.id
      }))
    );
  }, [combinations, config, job.status]);

  const progress = job.total > 0 ? Math.round(((job.completed + job.failed) / job.total) * 100) : 0;
  const canStart = !!config && combinations.length > 0 && job.status !== "running" && job.status !== "paused";
  const slotSummary = useMemo(() => {
    if (!config) return "未创建项目";
    if (config.slots.length === 0) return "还没有段落";
    return config.slots.map((slot) => `${slot.name}:${slot.assets.length}`).join("  ");
  }, [config]);

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

  function updateConfig(patch: Partial<MixProjectConfig>) {
    if (!config) return;
    void applyConfig({ ...config, ...patch });
  }

  async function saveCloudSettings() {
    if (!api) return;
    setCloudBusy(true);
    setCloudStatus(undefined);
    try {
      const next = await persistCloudSettings();
      setCloudSettings(next);
      setCloudStatus("云管家配置已保存");
    } catch (err) {
      setCloudStatus(toMessage(err));
    } finally {
      setCloudBusy(false);
    }
  }

  async function testCloudConnection() {
    if (!api) return;
    setCloudBusy(true);
    setCloudStatus(undefined);
    try {
      setCloudSettings(await persistCloudSettings());
      await api.testCloudConnection();
      setCloudStatus("连接成功；如果不知道 accountKey，请点击“拉取账号”后选择账号");
    } catch (err) {
      setCloudStatus(toMessage(err));
    } finally {
      setCloudBusy(false);
    }
  }

  async function loadCloudAccounts() {
    if (!api) return;
    setCloudBusy(true);
    setCloudStatus(undefined);
    try {
      setCloudSettings(await persistCloudSettings());
      const result = await api.listCloudAccounts(1, 100);
      setCloudAccounts(result.list);
      setCloudStatus(`已加载 ${result.list.length} 个账号`);
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
      baseUrl: cloudSettings.baseUrl,
      companyKey: cloudSettings.companyKey,
      companySecret: cloudSecret || undefined,
      accountKey: cloudSettings.accountKey
    });
    setCloudSecret("");
    return next;
  }

  async function searchCloudVideos(nextQuery: CloudVideoListQuery = cloudQuery) {
    if (!api) return;
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
    setCloudBusy(true);
    setCloudStatus(undefined);
    try {
      const sourceUrl = useRawUrl ? await api.getCloudRawUrl(video.id, cloudQuery.isInner) : video.videoUrl;
      if (!sourceUrl) {
        throw new Error("该云端视频没有可用的视频 URL");
      }
      const asset: AssetInfo = {
        id: `cloud_${video.id}_${useRawUrl ? "raw" : "video"}`,
        path: sourceUrl,
        name: video.name || `cloud-${video.id}.mp4`,
        kind: "video",
        durationSeconds: video.duration
      };
      const nextSlots = config.slots.map((slot) =>
        slot.name === cloudTargetSlot ? { ...slot, assets: mergeAssets(slot.assets, [asset]) } : slot
      );
      await applyConfig({ ...config, slots: nextSlots });
      setCloudStatus(`已加入段落 ${cloudTargetSlot}`);
    } catch (err) {
      setCloudStatus(toMessage(err));
    } finally {
      setCloudBusy(false);
    }
  }

  async function importCloudVideos() {
    if (!api) return;
    const twoLevelTypeId = Number(cloudImportMeta.twoLevelTypeId);
    if (!Number.isFinite(twoLevelTypeId) || twoLevelTypeId <= 0) {
      setCloudStatus("请填写云管家二级分类 ID");
      return;
    }
    const videos: CloudImportVideo[] = cloudImportRows.map((row) => ({
      localPath: row.localPath,
      videoName: row.videoName,
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
      setCloudStatus(result.errorList.length > 0 ? `已提交，${result.errorList.length} 条校验错误` : "已提交云管家导入");
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

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Wand2 size={22} />
          </div>
          <div>
            <h1>批量混剪工具</h1>
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
            <strong>{updateSnapshot.message}</strong>
            {updateSnapshot.error && <em>{updateSnapshot.error}</em>}
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
              onClick={installUpdate}
              disabled={!api || updateSnapshot.status !== "downloaded"}
            >
              重启安装
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
                    <AssetChips assets={slot.assets} onRemove={(assetId) => void removeAsset(slot.name, assetId)} />
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
              <h2>云管家接入</h2>
              <div className="cloud-form">
                <label>
                  <span>请求域名</span>
                  <input
                    value={cloudSettings.baseUrl}
                    placeholder="https://api.example.com"
                    onChange={(event) => setCloudSettings({ ...cloudSettings, baseUrl: event.target.value })}
                  />
                </label>
                <label>
                  <span>companyKey</span>
                  <input
                    value={cloudSettings.companyKey}
                    onChange={(event) => setCloudSettings({ ...cloudSettings, companyKey: event.target.value })}
                  />
                </label>
                <label>
                  <span>companySecret</span>
                  <input
                    type="password"
                    value={cloudSecret}
                    placeholder={cloudSettings.hasCompanySecret ? "已保存，留空不修改" : "必填"}
                    onChange={(event) => setCloudSecret(event.target.value)}
                  />
                </label>
                <label>
                  <span>accountKey</span>
                  <input
                    value={cloudSettings.accountKey}
                    onChange={(event) => setCloudSettings({ ...cloudSettings, accountKey: event.target.value })}
                  />
                </label>
              </div>
              <div className="cloud-actions">
                <button className="inline-command" type="button" onClick={saveCloudSettings} disabled={cloudBusy || !api}>
                  <Cloud size={16} />
                  <span>保存配置</span>
                </button>
                <button className="secondary-inline" type="button" onClick={testCloudConnection} disabled={cloudBusy || !api}>
                  测试连接
                </button>
                <button className="secondary-inline" type="button" onClick={loadCloudAccounts} disabled={cloudBusy || !api}>
                  拉取账号
                </button>
                {cloudAccounts.length > 0 && (
                  <select
                    value={cloudSettings.accountKey}
                    onChange={(event) => setCloudSettings({ ...cloudSettings, accountKey: event.target.value })}
                  >
                    <option value="">选择账号</option>
                    {cloudAccounts.map((account) => (
                      <option value={account.accountKey} key={account.accountKey}>
                        {account.name || account.account} · {account.accountKey}
                      </option>
                    ))}
                  </select>
                )}
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
                onAdd={(video) => void addCloudVideoToSlot(video, false)}
                onAddRaw={(video) => void addCloudVideoToSlot(video, true)}
                disabled={cloudBusy}
              />
            </section>

            <section className="panel">
              <h2>组合规则</h2>
              <div className="rule-list">
                <span>按段落 A、B、C 固定顺序拼接</span>
                <span>每段各选一个素材生成排列组合</span>
                <span>BGM 按顺序轮换，并只覆盖你选择的段落范围</span>
              </div>
            </section>

            <section className="panel full">
              <h2>组合预览</h2>
              <CombinationTable combinations={combinations} />
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

            {(config.exportTarget === "cloud" || config.exportTarget === "both") && job.status === "completed" && (
              <section className="panel full">
                <h2>导入云管家</h2>
                <div className="cloud-import-meta">
                  <label>
                    <span>视频类型</span>
                    <select
                      value={cloudImportMeta.videoType}
                      onChange={(event) => setCloudImportMeta({ ...cloudImportMeta, videoType: Number(event.target.value) })}
                    >
                      <option value={0}>成片</option>
                      <option value={1}>素材</option>
                      <option value={2}>第三方</option>
                      <option value={3}>图片</option>
                    </select>
                  </label>
                  <label>
                    <span>二级分类 ID</span>
                    <input
                      value={cloudImportMeta.twoLevelTypeId}
                      onChange={(event) => setCloudImportMeta({ ...cloudImportMeta, twoLevelTypeId: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>标签 IDs</span>
                    <input
                      value={cloudImportMeta.labelIds}
                      placeholder="多个用英文逗号"
                      onChange={(event) => setCloudImportMeta({ ...cloudImportMeta, labelIds: event.target.value })}
                    />
                  </label>
                  <label>
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
                  </label>
                </div>
                <CloudImportTable rows={cloudImportRows} onPatch={patchCloudImportRow} />
                <div className="cloud-actions">
                  <button className="inline-command" type="button" onClick={importCloudVideos} disabled={cloudBusy || !api}>
                    <UploadCloud size={16} />
                    <span>提交导入</span>
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
                </div>
                {cloudImportResults.length > 0 && <CloudImportResultTable results={cloudImportResults} />}
              </section>
            )}
          </div>
        ) : (
          <div className="empty-state">
            <CheckCircle2 size={40} />
            <h2>先选择输出目录</h2>
            <p>之后你可以自己添加段落，并给每个段落放入候选视频素材。</p>
          </div>
        )}
      </section>
    </main>
  );
}

function AssetChips({ assets, onRemove }: { assets: AssetInfo[]; onRemove: (assetId: string) => void }) {
  if (assets.length === 0) {
    return <p className="empty-line">还没有添加素材</p>;
  }

  return (
    <div className="asset-chip-list">
      {assets.map((asset) => (
        <span className="asset-chip" key={asset.id}>
          <span>{asset.name}</span>
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

function CombinationTable({ combinations }: { combinations: MixCombination[] }) {
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
              <td>{basename(combination.targetVideoPath)}</td>
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
  onAdd,
  onAddRaw,
  disabled
}: {
  videos: CloudVideo[];
  total: number;
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
  onPatch
}: {
  rows: CloudImportRow[];
  onPatch: (index: number, patch: Partial<CloudImportRow>) => void;
}) {
  if (rows.length === 0) {
    return <p className="empty-line">任务完成后会在这里列出待导入的视频。</p>;
  }

  return (
    <div className="table-wrap cloud-table">
      <table>
        <thead>
          <tr>
            <th>本地视频</th>
            <th>云管家名称</th>
            <th>公网 URL</th>
            <th>第三方 ID</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.localPath}>
              <td>{basename(row.localPath)}</td>
              <td>
                <input value={row.videoName} onChange={(event) => onPatch(index, { videoName: event.target.value })} />
              </td>
              <td>
                <input
                  value={row.url}
                  placeholder="https://...mp4"
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
      <p className="table-note">云管家文档要求传公网可访问的视频 URL，本地 mp4 不会被直接上传。</p>
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

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
