import type {
  CloudImportJob,
  CloudImportResult,
  CloudPage,
  WorkflowVideoResult
} from "../../src/shared/types.js";

export interface CloudImportMonitorUpdate {
  status: "processing" | "success" | "partial" | "failed" | "attention";
  message: string;
  succeeded: number;
  failed: number;
  videos: WorkflowVideoResult[];
}

export interface CloudImportMonitorOptions {
  requestId: string;
  videoNames: string[];
  importJob: CloudImportJob;
  query: (requestId: string, pageNo: number, pageSize: number) => Promise<CloudPage<CloudImportResult>>;
  onUpdate: (update: CloudImportMonitorUpdate) => void | Promise<void>;
  intervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function monitorCloudImport(options: CloudImportMonitorOptions): Promise<CloudImportMonitorUpdate> {
  const intervalMs = options.intervalMs ?? 10_000;
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  const sleep = options.sleep ?? delay;
  const startedAt = Date.now();
  const initialFailures = rejectedVideos(options.videoNames, options.importJob);
  let consecutiveErrors = 0;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const page = await options.query(options.requestId, 1, 50);
      consecutiveErrors = 0;
      const update = summarizeResults(options.videoNames, page.list, initialFailures);
      await options.onUpdate(update);
      if (update.status !== "processing") return update;
    } catch (error) {
      consecutiveErrors += 1;
      await options.onUpdate({
        status: "processing",
        message: `云管家结果查询暂时失败，正在重试（${consecutiveErrors}）：${toMessage(error)}`,
        succeeded: 0,
        failed: initialFailures.size,
        videos: pendingVideos(options.videoNames, initialFailures)
      });
    }
    await sleep(intervalMs);
  }

  const timeout: CloudImportMonitorUpdate = {
    status: "attention",
    message: "云管家处理超过 30 分钟，请打开看板关注结果",
    succeeded: 0,
    failed: initialFailures.size,
    videos: pendingVideos(options.videoNames, initialFailures)
  };
  await options.onUpdate(timeout);
  return timeout;
}

export function summarizeResults(
  videoNames: string[],
  results: CloudImportResult[],
  initialFailures = new Map<string, string>()
): CloudImportMonitorUpdate {
  const resultByName = new Map(results.map((result) => [result.videoName, result]));
  const videos: WorkflowVideoResult[] = videoNames.map((videoName) => {
    const rejected = initialFailures.get(videoName);
    if (rejected) return { videoName, status: "failed", message: rejected };
    const result = resultByName.get(videoName);
    if (!result) return { videoName, status: "processing", message: "等待云管家返回结果" };
    if (result.status === 10) return { videoName, status: "success", message: result.msg, videoId: result.videoId };
    if (result.status === 20) return { videoName, status: "failed", message: result.msg || "云管家处理失败", videoId: result.videoId };
    return { videoName, status: "processing", message: result.msg || (result.status === 3 ? "文件下载中" : "待处理") };
  });
  const succeeded = videos.filter((video) => video.status === "success").length;
  const failed = videos.filter((video) => video.status === "failed").length;
  const processing = videos.length - succeeded - failed;
  if (processing > 0) {
    return { status: "processing", message: `云管家正在处理：成功 ${succeeded}，失败 ${failed}，处理中 ${processing}`, succeeded, failed, videos };
  }
  const status = failed === 0 ? "success" : succeeded === 0 ? "failed" : "partial";
  return {
    status,
    message: status === "success" ? `云管家处理完成，${succeeded} 条视频全部成功` : `云管家处理完成，成功 ${succeeded} 条，失败 ${failed} 条`,
    succeeded,
    failed,
    videos
  };
}

function rejectedVideos(videoNames: string[], importJob: CloudImportJob): Map<string, string> {
  const failures = new Map<string, string>();
  for (const error of importJob.errorList) {
    const name = error.videoName || videoNames[error.index];
    if (!name) continue;
    const message = error.errors?.map((item) => item.message).filter(Boolean).join("、") || "提交导入时被云管家拒绝";
    failures.set(name, message);
  }
  return failures;
}

function pendingVideos(videoNames: string[], failures: Map<string, string>): WorkflowVideoResult[] {
  return videoNames.map((videoName) => failures.has(videoName)
    ? { videoName, status: "failed", message: failures.get(videoName) }
    : { videoName, status: "processing", message: "等待云管家返回结果" });
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
