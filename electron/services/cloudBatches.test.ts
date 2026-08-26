import { describe, expect, it } from "vitest";
import { CLOUD_IMPORT_BATCH_SIZE, splitCloudBatches } from "../../src/shared/cloudBatches.js";

describe("splitCloudBatches", () => {
  it("keeps a 50-item cloud import in one batch", () => {
    expect(splitCloudBatches(Array.from({ length: 50 }, (_, index) => index))).toEqual([
      Array.from({ length: 50 }, (_, index) => index)
    ]);
  });

  it("automatically splits 100 items into two sequential cloud batches", () => {
    const batches = splitCloudBatches(Array.from({ length: 100 }, (_, index) => index + 1));

    expect(CLOUD_IMPORT_BATCH_SIZE).toBe(50);
    expect(batches).toHaveLength(2);
    expect(batches.map((batch) => batch.length)).toEqual([50, 50]);
    expect(batches[0][0]).toBe(1);
    expect(batches[1][0]).toBe(51);
    expect(batches[1][49]).toBe(100);
  });

  it("puts the remaining videos in the final batch", () => {
    expect(splitCloudBatches(Array.from({ length: 101 }, (_, index) => index))).toHaveLength(3);
    expect(splitCloudBatches(Array.from({ length: 101 }, (_, index) => index)).map((batch) => batch.length)).toEqual([50, 50, 1]);
  });
});
