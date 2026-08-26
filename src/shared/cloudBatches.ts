export const CLOUD_IMPORT_BATCH_SIZE = 50;

export function splitCloudBatches<T>(items: readonly T[], batchSize = CLOUD_IMPORT_BATCH_SIZE): T[][] {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error("云管家分批数量必须是大于 0 的整数");
  }

  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += batchSize) {
    batches.push(items.slice(start, start + batchSize));
  }
  return batches;
}
